/**
 * Polar-derived speed through water (SPEC §3.1 `inertial-polar`).
 *
 * When the paddlewheel is missing or fouled, `signalk-polar-
 * performance-plugin` still publishes `performance.polarSpeed` — the
 * polar-table target boat speed for the current TWS/TWA (m/s). That
 * delta is a step-function lookup driven by the instantaneous wind,
 * so it flaps gust-by-gust and jumps between table bins: far too
 * jittery to feed the 1 Hz integrator directly. This module keeps a
 * running average over a time window of the emitted deltas, and an
 * honest staleness verdict so a wind that went out-of-table (the
 * sibling plugin then publishes `null`) lets DR fall through to the
 * idle branch instead of holding a frozen speed.
 *
 * Pure logic over an explicit state object — unit-testable without
 * Signal K plumbing. The plugin entry point samples on delta arrival
 * and reads the average once per tick.
 *
 * @file polar.js
 */

/**
 * Creates the polar-speed averaging state.
 *
 * @returns {{samples: {tsMs: number, speedKn: number}[]}}
 */
function createPolarSpeedState() {
  return { samples: [] };
}

/**
 * Records one `performance.polarSpeed` delta into the running-average
 * ring, evicting samples older than the window. Null (out-of-table)
 * values record nothing — the average must age out rather than decay
 * toward zero.
 *
 * @param {{samples: {tsMs: number, speedKn: number}[]}} state
 * @param {{tsMs: number, speedKn: number|null}} sample
 * @param {{windowMs: number}} opts
 * @returns {void}
 */
function polarSpeedSample(state, sample, opts) {
  if (sample.speedKn == null || !Number.isFinite(sample.speedKn)) return;
  evict(state, sample.tsMs, opts.windowMs);
  state.samples.push({ tsMs: sample.tsMs, speedKn: sample.speedKn });
}

/**
 * Running-average speed (kn) over the current window, with a
 * staleness verdict against the newest sample's age.
 *
 * @param {{samples: {tsMs: number, speedKn: number}[]}} state
 * @param {{nowMs: number, windowMs: number, staleMs: number}} opts
 * @returns {{averageKn: number|null, sampleCount: number, stale: boolean}}
 */
function polarSpeedAverage(state, opts) {
  evict(state, opts.nowMs, opts.windowMs);
  const n = state.samples.length;
  if (n === 0) return { averageKn: null, sampleCount: 0, stale: true };
  const newest = state.samples[n - 1].tsMs;
  const stale = opts.nowMs - newest > opts.staleMs;
  const mean = state.samples.reduce((acc, s) => acc + s.speedKn, 0) / n;
  return { averageKn: mean, sampleCount: n, stale };
}

/**
 * Drops samples older than `windowMs` before `nowMs`.
 *
 * @param {{samples: {tsMs: number, speedKn: number}[]}} state
 * @param {number} nowMs
 * @param {number} windowMs
 * @returns {void}
 */
function evict(state, nowMs, windowMs) {
  const cutoff = nowMs - windowMs;
  let i = 0;
  while (i < state.samples.length && state.samples[i].tsMs < cutoff) i++;
  if (i > 0) state.samples.splice(0, i);
}

module.exports = {
  createPolarSpeedState,
  polarSpeedSample,
  polarSpeedAverage,
};
