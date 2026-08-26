/**
 * Training Mode: live EMA matrix learning (SPEC §6.1).
 *
 * When GPS is reliable and the boat is sailing (not motoring, paddlewheel
 * not fouled, not in a tack/gybe transient), the trainer computes the
 * error vector between GPS ground truth and the sensor-derived water
 * track (minus the resolved current), and emits an observed correction
 * (leeway_angle, speed_loss) for the matrix to EMA-merge.
 *
 * This module is pure logic over an explicit state object — unit-testable
 * without Signal K plumbing. The plugin entry point feeds it sensor
 * snapshots each tick and forwards any emitted observation to
 * `matrix.update()`.
 *
 * What this module deliberately does *not* do:
 *  - `upwash_correction` learning. The matrix bins on AWA as an *input*;
 *    learning a correction to the same AWA we looked the bin up by is
 *    circular. Deferred to a follow-up (work doc §Risks).
 *  - GPS spoofing detection (§7). `isGpsReliable` here is a simple
 *    "recent fix and no gross jump" predicate; the real detector is a
 *    separate work doc.
 *
 * @file training.js
 */

const {
  distanceNm,
  bearingDeg,
  normalizeDeg180,
  normalizeDeg360,
} = require("./geo.js");

/**
 * Below this STW (kn) the paddlewheel is treated as reading "stopped",
 * for the fouling detector. Below the noise floor of a real instrument.
 */
const STW_STOP_KN = 0.3;

/**
 * SOG (kn) above which the boat is clearly making way through the water
 * (used by the fouling detector: STW≈0 while SOG above this = fouled).
 */
const SOG_MOVING_KN = 1.0;

/**
 * Apparent wind speed (kn) above which wind indicates the boat is moving
 * (a secondary fouling corroboration when SOG is unavailable).
 */
const AWS_MOVING_KN = 3.0;

/**
 * Rate-of-turn (deg/sec) above which a tack/gybe transient window opens
 * (SPEC §6.4 example: > 3°/sec).
 */
const ROT_TRANSIENT_DEG_S = 3.0;

/**
 * How long heel and AWA must remain within their stabilize tolerances
 * before a transient window closes (SPEC §6.4: settle ends on
 * re-stabilization, not a fixed timer).
 */
const SETTLE_SUSTAIN_S = 10.0;

/**
 * Heel (deg) and AWA (deg) re-stabilization tolerances — both must stay
 * within these bounds of their values at window-open for the sustained
 * interval before training resumes.
 */
const STABILIZE_HEEL_DEG = 2.0;
const STABILIZE_AWA_DEG = 10.0;

/**
 * Heading (deg) tolerance for the §6.4 re-stabilization test: the settle
 * clock runs only when the heading is holding within this of its
 * turn-stop reference — a maneuver is complete when the boat is settled
 * on its new course, not merely when heel/wind have steadied.
 */
const STABILIZE_HEADING_DEG = 5.0;

/**
 * Minimum elapsed seconds between two GPS fixes for a SOG/COG derivation
 * to be trusted (avoids divide-by-tiny-dt blowups at high report rates).
 */
const MIN_GPS_INTERVAL_S = 0.01;

/**
 * Gross GPS jump (nm) above which `isGpsReliable` is false — a position
 * discontinuity inconsistent with any plausible motion. The real spoofing
 * detector (§7) replaces this; here it just stops training on a blatant
 * glitch.
 */
const GROSS_JUMP_NM = 5.0;

/**
 * EMA smoothing on the derived SOG/COG before differencing, to take the
 * jitter out of position-delta-derived ground truth at 1Hz. Small so a
 * genuine change still propagates within a few seconds.
 */
const GROUND_TRUTH_ALPHA = 0.3;

/**
 * Training state. Held across ticks; the plugin owns one instance.
 */
