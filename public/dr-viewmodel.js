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

/** Rendering style constants (SPEC §14.1: LOPs #ffcc00 on #003399). */
export const STYLE = {
  lop: "#ffcc00",
  lopUsed: "#8a7a1a",
  cpl: "#4dd0e1",
  cplUsed: "#256b73",
  ghostTrack: "#b39ddb",
  gpsTrack: "#64b5f6",
  drMarker: "#e1bee7",
  snapVector: "#f5f5f5",
  fix: {
    gps: "#4caf50",
    celestial: "#ffb74d",
    bearing: "#ba68c8",
    manual: "#90a4ae",
  },
  uncertainty: "#b39ddb",
};

const RAD = Math.PI / 180;
const EARTH_RADIUS_NM = 3440.065;

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
    used: lop.used_in_fix_id != null,
  };
}

/**
 * Extends a line spec to two far endpoints ±lengthNm along the
 * perpendicular, for drawing as a polyline (renderer clips to view).
 *
 * @param {{anchor: [number, number], azimuthDeg: number}} spec
 * @param {number} [lengthNm=60]
 * @returns {[[number, number], [number, number]]}
 */
export function extendLineSpec(spec, lengthNm = 60) {
  const perp = (spec.azimuthDeg + 90) % 360;
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
