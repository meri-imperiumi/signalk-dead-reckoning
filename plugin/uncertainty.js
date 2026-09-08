/**
 * Uncertainty polygon: confidence-weighted DR error region (SPEC §8).
 *
 * Produces a circular error region around the shadow-boat DR position
 * from two independent error sources, combined root-sum-square:
 *
 *  - **Run term:** error that scales with elapsed distance run —
 *    compass/leeway/speed model error. Two regimes, blended continuously:
 *    the *empirical* median of `deviation_nm / dr_elapsed_seconds` from
 *    recent `dr_corrections` rows for the current sail/sea state
 *    (converted to a per-distance rate via STW), and a *fallback* fixed
 *    angular margin (deg of error per nm run) for bins with low hit
 *    count or no correction history.
 *  - **Current term:** error from not knowing the water's motion —
 *    the dominant DR error offshore (sea trial 2026-08-30…09-05: a
 *    0.5–1 kn unmodeled South Equatorial Current accumulated 88 km
 *    while the run term predicted 2 NM). Scales with elapsed *time* at
 *    a residual rate per resolved current tier: a live current source
 *    leaves only model residual; the zero vector assumes the whole
 *    ocean current (~1 kn) is unknown.
 *
 * The blend weight on the empirical rate rises from 0 (pure fallback)
 * to ~1 as the bin's effective hit count crosses
 * `MIN_HITS_FOR_EMPIRICAL`, so the polygon starts generous and tightens
 * as a bin is sailed — the tangible "system is learning" signal SPEC §8
 * calls out (motivation 2).
 *
 * This module is pure logic over an explicit input object — unit-testable
 * without Signal K or SQLite. The plugin entry point feeds it the current
 * bin confidence, recent correction rows, excursion distance/time, and
 * the resolved current tier each tick and publishes the result.
 *
 * v1 ships a **circle** (single scalar radius). A heading-aware ellipse is
 * a natural follow-up once a heading-vs-speed error decomposition exists;
 * the `deviation_bearing` column in `dr_corrections` already supports it
 * without schema change.
 *
 * @file uncertainty.js
 */

/**
 * Minimum published radius (nm) ≈ 92 m: GNSS position noise plus the
 * first seconds of sensor disagreement. With zero distance run the run
 * term would otherwise be 0, and any GPS wander — however small — then
 * "exceeds expected uncertainty", firing the divergence advisory on a
 * freshly-snapped boat. Sea trial 2026-08-30…09-05: with the previous
 * 0.02 nm floor the advisory re-raised within ~3 min of every confirmed
 * fix (0.04 nm divergence vs 1.5 × 0.02) — noise, not information.
 */
const MIN_RADIUS_NM = 0.05;

/**
 * Conservative angular-error margin (degrees of DR error per nautical
 * mile run) used by the fallback regime. Sea trial 2026-08-30…09-05
 * measured 0.12–0.22 nm/nm open-loop (≈7–12°); 4° (≈0.07 nm/nm) covers
 * compass + unlearned leeway/speed model error and lets the empirical
 * rate tighten from there. The previous 1° proved ~7–12× optimistic.
 */
const FALLBACK_DEG_PER_NM = 4.0;

/**
 * Cap on a single correction row's contribution to the empirical rate
 * (kn). A garbage correction (wrong fix, mis-entered sight) produces
 * absurd rates — the 2026-08-31 Antarctica snap recorded 3058 NM over
 * 21 h ≈ 145 kn — and must not move the model (work doc #2 specified a
 * robust aggregate for exactly this reason).
 */
const MAX_ROW_RATE_KN = 2.0;

/**
 * Residual current uncertainty per resolved current tier (kn): how much
 * unmodeled drift remains when the engine integrates that tier's vector.
 *
 * - tier 1 (manual): the watchstander set it from a recent observation;
 *   small residual.
 * - tier 3 (weather/GRIB): mesoscale model error, ~0.3 kn.
 * - tier 4 (pilot charts): monthly climatology, ~0.3 kn.
 * - tier 5 (zero vector): no current knowledge at all — the sea trial
 *   showed ~1 kn effective drift in the South Equatorial Current.
 */
const CURRENT_RESIDUAL_KN = Object.freeze({
  1: 0.25,
  3: 0.3,
  4: 0.3,
  5: 1.0,
});

/**
 * Effective hit count at which the blend reaches ~1 (pure empirical).
 * Below this the fallback dominates. ≈2 live samples at
 * `LIVE_WEIGHT_MULTIPLIER=5` (see matrix.js) — low enough that a single
 * short sail in given conditions starts tightening, high enough that one
 * noisy GPS fix doesn't set the rate.
 */
const MIN_HITS_FOR_EMPIRICAL = 10;

/**
 * Number of most-recent `dr_corrections` rows the median aggregates
 * over. A re-rig or season of changed trim should propagate through in
 * roughly this many snaps.
 */
const MEDIAN_N = 20;

const RAD = Math.PI / 180;

/**
 * Fallback growth rate, in nm of error per nm run.
 *
 * @param {number} [degPerNm=FALLBACK_DEG_PER_NM] - angular margin
 * @returns {number} nm/nm
 */
function fallbackRateNmPerNm(degPerNm = FALLBACK_DEG_PER_NM) {
  // degPerNm of angle over 1 nm of run ≈ tan(degPerNm) of lateral error.
  return Math.tan(degPerNm * RAD);
}

