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
 * Coordinate inputs are free text in any supported format (decimal / DM /
 * DMS) so values can be transcribed from paper exactly as written; parsing
 * and body shaping live in dr-viewmodel.js (pure, tested). This component
 * is the DOM adapter, mirroring `<dr-sight-panel>`.
 *
 * @file dr-fix-panel.js
 */

import * as posfmt from "./dr-position-format.js";
import * as vm from "./dr-viewmodel.js";

/** Signal K plugin REST mount (kept in sync with dr-app.js). */
const API = "/plugins/signalk-dead-reckoning";

const template = document.createElement("template");
template.innerHTML = /* html */ `
  <style>
    :host { display: block; padding: 1rem; }
    h2 {
      margin: 0 0 0.75rem 0;
      font-size: 1rem;
      color: var(--dr-muted, #8b949e);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    h2 button {
      font: inherit;
      padding: 0 0.4rem;
      border: 1px solid #2d3748;
      border-radius: 4px;
      background: #1a202c;
      color: var(--dr-fg, #e6edf3);
      cursor: pointer;
    }
    .gnss {
      margin: 0 0 0.75rem 0;
      padding: 0.5rem;
      background: #0d1117;
      border: 1px solid #1f2937;
      border-radius: 4px;
      font-size: 0.8rem;
      color: var(--dr-muted, #8b949e);
    }
    .gnss dl {
      margin: 0;
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 0.15rem 0.75rem;
    }
    .gnss dt { color: var(--dr-muted, #8b949e); }
    .gnss dd { margin: 0; color: var(--dr-fg, #e6edf3); }
    .form { display: grid; gap: 0.5rem; }
    label {
      display: flex;
      flex-direction: column;
      font-size: 0.8rem;
      color: var(--dr-muted, #8b949e);
      gap: 0.2rem;
    }
    input, select {
      font: inherit;
      padding: 0.3rem 0.4rem;
      border: 1px solid #2d3748;
      border-radius: 4px;
      background: #0d1117;
      color: var(--dr-fg, #e6edf3);
    }
    input[name="latitude"], input[name="longitude"] { font-family: ui-monospace, monospace; }
    .row { display: flex; gap: 0.5rem; }
    .row > label { flex: 1; }
    .fix-time { display: flex; gap: 0.5rem; align-items: end; }
    .fix-time > label { flex: 1; }
    .hint {
      margin: -0.25rem 0 0 0;
      font-size: 0.72rem;
      color: var(--dr-muted, #8b949e);
    }
    .actions { display: flex; gap: 0.5rem; margin-top: 0.5rem; align-items: center; }
    .actions button {
      font: inherit;
      padding: 0.4rem 0.8rem;
      border-radius: 6px;
      border: 1px solid #2d3748;
      background: #1a202c;
      color: var(--dr-fg, #e6edf3);
      cursor: pointer;
    }
    .actions button.primary {
      background: #238636;
      border-color: #238636;
    }
    .actions button:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .result {
      margin-top: 0.5rem;
      padding: 0.5rem;
      background: #0d1117;
      border: 1px solid #1f2937;
      border-radius: 4px;
      font-size: 0.8rem;
      color: #56d364;
      white-space: pre-wrap;
    }
    .error {
      color: #f85149;
      font-size: 0.8rem;
      margin-top: 0.5rem;
    }
  </style>
  <div class="panel">
    <h2>Fix at coordinates
      <button id="close-btn" title="Close">✕</button>
    </h2>
    <div class="gnss" id="gnss-stats"></div>
    <form class="form" id="form-fix">
      <div class="row">
        <label>Latitude
          <input name="latitude" placeholder="60°09.300' N" required />
        </label>
        <label>Longitude
          <input name="longitude" placeholder="024°57.100' E" required />
        </label>
      </div>
      <p class="hint">Decimal degrees, DM or DMS — transcribe from paper as written.</p>
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
    const root = this.attachShadow({ mode: "open" });
    root.appendChild(template.content.cloneNode(true));

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
    // watchkeeper can still override, e.g. to backfill).
    for (const name of ["latitude", "longitude"]) {
      this.form
        .querySelector(`input[name="${name}"]`)
        ?.addEventListener("input", (e) => {
          e.target.dataset.dirty = "true";
          if (this.sourceSel?.value === "gps" && !this.sourceTouched) {
            this.sourceSel.value = "manual";
          }
        });
    }
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
    const dirty = (name) =>
      this.form?.querySelector(`input[name="${name}"]`)?.dataset.dirty ===
      "true";
    if (this.lastPosition && !dirty("latitude") && !dirty("longitude")) {
      this.fillCoords(this.lastPosition);
    }
    if (!dirty("estimated_error_nm")) {
      const errNm = vm.hdopErrorNm(this.lastGnss?.hdop);
      this.form.querySelector('input[name="estimated_error_nm"]').value =
        errNm != null ? errNm.toFixed(3) : "";
    }
  }

  /**
   * Fills the coordinate inputs from a [lat, lon] pair in the
   * configured position format.
   *
   * @param {[number, number]} position
   * @returns {void}
   */
  fillCoords(position) {
    this.form.querySelector('input[name="latitude"]').value = posfmt.fmt(
      position[0],
      "lat",
    );
    this.form.querySelector('input[name="longitude"]').value = posfmt.fmt(
      position[1],
      "lon",
    );
  }

  /**
   * Re-displays prefilled coordinates after a server-side format change
   * (skipped when the user has edited them).
   *
   * @returns {void}
   */
  refreshFormat() {
    const dirty = (name) =>
      this.form?.querySelector(`input[name="${name}"]`)?.dataset.dirty ===
      "true";
    if (this.lastPosition && !dirty("latitude") && !dirty("longitude")) {
      this.fillCoords(this.lastPosition);
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
    let body;
    try {
      body = vm.pointFixBody(data);
    } catch (err) {
      this.showError(err.message);
      return;
    }
    if (!Number.isFinite(body.latitude) || !Number.isFinite(body.longitude)) {
      this.showError("latitude and longitude are required");
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
