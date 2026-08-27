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
 * Converts a position series into Leaflet-style `[lat, lon]` track
 * points, deduping near-identical fixes (a moored vessel holds one).
 *
 * @param {{t: string, v: unknown}[]} points - position series cells
 *   (GeoJSON `[lon, lat]` pairs)
 * @returns {Array<[number, number]>}
 */
export function seriesToTrack(points) {
  const pts = [];
  let prevLat = null;
  let prevLon = null;
  for (const { v } of points) {
    if (!Array.isArray(v) || v.length < 2) continue;
    const lon = v[0];
    const lat = v[1];
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
