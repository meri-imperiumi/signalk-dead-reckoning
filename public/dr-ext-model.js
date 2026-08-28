/**
 * Pure render-model for the plotter-extension status widget
 * (`dr-ext-widget.js`). Mirrors the `dr-viewmodel.js` split: geometry and
 * wording decisions live here, DOM/CSS in the widget element.
 *
 * Inputs are the flat bus values the widget subscribes to. The two headline
 * figures come from the plugin's scalar sibling paths
 * (`navigation.deadReckoning.divergence.distance` /
 * `…uncertainty.radius`, SI metres) — published exactly for consumers like
 * status tiles that don't want object subfields (SPEC §3.1).
 *
 * Severity mapping mirrors the webapp's status line (`dr-app.js`
 * renderDrState): idle→orange, idle-while-moving→red ("stale"), underway→
 * green, fouled→red, transient (tack/gybe)→orange, warm→muted.
 *
 * @file dr-ext-model.js
 */

import { elapsedText, methodLabel, metresToNm } from "./dr-viewmodel.js";

/**
 * Formats a SI metre figure as nautical miles, "—" when absent.
 *
 * @param {number|null|undefined} m
 * @returns {string} e.g. "0.42 nm"
 */
export function fmtNm(m) {
  if (m == null || !Number.isFinite(m)) return "—";
  return `${metresToNm(m).toFixed(2)} nm`;
}

/**
 * Builds the widget's whole render model from the latest bus values.
 *
 * @param {object} [v]
 * @param {{status: string, moving?: boolean, fouled?: boolean,
 *   transient?: boolean}|null} [v.state] - `navigation.deadReckoning.state`
 * @param {string|null} [v.method] - `navigation.deadReckoning.method`
 * @param {boolean|null} [v.active] - `navigation.deadReckoning.active`
 *   (OVERRIDE engaged — DR authoritative for navigation.position)
 * @param {number|null} [v.divergenceDistance] - metres, GPS↔DR
 * @param {number|null} [v.uncertaintyRadius] - metres, DR uncertainty radius
 * @param {number|null} [v.elapsedSinceFix] - seconds since last confirmed fix
 * @returns {{severity: "ok"|"warn"|"alert"|"muted", statusWord: string,
 *   method: string, sinceFix: string, override: boolean,
 *   divergence: string, uncertainty: string}}
 */
export function widgetModel(v = {}) {
  const state = v.state ?? null;
  let severity = "muted";
  let statusWord = "NO DR";
  if (state) {
    if (state.status === "idle") {
      // Idle while making way is the dangerous case — DR frozen, boat
      // sailing on. Idle on a moored boat is merely paused.
      severity = state.moving ? "alert" : "warn";
      statusWord = state.moving ? "STALE" : "IDLE";
    } else if (state.status === "underway") {
      if (state.fouled) {
        severity = "alert";
        statusWord = "FOULED";
      } else if (state.transient) {
        severity = "warn";
        statusWord = "MANEUVER";
      } else {
        severity = "ok";
        statusWord = "TRACKING";
      }
    } else if (state.status === "warm") {
      severity = state.fouled ? "alert" : "muted";
      statusWord = state.fouled ? "FOULED" : "WARM";
    }
  }
  return {
    severity,
    statusWord,
    method: methodLabel(v.method),
    sinceFix: elapsedText(v.elapsedSinceFix),
    override: Boolean(v.active),
    divergence: fmtNm(v.divergenceDistance),
    uncertainty:
      v.uncertaintyRadius == null ? "—" : `± ${fmtNm(v.uncertaintyRadius)}`,
  };
}
