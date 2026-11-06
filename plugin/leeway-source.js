/**
 * Companion leeway consumption (SPEC §3.2, §6.1).
 *
 * The speedandcurrent companion plugin publishes a learned
 * `navigation.leewayAngle` (rad, positive = slip toward starboard —
 * the same sign convention as our matrix). That value is a
 * measurement-grade estimate on the bus, and the DR design rule is
 * that a working measurement outranks a model: when a fresh,
 * plausible companion value exists it drives the shadow boat, and the
 * matrix lookup becomes the fallback for installs without the
 * companion (or while its value is stale beyond the freshness window
 * or implausible).
 *
 * Training is deliberately NOT switched over: the geometric
 * observation pipeline keeps feeding our own matrix even while the
 * companion drives the runtime. The fallback must stay warm — a
 * season of companion presence must not leave the matrix stale, or
 * the day the companion is removed the DR solution inherits a
 * year-old model with no recent observations.
 *
 * Pure logic over an explicit snapshot — unit-testable without
 * Signal K plumbing.
 *
 * @file leeway-source.js
 */

/** Signal K bus angles are rad; the DR engine works in degrees. */
const DEG_PER_RAD = 180 / Math.PI;

/**
 * How long after the last companion delta the value stays usable.
 * The companion publishes continuously while running, so exceeding
 * this window means it stopped, was disabled, or the value predates
 * this tick's decision — all reasons to fall back.
 */
const DEFAULT_MAX_AGE_MS = 15_000;

/**
 * Runtime plausibility bound (deg), matching training's
 * MAX_PLAUSIBLE_LEEWAY_DEG: real leeway is ≈0° on a run and ≈10–13°
 * close-hauled in a gale. A companion value beyond this is that
 * plugin's estimator misbehaving (lagging current smoother in a tide
 * race, for instance) — not something to integrate into the shadow
 * boat.
 */
const DEFAULT_MAX_ABS_DEG = 15;

/**
 * Resolves the leeway angle to drive the shadow boat this tick.
 *
 * Companion path: value must be finite, received within the freshness
 * window, and convert to a plausible angle. Otherwise the matrix
 * lookup is passed through (possibly null — the engine already treats
 * a missing angle as 0, upright water track).
 *
 * @param {object} inputs
 * @param {number|null} inputs.companionRad - latest published
 *   `navigation.leewayAngle` (rad, starboard-positive), or null when
 *   no companion has published since start
 * @param {number|null} inputs.companionAtMs - Date.now() when that
 *   delta was received, or null
 * @param {number} inputs.nowMs - current wall clock
 * @param {number|null} inputs.matrixLeewayDeg - matrix lookup result
 *   (deg, signed), the fallback
 * @param {number} [inputs.maxAgeMs] - freshness window
 * @param {number} [inputs.maxAbsDeg] - plausibility bound
 * @returns {{leewayDeg: number|null, source: "companion"|"matrix"}} the
 *   angle to integrate (deg) and where it came from
 */
function resolveLeewayDeg({
  companionRad,
  companionAtMs,
  nowMs,
  matrixLeewayDeg,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  maxAbsDeg = DEFAULT_MAX_ABS_DEG,
}) {
  const hasCompanionValue = Number.isFinite(companionRad);
  const hasReceipt = Number.isFinite(companionAtMs);
  const ageMs = hasReceipt ? nowMs - companionAtMs : Infinity;
  // A receipt "in the future" is a local clock anomaly, not a stale
  // value — treat as fresh rather than flapping the source.
  const fresh = ageMs >= 0 ? ageMs <= maxAgeMs : true;
  const leewayDeg = hasCompanionValue ? companionRad * DEG_PER_RAD : NaN;
  const plausible =
    Number.isFinite(leewayDeg) && Math.abs(leewayDeg) <= maxAbsDeg;

  if (hasCompanionValue && fresh && plausible) {
    return { leewayDeg, source: "companion" };
  }
  return { leewayDeg: matrixLeewayDeg ?? null, source: "matrix" };
}

module.exports = {
  resolveLeewayDeg,
  DEFAULT_MAX_AGE_MS,
  DEFAULT_MAX_ABS_DEG,
};