class TrainingState {
  /**
   * @param {object} [opts] - tunable overrides (mainly for fast tests;
   *   production uses the module constants)
   * @param {number} [opts.settleSustainS] - §6.4 re-stabilization window
   */
  constructor(opts = {}) {
    /** @type {number} §6.4 settle window (s), overridable */
    this.settleSustainS = opts.settleSustainS ?? SETTLE_SUSTAIN_S;
    /** @type {{latitude:number, longitude:number, timestampS:number}|null} last accepted GPS fix */
    this.lastGps = null;
    /** @type {number|null} smoothed ground-truth SOG (kn) */
    this.sogKn = null;
    /** @type {number|null} smoothed ground-truth COG (deg true) */
    this.cogDeg = null;
    /** @type {number|null} previous heading (deg true) for rate-of-turn */
    this.lastHeadingDeg = null;
    /** @type {number|null} timestamp (s) of last heading sample */
    this.lastHeadingAtS = null;
    /** @type {boolean} paddlewheel fouled (§6.3) */
    this.fouled = false;
    /** @type {boolean} tack/gybe transient window open (§6.4) */
    this.transient = false;
    /** @type {number|null} transient window open timestamp (s) */
    this.transientOpenAtS = null;
    /** @type {number|null} heel (deg) at transient open, to test re-stabilize */
    this.transientHeelDeg = null;
    /** @type {number|null} AWA (deg) at transient open, to test re-stabilize */
    this.transientAwaDeg = null;
    /** @type {number|null} heading (deg) at transient open, for §9.4
     * tack/gybe classification at the close edge */
    this.transientHeadingDeg = null;
    /** @type {number|null} AWA (deg) from the tick *before* the window
     * opened — the pre-maneuver wind side, for §9.4 classification
     * (transientAwaDeg is captured mid-maneuver, after the flip) */
    this.maneuverAwaDeg = null;
    /** @type {number|null} AWA (deg) of the previous tick (non-transient),
     * feeding maneuverAwaDeg at window open */
    this.lastAwaDeg = null;
    /** @type {number|null} seconds of sustained re-stabilization so far */
    this.stabilizedS = 0;
  }
}

/**
 * Angular difference in degrees, normalized to [-180, 180).
 *
 * @param {number} aDeg
 * @param {number} bDeg
 * @returns {number}
 */
function angleDelta(aDeg, bDeg) {
  return normalizeDeg180(aDeg - bDeg);
}

/**
 * Decides whether GPS is usable as a training reference this tick. v1: a
 * recent fix whose jump from the last fix is below the gross-jump bound.
 * The real spoofing detector (§7) is a separate work doc; this just keeps
 * blatant glitches out of the bins.
 *
 * @param {TrainingState} st
 * @param {{latitude:number, longitude:number, timestampS:number}|null} fix
 * @returns {boolean}
 */
function isGpsReliable(st, fix) {
  if (!fix) return false;
  if (st.lastGps) {
    const jump = distanceNm(st.lastGps, fix);
    if (jump > GROSS_JUMP_NM) return false;
  }
  return true;
}

/**
 * Paddlewheel fouling detector (SPEC §6.3). STW reads ~0 while the boat
 * is clearly moving (SOG well above zero, or AWS + heel corroborate).
 * Distinguishes fouling from "boat genuinely stopped" (SOG≈0 too).
 *
 * Pure function of the current sensor snapshot.
 *
 * @param {object} s - {stwKn, sogKn, awsKn, heelDeg}
 * @returns {boolean}
 */
function detectFouling(s) {
  const stw = s.stwKn ?? 0;
  if (stw > STW_STOP_KN) return false; // paddlewheel is reading motion
  // STW≈0. Is the boat actually moving?
  const movingByGps = s.sogKn != null && s.sogKn > SOG_MOVING_KN;
  const movingByWind = s.awsKn != null && s.awsKn > AWS_MOVING_KN;
  return movingByGps || movingByWind;
}

/**
 * Updates the tack/gybe transient window (SPEC §6.4). Opens when rate-of-
 * turn exceeds the threshold; closes only after heel and AWA re-stabilize
 * within tolerance for a sustained interval. Returns the new transient
 * flag.
 *
 * @param {TrainingState} st
 * @param {object} s - {headingDeg, heelDeg, awaDeg, timestampS}
 * @returns {boolean} transient flag after update
 */
