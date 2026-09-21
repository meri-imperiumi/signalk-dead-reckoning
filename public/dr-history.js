/**
 * Signal K History API client helpers (`/signalk/v2/api/history`,
 * served e.g. by @meri-imperiumi/signalk-history-sqlite).
 *
 * Contract (OpenAPI, no auth): `GET /values?duration=&resolution=&paths=`
 * takes a comma-separated list of paths, each optionally with an
 * aggregation postfix (`path:method[:param]`). The response mirrors the
 * request order in `values[]` and delivers one `data[]` row per time
 * bucket: `[isoTimestamp, col0, col1, …]` with `null` for missing
 * cells. Positions come back as GeoJSON `[lon, lat]` pairs.
 *
 * Aggregation rules: numbers accept `average`/`min`/`max`/`first`/`last`/
 * `sma`/`ema`; **non-numeric values (strings, objects like the DR
 * divergence record) only accept `first` or `last`** — always suffix
 * those paths explicitly.
 *
 * Pure URL/parse helpers (unit-tested) + a thin `fetch` wrapper the
 * app uses for restart survival: history backfill of the GPS track,
 * the DR ghost track, and the divergence sparkline.
 *
 * @file dr-history.js
 */

/**
 * Builds the history-values URL for a multi-path query.
 *
 * @param {object} q
 * @param {string[]} q.paths - path specs, e.g. `["navigation.position",
 *   "navigation.deadReckoning.divergence:last"]`
 * @param {number} q.durationSec - length of the range up to now
 * @param {number} [q.resolutionSec] - bucket size; provider default
 *   when omitted
 * @returns {string} URL relative to the server origin
 */
export function historyValuesUrl(q) {
  const params = new URLSearchParams({
    duration: String(Math.max(1, Math.floor(q.durationSec))),
    paths: q.paths.join(","),
  });
  if (q.resolutionSec != null) {
    params.set("resolution", String(Math.max(1, Math.floor(q.resolutionSec))));
  }
  return `/signalk/v2/api/history/values?${params.toString()}`;
}

/**
 * Parses a `/values` response into per-path series, preserving the
 * request order. Cells that are `null` (path had no data in that
 * bucket) are skipped for that path's series.
 *
 * @param {unknown} response - parsed JSON body
 * @returns {{path: string, method: string, points: {t: string, v: unknown}[]}[]}
 */
export function parseHistoryValues(response) {
  const values = response?.values;
  const data = response?.data;
  if (!Array.isArray(values) || !Array.isArray(data)) return [];
  return values.map((spec, col) => {
    const points = [];
    for (const row of data) {
      if (!Array.isArray(row) || row.length < 2) continue;
      const v = row[col + 1];
      if (v === null || v === undefined) continue;
      points.push({ t: String(row[0]), v });
    }
    return { path: spec?.path ?? "", method: spec?.method ?? "", points };
  });
}

/**
 * The webapp's chart history window: max(7 days, since trip start)
 * — whichever is longer, so a trip older than a week still shows in
 * full (the whole passage is the watchkeeper's working set), while
 * routine use keeps the chart to the last week.
 *
 * Pure — unit-tested without a clock: pass the wall clock in.
 *
 * @param {number} nowMs - wall clock (ms)
 * @param {number|null} tripStartMs - trip boundary from GET /status
 *   (null when no boundary has been observed)
 * @returns {{sinceMs: number, durationSec: number}} the window start
 *   and its length up to now, for the History API and REST overlays
 */
export function chartWindow(nowMs, tripStartMs) {
  const sinceMs =
    tripStartMs != null && tripStartMs < nowMs
      ? Math.min(tripStartMs, nowMs - 7 * 24 * 3600 * 1000)
      : nowMs - 7 * 24 * 3600 * 1000;
  return { sinceMs, durationSec: Math.max(1, (nowMs - sinceMs) / 1000) };
}

/**
 * Converts a position series into Leaflet-style `[lat, lon]` track
 * points, deduping near-identical fixes (a moored vessel holds one).
 *
 * Position cells arrive in BOTH shapes the history provider emits:
 * GeoJSON `[lon, lat]` pairs (raw `navigation.position`) and
 * `{latitude, longitude}` objects (values this plugin publishes, e.g.
 * `navigation.deadReckoning.position` — verified against the live
 * API; the object form was previously dropped silently, so the DR
 * track backfill never rendered).
 *
 * @param {{t: string, v: unknown}[]} points - position series cells
 * @returns {Array<[number, number]>}
 */
export function seriesToTrack(points) {
  const pts = [];
  let prevLat = null;
  let prevLon = null;
  for (const { v } of points) {
    let lon;
    let lat;
    if (Array.isArray(v) && v.length >= 2) {
      lon = v[0];
      lat = v[1];
    } else if (v && typeof v === "object") {
      lat = v.latitude;
      lon = v.longitude;
    } else {
      continue;
    }
    if (lat == null || lon == null || Number.isNaN(lat) || Number.isNaN(lon))
      continue;
    if (
      prevLat !== null &&
      Math.abs(lat - prevLat) < 0.001 &&
      Math.abs(lon - prevLon) < 0.001
    )
      continue;
    pts.push([lat, lon]);
    prevLat = lat;
    prevLon = lon;
  }
  return pts;
}

/**
 * Merges a history track with the live-session track so the polyline
 * is continuous (history → live continuation): live points that differ
 * from the last history point are appended.
 *
 * @param {Array<[number, number]>} history
 * @param {Array<[number, number]>} live
 * @returns {Array<[number, number]>}
 */
export function mergeHistoryTrack(history, live) {
  if (!history || history.length === 0) return live;
  const last = history[history.length - 1];
  const extending = live.filter(
    (p) => Math.abs(p[0] - last[0]) > 0.001 || Math.abs(p[1] - last[1]) > 0.001,
  );
  return [...history, ...extending];
}

/**
 * Fetches multiple paths from the history API in one request.
 * No authentication is required by the history API.
 *
 * @param {object} q - as for {@link historyValuesUrl}
 * @returns {Promise<{path: string, method: string, points: {t: string, v: unknown}[]}[]|null>}
 *   null when the request fails (no provider configured, offline, …)
 */
export async function fetchHistory(q) {
  try {
    const res = await fetch(historyValuesUrl(q));
    if (!res.ok) return null;
    return parseHistoryValues(await res.json());
  } catch {
    return null;
  }
}
