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
  // AIS targets (work doc #23): violet for ordinary traffic (distinct
  // from every family above — plotters draw AIS in its own hue too),
  // green for buddies (Freeboard-SK's ais_buddy convention). Targets
  // past the expiring threshold keep ONE shared grey (the inactive
  // family) — the plotter convention: active target color → expiring
  // color → gone.
  ais: "#c77bd9",
  aisBuddy: "#6b9e78",
  aisExpiring: "#888899",
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

/** Metres per nautical mile — Signal K bus values are SI (m, m/s, rad);
 * the DR displays are nautical (NM, kn, °). */
export const METRES_PER_NM = 1852;

/** @param {number} m @returns {number} */
export function metresToNm(m) {
  return m / METRES_PER_NM;
}

/** @param {number} ms @returns {number} */
export function msToKn(ms) {
  return (ms * 3600) / METRES_PER_NM;
}

/** @param {number} r @returns {number} */
export function radToDeg(r) {
  return (r * 180) / Math.PI;
}

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
 * Shapes the resolved current vector (§6.2) into the header figure:
 * value "067° · 1.2 kn", a source-labeled caption, and a semantic
 * theme class (manual = orange — alternate input; weather/pilot =
 * teal — active system; none = offline grey).
 *
 * @param {{setTrue: number, drift: number, source: string}|null} current
 * @param {{validUntilMs: number}|null} [manual] - active override, for the TTL caption
 * @param {number} [nowMs]
 * @returns {{value: string, label: string, theme: string|null}}
 */
