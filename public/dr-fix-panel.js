/**
 * `<dr-fix-panel>` — "Fix at coordinates" confirm dialog (SPEC §9.1/§9.3).
 *
 * Generalizes the one-tap GPS reality check into a reviewable point fix:
 * opens prefilled with the live GNSS position (which the watchkeeper can
 * accept unchanged — the GPS reality-check case) and editable coordinates
 * covering fixes taken offline (paper forms, backdated) or at a known
 * location (a berth). Shows GNSS fix-quality stats (system, fix method,
 * satellites, HDOP + error estimate) when the receiver publishes them.
 *
 * Coordinate entry uses the same structured deg/min/sec/hemisphere (or
 * decimal) sub-fields as the sight panel's LOP/celestial forms
 * (dr-coord-fields.js), driven by the server-configured position
 * format; body shaping lives in dr-viewmodel.js (pure, tested). This
 * component is the DOM adapter, mirroring `<dr-sight-panel>`.
 *
 * @file dr-fix-panel.js
 */

import {
  buildCoordFieldset,
  COORD_FIELD_CSS,
  clearCoordDirty,
  readCoordData,
  seedCoord,
} from "./dr-coord-fields.js";
import { THEME_CSS } from "./dr-theme.js";
import * as vm from "./dr-viewmodel.js";

/** Signal K plugin REST mount (kept in sync with dr-app.js). */
const API = "/plugins/signalk-dead-reckoning";

const template = document.createElement("template");
template.innerHTML = /* html */ `
  <style>
    ${THEME_CSS}
    ${COORD_FIELD_CSS}
    :host { display: block; padding: 1rem; --theme-color: var(--color-teal); }
    h2 { justify-content: space-between; }
    .gnss {
      margin: 0 0 0.75rem 0;
      padding: 0.6rem;
      background: var(--bg-panel-muted);
      border: 1px solid rgba(255, 255, 255, 0.1);
      font-size: 0.8rem;
      color: var(--text-muted);
      font-family: ui-monospace, "Fira Code", monospace;
    }
    .gnss dl {
      margin: 0;
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 0.15rem 0.75rem;
    }
    .gnss dt { color: var(--text-muted); }
    .gnss dd { margin: 0; color: var(--text-main); }
    .form { display: grid; gap: 0.75rem; }
    label {
      display: flex;
      flex-direction: column;
      font-size: 0.75rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--text-muted);
      gap: 0.2rem;
    }
    .row { display: flex; gap: 0.75rem; flex-wrap: wrap; }
    .row > label { flex: 1; min-width: 8rem; }
    .fix-time { display: flex; gap: 0.75rem; align-items: end; }
    .fix-time > label { flex: 1; }
    .fix-time .tz-toggle select { min-width: 6rem; }
    .hint {
      margin: 0.25rem 0 0 0;
      font-size: 0.72rem;
      font-weight: 400;
      text-transform: none;
      letter-spacing: 0;
      color: var(--text-muted);
    }
    .actions {
      display: flex;
      gap: 0.5rem;
      margin-top: 0.75rem;
      align-items: center;
      flex-wrap: wrap;
    }
    .actions button.primary { --theme-color: var(--color-green); }
    .result {
      margin-top: 0.5rem;
      padding: 0.6rem;
      background: var(--bg-panel-muted);
      border: 1px solid rgba(107, 158, 120, 0.4);
      font: 0.8rem/1.5 ui-monospace, "Fira Code", monospace;
      color: var(--color-green);
      white-space: pre-wrap;
    }
    .error {
      font-size: 0.8rem;
      margin-top: 0.5rem;
      font-family: ui-monospace, "Fira Code", monospace;
    }
  </style>
  <div class="panel">
    <h2>Fix at coordinates
      <button id="close-btn" title="Close">✕</button>
    </h2>
    <div class="gnss" id="gnss-stats"></div>
    <form class="form" id="form-fix">
      <fieldset class="coord" data-prefix="fix">
        <legend>Position</legend>
        <div class="coord-lat"></div>
        <div class="coord-lon"></div>
      </fieldset>
      <p class="hint">Same entry as the sight forms — format follows the server configuration (decimal, DM or DMS).</p>
      <label>Source
        <select name="source_type">
          <option value="gps">GNSS (live fix, coordinates as received)</option>
          <option value="manual">Manual entry (known position, e.g. berth)</option>
          <option value="backfill">Backfill (recorded after the fact)</option>
        </select>
      </label>
      <div class="fix-time">
        <label>Fix time
          <input name="fix_time" type="datetime-local" step="1" required />
        </label>
        <label class="tz-toggle" title="Switch between local time and UTC">
          <select name="fix_tz">
            <option value="local">local</option>
            <option value="utc">UTC</option>
          </select>
        </label>
      </div>
      <div class="row">
        <label>Est. error radius (nm)
          <input name="estimated_error_nm" type="number" step="0.001" min="0" />
        </label>
        <label>Notes
          <input name="notes" placeholder="e.g. berth 12, guest harbour" />
        </label>
      </div>
      <div class="actions">
        <button type="button" class="primary" id="confirm-btn">Confirm fix</button>
      </div>
    </form>
    <div class="result" id="result" hidden></div>
    <div class="error" id="error" hidden></div>
  </div>
`;

