/**
 * Current-vector subsystem (SPEC §6.2 "Current Hierarchy of Truth").
 *
 * The DR engine needs a set-and-drift vector to integrate on top of the
 * water track. The hierarchy, highest truth first:
 *
 *  1. **Manual override** — watchstander input with a valid TTL
 *     (`environment.current`). Not yet wired to an input path; the
 *     resolver accepts it so the precedence is explicit and testable.
 *  2. Live high-res NetCDF (Starlink-cached coastal) — future.
 *  3. **Signal K Weather API** (`/signalk/v2/api/weather/forecasts/point`)
 *     — a provider (e.g. a GRIB another process already downloaded)
 *     serves point forecasts carrying `current: {set (rad), drift (m/s)}`.
 *     The client polls it at the vessel position on a slow interval and
 *     caches the time-interpolated vector; the 1 Hz tick never touches
 *     the network.
 *  4. Offline pilot charts (`offline_pilot_currents`) — table exists in
 *     the schema; the lookup hook is reserved.
 *  5. **Zero vector** — pure inertial water track.
 *
 * All network I/O lives in `WeatherCurrentClient`; `resolveCurrent` and
 * `parseWeatherCurrent` are pure and unit-testable.
 *
 * @file current.js
 */

/** m/s → knots. */
const MS_TO_KN = 3600 / 1852;
/** rad → deg. */
const RAD_TO_DEG = 180 / Math.PI;

/**
 * Normalizes an angle to [0, 360).
 * @param {number} deg
 * @returns {number}
 */
function normalizeDeg360(deg) {
  return ((deg % 360) + 360) % 360;
}

/**
 * Parses a Weather API forecast series into the current vector valid at
 * `nowMs`. Entries carrying `current.set` (rad, direction the current
 * flows *toward*) and `current.drift` (m/s) are interpolated as u/v
 * components between the entries bracketing `nowMs`; outside the series
 * the nearest endpoint is used (the client's TTL bounds staleness).
 *
 * @param {Array<{date: string, current?: {set?: number, drift?: number}}>} points
 * @param {number} nowMs - epoch ms
 * @returns {{setTrue: number, drift: number, fromMs: number, toMs: number}|null}
 *   null when no entry carries usable current data
 */
function parseWeatherCurrent(points, nowMs) {
  if (!Array.isArray(points)) return null;
  const entries = [];
  for (const p of points) {
    const t = Date.parse(p?.date ?? "");
    const set = p?.current?.set;
    const drift = p?.current?.drift;
    if (!Number.isFinite(t)) continue;
    if (!Number.isFinite(set) || !Number.isFinite(drift)) continue;
    entries.push({ t, set, drift });
  }
  if (entries.length === 0) return null;
  entries.sort((a, b) => a.t - b.t);

  // u/v components: set is the direction the current flows toward.
  const uv = (e) => ({
    u: e.drift * Math.sin(e.set),
    v: e.drift * Math.cos(e.set),
  });

  // Bracket nowMs.
  let a = entries[0];
  let b = entries[entries.length - 1];
  let f = 1;
  for (let i = 0; i < entries.length - 1; i++) {
    if (entries[i].t <= nowMs && nowMs <= entries[i + 1].t) {
      a = entries[i];
      b = entries[i + 1];
      f = a.t === b.t ? 1 : (nowMs - a.t) / (b.t - a.t);
      break;
    }
  }
  if (nowMs < entries[0].t) f = 0;
  if (nowMs > entries[entries.length - 1].t) f = 1;

  const va = uv(a);
  const vb = uv(b);
  const u = va.u + (vb.u - va.u) * f;
  const v = va.v + (vb.v - va.v) * f;
  const driftKn = Math.hypot(u, v) * MS_TO_KN;
  const setTrue =
    driftKn === 0 ? 0 : normalizeDeg360(Math.atan2(u, v) * RAD_TO_DEG);
  return { setTrue, drift: driftKn, fromMs: a.t, toMs: b.t };
}

/**
 * Resolves the best available current vector (SPEC §6.2). Pure: every
 * tier is passed in, the highest tier with valid data wins.
 *
 * @param {object} [input]
 * @param {{setTrue: number, drift: number, validUntilMs: number}|null} [input.manual]
 *   tier 1: watchstander override, honored while its TTL lasts
 * @param {{setTrue: number, drift: number, validUntilMs: number}|null} [input.weather]
 *   tier 3: Weather API cache entry from `WeatherCurrentClient.currentAt`
 * @param {((ctx: object) => ({setTrue: number, drift: number}|null))|null} [input.pilotLookup]
 *   tier 4: (month,lat,lon)→vector lookup into `offline_pilot_currents`
 * @param {object} [input.pilotCtx] - context for the pilot lookup
 * @param {number} [input.nowMs] - epoch ms; defaults to Date.now()
 * @returns {{setTrue: number, drift: number, tier: 1|3|4|5, source: string}}
 *   drift in knots, setTrue in deg true (direction the current flows toward)
 */