function updateTransient(st, s) {
  let rot = 0;
  if (
    st.lastHeadingDeg != null &&
    st.lastHeadingAtS != null &&
    s.timestampS > st.lastHeadingAtS
  ) {
    const dt = s.timestampS - st.lastHeadingAtS;
    rot = Math.abs(angleDelta(s.headingDeg, st.lastHeadingDeg)) / dt;
  }

  if (!st.transient) {
    if (rot > ROT_TRANSIENT_DEG_S) {
      st.transient = true;
      st.transientOpenAtS = s.timestampS;
      st.transientHeelDeg = s.heelDeg;
      st.transientAwaDeg = s.awaDeg;
      st.transientHeadingDeg = s.headingDeg;
      // §9.4: the pre-maneuver wind side is the previous tick's AWA —
      // by the time the rate-of-turn gate trips, the bow may already be
      // through the wind.
      st.maneuverAwaDeg = st.lastAwaDeg ?? s.awaDeg;
      st.stabilizedS = 0;
    }
  } else {
    const heelOk =
      Math.abs(s.heelDeg - st.transientHeelDeg) <= STABILIZE_HEEL_DEG;
    const awaOk =
      Math.abs(angleDelta(s.awaDeg, st.transientAwaDeg)) <= STABILIZE_AWA_DEG;
    // §9.4: the heading must also have stopped swinging — heel and wind
    // can steady before the boat has finished bearing away onto its final
    // course, and the logged "new heading" must be the settled course, not
    // a mid-settle snapshot.
    const headingOk =
      st.transientHeadingDeg != null &&
      Math.abs(angleDelta(s.headingDeg, st.transientHeadingDeg)) <=
        STABILIZE_HEADING_DEG;
    // A new high rate-of-turn resets the settle clock (it's still transient).
    if (rot > ROT_TRANSIENT_DEG_S) {
      st.transientHeelDeg = s.heelDeg;
      st.transientAwaDeg = s.awaDeg;
      st.transientHeadingDeg = s.headingDeg;
      st.stabilizedS = 0;
    } else if (heelOk && awaOk && headingOk) {
      st.stabilizedS +=
        s.timestampS > (st.lastHeadingAtS ?? s.timestampS)
          ? s.timestampS - st.lastHeadingAtS
          : 0;
      if (st.stabilizedS >= st.settleSustainS) {
        st.transient = false;
        st.transientOpenAtS = null;
        st.stabilizedS = 0;
        // NOTE: transientHeelDeg/transientAwaDeg/transientHeadingDeg and
        // maneuverAwaDeg are deliberately RETAINED on close —
        // detectManeuver (§9.4) reads them at this falling edge to
        // classify the completed maneuver. They are overwritten when the
        // next window opens.
      }
    } else {
      st.stabilizedS = 0;
    }
  }

  st.lastHeadingDeg = s.headingDeg;
  st.lastHeadingAtS = s.timestampS;
  if (!st.transient) st.lastAwaDeg = s.awaDeg;
  return st.transient;
}

/**
 * AWA (deg) from the wind below which a side is "upwind": close-hauled to
 * close reaching (a typical tack starts/ends here). A tack's endpoints sit
 * on opposite sides within this half.
 */
const TACK_AWA_MAX_DEG = 90;

/**
 * AWA (deg) from dead downwind within which both endpoints of a gybe sit
 * (broad reach to run, either side of 180°).
 */
const GYBE_AWA_MAX_DEG = 60;

/**
 * Classifies a completed maneuver from the AWA change across a transient
 * window (SPEC §9.4): a tack puts the bow through the wind (AWA crosses
 * from one side of ~0°/360° to the other), a gybe puts the stern through
 * it (AWA crosses from one side of ~180° to the other).
 *
 * `awaBefore`/`awaAfter` are 0-360 true-wind-relative (starboard tack
 * 0-180, port 180-360). Returns null when neither band was crossed
 * (e.g. a course change that merely tripped the rate-of-turn gate).
 *
 * @param {number} awaBefore - AWA (deg, 0-360) when the window opened
 * @param {number} awaAfter - AWA (deg, 0-360) at stabilization
 * @returns {"tack"|"gybe"|null}
 */
function classifyManeuver(awaBefore, awaAfter) {
  // Upwind distance: near 0 (starboard) or near 360 (port).
  const beforeUp = Math.min(awaBefore, 360 - awaBefore);
  const afterUp = Math.min(awaAfter, 360 - awaAfter);
  const beforeDown = Math.abs(awaBefore - 180);
  const afterDown = Math.abs(awaAfter - 180);
  // Sides: starboard (0-180) vs port (180-360).
  const sideFlip = awaBefore < 180 !== awaAfter < 180;
  if (!sideFlip) return null;
  if (beforeUp <= TACK_AWA_MAX_DEG && afterUp <= TACK_AWA_MAX_DEG) {
    return "tack";
  }
  if (beforeDown <= GYBE_AWA_MAX_DEG && afterDown <= GYBE_AWA_MAX_DEG) {
    return "gybe";
  }
  return null;
}

/**
 * Maneuver detection for logbook auto-entries (SPEC §9.4). Consumes the
 * transient window's *close* edge: when `updateTransient` just closed a
 * window, the open-time AWA/heading are still available on the state
 * (they are cleared before returning, so this reads them first).
 *
 * Not a pure function of a snapshot — it tracks the previous transient
 * flag on `st._prevTransient` to detect the falling edge. Returns null
 * unless a window just closed and the AWA crossing classifies cleanly.
 *
 * @param {TrainingState} st
 * @param {{awaDeg: number, headingDeg: number}} s - current snapshot
 * @returns {{direction: "tack"|"gybe", newHeadingDeg: number}|null}
 */
