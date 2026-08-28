/**
 * Generic symmetric hysteresis for a boolean condition (sustained raise,
 * sustained clear), extracted from the divergence advisory monitor's
 * debounce shape so other watchkeeper alerts (§6.3 paddlewheel fouling,
 * idle-but-making-way) can't flap when a sensor hovers at a threshold.
 *
 * The condition must persist for `sustainS` before the debounced flag
 * goes true, and stay false for `clearS` before it drops — a single
 * jittery tick neither raises nor clears.
 *
 * Pure logic over an explicit state object — unit-testable without
 * Signal K plumbing.
 *
 * @file hysteresis.js
 */

/**
 * Default windows (seconds) for sensor-health style flags. Slower than
 * the divergence advisory's 30 s — fouling and idle transitions are
 * mechanical conditions that don't change meaningfully in a second, but
 * fast enough that a real fault surfaces within a watch check.
 */
const DEFAULT_SUSTAIN_S = 10;
const DEFAULT_CLEAR_S = 10;

/**
 * Creates a fresh debounce state.
 *
 * @returns {{active: boolean, exceedS: number, insideS: number}}
 */
function createFlagState() {
  return {
    /** debounced flag currently raised */
    active: false,
    /** sustained seconds of the raw condition accumulated */
    exceedS: 0,
    /** sustained seconds of the raw condition being absent */
    insideS: 0,
  };
}

/**
 * Advances the debounce one tick.
 *
 * @param {object} state - from createFlagState(), mutated
 * @param {boolean} raw - the undebounced per-tick condition
 * @param {number} dtS - tick interval in seconds
 * @param {object} [opts]
 * @param {number} [opts.sustainS=DEFAULT_SUSTAIN_S]
 * @param {number} [opts.clearS=DEFAULT_CLEAR_S]
 * @returns {{active: boolean, transition: "raise"|"clear"|null}}
 */
function flagTick(state, raw, dtS, opts = {}) {
  const sustainS = opts.sustainS ?? DEFAULT_SUSTAIN_S;
  const clearS = opts.clearS ?? DEFAULT_CLEAR_S;
  let transition = null;

  if (raw) {
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

  return { active: state.active, transition };
}

module.exports = {
  DEFAULT_SUSTAIN_S,
  DEFAULT_CLEAR_S,
  createFlagState,
  flagTick,
};
