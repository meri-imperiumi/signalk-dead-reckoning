/**
 * Pure view-model for the DR webapp (SPEC §14.1).
 *
 * No DOM, no Leaflet — all geometry, styling constants, and data
 * shaping live here so the web components stay thin adapters and this
 * file is unit-testable in Node (`node --test`).
 *
 * Coordinate convention: [lat, lon] pairs (Leaflet's order), degrees
 * everywhere, distances in nautical miles.
 *
 * @module dr-viewmodel.js
 */

import * as posfmt from "./dr-position-format.js";

/**
 * Rendering style constants — the Lille Ø semantic neon palette
 * (green = nominal/GPS, teal = primary active DR system, orange =
 * pending/warning constraint, grey = consumed/inactive).
 */
export const STYLE = {
  lop: "#c77b28",
  lopUsed: "#7a4f1b",
  cpl: "#4b8b99",
  cplUsed: "#2a525c",
  ghostTrack: "#4b8b99",
  gpsTrack: "#6b9e78",
  drMarker: "#ffffff",
  snapVector: "#888899",
  fix: {
    gps: "#6b9e78",
    celestial: "#c77b28",
    bearing: "#4b8b99",
    manual: "#888899",
    backfill: "#888899",
  },
  uncertainty: "#888899",
};

const RAD = Math.PI / 180;
const EARTH_RADIUS_NM = 3440.065;

/**
 * Parses a `<input type="datetime-local">` value (a naive string like
 * "2026-06-21T17:00:00") into an ISO-8601 UTC timestamp. `datetime-local`
 * carries no timezone, so the `tz` argument tells us how to interpret it:
 * "local" (the browser's zone) or "utc". Returns null for empty/invalid.
 *
 * @param {string} s
 * @param {"local"|"utc"} [tz="local"]
 * @returns {string|null}
 */
