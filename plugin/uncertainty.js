/**
 * Uncertainty polygon: confidence-weighted DR error region (SPEC §8).
 *
 * Produces a circular error region around the shadow-boat DR position
 * whose radius grows with elapsed distance run, tightened as the matching
 * matrix bin's confidence rises. Two regimes, blended continuously:
 *
 *  - **Empirical:** the EWMA of `deviation_nm / dr_elapsed_seconds` from
 *    recent `dr_corrections` rows for the current sail/sea state,
 *    converted to a per-distance rate using the current through-water
 *    speed (so the radius scales with distance run, not clock time —
 *    SPEC §8 is explicit that DR error compounds with distance more
 *    honestly than with time).
 *  - **Fallback:** a conservative fixed angular margin (deg of error per
 *    nm run) for bins with low effective hit count, or no correction
 *    history yet.
 *
 * The blend weight rises from 0 (pure fallback) to ~1 (pure empirical) as
 * the bin's effective hit count crosses `MIN_HITS_FOR_EMPIRICAL`, so the
 * polygon starts generous and tightens as a bin is sailed — the tangible
 * "system is learning" signal SPEC §8 calls out (motivation 2).
 *
 * This module is pure logic over an explicit input object — unit-testable
 * without Signal K or SQLite. The plugin entry point feeds it the current
 * bin confidence, recent correction rows, and excursion distance each tick
 * and publishes the result.
 *
 * v1 ships a **circle** (single scalar radius). A heading-aware ellipse is
 * a natural follow-up once a heading-vs-speed error decomposition exists;
 * the `deviation_bearing` column in `dr_corrections` already supports it
 * without schema change.
 *
 * @file uncertainty.js
 */

/**
 * Conservative angular-error margin (degrees of DR error per nautical
 * mile run) used by the fallback regime. ~1° over a mile is a deliberately
 * wide starting point (≈1 nm of error per 57 nm run); the polygon tightens
 * as the empirical rate takes over.
 */
const FALLBACK_DEG_PER_NM = 1.0;

/**
 * Effective hit count at which the blend reaches ~1 (pure empirical).
 * Below this the fallback dominates. ≈2 live samples at
 * `LIVE_WEIGHT_MULTIPLIER=5` (see matrix.js) — low enough that a single
 * short sail in given conditions starts tightening, high enough that one
 * noisy GPS fix doesn't set the rate.
 */
const MIN_HITS_FOR_EMPIRICAL = 10;

/**
 * Number of recent `dr_corrections` rows the EWMA aggregates over. A
 * re-rig or season of changed trim should propagate through in roughly
 * this many snaps.
 */
const EWMA_N = 20;

/**
 * EWMA alpha derived from EWMA_N (effective window ≈ N samples).
 * α = 2/(N+1) is the standard EWMA-from-window mapping.
 */
const EWMA_ALPHA = 2 / (EWMA_N + 1);

const RAD = Math.PI / 180;

/**
 * Fallback growth rate, in nm of error per nm run.
 *
 * @param {number} [degPerNm=FALLBACK_DEG_PER_NM] - angular margin
 * @returns {number} nm/nm
 */
function fallbackRateNmPerNm(degPerNm = FALLBACK_DEG_PER_NM) {
  // 1° of angle over 1 nm of run ≈ tan(1°) ≈ 0.01745 nm of lateral error.
  return Math.tan(degPerNm * RAD);
}

/**
 * Computes a per-time deviation rate (nm/s) for a single correction row.
 *
 * @param {{deviation_nm: number, dr_elapsed_seconds: number}} row
 * @returns {number} nm/s, or 0 if the row has no elapsed time
 */
function rowRatePerSecond(row) {
  if (!row.dr_elapsed_seconds || row.dr_elapsed_seconds <= 0) return 0;
  return row.deviation_nm / row.dr_elapsed_seconds;
}

/**
 * EWMA of the per-time deviation rate across recent correction rows,
 * seeded from the fallback (converted to per-time via the given speed)
 * when fewer rows exist, so the blend is implicit.
 *
 * Rows are applied oldest→newest so the EMA weights recent behaviour
 * (a re-rig tightens the polygon within ~EWMA_N snaps).
 *
 * @param {Array<{deviation_nm: number, dr_elapsed_seconds: number}>} rows
 * @param {object} opts
 * @param {number} opts.stwKn - current through-water speed (knots), to
 *   seed the EWMA from the fallback rate when rows are sparse
 * @returns {number} EWMA of deviation rate, nm/s
 */