function detectManeuver(st, s) {
  const was = st._prevTransient ?? false;
  st._prevTransient = st.transient;
  if (!was || st.transient) return null;
  // Falling edge: the window just closed. The pre-maneuver AWA is
  // retained on the state by updateTransient for exactly this read.
  if (st.maneuverAwaDeg == null) return null;
  const direction = classifyManeuver(st.maneuverAwaDeg, s.awaDeg);
  if (!direction) return null;
  return { direction, newHeadingDeg: s.headingDeg };
}

/**
 * Smooths a scalar with an EMA, treating `null` existing as "adopt
 * wholesale" (no prior to blend against).
 *
 * @param {number|null} existing
 * @param {number} observed
 * @param {number} alpha
 * @returns {number}
 */
function ema(existing, observed, alpha) {
  if (existing == null) return observed;
  return alpha * observed + (1 - alpha) * existing;
}

/**
 * Smooths an angle (deg true) with an EMA, taking the short way around
 * the circle.
 *
 * @param {number|null} existing
 * @param {number} observed
 * @param {number} alpha
 * @returns {number}
 */
function emaAngle(existing, observed, alpha) {
  if (existing == null) return normalizeDeg360(observed);
  const d = angleDelta(observed, existing);
  return normalizeDeg360(existing + alpha * d);
}

/**
 * Computes the observed correction (leeway_angle, speed_loss) for one
 * training-eligible tick, given the smoothed ground-truth SOG/COG and
 * the water-track vector.
 *
 * The decomposition:
 *  - Resolve the boat's ground-truth motion into (COG, SOG).
 *  - Subtract the resolved current vector → the water-made-good vector.
 *  - The water-made-good bearing minus the heading is the observed leeway
 *    angle (signed: + to leeward).
 *  - The water-made-good speed minus (STW * (1 - speed_loss_lookup)) gives
 *    the speed-loss residual; convert to a speed_loss fraction relative
 *    to STW so the bin stores a unitless [0,1]-ish correction.
 *
 * Returns null if the inputs are insufficient to compute a correction.
 *
 * @param {object} inputs
 * @param {number} inputs.stwKn - raw STW (kn)
 * @param {number} inputs.headingTrueDeg - true heading (deg)
 * @param {number} inputs.sogKn - ground-truth SOG (kn)
 * @param {number} inputs.cogDeg - ground-truth COG (deg true)
 * @param {{setTrue:number, drift:number}} inputs.current
 * @param {number} inputs.lookupLeewayDeg - leeway the bin currently holds
 * @param {number} inputs.lookupSpeedLoss - speed_loss the bin currently holds
 * @returns {{leeway_angle:number, speed_loss:number, upwash_correction:number}|null}
 */
function computeObservation(inputs) {
  const { stwKn, headingTrueDeg, sogKn, cogDeg, current } = inputs;
  if (
    stwKn == null ||
    headingTrueDeg == null ||
    sogKn == null ||
    cogDeg == null
  ) {
    return null;
  }
  if (stwKn <= 0) return null; // no water track to compare against

  // Ground-truth vector (COG, SOG) minus current → water-made-good.
  // Represent both as (east, north) components in nm/h (kn).
  const gtE = sogKn * Math.sin((cogDeg * Math.PI) / 180);
  const gtN = sogKn * Math.cos((cogDeg * Math.PI) / 180);
  const curE = current.drift * Math.sin((current.setTrue * Math.PI) / 180);
  const curN = current.drift * Math.cos((current.setTrue * Math.PI) / 180);
  const wmgE = gtE - curE;
  const wmgN = gtN - curN;
  const wmgSpd = Math.hypot(wmgE, wmgN);
  if (wmgSpd <= 1e-6) return null;

  const wmgBearing = normalizeDeg360((Math.atan2(wmgE, wmgN) * 180) / Math.PI);

  // Observed leeway = water-made-good bearing minus heading.
  const leeway = angleDelta(wmgBearing, headingTrueDeg);

  // Observed speed_loss: the bin currently holds `lookupSpeedLoss`; the
  // effective STW it assumed was stwKn*(1-lookupSpeedLoss). The residual
  // between water-made-good speed and that gives the correction to merge.
  // Express the result as a total speed_loss fraction relative to STW so
  // the bin stores a stable, unitless value.
  const assumedEffective = stwKn * (1 - (inputs.lookupSpeedLoss || 0));
  const residual = wmgSpd - assumedEffective; // kn, + = boat faster than assumed
  const speedLoss = Math.max(
    0,
    Math.min(1, (inputs.lookupSpeedLoss || 0) - residual / stwKn),
  );

  return {
    leeway_angle: leeway,
    speed_loss: speedLoss,
    upwash_correction: 0,
  };
}