class DrFixPanel extends HTMLElement {
  constructor() {
    super();
    // Default to DMS (matches the plugin default); updated when the
    // server config loads.
    this.setAttribute("data-pos-format", "dms");
    const root = this.attachShadow({ mode: "open" });
    root.appendChild(template.content.cloneNode(true));

    // Structured coordinate entry — same fields as the sight panel.
    /** @type {HTMLFieldSetElement|null} */
    this.coordFs = root.querySelector('fieldset.coord[data-prefix="fix"]');
    if (this.coordFs) buildCoordFieldset(this.coordFs);

    /** @type {HTMLFormElement|null} */
    this.form = root.querySelector("#form-fix");
    /** @type {HTMLElement|null} */
    this.errorEl = root.querySelector("#error");
    /** @type {HTMLElement|null} */
    this.resultEl = root.querySelector("#result");
    /** @type {HTMLSelectElement|null} */
    this.tzSel = root.querySelector('select[name="fix_tz"]');
    /** @type {HTMLSelectElement|null} */
    this.sourceSel = root.querySelector('select[name="source_type"]');
    this.tzSel.value = this.loadTz();

    /** @type {number|null} auto-close timer after a successful confirm */
    this.closeTimer = null;
    /** Whether the user chose the source type themselves this dialog. */
    this.sourceTouched = false;
    /** Last-seeded GNSS position ([lat, lon]) for live re-seeding. */
    this.lastPosition = null;
    /** Last-seeded GNSS quality object for live re-seeding. */
    this.lastGnss = null;

    root
      .querySelector("#confirm-btn")
      ?.addEventListener("click", () => this.confirm());
    root
      .querySelector("#close-btn")
      ?.addEventListener("click", () => this.dispatchClose());

    // Editing a prefilled coordinate means the fix is no longer the
    // as-received GNSS position — switch the source to manual once (the
    // watchkeeper can still override, e.g. to backfill). The per-field
    // dirty flags also stop live GNSS re-seeding from overwriting the
    // edit.
    this.coordFs?.addEventListener("input", (e) => {
      e.target.dataset.dirty = "true";
      if (this.sourceSel?.value === "gps" && !this.sourceTouched) {
        this.sourceSel.value = "manual";
      }
    });
    this.sourceSel?.addEventListener("change", () => {
      this.sourceTouched = true;
    });

    // Timezone toggle: re-express the current fix time in the newly
    // selected zone and persist the choice (shared with the sight panel
    // so the app has one time-entry preference).
    this.tzSel?.addEventListener("change", () => {
      this.saveTz(this.tzSel.value);
      const input = this.form?.querySelector('input[name="fix_time"]');
      if (!input?.value) return;
      const other = this.tzSel.value === "utc" ? "local" : "utc";
      const iso = vm.sightTimeToIso(input.value, other);
      if (iso) input.value = vm.isoToSightTimeInput(iso, this.tzSel.value);
    });
  }