/**
 * Computes a per-time deviation rate (nm/s) for a single correction row,
 * capped at MAX_ROW_RATE_KN.
 *
 * @param {{deviation_nm: number, dr_elapsed_seconds: number}} row
 * @returns {number} nm/s, or 0 if the row has no elapsed time
 */
function rowRatePerSecond(row) {
  if (!row.dr_elapsed_seconds || row.dr_elapsed_seconds <= 0) return 0;
  return Math.min(
    row.deviation_nm / row.dr_elapsed_seconds,
    MAX_ROW_RATE_KN / 3600,
  );
}

/**
 * Median of the capped per-time deviation rates across recent correction
 * rows (work doc #2: "a single bad excursion shouldn't move the model
 * much" — the sea-trial garbage rows proved the point). Rows beyond the
 * newest MEDIAN_N are ignored; null when no usable rows exist.
 *
 * @param {Array<{deviation_nm: number, dr_elapsed_seconds: number}>} rows
 *   newest-first (as returned by the db query)
 * @returns {number|null} median deviation rate, nm/s
 */
function deviationRateMedian(rows) {
  const valid = (rows ?? [])
    .slice(0, MEDIAN_N)
    .filter((r) => r.dr_elapsed_seconds && r.dr_elapsed_seconds > 0)
    .map(rowRatePerSecond)
    .sort((a, b) => a - b);
  if (valid.length === 0) return null;
  const mid = valid.length >> 1;
  return valid.length % 2 === 1
    ? valid[mid]
    : (valid[mid - 1] + valid[mid]) / 2;
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
 * radius = max(MIN, √((growthRate × runNm)² + (residualKn × hours)²))
 *
 * @param {object} input
 * @param {number} input.elapsedDistanceNm - water-track distance run since
 *   the last snap-to-fix (the engine's `logNmSinceOrigin`)
 * @param {number} [input.elapsedS] - seconds since the last snap-to-fix,
 *   driving the current-knowledge term
 * @param {number} [input.currentTier] - resolved current tier (1|3|4|5,
 *   from `resolveCurrent`); defaults to 5 (no current knowledge)
 * @param {number} [input.originErrorNm] - error radius of the fix that
 *   seeded the origin (nm); floors the cone at the fix's own accuracy
 *   (a celestial fix is realistically ~5 nm — the cone must not collapse
 *   to GPS-level confidence below that)
 * @param {number} input.effectiveHitCount - effective hit count of the
 *   current matrix bin (from `matrix.lookup(ctx).hit_count`)
 * @param {Array<{deviation_nm: number, dr_elapsed_seconds: number}>} [input.deviationRows]
 *   recent `dr_corrections` rows for the current sail/sea state
 * @param {number} input.stwKn - current through-water speed (knots), used
 *   to convert the per-time empirical rate to a per-distance rate
 * @returns {{radius_nm: number, growth_rate: number, method: "empirical"|"fallback"|"blend", empirical_rate: number|null, fallback_rate: number, weight: number, current_residual_kn: number, current_term_nm: number, run_term_nm: number}}
 */
function computeRadius(input) {
  const elapsed = Math.max(0, input.elapsedDistanceNm ?? 0);
  const elapsedS = Math.max(0, input.elapsedS ?? 0);
  const tier = input.currentTier ?? 5;
  const hits = Math.max(0, input.effectiveHitCount ?? 0);
  const stwKn = input.stwKn ?? 0;

  const fallbackRate = fallbackRateNmPerNm();
  const medianPerSecond = deviationRateMedian(input.deviationRows ?? []);
  // Convert the per-time empirical rate to per-distance using the current
  // through-water speed (nm/s ÷ (nm/s of run) = nm error per nm run).
  const runPerSecond = stwKn / 3600;
  const empiricalRate =
    medianPerSecond != null && runPerSecond > 0
      ? medianPerSecond / runPerSecond
      : null;

  const w = blendWeight(hits);
  const rate =
    empiricalRate != null
      ? w * empiricalRate + (1 - w) * fallbackRate
      : fallbackRate;

  const currentResidualKn = CURRENT_RESIDUAL_KN[tier] ?? CURRENT_RESIDUAL_KN[5];
  const runTermNm = rate * elapsed;
  const currentTermNm = (currentResidualKn * elapsedS) / 3600;
  const radius_nm = Math.max(
    Math.hypot(runTermNm, currentTermNm),
    MIN_RADIUS_NM,
    Math.max(0, input.originErrorNm ?? 0),
  );

  let method;
  if (empiricalRate == null || w <= 0) method = "fallback";
  else if (w >= 0.95) method = "empirical";
  else method = "blend";

  return {
    radius_nm,
    growth_rate: rate,
    method,
    empirical_rate: empiricalRate,
    fallback_rate: fallbackRate,
    weight: w,
    current_residual_kn: currentResidualKn,
    current_term_nm: currentTermNm,
    run_term_nm: runTermNm,
  };
}

module.exports = {
  FALLBACK_DEG_PER_NM,
  MIN_RADIUS_NM,
  MIN_HITS_FOR_EMPIRICAL,
  MEDIAN_N,
  MAX_ROW_RATE_KN,
  CURRENT_RESIDUAL_KN,
  fallbackRateNmPerNm,
  rowRatePerSecond,
  deviationRateMedian,
  blendWeight,
  computeRadius,
};
