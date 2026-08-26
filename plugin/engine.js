/**
 * Dead-reckoning vector integration engine (SPEC §5, §6.1, §3.1).
 *
 * Continuously integrates a "shadow boat" position from water-track sensors
 * (paddlewheel STW, compass heading), applying learned leeway/current
 * corrections from the matrix and a resolved current vector, regardless of
 * whether GPS is currently trusted. The result is published at 1Hz as
 * `navigation.deadReckoning.position` (SPEC §3.1) — the engine runs warm at
 * all times so a switch to OVERRIDE is an instant authority handoff rather
 * than a cold start (SPEC §5).
 *
 * The engine is pure logic over an explicit state object so it is unit-
 * testable without Signal K plumbing. The plugin entry point feeds it
 * sensor deltas and publishes the result.
 *
 * @file engine.js
 */

const { normalizeDeg360, destinationPoint } = require("./geo.js");

/**
 * Default fallback current vector (SPEC §6.2 tier 5: zero vector — pure
 * inertial water track).
 */
const ZERO_CURRENT = Object.freeze({ setTrue: 0, drift: 0 });

/**
 * Resolves a numeric value from a Signal K delta payload, which may arrive
 * as a bare number or as `{value: number}`.
 *
 * @param {unknown} v
 * @returns {number|null}
 */
function toNumber(v) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "object" && typeof v.value === "number")
    return Number.isFinite(v.value) ? v.value : null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Dead-reckoning engine state. Holds the shadow-boat origin (last snap-to-
 * fix or last known good position), the running water-track log, and
 * per-tick inputs.
 */
class DeadReckoningEngine {
  /**
   * @param {object} [opts]
   * @param {{latitude: number, longitude: number}|null} [opts.origin]
   * @param {number} [opts.logNm] - cumulative water-track log (nm)
   * @param {number} [opts.tripLogNm]
   */
  constructor(opts = {}) {
    /** @type {{latitude: number, longitude: number}|null} */
    this.origin = opts.origin ?? null;
    /** @type {number} */
    this.logNm = opts.logNm ?? 0;
    /** @type {number} */
    this.tripLogNm = opts.tripLogNm ?? 0;
    /** @type {number|null} seconds since the DR origin was last reset */
    this.elapsedSinceOriginS = 0;
    /** @type {number} water-track log accumulated since the last snap-to-fix (nm)
     * — SPEC §8 uses elapsed *distance* run, not clock time, as the
     * uncertainty-polygon growth axis (DR error compounds with distance
     * more honestly than with time). */
    this.logNmSinceOrigin = 0;
    /** @type {string} active calculation method (SPEC §3.1) */
    this.method = "inertial-paddlewheel";
    /** @type {boolean} whether DR is authoritative for navigation.position */
    this.active = false;
  }

  /**
   * Snaps the DR origin to a confirmed fix, recording the elapsed time so
   * that deviation-rate can be computed later (SPEC §4.5, §9.3). Does not
   * touch the running logs.
   *
   * @param {{latitude: number, longitude: number}} fix
   * @returns {void}
   */
  snapToFix(fix) {
    this.origin = { latitude: fix.latitude, longitude: fix.longitude };
    this.elapsedSinceOriginS = 0;
    this.logNmSinceOrigin = 0;
  }

  /**
   * Resets the trip log (SPEC §3.1, §9.2 — trip boundaries defined by
   * navigation.state transitions to anchored/moored).
   *
   * @returns {void}
   */
  resetTrip() {
    this.tripLogNm = 0;
  }

  /**
   * Advances the shadow-boat position by one tick.
   *
   * The motion model per tick is: water-track vector at (headingTrue +
   * leeway_angle) over STW*(1 - speed_loss), plus the resolved current
   * vector at setTrue over drift, each scaled by the tick interval. This is
   * the small-step flat-earth approximation, exact over the 1s / few-metre
   * scales a tick covers; the great-circle destination formula is used so
   * accumulated error over a long excursion stays bounded.
   *
   * @param {object} inputs
   * @param {number} inputs.stwKn - calibrated STW (knots)
   * @param {number} inputs.headingTrueDeg - true heading (degrees)
   * @param {number} inputs.leewayDeg - learned leeway angle (degrees, + to leeward)
   * @param {number} inputs.speedLoss - learned speed-loss fraction [0,1]
   * @param {{setTrue: number, drift: number}} [inputs.current] - resolved current (deg true, kn)
   * @param {number} [inputs.dtS=1] - tick interval in seconds
   * @returns {{latitude: number, longitude: number}|null} new position, or null if no origin
   */
  tick(inputs, dtS = 1) {
    if (!this.origin) return null;
    const stw = toNumber(inputs.stwKn);
    const hdg = toNumber(inputs.headingTrueDeg);
    if (stw == null || hdg == null) return this.origin;

    const leeway = toNumber(inputs.leewayDeg) ?? 0;
    const speedLoss = clamp01(toNumber(inputs.speedLoss) ?? 0);
    const current = inputs.current ?? ZERO_CURRENT;

    const hours = dtS / 3600;
    const effectiveStw = stw * (1 - speedLoss);
    const courseDeg = normalizeDeg360(hdg + leeway);

    // Water-track displacement.
    let pos = destinationPoint(this.origin, courseDeg, effectiveStw * hours);

    // Current displacement added on top.
    if (current && (current.drift || 0) !== 0) {
      pos = destinationPoint(pos, current.setTrue, current.drift * hours);
    }

    this.origin = pos;
    this.logNm += effectiveStw * hours;
    this.tripLogNm += effectiveStw * hours;
    this.elapsedSinceOriginS += dtS;
    this.logNmSinceOrigin += effectiveStw * hours;
    return pos;
  }
}

/**
 * Clamps to [0, 1].
 *
 * @param {number} x
 * @returns {number}
 */
function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

module.exports = {
  DeadReckoningEngine,
  ZERO_CURRENT,
  toNumber,
};