  /** localStorage key — shared with the sight panel's tz preference. */
  static get TZ_KEY() {
    return "dr-sight-tz";
  }

  /**
   * @returns {"local"|"utc"}
   */
  loadTz() {
    try {
      const v = localStorage.getItem(DrFixPanel.TZ_KEY);
      return v === "utc" ? "utc" : "local";
    } catch {
      return "local";
    }
  }

  /**
   * @param {"local"|"utc"} tz
   * @returns {void}
   */
  saveTz(tz) {
    try {
      localStorage.setItem(DrFixPanel.TZ_KEY, tz);
    } catch {
      /* storage unavailable — keep the session value */
    }
  }

  /**
   * Full prefill for a dialog open. Coordinates come in as a
   * [lat, lon] pair (or null when no GNSS fix is known — the manual /
   * known-berth case), quality data as the vm gnss shape. The fix time
   * defaults to now; the error estimate to the HDOP-based figure when
   * available.
   *
   * @param {{position: [number, number]|null, gnss: object|null}} seed
   * @returns {void}
   */
  seed({ position, gnss }) {
    if (this.closeTimer != null) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    this.lastPosition = position;
    this.lastGnss = gnss;
    this.sourceTouched = false;
    this.form?.reset();
    // form.reset() clears values but not our dirty flags — clear them
    // so a re-opened dialog re-seeds everything.
    if (this.coordFs) clearCoordDirty(this.coordFs);
    this.tzSel.value = this.loadTz();
    this.renderGnssStats(gnss);
    this.sourceSel.value = position ? "gps" : "manual";
    if (position) this.fillCoords(position);
    const errNm = vm.hdopErrorNm(gnss?.hdop);
    this.form.querySelector('input[name="estimated_error_nm"]').value =
      errNm != null ? errNm.toFixed(3) : "";
    this.form.querySelector('input[name="fix_time"]').value =
      vm.isoToSightTimeInput(new Date().toISOString(), this.loadTz());
    this.hideError();
    if (this.resultEl) this.resultEl.hidden = true;
  }

  /**
   * Live update while the dialog is open: refreshes the GNSS stats and
   * re-seeds coordinates/error estimate the user hasn't edited, so the
   * GPS-sync case stays current even while the dialog is pondered.
   *
   * @param {{position: [number, number]|null, gnss: object|null}} live
   * @returns {void}
   */
  updateGnss({ position, gnss }) {
    if (position) this.lastPosition = position;
    if (gnss) this.lastGnss = gnss;
    this.renderGnssStats(this.lastGnss);
    // Re-seed the structured fields — seedCoord skips any sub-field
    // the user has edited, so partial edits survive live updates.
    if (this.lastPosition) this.fillCoords(this.lastPosition);
    const errDirty =
      this.form?.querySelector('input[name="estimated_error_nm"]')?.dataset
        .dirty === "true";
    if (!errDirty) {
      const errNm = vm.hdopErrorNm(this.lastGnss?.hdop);
      this.form.querySelector('input[name="estimated_error_nm"]').value =
        errNm != null ? errNm.toFixed(3) : "";
    }
  }

  /**
   * Fills the coordinate inputs from a [lat, lon] pair in the
   * configured position format (per-field dirty skipping inside
   * seedCoord).
   *
   * @param {[number, number]} position
   * @returns {void}
   */
  fillCoords(position) {
    if (!this.coordFs) return;
    seedCoord(this.coordFs, "lat", position[0]);
    seedCoord(this.coordFs, "lon", position[1]);
  }

  /**
   * Sets the position format shown in the coordinate fieldset
   * (decimal / DM / DMS), mirroring the sight panel: toggles the
   * data-pos-format host attribute and re-seeds non-dirty fields from
   * the last known position.
   *
   * @param {"decimal"|"dm"|"dms"} format
   * @returns {void}
   */
  applyFormat(format) {
    if (format === "decimal" || format === "dm" || format === "dms") {
      this.setAttribute("data-pos-format", format);
      if (this.lastPosition) this.fillCoords(this.lastPosition);
    }
  }