/**
 * Processes one tick. Decides eligibility, updates derived ground truth
 * and the transient/fouling flags, and — if eligible — returns an
 * observation for the matrix to merge.
 *
 * @param {TrainingState} st
 * @param {object} s - per-tick snapshot
 * @param {number} s.timestampS - monotonic seconds
 * @param {{latitude:number, longitude:number}|null} s.gps - latest GPS fix (may be null)
 * @param {number|null} s.stwKn
 * @param {number|null} s.headingTrueDeg
 * @param {number|null} s.awaDeg - apparent wind angle (deg, signed ok)
 * @param {number|null} s.awsKn - apparent wind speed (kn)
 * @param {number|null} s.heelDeg
 * @param {string} s.propulsionState - 'started' | 'stopped' | other
 * @param {{setTrue:number, drift:number, tier:number}} s.current - resolved current
 * @param {number} s.lookupLeewayDeg
 * @param {number} s.lookupSpeedLoss
 * @returns {{observation: object|null, eligible: boolean, fouled: boolean, transient: boolean}}
 */
function tick(st, s) {
  // --- Update derived ground truth from the GPS fix ----------------------
  // Reliability is judged against the *previous* fix before we adopt the
  // new one, so a gross jump is detected rather than measured as zero.
  const gpsReliable = isGpsReliable(st, s.gps);
  if (s.gps && st.lastGps) {
    const dt = s.timestampS - st.lastGps.timestampS;
    if (dt >= MIN_GPS_INTERVAL_S) {
      const sog = distanceNm(st.lastGps, s.gps) / (dt / 3600);
      const cog = bearingDeg(st.lastGps, s.gps);
      st.sogKn = ema(st.sogKn, sog, GROUND_TRUTH_ALPHA);
      st.cogDeg = emaAngle(st.cogDeg, cog, GROUND_TRUTH_ALPHA);
      st.lastGps = {
        latitude: s.gps.latitude,
        longitude: s.gps.longitude,
        timestampS: s.timestampS,
      };
    } else {
      // Fix arrived too soon after the previous; keep prior ground truth,
      // just refresh the stored fix position for the next interval.
      st.lastGps = {
        latitude: s.gps.latitude,
        longitude: s.gps.longitude,
        timestampS: s.timestampS,
      };
    }
  } else if (s.gps && !st.lastGps) {
    st.lastGps = {
      latitude: s.gps.latitude,
      longitude: s.gps.longitude,
      timestampS: s.timestampS,
    };
  }

  // --- Fouling + transient flags -----------------------------------------
  st.fouled = detectFouling({
    stwKn: s.stwKn,
    sogKn: st.sogKn,
    awsKn: s.awsKn,
    heelDeg: s.heelDeg,
  });
  updateTransient(st, {
    headingDeg: s.headingTrueDeg ?? 0,
    heelDeg: s.heelDeg ?? 0,
    awaDeg: s.awaDeg ?? 0,
    timestampS: s.timestampS,
  });

  // --- Eligibility (SPEC §6.1) ------------------------------------------
  const motoring = s.propulsionState === "started";
  const eligible =
    gpsReliable &&
    !motoring &&
    !st.fouled &&
    !st.transient &&
    st.sogKn != null &&
    st.cogDeg != null &&
    s.stwKn != null &&
    s.headingTrueDeg != null;

  let observation = null;
  if (eligible) {
    observation = computeObservation({
      stwKn: s.stwKn,
      headingTrueDeg: s.headingTrueDeg,
      sogKn: st.sogKn,
      cogDeg: st.cogDeg,
      current: s.current,
      lookupLeewayDeg: s.lookupLeewayDeg,
      lookupSpeedLoss: s.lookupSpeedLoss,
    });
  }

  return {
    observation,
    eligible,
    fouled: st.fouled,
    transient: st.transient,
  };
}

module.exports = {
  TrainingState,
  detectFouling,
  updateTransient,
  classifyManeuver,
  detectManeuver,
  isGpsReliable,
  computeObservation,
  tick,
  // tunables exported for tests
  STW_STOP_KN,
  SOG_MOVING_KN,
  AWS_MOVING_KN,
  ROT_TRANSIENT_DEG_S,
  SETTLE_SUSTAIN_S,
  STABILIZE_HEEL_DEG,
  STABILIZE_AWA_DEG,
  STABILIZE_HEADING_DEG,
  GROSS_JUMP_NM,
  GROUND_TRUTH_ALPHA,
  TACK_AWA_MAX_DEG,
  GYBE_AWA_MAX_DEG,
};