export function currentFigure(current, manual = null, nowMs = Date.now()) {
  if (!current || !Number.isFinite(current.setTrue)) {
    return { value: "—", label: "Current set/drift", theme: null };
  }
  const set = String(
    Math.round(((current.setTrue % 360) + 360) % 360),
  ).padStart(3, "0");
  const drift = (Number(current.drift) || 0).toFixed(1);
  const source = current.source ?? "";
  let label;
  let theme;
  if (source === "manual") {
    const minLeft =
      manual?.validUntilMs != null
        ? Math.max(0, Math.ceil((manual.validUntilMs - nowMs) / 60_000))
        : null;
    label =
      minLeft != null ? `Current · manual (${minLeft}m)` : "Current · manual";
    theme = "theme-orange";
  } else if (source === "weather-api") {
    label = "Current · weather";
    theme = "theme-teal";
  } else if (source === "pilot-chart") {
    label = "Current · pilot chart";
    theme = "theme-teal";
  } else {
    label = "Current · none";
    theme = "theme-offline";
  }
  return { value: `${set}° · ${drift} kn`, label, theme };
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
 * @param {{radius_m: number, method: string}} uncertainty
 * @returns {{center: [number, number], radiusNm: number, method: string}}
 */
export function uncertaintySpec(drPosition, uncertainty) {
  return {
    center: drPosition,
    radiusNm: metresToNm(uncertainty?.radius_m ?? 0),
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
 * @param {{distance_m: number, bearing_true: number}|null} d - SI bus
 *   values (metres, radians)
 * @returns {string}
 */
export function divergenceText(d) {
  if (!d || !Number.isFinite(d.distance_m)) return "— nm";
  const nm = metresToNm(d.distance_m);
  // Below display resolution the bearing is the direction of noise on a
  // zero-length vector — meaningless, don't show it.
  if (nm < 0.005) return `${nm.toFixed(2)} nm`;
  const brg = String(Math.round(radToDeg(d.bearing_true))).padStart(3, "0");
  return `${nm.toFixed(2)} nm / ${brg}°`;
}

/**
 * Status-line text for the DR state panel. Pure — the panel's CSS
 * classes stay in the adapter.
 *
 * @param {object|null|undefined} s - navigation.deadReckoning.state value
 *   ({status: "underway"|"warm"|"idle", …}); the app merges in `navState`
 *   from the vessel's own navigation.state subscription.
 * @returns {string|null} null when the state isn't recognized (caller
 *   keeps the previous text)
 */
export function drStatusText(s) {
  if (!s) return "No dead-reckoning data";
  if (s.status === "idle") {
    const reason = s.reason ?? "waiting for speed and heading";
    if (s.moving) {
      // Idle while making way — the dangerous case (fouled paddlewheel,
      // sensor dropout): DR is stale, not merely paused.
      return `⚠ DR stale — ${reason}, but the vessel is making way. DR position is NOT tracking; uncertainty is growing.`;
    }
    return `Dead reckoning idle — ${reason}. GPS position still shown on map.`;
  }
  if (s.status === "underway") {
    if (s.fouled) {
      return "⚠ Paddlewheel appears fouled — STW≈0 while making way. DR is integrating near-zero speed.";
    }
    if (s.transient) {
      return "Dead reckoning active — tack/gybe in progress, divergence may spike temporarily.";
    }
    return "Dead reckoning active";
  }
  if (s.status === "warm") {
    // The engine runs warm on a tied-up boat (SPEC §5 — instant OVERRIDE
    // handoff): integrating an honest 0 kn is not "underway".
    if (s.fouled) {
      return "⚠ Paddlewheel appears fouled — STW≈0 while making way. DR is integrating near-zero speed.";
    }
    return `DR warm — ${s.navState ?? "moored"}, integrating sensors`;
  }
  return null;
}

/**
 * Short display label for the DR calculation method (SPEC §3.1). The
 * wire value stays the spec token (`inertial-paddlewheel` etc.); the
 * headline shows the watchkeeper-sized word for it.
 *
 * @param {string|null|undefined} method
 * @returns {string}
 */
export function methodLabel(method) {
  switch (method) {
    case "inertial-paddlewheel":
      return "STW";
    case "inertial-polar":
      return "Polar";
    case "fallback-zero":
      return "Zero";
    default:
      return "—";
  }
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
 * fallback here — basemaps come from whatever the server is configured
 * to serve (often offline MBTiles); the fallback lives in
 * DEFAULT_OSM_LAYER / chartLayersWithFallback.
 *
 * Vector charts (`format: 'pbf'`, work doc #20) carry their format and
 * the resource's vector source-layer ids (`chartLayers`) through so the
 * map view can render them with MapLibre instead of an image tileLayer.
 *
 * Ported from signalk-logbook's src/helpers/charts.js (same server API).
 *
 * @param {object|null|undefined} resource - GET /signalk/v1/api/resources/charts
 * @returns {Array<{identifier: string, name: string, url: string, minZoom: number, maxZoom: number, format?: string, chartLayers?: string[]}>}
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
      const layer = {
        identifier: chart.identifier || key,
        name: chart.name || chart.identifier || key,
        url: chart.tilemapUrl,
        minZoom: typeof chart.minzoom === "number" ? chart.minzoom : 0,
        maxZoom: typeof chart.maxzoom === "number" ? chart.maxzoom : 19,
      };
      if (typeof chart.format === "string" && chart.format.length > 0) {
        layer.format = chart.format.toLowerCase();
      }
      if (Array.isArray(chart.chartLayers)) {
        layer.chartLayers = chart.chartLayers.filter(
          (id) => typeof id === "string" && id.length > 0,
        );
      }
      return layer;
    })
    .filter((layer) => layer !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Whether a parsed chart layer is a vector (Mapbox/MapLibre `.pbf`) tile
 * set that Leaflet's raster engine can't draw — the cue for
 * `<dr-map-view>` to mount it via `L.maplibreGL` instead (work doc #20).
 *
 * @param {{format?: string}|null|undefined} chart - parsed chart layer
 * @returns {boolean}
 */
export function isVectorChart(chart) {
  return chart?.format === "pbf";
}

/**
 * Makes a chart tilemapUrl absolute for MapLibre's style. MapLibre fetches
 * tiles from a blob-URL worker where root-relative URLs (`/signalk/…`)
 * can't resolve — every request fails with "URL is not valid or contains
 * user credentials" / "Failed to parse URL". Absolute http(s) URLs pass
 * through; outside a browser (unit tests) there's no origin to prepend.
 *
 * @param {string} url - chart tilemapUrl, possibly root-relative
 * @returns {string} absolute tile URL (or unchanged when no page origin)
 */
export function absoluteTileUrl(url) {
  if (/^https?:\/\//i.test(url)) return url;
  const origin = globalThis.location?.origin;
  return origin && origin !== "null" ? `${origin}${url}` : url;
}

/**
 * Validates the corridor downloader's asset manifest
 * (`/plugins/signalk-corridor-tile-downloader/assets/manifest.json`). When the
 * downloader has mirrored the upstream chart style, the manifest carries
 * its local `style` URL — the map view then mounts that style wholesale
 * (full symbology, base map, bathymetry) instead of composing the
 * geometry-only fallback style here. Anything that isn't a manifest with
 * a usable style URL yields null so callers keep their fallback.
 *
 * @param {object|null|undefined} value - parsed manifest response body
 * @returns {{style: string}|null}
 */
export function chartAssetsFromManifest(value) {
  if (!value || typeof value !== "object") return null;
  const style = value.style;
  if (typeof style !== "string" || !/^https?:\/\//i.test(style)) {
    return null;
  }
  return { style };
}

/**
 * First POINT feature among a `queryRenderedFeatures` result — the
 * actual object under the cursor (light, beacon, buoy, named peak,
 * cape, landmark, place point). Only symbol layers render labels, so
 * non-symbol layers are skipped; and only Point/MultiPoint geometry
 * counts, because the mirrored Open Waters style renders area names
 * like "Marae Moana" (a 100 NM nature reserve) as a `symbol` layer over
 * a Polygon — a symbol hit is not enough on its own. Area/line labels
 * are not things you take a bearing to.
 *
 * @param {Array<object>|null|undefined} hits
 * @returns {object|null} the first point symbol feature, or null
 */
export function firstPointSymbolHit(hits) {
  if (!Array.isArray(hits)) return null;
  for (const f of hits) {
    if (f?.layer?.type !== "symbol") continue;
    const geom = f.geometry?.type ?? "";
    if (geom === "Point" || geom === "MultiPoint") return f;
  }
  return null;
}

/**
 * A point symbol feature's charted identifier — its `name` (a named
 * peak, cape, landmark) or, falling back, its `light` characteristic
 * (e.g. `Fl.G.3s`), which is how the Open Waters `lights-label` layer
 * renders lights that carry no `name`. Returns null for an unnamed
 * point so the sight form leaves the object field for the user to type.
 *
 * @param {object|null|undefined} feature - a `queryRenderedFeatures` point hit
 * @returns {string|null}
 */
export function pointSymbolName(feature) {
  if (!feature) return null;
  const props = feature.properties ?? {};
  const name = typeof props.name === "string" ? props.name.trim() : "";
  if (name) return name;
  const light = typeof props.light === "string" ? props.light.trim() : "";
  return light || null;
}

/**
 * Picks the charted name to attribute a pick/bearing to, from the
 * features a MapLibre `queryRenderedFeatures` box returned. Only symbol
 * layers render names, so non-symbol layers are skipped.
 *
 * Bearings and vertical-sextant distances are taken to POINT objects —
 * a light, beacon, named peak, landmark, place point — never to an area
 * or line label (see `firstPointSymbolHit` for why geometry, not render
 * order, decides). Getting the name right is a convenience, so it is
 * only filled for objects we recognize — a point feature that carries a
 * charted `name` (a named peak, cape, landmark) or a `light`
 * characteristic. An unnamed point (a light with neither) stays null and
 * the sight form leaves the object field for the user to type — better
 * an honest blank than a guessed name.
 *
 * A light's charted identifier is its `light` characteristic (e.g.
 * `Fl.G.3s`), not its `name`: most lights carry an empty `name`, and the
 * Open Waters `lights-label` layer renders `light` (adding `name` only
 * at close zoom when present). So for point features `name` is tried
 * first and `light` falls back, matching what the chart actually shows.
 *
 * @param {Array<object>|null|undefined} hits - `map.queryRenderedFeatures` result
 * @returns {string|null} resolved name/characteristic, or null when no named point is hit
 */
export function pickSymbolNameFromHits(hits) {
  return pointSymbolName(firstPointSymbolHit(hits));
}

/**
 * Whether the cursor is over a bearing-able chart object — any point
 * symbol hit (light, beacon, buoy, named peak, cape, landmark, place
 * point), named or not. Drives the crosshair hover cursor: an unnamed
 * buoy is still something you can see and take a bearing to, so the
 * cursor signals it even though `pickSymbolNameFromHits` leaves the
 * sight form's object field blank for the user to type.
 *
 * @param {Array<object>|null|undefined} hits - `map.queryRenderedFeatures` result
 * @returns {boolean}
 */
export function isBearingablePointHit(hits) {
  return firstPointSymbolHit(hits) != null;
}

/**
 * Marine-tactical palette for the generated vector style: dark sea
 * background to match the app theme, land/depth families keyed by the
 * source-layer names chart producers actually use (S-57 ENC layer ids
 * from NOAA-converted MBTiles, generic OSM-ish names otherwise).
 * Geometry-only — this is the FALLBACK style for chart sources without
 * a mirrored upstream style (chartAssetsFromManifest): when the corridor
 * downloader serves the Open Waters style mirror, the map view mounts
 * that instead, with the full symbology, labels, and hillshade.
 *
 * @typedef {{kind: "land"|"water"|"waterway"|"wetland"|"seamark"|"coastline"|"contour"|"point"|"light", styles: object}} VectorLayerFamily
 */
const VECTOR_LAYER_FAMILIES = [
  // Land masses and built-up areas → solid dark-olive fills.
  {
    kind: "land",
    match: [/^land$/i, /^landcover$/i, /^landuse$/i, /^lndare$/i],
    styles: {
      fill: { "fill-color": "#2a3a2e", "fill-opacity": 0.9 },
      line: { "line-color": "#3d4f40", "line-width": 0.6 },
    },
  },
  // Depth / water areas → translucent deep-blue fills.
  {
    kind: "water",
    match: [/^water$/i, /^depare$/i, /^sea$/i, /^ocean$/i, /^sea_area$/i],
    styles: {
      fill: { "fill-color": "#102a3d", "fill-opacity": 0.55 },
      line: { "line-color": "#1c3c52", "line-width": 0.5 },
    },
  },
  // Rivers / channels / canals → water-toned fills and lines.
  {
    kind: "waterway",
    match: [/^waterway$/i, /^river$/i, /^canal$/i, /^stream$/i],
    styles: {
      fill: { "fill-color": "#14324a", "fill-opacity": 0.5 },
      line: { "line-color": "#2f6a80", "line-width": 1 },
    },
  },
  // Marsh / mangrove → muted green fills between land and water.
  {
    kind: "wetland",
    match: [/^wetland$/i, /^marsh/i, /^mangrove$/i],
    styles: {
      fill: { "fill-color": "#233830", "fill-opacity": 0.6 },
      line: { "line-color": "#35503f", "line-width": 0.6 },
    },
  },
  // Buoys, beacons, restricted areas, moorings → visible teal marks.
  {
    kind: "seamark",
    match: [/^seamark$/i, /^navigation/i],
    styles: {
      fill: { "fill-color": "#16394a", "fill-opacity": 0.45 },
      line: { "line-color": "#4b8b99", "line-width": 0.9 },
      circle: { "circle-color": "#9fd6d9", "circle-radius": 2 },
    },
  },
  // Coastlines → the crisp reference edge over the fills.
  {
    kind: "coastline",
    match: [/^coalne$/i, /^coastline$/i, /^shoreline$/i],
    styles: {
      line: { "line-color": "#7fa3b0", "line-width": 1.2 },
    },
  },
  // Depth contours / bathymetry → thin mid-blue lines.
  {
    kind: "contour",
    match: [/^depcnt$/i, /^contour/i, /^depth_contour$/i],
    styles: {
      line: { "line-color": "#2f5a70", "line-width": 0.8 },
    },
  },
  // Soundings / spot points → tiny dots.
  {
    kind: "point",
    match: [/^soundg$/i, /^sounding/i, /^soundings$/i],
    styles: {
      circle: { "circle-color": "#4b8b99", "circle-radius": 1.5 },
    },
  },
  // Lights (lighthouses, beacons) → amber dots that read instantly.
  {
    kind: "light",
    match: [/^lights?$/i],
    styles: {
      circle: { "circle-color": "#e0b458", "circle-radius": 2.5 },
      line: { "line-color": "#e0b458", "line-width": 0.6 },
    },
  },
];

/** Fallback family for source layers no pattern matches. */
const VECTOR_DEFAULT_FAMILY = {
  kind: "default",
  match: [],
  styles: {
    fill: { "fill-color": "#1c2830", "fill-opacity": 0.35 },
    line: { "line-color": "#6a7a86", "line-width": 0.8 },
    circle: { "circle-color": "#6a7a86", "circle-radius": 1.5 },
  },
};

/**
 * Classifies a vector source-layer id into its styling family.
 *
 * @param {string} layerId
 * @returns {VectorLayerFamily}
 */
function vectorLayerFamily(layerId) {
  for (const family of VECTOR_LAYER_FAMILIES) {
    if (family.match.some((re) => re.test(layerId))) return family;
  }
  return VECTOR_DEFAULT_FAMILY;
}

/**
 * Builds a complete MapLibre style for a vector chart layer, entirely
 * client-side: one vector source on the chart's `tilemapUrl` (made
 * absolute — MapLibre's tile workers can't resolve relative URLs), a dark
 * sea background, and a
 * fill/line/circle trio per source layer — a line layer only draws line
 * features, fills only polygons, circles only points, so the trio covers
 * any geometry without knowing the schema. The source's `maxzoom` is the
 * *native* tile max, so MapLibre keeps overzooming vector data past it
 * (the raster path's maxNativeZoom behaviour, but sharper). No symbol
 * layers: without a glyphs endpoint they can't render, and hosting one
 * is the corridor-downloader side of the blueprint, not ours.
 *
 * @param {{identifier: string, name: string, url: string, minZoom: number, maxZoom: number, format?: string, chartLayers?: string[]}} chart
 * @returns {{version: number, name: string, sources: object, layers: Array<object>}} MapLibre style spec object
 */
export function maplibreStyleFor(chart) {
  const sourceId = `${chart.identifier.replace(/[^\w.-]/g, "_")}`;
  // Without the resource's vector_layers metadata, guess the conventional
  // single-layer name (the chart identifier) — best-effort, documented.
  // Duplicated ids in the metadata table would yield duplicate MapLibre
  // layer ids (undefined rendering), so they're deduped first.
  const sourceLayers = [
    ...new Set(
      chart.chartLayers && chart.chartLayers.length > 0
        ? chart.chartLayers
        : [chart.identifier],
    ),
  ];

  const families = sourceLayers.map((id) => ({
    id,
    family: vectorLayerFamily(id),
  }));

  const layers = [
    {
      id: "background",
      type: "background",
      paint: { "background-color": "#0b1b26" },
    },
  ];
  // Paint order matters: area fills under lines under points; land
  // before water so islands don't drown (both translucent otherwise);
  // seamark areas above the natural families so marks stay legible.
  const byKind = (kind) => families.filter((f) => f.family.kind === kind);
  for (const kind of [
    "land",
    "water",
    "waterway",
    "wetland",
    "seamark",
    "default",
    "coastline",
    "contour",
  ]) {
    for (const { id, family } of byKind(kind)) {
      if (!family.styles.fill) continue;
      layers.push({
        id: `${sourceId}-${id}-fill`,
        type: "fill",
        source: sourceId,
        "source-layer": id,
        paint: family.styles.fill,
      });
    }
  }
  for (const { id, family } of families) {
    if (!family.styles.line) continue;
    layers.push({
      id: `${sourceId}-${id}-line`,
      type: "line",
      source: sourceId,
      "source-layer": id,
      paint: family.styles.line,
    });
  }
  for (const { id, family } of families) {
    if (!family.styles.circle) continue;
    layers.push({
      id: `${sourceId}-${id}-circle`,
      type: "circle",
      source: sourceId,
      "source-layer": id,
      paint: family.styles.circle,
    });
  }

  return {
    version: 8,
    name: chart.name,
    sources: {
      [sourceId]: {
        type: "vector",
        tiles: [absoluteTileUrl(chart.url)],
        minzoom: chart.minZoom,
        maxzoom: chart.maxZoom,
      },
    },
    layers,
  };
}

/**
 * Basemap when the server has no charts configured (e.g.
 * `/signalk/v1/api/resources/charts` 404s). Used as the *default*
 * selection in that case — the map defaults to the first chart
 * provider and never opens blank — and the watchkeeper can switch it
 * off in the layers control when offline (tiles simply fail dark).
 * Mirrors signalk-logbook's DEFAULT_LAYER.
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

// ---------------------------------------------------------------------------
// AIS targets on the chart (work doc #23)
// Pure delta→store reducer, staleness/range shaping, and marker specs so
// the map adapter stays thin and everything here is unit-testable.
// Targets keep Signal K SI units (rad, m/s) as received; conversions
// happen at spec time. Coordinate convention: [lat, lon] like the rest
// of the module.
// ---------------------------------------------------------------------------

/**
 * Position report older than this starts the target EXPIRING: the mark
 * greys out, the velocity leader drops, the tooltip says how old the
 * report is — the plotter-standard warning that the data is decaying
 * (Freeboard-SK's 3-minute `ais_inactive` convention; one missed Class A
 * report at anchor).
 */
export const AIS_EXPIRING_MS = 3 * 60_000;

/**
 * Position report older than this drops the target from the map AND
 * evicts it from the store ("aged out", work doc #23): a target silent
 * for 20 minutes — several Class B report intervals — is no longer
 * navigational data, only a guess, and a long-running chart in busy
 * waters would otherwise keep every context it ever heard forever.
 */
export const AIS_DROP_MS = 20 * 60_000;

/**
 * Default range filter around own position (nm): markers beyond it are
 * clutter, not situational awareness, and the bearing you'd take to a
 * hull-down target 40 nm away isn't one you can hold against your compass.
 */
export const AIS_RANGE_NM = 24;

/** Velocity-leader length (minutes) — the plotter-standard 6-minute run. */
export const AIS_LEADER_MIN = 6;

/** Extrapolation horizon: predictions freeze at the expiring threshold. */
export const AIS_PREDICT_HORIZON_MS = AIS_EXPIRING_MS;

/**
 * Great-circle distance between two [lat, lon] points, in nautical miles
 * (haversine; the ranges here are tens of nm so a spherical earth is far
 * beyond the precision of an AIS report).
 *
 * @param {[number, number]} from
 * @param {[number, number]} to
 * @returns {number}
 */
export function distanceNm(from, to) {
  const φ1 = from[0] * RAD;
  const φ2 = to[0] * RAD;
  const dφ = φ2 - φ1;
  const dλ = (to[1] - from[1]) * RAD;
  const a =
    Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Folds one `vessels.*` delta into the target store (work doc #23).
 * The store is a Map keyed by context, mutated in place (the TrackLog
 * pattern — the caller owns the Map, the reducer owns its shape).
 * Only position reports refresh `tMs`; name/mmsi/buddy ride along on
 * any update. Values keep their SI wire units.
 *
 * @param {Map<string, object>} store
 * @param {object} delta - Signal K delta with `context` + `updates`
 * @param {number} [nowMs=Date.now()] receipt time
 * @returns {Map<string, object>} the same store (deltas without a
 *   usable context or updates are ignored)
 */
export function applyAisDelta(store, delta, nowMs = Date.now()) {
  const ctx = delta?.context;
  if (typeof ctx !== "string" || ctx.length === 0) return store;
  const updates = delta?.updates;
  if (!Array.isArray(updates)) return store;
  let t = store.get(ctx);
  const touch = () => {
    if (!t) {
      t = {
        context: ctx,
        name: null,
        mmsi: null,
        buddy: false,
        lat: null,
        lon: null,
        tMs: null,
        cogRad: null,
        sogMs: null,
        headingRad: null,
        receivedMs: nowMs,
      };
      store.set(ctx, t);
    }
    t.receivedMs = nowMs;
    return t;
  };
  for (const update of updates) {
    if (!Array.isArray(update?.values)) continue;
    const updateMs = Number.isFinite(Date.parse(update.timestamp ?? ""))
      ? Date.parse(update.timestamp)
      : nowMs;
    for (const v of update.values) {
      const value = v?.value;
      switch (v?.path) {
        case "navigation.position":
          if (value?.latitude != null && value?.longitude != null) {
            const target = touch();
            target.lat = value.latitude;
            target.lon = value.longitude;
            target.tMs = updateMs;
          }
          break;
        case "navigation.courseOverGroundTrue":
          if (Number.isFinite(value)) touch().cogRad = value;
          break;
        case "navigation.speedOverGround":
          if (Number.isFinite(value)) touch().sogMs = value;
          break;
        case "navigation.headingTrue":
          if (Number.isFinite(value)) touch().headingRad = value;
          break;
        case "name":
          if (typeof value === "string" && value) touch().name = value;
          break;
        case "mmsi":
          if (value != null && `${value}` !== "") {
            touch().mmsi = typeof value === "string" ? value : `${value}`;
          }
          break;
        case "": {
          // Root value: AIS providers commonly identify the target here
          // (Freeboard's buddy flag arrives the same way).
          if (value && typeof value === "object") {
            const target = touch();
            if (typeof value.name === "string" && value.name) {
              target.name = value.name;
            }
            if (value.mmsi != null && `${value.mmsi}` !== "") {
              target.mmsi =
                typeof value.mmsi === "string" ? value.mmsi : `${value.mmsi}`;
            }
            if (typeof value.buddy === "boolean") target.buddy = value.buddy;
          }
          break;
        }
        default:
          break;
      }
    }
  }
  return store;
}

/**
 * Seeds the target store from a REST `GET /signalk/v1/api/vessels`
 * snapshot (work doc #23): static data (name/mmsi) arrives here once,
 * live positions keep arriving as deltas. Entries without a position are
 * still seeded — the name/mmsi are what make later position deltas
 * render with a label. `self` (and the real self context, and the DR
 * shadow vessel's context, when known) are excluded: the webapp already
 * draws own vessel and the DR marker.
 *
 * @param {Map<string, object>} store
 * @param {object|null|undefined} snapshot - parsed REST response
 * @param {{selfContext?: string|null, shadowContext?: string|null, nowMs?: number}} [opts]
 * @returns {Map<string, object>} the same store
 */
export function seedAisFromSnapshot(store, snapshot, opts = {}) {
  const vessels = snapshot?.vessels ?? snapshot;
  if (!vessels || typeof vessels !== "object") return store;
  const skip = new Set(["self", opts.selfContext, opts.shadowContext]);
  for (const ctx of Object.keys(vessels)) {
    if (skip.has(ctx) || !ctx.startsWith("vessels.")) continue;
    const v = vessels[ctx];
    if (!v || typeof v !== "object") continue;
    // REST leaves are {value, timestamp} objects in full snapshots;
    // accept plain values too (partial APIs, tests).
    const leaf = (node, key) => node?.[key]?.value ?? node?.[key];
    const position = leaf(v.navigation, "position");
    const ts = v.navigation?.position?.timestamp;
    const tMs = Number.isFinite(Date.parse(ts ?? "")) ? Date.parse(ts) : null;
    const store2 = applyAisDelta(
      store,
      {
        context: ctx,
        updates: [
          {
            timestamp: null, // parsed ts below wins; null → receipt time
            values: [
              ...(position?.latitude != null
                ? [
                    {
                      path: "navigation.position",
                      value: {
                        latitude: position.latitude,
                        longitude: position.longitude,
                      },
                    },
                  ]
                : []),
              { path: "name", value: leaf(v, "name") ?? null },
              { path: "mmsi", value: leaf(v, "mmsi") ?? null },
              ...(leaf(v, "buddy") === true
                ? [{ path: "", value: { buddy: true } }]
                : []),
              {
                path: "navigation.courseOverGroundTrue",
                value: leaf(v.navigation, "courseOverGroundTrue") ?? null,
              },
              {
                path: "navigation.speedOverGround",
                value: leaf(v.navigation, "speedOverGround") ?? null,
              },
              {
                path: "navigation.headingTrue",
                value: leaf(v.navigation, "headingTrue") ?? null,
              },
            ],
          },
        ],
      },
      tMs ?? opts.nowMs ?? Date.now(),
    );
    // applyAisDelta stamps receipt time when timestamp is null; carry
    // the report timestamp for position so staleness reflects the AIS
    // report age, not the snapshot fetch.
    const t = store2.get(ctx);
    if (t && tMs != null && position?.latitude != null) t.tMs = tMs;
  }
  return store;
}

/**
 * Age of the last position report, in ms.
 *
 * @param {object} target - store entry
 * @param {number} nowMs
 * @returns {number|null}
 */
export function aisTargetAgeMs(target, nowMs) {
  const base = target?.tMs ?? target?.receivedMs;
  return base == null ? null : Math.max(0, nowMs - base);
}

/**
 * Staleness classification (plotter tri-state, work doc #23):
 * "active" while the position report is fresh, "expiring" past
 * `expiringMs` (greyed, leader dropped — the data is decaying),
 * "dropped" past `dropMs` (removed from the map and the store).
 *
 * @param {object} target - store entry
 * @param {number} nowMs
 * @param {{expiringMs?: number, dropMs?: number}} [opts]
 * @returns {active|expiring|dropped}
 */
export function aisStaleness(target, nowMs, opts = {}) {
  const expiringMs = opts.expiringMs ?? AIS_EXPIRING_MS;
  const dropMs = opts.dropMs ?? AIS_DROP_MS;
  const age = aisTargetAgeMs(target, nowMs);
  if (age == null) return "dropped";
  if (age >= dropMs) return "dropped";
  if (age >= expiringMs) return "expiring";
  return "active";
}

/**
 * Predicts a target's position at `nowMs` by dead reckoning its last
 * report forward along COG/SOG — the honest default when a pick seeds a
 * bearing (AIS reports lag reality, up to 3 min for Class B). The
 * extrapolation horizon caps at `maxHorizonMs` (default: the stale
 * threshold): past it the mark freezes rather than speculating further,
 * and the stale styling says so. Returns the report position when there
 * is nothing to extrapolate from (no COG/SOG, or zero speed).
 *
 * @param {object} target - store entry
 * @param {number} nowMs
 * @param {{maxHorizonMs?: number}} [opts]
 * @returns {[number, number]|null} predicted [lat, lon], null when the
 *   target has never reported a position
 */
export function predictAisPosition(target, nowMs, opts = {}) {
  if (target?.lat == null || target?.lon == null) return null;
  const horizon = opts.maxHorizonMs ?? AIS_PREDICT_HORIZON_MS;
  const dt = Math.min(
    Math.max(0, nowMs - (target.tMs ?? target.receivedMs ?? nowMs)),
    horizon,
  );
  const sogKn = target.sogMs != null ? msToKn(target.sogMs) : null;
  if (target.cogRad == null || !sogKn || dt <= 0) {
    return [target.lat, target.lon];
  }
  const distNm = sogKn * (dt / 3_600_000);
  return destinationPoint(
    [target.lat, target.lon],
    radToDeg(target.cogRad),
    distNm,
  );
}

/**
 * Full render spec for one target (work doc #23): the marker position is
 * the *predicted* position (the mark rides its dead-reckoned track
 * between reports — the DR plugin's home turf), so a right-click pick
 * seeds the bearing from where the target actually is at pick time. The
 * velocity leader projects `AIS_LEADER_MIN` ahead from that position.
 * Expiring targets keep their predicted position but grey out and lose
 * the leader — the plotter's "data decaying" state before age-out.
 *
 * @param {object} target - store entry
 * @param {number} nowMs
 * @param {[number, number]|null} [own] - own DR/GPS position for the
 *   range figure (null → no range in tooltip)
 * @returns {{context: string, label: string, position: [number, number],
 *   rotationDeg: number|null, color: string, expiring: boolean, buddy: boolean,
 *   sogKn: number|null, cogDeg: number|null, rangeNm: number|null, ageMin: number|null,
 *   leader: {from: [number, number], to: [number, number]}|null,
 *   tooltip: string}|null} null when the target has no position yet
 */
export function aisMarkerSpec(target, nowMs, own) {
  const position = predictAisPosition(target, nowMs);
  if (!position) return null;
  const expiring = aisStaleness(target, nowMs) !== "active";
  const age = aisTargetAgeMs(target, nowMs);
  const sogKn = target.sogMs != null ? msToKn(target.sogMs) : null;
  const cogDeg = target.cogRad != null ? radToDeg(target.cogRad) : null;
  // Glyph orientation: true heading when broadcast (Class A), else COG.
  const rotationDeg =
    target.headingRad != null
      ? radToDeg(target.headingRad)
      : target.cogRad != null
        ? radToDeg(target.cogRad)
        : null;
  const label =
    target.name ??
    (target.mmsi
      ? `MMSI ${target.mmsi}`
      : target.context.replace("vessels.", ""));
  const rangeNm = own ? distanceNm(own, position) : null;
  const leader =
    !expiring && cogDeg != null && sogKn && sogKn > 0
      ? {
          from: position,
          to: destinationPoint(position, cogDeg, sogKn * (AIS_LEADER_MIN / 60)),
        }
      : null;
  const parts = [label];
  if (rangeNm != null) parts.push(`${rangeNm.toFixed(1)} nm`);
  if (sogKn != null && cogDeg != null) {
    parts.push(
      `${sogKn.toFixed(1)} kn / ${String(Math.round(cogDeg)).padStart(3, "0")}°`,
    );
  }
  if (expiring && age != null) {
    parts.push(`expiring · last report ${Math.round(age / 60_000)}m ago`);
  }
  return {
    context: target.context,
    label,
    position,
    rotationDeg,
    color: expiring
      ? STYLE.aisExpiring
      : target.buddy
        ? STYLE.aisBuddy
        : STYLE.ais,
    expiring,
    buddy: Boolean(target.buddy),
    sogKn,
    cogDeg,
    rangeNm,
    ageMin: age != null ? age / 60_000 : null,
    leader,
    tooltip: parts.join(" · "),
  };
}

/**
 * Evicts aged-out targets from the store entirely (work doc #23): past
 * `dropMs` without a report a target is useless for navigating, so it
 * leaves the map and frees its slot — otherwise every context ever
 * heard lingers in memory for the life of the page (busy waters =
 * hundreds of entries). Callers run this on their regular render tick;
 * a target that starts reporting again simply re-seeds on its next
 * delta (the store is a cache, not a log).
 *
 * @param {Map<string, object>} store
 * @param {number} nowMs
 * @param {{dropMs?: number}} [opts]
 * @returns {Map<string, object>} the same store, pruned
 */
export function pruneAisStore(store, nowMs, opts = {}) {
  const dropMs = opts.dropMs ?? AIS_DROP_MS;
  for (const [ctx, target] of store) {
    const age = aisTargetAgeMs(target, nowMs);
    if (age == null || age >= dropMs) store.delete(ctx);
  }
  return store;
}

/**
 * Builds the map's AIS render set from the target store: dropped targets
 * removed, range-filtered around `own` when known (without own there is
 * no basis to filter — render everything), nearest first so closer
 * markers win click/hit-testing ties.
 *
 * @param {Map<string, object>} store
 * @param {number} nowMs
 * @param {[number, number]|null} [own]
 * @param {{rangeNm?: number}} [opts]
 * @returns {Array<object>} aisMarkerSpec results
 */
export function aisTargetsForRender(store, nowMs, own, opts = {}) {
  const rangeNm = opts.rangeNm ?? AIS_RANGE_NM;
  const specs = [];
  for (const target of store.values()) {
    if (target.lat == null) continue;
    if (aisStaleness(target, nowMs) === "dropped") continue;
    const spec = aisMarkerSpec(target, nowMs, own);
    if (!spec) continue;
    if (own && spec.rangeNm != null && spec.rangeNm > rangeNm) continue;
    specs.push(spec);
  }
  if (own) specs.sort((a, b) => (a.rangeNm ?? 0) - (b.rangeNm ?? 0));
  return specs;
}