  /**
   * Renders the GNSS fix-quality stats block.
   *
   * @param {object|null} gnss
   * @returns {void}
   */
  renderGnssStats(gnss) {
    const el = this.shadowRoot.querySelector("#gnss-stats");
    const rows = vm.gnssStats(gnss);
    if (rows.length === 0) {
      el.textContent =
        "No GNSS fix-quality data available (receiver doesn't publish it, or no fix yet).";
      return;
    }
    el.innerHTML = "";
    const dl = document.createElement("dl");
    for (const row of rows) {
      const dt = document.createElement("dt");
      dt.textContent = row.label;
      const dd = document.createElement("dd");
      dd.textContent = row.value;
      dl.appendChild(dt);
      dl.appendChild(dd);
    }
    el.appendChild(dl);
  }

  /**
   * @returns {Record<string, string>}
   */
  readForm() {
    const data = {};
    if (!this.form) return data;
    for (const el of this.form.querySelectorAll("input, select")) {
      if (el.name) data[el.name] = el.value;
    }
    return data;
  }

  /**
   * Validates the form, POSTs the point fix, and shows the snap result
   * (SPEC §9.3: deviation surfaced as immediate feedback) before
   * auto-closing.
   *
   * @returns {Promise<void>}
   */
  async confirm() {
    this.hideError();
    if (this.resultEl) this.resultEl.hidden = true;
    const data = this.readForm();
    const format = this.getAttribute("data-pos-format") ?? "dms";
    const latitude = readCoordData(data, "fix", "lat", format);
    const longitude = readCoordData(data, "fix", "lon", format);
    if (latitude == null || longitude == null) {
      this.showError("latitude and longitude are required");
      return;
    }
    data.latitude = latitude;
    data.longitude = longitude;
    let body;
    try {
      body = vm.pointFixBody(data);
    } catch (err) {
      this.showError(err.message);
      return;
    }
    const btn = this.shadowRoot.querySelector("#confirm-btn");
    btn.disabled = true;
    try {
      const res = await fetch(`${API}/fix`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.message || `HTTP ${res.status}`);
      this.showResult(result);
      this.dispatchEvent(
        new CustomEvent("dr-fix-confirmed", {
          bubbles: true,
          composed: true,
          detail: result,
        }),
      );
      // Leave the result readable briefly, then close.
      this.closeTimer = setTimeout(() => this.dispatchClose(), 2500);
    } catch (err) {
      this.showError(err.message);
    } finally {
      btn.disabled = false;
    }
  }

  /**
   * Renders the post-confirm feedback line.
   *
   * @param {object} result - POST /fix response
   * @returns {void}
   */
  showResult(result) {
    if (!this.resultEl) return;
    const lines = [`Fix #${result.fix_id} recorded`];
    if (result.recorded_correction && Number.isFinite(result.deviation_nm)) {
      const brg = String(Math.round(result.deviation_bearing)).padStart(3, "0");
      lines.push(
        `DR origin moved ${Number(result.deviation_nm).toFixed(2)} nm / ${brg}°`,
      );
    }
    this.resultEl.textContent = lines.join("\n");
    this.resultEl.hidden = false;
  }

  /** @returns {void} */
  dispatchClose() {
    if (this.closeTimer != null) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    this.dispatchEvent(
      new CustomEvent("dr-close", { bubbles: true, composed: true }),
    );
  }

  /**
   * @param {string} msg
   * @returns {void}
   */
  showError(msg) {
    if (!this.errorEl) return;
    this.errorEl.textContent = msg;
    this.errorEl.hidden = false;
  }

  /** @returns {void} */
  hideError() {
    if (this.errorEl) this.errorEl.hidden = true;
  }
}

customElements.define("dr-fix-panel", DrFixPanel);
