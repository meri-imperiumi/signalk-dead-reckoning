/**
 * Divergence advisory monitor: gradual DR-vs-GPS growth (SPEC §7.3, band 2).
 *
 * When the actual distance between the shadow-boat DR position and GPS
 * stays beyond `FACTOR ×` the uncertainty polygon's radius (work doc #2 —
 * the model's *expected* DR error growth) for a sustained interval, the
 * watchkeeper is nudged with a low-severity advisory to get a fix. This
 * is not necessarily a spoofing scenario — often just "it's been a while
 * since a confirmed fix."
 *
 * Hysteresis mirrors the tack/gybe transient suppressor in `training.js`:
 * the condition must hold for a sustained window to raise, and the
 * recovery must hold for a symmetric window to clear, so a single jittery
 * fix neither raises nor flaps the alert.
 *
 * Pure logic over an explicit state object — unit-testable without Signal
 * K plumbing. The plugin entry point feeds it divergence + radius each
 * tick and acts on the returned transitions.
 *
 * What this deliberately does *not* do:
 *  - The sudden-jump high-severity `gpsSpoofed` band (§7.3 band 1) —
 *    needs the spoofing-detector design pass (SPEC open item 1).
 *  - AIS/ADS-B corroboration (§7.4).
 *
 * @file divergence.js
 */

/**
 * Divergence (nm) must exceed FACTOR × uncertainty radius, sustained, to
 * raise the advisory. 1.5 gives the polygon model a soft margin rather
 * than firing at parity.
 */
const DEFAULT_FACTOR = 1.5;

/**
 * Seconds the exceedance must persist before the advisory raises.
 */
const DEFAULT_SUSTAIN_S = 30;

/**
 * Seconds the divergence must be back inside the expected radius before
 * the advisory clears. Symmetric with SUSTAIN_S so the alert can't flap.
 */
const DEFAULT_CLEAR_S = 30;

/**
 * Deadband (nm) on the exceedance comparison. At 2 mm this is far below
 * any instrument resolution; it exists so that a post-snap divergence of
 * floating-point epsilon (~1e-9 nm from repeated destinationPoint calls)
 * against an exactly-zero radius does not count as exceeding.
 */
const EPS_NM = 1e-6;

/**
 * Creates a fresh monitor state.
 *
 * @returns {{active: boolean, exceedS: number, insideS: number}}
 */
function createDivergenceState() {
  return {
    /** advisory currently raised */
    active: false,
    /** sustained seconds of exceedance accumulated */
    exceedS: 0,
    /** sustained seconds of recovery accumulated */
    insideS: 0,
  };
}

/**
 * Advances the monitor one tick.
 *
 * Missing input (no divergence or radius) holds the timers — no
 * progression in either direction — so a dropped GPS stream neither
 * raises nor clears on its own.
 *
 * @param {object} state - from createDivergenceState(), mutated
 * @param {object} input
 * @param {number|null} [input.divergenceNm] - DR-vs-GPS distance (nm), or
 *   null/undefined when either position is unavailable
 * @param {number|null} [input.radiusNm] - uncertainty polygon radius (nm)
 * @param {number} [input.dtS=1] - tick interval in seconds
 * @param {object} [opts]
 * @param {number} [opts.factor=DEFAULT_FACTOR]
 * @param {number} [opts.sustainS=DEFAULT_SUSTAIN_S]
 * @param {number} [opts.clearS=DEFAULT_CLEAR_S]
 * @returns {{active: boolean, transition: "raise"|"clear"|null, divergenceNm: number|null, expectedNm: number|null}}
 */
function divergenceTick(state, input, opts = {}) {
  const factor = opts.factor ?? DEFAULT_FACTOR;
  const sustainS = opts.sustainS ?? DEFAULT_SUSTAIN_S;
  const clearS = opts.clearS ?? DEFAULT_CLEAR_S;
  const dtS = input.dtS ?? 1;

  const divergenceNm =
    typeof input.divergenceNm === "number" ? input.divergenceNm : null;
  const radiusNm = typeof input.radiusNm === "number" ? input.radiusNm : null;

  if (divergenceNm == null || radiusNm == null) {
    // No data: hold timers, no transitions.
    return {
      active: state.active,
      transition: null,
      divergenceNm,
      expectedNm: null,
    };
  }

  const expectedNm = factor * radiusNm;
  let transition = null;

  if (divergenceNm > expectedNm + EPS_NM) {
    state.insideS = 0;
    state.exceedS += dtS;
    if (!state.active && state.exceedS >= sustainS) {
      state.active = true;
      transition = "raise";
    }
  } else {
    state.exceedS = 0;
    state.insideS += dtS;
    if (state.active && state.insideS >= clearS) {
      state.active = false;
      transition = "clear";
    }
  }

  return { active: state.active, transition, divergenceNm, expectedNm };
}

module.exports = {
  DEFAULT_FACTOR,
  DEFAULT_SUSTAIN_S,
  DEFAULT_CLEAR_S,
  createDivergenceState,
  divergenceTick,
};