function deviationRateEwma(rows, opts) {
  const stwKn = opts.stwKn ?? 0;
  const fallbackSeed = fallbackRateNmPerNm() * (stwKn / 3600);
  const valid = (rows ?? []).filter(
    (r) => r.dr_elapsed_seconds && r.dr_elapsed_seconds > 0,
  );
  if (valid.length === 0) return fallbackSeed;
  // Order oldest→newest (rows come newest-first from the db query). Seed
  // the EMA from the oldest real observation so a short history doesn't
  // under-shoot toward a near-zero fallback-derived seed.
  const ordered = [...valid].reverse();
  let acc = rowRatePerSecond(ordered[0]);
  for (let i = 1; i < ordered.length; i++) {
    acc = EWMA_ALPHA * rowRatePerSecond(ordered[i]) + (1 - EWMA_ALPHA) * acc;
  }
  return acc;
}

/**
 * Blend weight in [0, 1) for the empirical regime, as a function of the
 * bin's effective hit count. Uses a smooth ramp (not a step) so the
 * transition is continuous: w rises from 0 at hit_count=0 toward 1 as
 * hit_count crosses MIN_HITS_FOR_EMPIRICAL.
 *
 * @param {number} effectiveHitCount
 * @returns {number} weight on the empirical rate (fallback weight = 1 - w)
 */
function blendWeight(effectiveHitCount) {
  if (effectiveHitCount <= 0) return 0;
  // Smooth ramp: w = h / (h + MIN_HITS), so w=0.5 at h=MIN_HITS,
  // w→1 as h≫MIN_HITS. Monotonic, continuous, no tuning cliffs.
  return effectiveHitCount / (effectiveHitCount + MIN_HITS_FOR_EMPIRICAL);
}

/**
 * Computes the current uncertainty radius around the DR position.
 *
 * @param {object} input
 * @param {number} input.elapsedDistanceNm - water-track distance run since
 *   the last snap-to-fix (the engine's `logNmSinceOrigin`)
 * @param {number} input.effectiveHitCount - effective hit count of the
 *   current matrix bin (from `matrix.lookup(ctx).hit_count`)
 * @param {Array<{deviation_nm: number, dr_elapsed_seconds: number}>} [input.deviationRows]
 *   recent `dr_corrections` rows for the current sail/sea state
 * @param {number} input.stwKn - current through-water speed (knots), used
 *   to convert the per-time empirical rate to a per-distance rate
 * @returns {{radius_nm: number, growth_rate: number, method: "empirical"|"fallback"|"blend", empirical_rate: number, fallback_rate: number, weight: number}}
 */
function computeRadius(input) {
  const elapsed = Math.max(0, input.elapsedDistanceNm ?? 0);
  const hits = Math.max(0, input.effectiveHitCount ?? 0);
  const stwKn = input.stwKn ?? 0;

  const fallbackRate = fallbackRateNmPerNm();
  const empiricalPerSecond = deviationRateEwma(input.deviationRows ?? [], {
    stwKn,
  });
  // Convert the per-time empirical rate to per-distance using the current
  // through-water speed (nm/s ÷ (nm/s of run) = nm error per nm run).
  const runPerSecond = stwKn / 3600;
  const empiricalRate =
    runPerSecond > 0 ? empiricalPerSecond / runPerSecond : fallbackRate;

  const w = blendWeight(hits);
  const rate = w * empiricalRate + (1 - w) * fallbackRate;
  const radius_nm = rate * elapsed;

  let method;
  if (w <= 0) method = "fallback";
  else if (w >= 0.95) method = "empirical";
  else method = "blend";

  return {
    radius_nm,
    growth_rate: rate,
    method,
    empirical_rate: empiricalRate,
    fallback_rate: fallbackRate,
    weight: w,
  };
}

module.exports = {
  FALLBACK_DEG_PER_NM,
  MIN_HITS_FOR_EMPIRICAL,
  EWMA_N,
  EWMA_ALPHA,
  fallbackRateNmPerNm,
  rowRatePerSecond,
  deviationRateEwma,
  blendWeight,
  computeRadius,
};