function resolveCurrent(input = {}) {
  const nowMs = input.nowMs ?? Date.now();
  const valid = (v) =>
    v != null && v.validUntilMs > nowMs && Number.isFinite(v.drift);

  // Tier 1: manual override.
  if (valid(input.manual)) {
    return {
      setTrue: normalizeDeg360(input.manual.setTrue ?? 0),
      drift: input.manual.drift,
      tier: 1,
      source: "manual",
    };
  }
  // Tier 3: Weather API (sparse forecast GRIB via a weather provider).
  if (valid(input.weather)) {
    return {
      setTrue: input.weather.setTrue,
      drift: input.weather.drift,
      tier: 3,
      source: "weather-api",
    };
  }
  // Tier 4: offline pilot charts.
  if (input.pilotLookup) {
    const p = input.pilotLookup(input.pilotCtx ?? {});
    if (p && Number.isFinite(p.drift)) {
      return {
        setTrue: normalizeDeg360(p.setTrue ?? 0),
        drift: p.drift,
        tier: 4,
        source: "pilot-chart",
      };
    }
  }
  // Tier 5: zero vector — pure inertial water track.
  return { setTrue: 0, drift: 0, tier: 5, source: "none" };
}

/**
 * Polls the Signal K Weather API for the point-forecast current at the
 * vessel position and caches the interpolated vector. Off the 1 Hz hot
 * path by design (SPEC §6): fetches run on a slow interval (default
 * 30 min) with a hard timeout, failures keep the previous cache until
 * its TTL lapses, and `currentAt` is a synchronous cache read.
 *
 * The response is a WeatherDataModel array; `current.set` is radians
 * and `current.drift` m/s (converted here to deg/kn).
 */
class WeatherCurrentClient {
  /**
   * @param {object} [opts]
   * @param {string} [opts.baseUrl] - server base URL (no trailing slash)
   * @param {number} [opts.intervalMs=1800000] - poll interval
   * @param {number} [opts.count=6] - forecast entries to request
   * @param {number} [opts.timeoutMs=10000] - per-fetch abort timeout
   * @param {number} [opts.validityFactor=4] - cache TTL = interval × this
   * @param {() => ({latitude: number, longitude: number}|null)} [opts.getPosition]
   * @param {(message: string) => void} [opts.onStatus]
   * @param {typeof fetch} [opts.fetchFn=globalThis.fetch]
   * @param {() => number} [opts.now=Date.now]
   */
  constructor(opts = {}) {
    this.baseUrl = (opts.baseUrl ?? "http://localhost:3000").replace(
      /\/+$/,
      "",
    );
    this.intervalMs = opts.intervalMs ?? 30 * 60 * 1000;
    this.count = opts.count ?? 6;
    this.timeoutMs = opts.timeoutMs ?? 10000;
    this.validityFactor = opts.validityFactor ?? 4;
    this.getPosition = opts.getPosition ?? (() => null);
    this.onStatus = opts.onStatus ?? null;
    this.fetchFn = opts.fetchFn ?? globalThis.fetch?.bind(globalThis);
    this.now = opts.now ?? (() => Date.now());
    /** @type {{setTrue: number, drift: number, fetchedAt: number, validUntilMs: number}|null} */
    this.cache = null;
    this.timer = null;
    this.fetching = false;
  }

  /**
   * Starts polling. The first fetch fires immediately (async, failures
   * surface via onStatus, never throw).
   * @returns {void}
   */
  start() {
    this.stop();
    this.poll(); // immediate first attempt
    this.timer = setInterval(() => this.poll(), this.intervalMs);
  }

  /** @returns {void} */
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * The cached current vector, or null when no fetch has succeeded
   * within the TTL.
   * @param {number} [nowMs] - defaults to now
   * @returns {{setTrue: number, drift: number, fetchedAt: number, validUntilMs: number}|null}
   */
  currentAt(nowMs = this.now()) {
    if (!this.cache || this.cache.validUntilMs <= nowMs) return null;
    return this.cache;
  }

  /**
   * One poll cycle. Never throws: a failed fetch keeps the previous
   * cache (it may still be valid until its TTL).
   * @returns {Promise<void>}
   */
  async poll() {
    if (this.fetching || !this.fetchFn) return;
    const pos = this.getPosition();
    if (!pos) return; // no position yet — retry on the next interval
    this.fetching = true;
    try {
      const url = new URL(
        `${this.baseUrl}/signalk/v2/api/weather/forecasts/point`,
      );
      url.searchParams.set("lat", String(pos.latitude));
      url.searchParams.set("lon", String(pos.longitude));
      url.searchParams.set("count", String(this.count));

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchFn(url.toString(), {
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(`weather API returned ${res.status}`);
        }
        const data = await res.json();
        if (!Array.isArray(data)) {
          throw new Error("weather API response is not an array");
        }
        const parsed = parseWeatherCurrent(data, this.now());
        if (!parsed) {
          throw new Error("forecast carries no current data");
        }
        const now = this.now();
        this.cache = {
          setTrue: parsed.setTrue,
          drift: parsed.drift,
          fetchedAt: now,
          validUntilMs: now + this.intervalMs * this.validityFactor,
        };
        this.onStatus?.(
          `Weather current: set ${parsed.setTrue.toFixed(0)}° true, drift ${parsed.drift.toFixed(2)} kn`,
        );
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      // Keep any previous cache; the TTL decides when it stops being
      // trusted. Surface the failure once per poll cycle.
      this.onStatus?.(
        `Weather current fetch failed: ${err?.message ?? err} — using ${
          this.cache ? "cached" : "zero"
        } current`,
      );
    } finally {
      this.fetching = false;
    }
  }
}

module.exports = {
  MS_TO_KN,
  RAD_TO_DEG,
  normalizeDeg360,
  parseWeatherCurrent,
  resolveCurrent,
  WeatherCurrentClient,
};