export function sightTimeToIso(s, tz = "local") {
  if (!s) return null;
  // Append "Z" so the JS engine parses as UTC rather than local.
  const d = tz === "utc" ? new Date(`${s}Z`) : new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Parses a `datetime-local` value into epoch milliseconds (UTC).
 * @param {string} s
 * @param {"local"|"utc"} [tz="local"]
 * @returns {number|null}
 */
export function sightTimeToEpochMs(s, tz = "local") {
  if (!s) return null;
  const d = tz === "utc" ? new Date(`${s}Z`) : new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/**
 * Formats an ISO timestamp into a `datetime-local` value (naive, in the
 * chosen timezone) for pre-filling the input on dialog open. Includes
 * seconds (the input has `step="1"`).
 *
 * @param {string} iso
 * @param {"local"|"utc"} [tz="local"]
 * @returns {string}
 */
export function isoToSightTimeInput(iso, tz = "local") {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  // In UTC mode, use the UTC getters; otherwise the local getters.
  const get = (fn) => (tz === "utc" ? d[`getUTC${fn}`]() : d[`get${fn}`]());
  const pad = (n) => String(n).padStart(2, "0");
  return `${get("FullYear")}-${pad(get("Month") + 1)}-${pad(get("Date"))}T${pad(get("Hours"))}:${pad(get("Minutes"))}:${pad(get("Seconds"))}`;
}

/**
 * Stopwatch-method conversion: "N minutes N seconds ago" → ISO
 * timestamp, relative to `now` (defaults to the moment of the call —
 * the conversion must happen at entry, not at submission, so the
 * offset stays anchored to when the navigator stopped the watch).
 * Blank or non-finite values count as 0; negative offsets are clamped.
 *
 * @param {number|string} minutes
 * @param {number|string} seconds
 * @param {Date} [now]
 * @returns {string} ISO timestamp
 */
export function stopwatchToIso(minutes, seconds, now = new Date()) {
  const mins = Math.max(0, Number(minutes) || 0);
  const secs = Math.max(0, Number(seconds) || 0);
  return new Date(now.getTime() - (mins * 60 + secs) * 1000).toISOString();
}

/**
 * Great-circle destination point from [lat, lon], bearing (deg true),
 * distance (nm). Mirrors plugin/geo.js (kept self-contained so this
 * module loads in the browser without a bundler).
 *
 * @param {[number, number]} from - [lat, lon]
 * @param {number} bearingDeg
 * @param {number} distNm
 * @returns {[number, number]} [lat, lon]
 */
export function destinationPoint(from, bearingDeg, distNm) {
  const [lat1, lon1] = from;
  const φ1 = lat1 * RAD;
  const λ1 = lon1 * RAD;
  const θ = bearingDeg * RAD;
  const δ = distNm / EARTH_RADIUS_NM;
  const sinφ2 =
    Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ);
  const φ2 = Math.asin(Math.max(-1, Math.min(1, sinφ2)));
  const λ2 =
    λ1 +
    Math.atan2(
      Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
      Math.cos(δ) - Math.sin(φ1) * sinφ2,
    );
  const lon = ((λ2 / RAD + 540) % 360) - 180;
  return [φ2 / RAD, lon];
}

/**
 * Ring-buffer track log (SPEC §14.1 dual track). Newest appended;
 * oldest evicted at capacity. Points carry a timestamp for
 * age-based trimming by the renderer if wanted.
 */
export class TrackLog {
  /**
   * @param {number} [maxPoints=3600]
   */
  constructor(maxPoints = 3600) {
    this.maxPoints = maxPoints;
    /** @type {Array<[number, number, number]>} [lat, lon, tMs] */
    this._pts = [];
  }

  /**
   * Appends a point (deduplicated on position + 1 s timestamp slack).
   *
   * @param {number} lat
   * @param {number} lon
   * @param {number} [tMs=Date.now()]
   * @returns {void}
   */
  push(lat, lon, tMs = Date.now()) {
    const n = this._pts.length;
    if (n > 0) {
      const [pLat, pLon, pT] = this._pts[n - 1];
      if (pLat === lat && pLon === lon && tMs - pT < 1000) return;
    }
    this._pts.push([lat, lon, tMs]);
    if (this._pts.length > this.maxPoints) this._pts.shift();
  }

  /**
   * @returns {Array<[number, number]>} Leaflet-style [lat, lon] pairs
   */
  points() {
    return this._pts.map(([lat, lon]) => [lat, lon]);
  }

  /**
   * @returns {number}
   */
  get length() {
    return this._pts.length;
  }
}

/**
 * Line-of-position render spec (SPEC §14.1 LOP primitive).
 *
 * The true LOP runs perpendicular to the body azimuth through the
 * intercept point: the assumed position advanced `intercept_nm` along
 * the azimuth (positive = toward the body — same convention as
 * plugin/fixes.js `lopToLocal`).
 *
 * @param {object} lop - db row shape from GET /observations
 * @returns {{anchor: [number, number], azimuthDeg: number, used: boolean}}
 */
export function lopLineSpec(lop) {
  const anchor = destinationPoint(
    [lop.assumed_lat, lop.assumed_lon],
    lop.azimuth_true,
    lop.intercept_nm ?? 0,
  );
  return {
    anchor,
    azimuthDeg: lop.azimuth_true,
    lopType: lop.lop_type ?? "celestial",
    used: lop.used_in_fix_id != null,
  };
}

/**
 * Extends a line spec to two far endpoints for drawing as a polyline.
 *
 * - **Celestial LOP**: an infinite line perpendicular to the azimuth
 *   through the intercept point — drawn symmetric ±lengthNm, since the
 *   navigator's position could be on either side.
 * - **Bearing LOP**: the line through the charted object along the
 *   measured bearing. The navigator lies on the *reciprocal* side of
 *   the object (bearing + 180°), so we draw a ray from the object toward
 *   the navigator rather than a symmetric line through the object — a
 *   symmetric line visually "runs through and past the object to the
 *   opposite bearing," which reads as wrong even though the infinite
 *   line is mathematically correct. The near endpoint sits a short
 *   distance past the object so the line still visibly touches it.
 *
 * @param {{anchor: [number, number], azimuthDeg: number, lopType?: string}} spec
 * @param {number} [lengthNm=60]
 * @returns {[[number, number], [number, number]]}
 */
export function extendLineSpec(spec, lengthNm = 60) {
  const perp = (spec.azimuthDeg + 90) % 360;
  if (spec.lopType === "bearing") {
    // perp already points toward the navigator (reciprocal of the
    // measured bearing). Draw a ray from just past the object (the
    // short stub on the away side) toward the navigator's side.
    const away = (perp + 180) % 360;
    return [
      destinationPoint(spec.anchor, away, 1),
      destinationPoint(spec.anchor, perp, lengthNm),
    ];
  }
  return [
    destinationPoint(spec.anchor, perp, lengthNm),
    destinationPoint(spec.anchor, (perp + 180) % 360, lengthNm),
  ];
}

/**
 * Circular position line render spec (SPEC §14.1 CPL primitive).
 *
 * @param {object} cpl - db row shape from GET /observations
 * @returns {{center: [number, number], radiusNm: number, used: boolean}}
 */
export function cplCircleSpec(cpl) {
  return {
    center: [cpl.center_lat, cpl.center_lon],
    radiusNm: cpl.radius_nm,
    used: cpl.used_in_fix_id != null,
  };
}

/**
 * Fix point render spec, styled by source type (SPEC §14.1 fixes).
 *
 * @param {object} fix - db row shape from GET /fixes
 * @returns {{position: [number, number], color: string, label: string}}
 */
export function fixPointSpec(fix) {
  return {
    position: [fix.latitude, fix.longitude],
    color: STYLE.fix[fix.source_type] ?? STYLE.fix.manual,
    label: `${fix.source_type} fix${fix.confirmed_by ? ` (${fix.confirmed_by})` : ""}`,
  };
}

/**
 * Snap-to-fix correction vector spec (SPEC §9.3/§14.1 — dashed
 * segment from pre-snap ghost position to confirmed fix).
 *
 * @param {object} c - db row shape from GET /corrections
 * @returns {{from: [number, number], to: [number, number], deviationNm: number, bearingDeg: number}}
 */
export function correctionSegmentSpec(c) {
  return {
    from: [c.dr_lat, c.dr_lon],
    to: [c.fix_lat, c.fix_lon],
    deviationNm: c.deviation_nm,
    bearingDeg: c.deviation_bearing,
  };
}

/**
 * Uncertainty circle spec (SPEC §8/§14.1 — visibly tightening over a
 * season).
 *
 * @param {[number, number]} drPosition
 * @param {{radius_nm: number, method: string}} uncertainty
 * @returns {{center: [number, number], radiusNm: number, method: string}}
 */
export function uncertaintySpec(drPosition, uncertainty) {
  return {
    center: drPosition,
    radiusNm: uncertainty?.radius_nm ?? 0,
    method: uncertainty?.method ?? "fallback",
  };
}

/**
 * Rolling numeric series for the divergence sparkline (SPEC §14.1
 * "short trend sparkline"). Normalized for canvas drawing.
 */
export class Sparkline {
  /**
   * @param {number} [maxSamples=120]
   */
  constructor(maxSamples = 120) {
    this.maxSamples = maxSamples;
    /** @type {number[]} */
    this._vals = [];
  }

  /**
   * @param {number} v
   * @returns {void}
   */
  push(v) {
    if (!Number.isFinite(v)) return;
    this._vals.push(v);
    if (this._vals.length > this.maxSamples) this._vals.shift();
  }

  /**
   * @returns {{current: number|null, min: number, max: number, points: number[]}}
   * points are y-fractions 0..1 within [min, max] (flat line when
   * min === max)
   */
  stats() {
    if (this._vals.length === 0) {
      return { current: null, min: 0, max: 0, points: [] };
    }
    const min = Math.min(...this._vals);
    const max = Math.max(...this._vals);
    const span = max - min;
    const points = this._vals.map((v) => (span > 0 ? (v - min) / span : 0.5));
    return { current: this._vals[this._vals.length - 1], min, max, points };
  }
}

/**
 * Human-readable divergence readout (SPEC §14.1 "distance + bearing").
 *
 * @param {{distance_nm: number, bearing_true: number}|null} d
 * @returns {string}
 */
export function divergenceText(d) {
  if (!d || !Number.isFinite(d.distance_nm)) return "— nm";
  const brg = String(Math.round(d.bearing_true)).padStart(3, "0");
  return `${d.distance_nm.toFixed(2)} nm / ${brg}°`;
}

/**
 * Formats seconds since the last confirmed fix for the headline figure —
 * the watchkeeper's fix-cadence cue ("how stale is my DR origin?").
 *
 * @param {number|null|undefined} s
 * @returns {string} e.g. "4m", "2h 14m", "—"
 */
export function elapsedText(s) {
  if (s == null || !Number.isFinite(s) || s < 0) return "—";
  const m = Math.floor(s / 60);
  if (m < 1) return `${Math.floor(s)}s`;
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m - h * 60}m`;
}

/**
 * Parses Signal K's `resources/charts` object into tile layers the map
 * can render (chart identifier/name + a `{z}/{x}/{y}`-template URL).
 * Charts without a `tilemapUrl` (WMS, S-57, PDFs…) are dropped. No OSM
 * fallback — an offline-first plugin defaults to the tile-less vector
 * plot; basemaps come from whatever the server is configured to serve
 * (often offline MBTiles).
 *
 * Ported from signalk-logbook's src/helpers/charts.js (same server API).
 *
 * @param {object|null|undefined} resource - GET /signalk/v1/api/resources/charts
 * @returns {Array<{identifier: string, name: string, url: string, minZoom: number, maxZoom: number}>}
 */
export function parseChartLayers(resource) {
  if (!resource || typeof resource !== "object") {
    return [];
  }
  return Object.keys(resource)
    .map((key) => {
      const chart = resource[key];
      if (!chart?.tilemapUrl) {
        return null;
      }
      return {
        identifier: chart.identifier || key,
        name: chart.name || chart.identifier || key,
        url: chart.tilemapUrl,
        minZoom: typeof chart.minzoom === "number" ? chart.minzoom : 0,
        maxZoom: typeof chart.maxzoom === "number" ? chart.maxzoom : 19,
      };
    })
    .filter((layer) => layer !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Last-resort basemap when the server has no charts configured (e.g.
 * `/signalk/v1/api/resources/charts` 404s). Offered as an *opt-in*
 * layer in the control — never auto-selected — so the DR plot stays
 * tile-less by default (offline-first), and the user can turn a
 * basemap on when online. Mirrors signalk-logbook's DEFAULT_LAYER.
 */
export const DEFAULT_OSM_LAYER = {
  identifier: "osm",
  name: "OpenStreetMap (online)",
  url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  minZoom: 0,
  maxZoom: 19,
};

/**
 * Configured tile layers, or a single OSM fallback when none are set
 * up. Same contract as signalk-logbook's `chartLayersWithFallback`,
 * but the OSM layer is labelled "(online)" to make its network
 * dependency explicit in the layers control.
 *
 * @param {object|null|undefined} resource
 * @returns {Array<object>}
 */
export function chartLayersWithFallback(resource) {
  const layers = parseChartLayers(resource);
  return layers.length > 0 ? layers : [DEFAULT_OSM_LAYER];
}

/**
 * Bearing (deg true) between two [lat, lon] points, for the
 * snap-vector tooltip and any local geometry the map needs.
 *
 * @param {[number, number]} from
 * @param {[number, number]} to
 * @returns {number} 0..360
 */
export function bearingBetween(from, to) {
  const [φ1, λ1] = [from[0] * RAD, from[1] * RAD];
  const [φ2, λ2] = [to[0] * RAD, to[1] * RAD];
  const y = Math.sin(λ2 - λ1) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(λ2 - λ1);
  return (((Math.atan2(y, x) / RAD) % 360) + 360) % 360;
}

/**
 * Reduces a Signal K `/signalk/v1/history/values` response for
 * `navigation.position` into a Leaflet-style [lat, lon] track.
 *
 * The history API returns `{ data: [[timestamp, [lon, lat]], ...] }`
 * (GeoJSON [lon, lat] order inside the value). Points with no value or
 * duplicating the previous point (within ~0.001°, ~6 m) are dropped —
 * the server may store a static position every tick when moored.
 *
 * @param {object|null|undefined} response
 * @returns {Array<[number, number]>} [lat, lon] pairs
 */
export function historyToTrack(response) {
  if (!response?.data || !Array.isArray(response.data)) return [];
  const pts = [];
  let prevLat = null;
  let prevLon = null;
  for (const entry of response.data) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const value = entry[1];
    if (!Array.isArray(value) || value.length < 2) continue;
    // SK history stores [longitude, latitude] (GeoJSON order).
    const lon = value[0];
    const lat = value[1];
    if (lat == null || lon == null || Number.isNaN(lat) || Number.isNaN(lon)) {
      continue;
    }
    // Dedupe near-identical points (moored vessel holds a static fix).
    if (
      prevLat !== null &&
      Math.abs(lat - prevLat) < 0.001 &&
      Math.abs(lon - prevLon) < 0.001
    ) {
      continue;
    }
    pts.push([lat, lon]);
    prevLat = lat;
    prevLon = lon;
  }
  return pts;
}

/**
 * Builds the history-values URL for the GPS track. `hours` defaults to
 * 6 (enough to see a recent passage without pulling the whole season).
 *
 * @param {number} [hours=6]
 * @param {number} [resolutionSec=60]
 * @returns {string} absolute path under /signalk/v1
 */
export function historyUrl(hours = 6, resolutionSec = 60) {
  const to = new Date();
  const from = new Date(to.getTime() - hours * 3600 * 1000);
  const f = from.toISOString().replace(/\.\d+Z$/, "Z");
  const t = to.toISOString().replace(/\.\d+Z$/, "Z");
  return `/signalk/v1/history/values?from=${f}&to=${t}&paths=navigation.position&resolution=${resolutionSec}`;
}

// ---------------------------------------------------------------------------
// Sight & LOP input (SPEC §14.1 "Manual LOP & Sight Input")
// Pure form→REST-body shapers + small conversions, unit-tested. The
// <dr-sight-panel> component calls these; they never touch the DOM.
// ---------------------------------------------------------------------------

/**
 * Converts a magnetic bearing to true, adding variation (east positive,
 * west negative). Per navigator convention: True = Magnetic + Variation
 * (E), i.e. add east variation, subtract west.
 *
 * @param {number} bearingMag
 * @param {number} variationDeg - east positive, west negative
 * @returns {number} 0..360
 */
export function bearingToTrue(bearingMag, variationDeg) {
  return (((Number(bearingMag) + Number(variationDeg)) % 360) + 360) % 360;
}

/**
 * Distance to an object of known height from a vertical angle, in
 * nautical miles. Standard formula: distance = height / tan(angle),
 * with height in meters converted to nm (1 nm = 1852 m).
 *
 * @param {number} heightM - height of the object above the observer's eye
 * @param {number} angleDeg - vertical angle above the horizontal
 * @returns {number} distance in nm
 */
export function verticalAngleDistanceNm(heightM, angleDeg) {
  const rad = Number(angleDeg) * RAD;
  if (rad <= 0) return Number.POSITIVE_INFINITY;
  return Number(heightM) / Math.tan(rad) / 1852;
}

/**
 * Shape a compass-bearing form into a `POST /fix/lop` body. The
 * navigator takes a bearing to a charted object whose position is
 * known; the LOP is the line from the object at the reciprocal bearing
 * (you are somewhere on it). The engine's LOP convention is "a line
 * through `assumed` perpendicular to `azimuth`", so to make the line
 * run *along* the bearing we feed the object position as the assumed
 * point and rotate the azimuth +90° (the line's normal points
 * across-track). Intercept is 0 — the line passes through the object.
 *
 * @param {object} form - { object, bearing_true, object_lat, object_lon, sight_time, confirmed_by? }
 * @returns {object}
 */
export function bearingLopBody(form) {
  const bearing = Number(form.bearing_true);
  const body = {
    lop_type: "bearing",
    assumed_lat: Number(form.object_lat),
    assumed_lon: Number(form.object_lon),
    // +90° so the line runs along the bearing (engine normal ⊥ line).
    azimuth_true: (bearing + 90) % 360,
    intercept_nm: 0,
    body_or_object: form.object || null,
    confirmed_by: form.confirmed_by || null,
  };
  const ts = sightTimeToIso(form.sight_time, form.sight_tz);
  if (ts) body.timestamp = ts;
  return body;
}

/**
 * Shape a vertical-angle form into a `POST /fix/cpl` body. The CPL is
 * centered on the object's charted position with radius = the distance
 * computed from height + angle.
 *
 * @param {object} form - { object, height_m, angle_deg, center_lat, center_lon, sight_time, confirmed_by? }
 * @returns {object}
 */
export function verticalAngleCplBody(form) {
  const body = {
    cpl_type: "vertical-angle",
    center_lat: Number(form.center_lat),
    center_lon: Number(form.center_lon),
    radius_nm: verticalAngleDistanceNm(form.height_m, form.angle_deg),
    source_object: form.object || null,
    confirmed_by: form.confirmed_by || null,
  };
  const ts = sightTimeToIso(form.sight_time, form.sight_tz);
  if (ts) body.timestamp = ts;
  return body;
}

/**
 * Shape a celestial-sight form into a `POST /celestial/sight` body.
 *
 * @param {object} form - { body, hs_deg, index_correction_deg?, eye_height_m?,
 *   limb?, sight_time, assumed_position?, noon?, confirmed_by? }
 * @returns {object}
 */
// ---------------------------------------------------------------------------
// Pending observations & resolve preview (work doc #13 stages A/B)
// Pure shapers for <dr-pending-list> and the map's advancement layer.
// ---------------------------------------------------------------------------

/**
 * Shapes a db LOP row into a pending-list row spec.
 *
 * @param {object} lop - row from GET /observations
 * @returns {{kind: "lop", id: number, label: string, timestamp: string, used: boolean}}
 */
export function pendingLopRow(lop) {
  return {
    kind: "lop",
    id: lop.lop_id,
    label: lop.body_or_object
      ? `${lop.body_or_object} ${lop.lop_type ?? ""} LOP`.trim()
      : `${lop.lop_type ?? "celestial"} LOP`,
    timestamp: lop.timestamp,
    used: lop.used_in_fix_id != null,
    fixId: lop.used_in_fix_id ?? null,
  };
}

/**
 * Shapes a db CPL row into a pending-list row spec.
 *
 * @param {object} cpl - row from GET /observations
 * @returns {{kind: "cpl", id: number, label: string, timestamp: string, used: boolean}}
 */
export function pendingCplRow(cpl) {
  return {
    kind: "cpl",
    id: cpl.cpl_id,
    label: cpl.source_object
      ? `${cpl.source_object} r=${(cpl.radius_nm ?? 0).toFixed(1)} nm`
      : `CPL r=${(cpl.radius_nm ?? 0).toFixed(1)} nm`,
    timestamp: cpl.timestamp,
    used: cpl.used_in_fix_id != null,
    fixId: cpl.used_in_fix_id ?? null,
  };
}

/**
 * Whether a pending list is too small to resolve: a single observation is
 * a constraint, not a fix (the "needs a partner" hint).
 *
 * @param {Array<object>} rows
 * @returns {boolean}
 */
export function needsPartner(rows) {
  return rows.length === 1;
}

/**
 * Builds the POST /fix/resolve body for a selected subset of pending
 * rows — the interactive what-if of work doc #13 stage B.
 *
 * @param {Array<{kind: "lop"|"cpl", id: number}>} selection
 * @returns {{source_type: string, lop_ids: number[], cpl_ids: number[]}}
 */
export function resolvePreviewBody(selection) {
  return {
    source_type: "manual",
    lop_ids: selection.filter((s) => s.kind === "lop").map((s) => s.id),
    cpl_ids: selection.filter((s) => s.kind === "cpl").map((s) => s.id),
  };
}

/**
 * Detects the honest-failure case (work doc #13): an observation older
 * than the latest one that could not be advanced (no DR track over the
 * interval) — its `displacement` is null although it isn't the latest.
 * The preview must show this, not hide it behind a plausible fix.
 *
 * @param {Array<{timestamp_ms: number|null, displacement: object|null}>} advancements
 * @returns {boolean}
 */
export function hasUnadvanced(advancements) {
  const stamped = (advancements ?? []).filter((a) =>
    Number.isFinite(a.timestamp_ms),
  );
  if (stamped.length < 2) return false;
  const tLate = Math.max(...stamped.map((a) => a.timestamp_ms));
  return stamped.some((a) => a.timestamp_ms < tLate && a.displacement == null);
}

/**
 * Render specs for the map's advancement layer (work doc #13 stage B):
 * per observation, the faded original point, the solid advanced point,
 * the dashed DR-run vector between them, and a warning flag when an
 * older observation couldn't be advanced. Geometry of the advanced
 * constraint (azimuth/radius) comes from the observation rows, matched
 * by id.
 *
 * @param {Array<object>} advancements - from POST /fix/resolve candidate
 * @param {object} rowsById - { lop: Map<number, row>, cpl: Map<number, row> }
 * @returns {Array<{id: number|null, kind: string, original: [number, number],
 *   advanced: [number, number], displacementNm: number|null,
 *   azimuthDeg: number|null, radiusNm: number|null, warning: boolean}>}
 */
export function advancementLayerSpecs(advancements, rowsById) {
  const stamped = (advancements ?? []).filter((a) =>
    Number.isFinite(a.timestamp_ms),
  );
  const tLate =
    stamped.length > 0 ? Math.max(...stamped.map((a) => a.timestamp_ms)) : null;
  const out = [];
  for (const a of advancements ?? []) {
    const row =
      a.kind === "cpl" ? rowsById.cpl.get(a.id) : rowsById.lop.get(a.id);
    out.push({
      id: a.id ?? null,
      kind: a.kind,
      original: [a.original.latitude, a.original.longitude],
      advanced: [a.advanced.latitude, a.advanced.longitude],
      displacementNm: a.displacement?.distanceNm ?? null,
      azimuthDeg: row?.azimuth_true ?? null,
      radiusNm: row?.radius_nm ?? null,
      warning:
        tLate != null &&
        Number.isFinite(a.timestamp_ms) &&
        a.timestamp_ms < tLate &&
        a.displacement == null,
    });
  }
  return out;
}

/**
 * Relative timestamp for pending-list rows ("3m ago"); the absolute
 * time goes in the hover title.
 *
 * @param {string} iso
 * @param {number} [nowMs=Date.now()]
 * @returns {string}
 */
export function relativeTimeText(iso, nowMs = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((nowMs - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m - h * 60}m ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function celestialSightBody(form) {
  const body = {
    body: form.body,
    hs_deg: Number(form.hs_deg),
    epoch_ms: sightTimeToEpochMs(form.sight_time, form.sight_tz),
    confirmed_by: form.confirmed_by || null,
  };
  if (form.index_correction_deg != null && form.index_correction_deg !== "") {
    body.index_correction_deg = Number(form.index_correction_deg);
  }
  if (form.eye_height_m != null && form.eye_height_m !== "") {
    body.eye_height_m = Number(form.eye_height_m);
  }
  if (form.limb) body.limb = form.limb;
  if (form.noon) body.noon = true;
  if (form.assumed_lat != null && form.assumed_lon != null) {
    body.assumed_position = {
      latitude: Number(form.assumed_lat),
      longitude: Number(form.assumed_lon),
    };
  }
  return body;
}

// ---------------------------------------------------------------------------
// Fix at coordinates (SPEC §9.1/§9.3 — point-fix confirm dialog)
// Pure shapers for the <dr-fix-panel> component: GNSS fix-quality stats,
// HDOP-based error estimate, and the form → POST /fix body. No DOM.
// ---------------------------------------------------------------------------

/**
 * Typical user-equivalent range error (m) of a modern receiver, used with
 * HDOP for a rough horizontal-error estimate (HDOP × UERE).
 */
export const GNSS_UERE_M = 3;

/**
 * Rough horizontal position-error estimate from HDOP, in nautical miles:
 * HDOP × UERE (~3 m for a modern receiver). Returns null when no usable
 * HDOP is known — never invents a number without a fix-quality basis.
 *
 * @param {number|null|undefined} hdop
 * @param {number} [uereM=GNSS_UERE_M]
 * @returns {number|null}
 */
export function hdopErrorNm(hdop, uereM = GNSS_UERE_M) {
  if (!Number.isFinite(hdop) || hdop <= 0) return null;
  return (hdop * uereM) / 1852;
}

/**
 * Shapes the live GNSS quality data (from `navigation.gnss.*`) into
 * label/value rows for the fix dialog's stats block. Only fields with a
 * known value are included — the dialog renders "no data" when the array
 * is empty (receiver or provider doesn't publish gnss quality).
 *
 * @param {object|null|undefined} gnss - { type, method, satellites,
 *   satellitesVisible, hdop } with any subset of fields
 * @returns {Array<{label: string, value: string}>}
 */
export function gnssStats(gnss) {
  const rows = [];
  if (gnss?.type) rows.push({ label: "System", value: String(gnss.type) });
  if (gnss?.method)
    rows.push({ label: "Fix method", value: String(gnss.method) });
  const sats = Number(gnss?.satellites);
  const visible = Number(gnss?.satellitesVisible);
  if (Number.isFinite(sats)) {
    rows.push({
      label: "Satellites",
      value:
        Number.isFinite(visible) && visible !== sats
          ? `${sats} in use, ${visible} visible`
          : `${sats} in use`,
    });
  } else if (Number.isFinite(visible)) {
    rows.push({ label: "Satellites", value: `${visible} visible` });
  }
  if (Number.isFinite(gnss?.hdop) && gnss.hdop > 0) {
    const errM = Math.round(gnss.hdop * GNSS_UERE_M);
    rows.push({
      label: "HDOP",
      value: `${gnss.hdop.toFixed(1)} (≈ ${errM} m error)`,
    });
  }
  return rows;
}

/**
 * Shape a fix-dialog form into a `POST /fix` body. Coordinates may be
 * strings in any supported position format (decimal / DM / DMS — the
 * paper-form transcription case) or already-parsed numbers; string
 * parsing throws on malformed input so the panel can surface the error.
 * Fix time, notes and estimated error are forwarded only when present.
 *
 * @param {object} form - { latitude, longitude, source_type?, fix_time?,
 *   fix_tz?, estimated_error_nm?, notes? }
 * @returns {object}
 * @throws {Error} when a coordinate string can't be parsed
 */
export function pointFixBody(form) {
  const toDeg = (v, kind) =>
    typeof v === "number" ? v : posfmt.parseCoord(v, kind);
  const body = {
    source_type: form.source_type || "manual",
    latitude: toDeg(form.latitude, "lat"),
    longitude: toDeg(form.longitude, "lon"),
  };
  const ts = sightTimeToIso(form.fix_time, form.fix_tz);
  if (ts) body.timestamp = ts;
  if (form.notes) body.notes = form.notes;
  const err = Number(form.estimated_error_nm);
  if (
    form.estimated_error_nm != null &&
    form.estimated_error_nm !== "" &&
    Number.isFinite(err) &&
    err > 0
  ) {
    body.estimated_error_nm = err;
  }
  return body;
}
