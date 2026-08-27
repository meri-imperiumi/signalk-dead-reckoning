/**
 * `<dr-current-panel>` — manual set & drift entry (SPEC §6.2 tier 1:
 * watchstander input outranks every automatic current source while its
 * TTL lasts).
 *
 * Shows the currently resolved vector (and any active override with
 * its remaining TTL), then lets the watchkeeper set a manual
 * set/drift with a TTL (PUT /current/manual) or clear it (DELETE).
 * Always human-initiated, like OVERRIDE. On change the app re-reads
 * GET /status so the header figure updates.
 *
 * @file dr-current-panel.js
 */

import { THEME_CSS } from "./dr-theme.js";

/** Signal K plugin REST mount (kept in sync with dr-app.js). */
const API = "/plugins/signalk-dead-reckoning";

const template = document.createElement("template");
template.innerHTML = /* html */ `
  <style>
    ${THEME_CSS}
    :host {
      display: block;
      padding: 1rem;
      /* Alternate-power semantics: a manual vector outranks the
         automatic hierarchy — orange like OVERRIDE. */
      --theme-color: var(--color-orange);
      --theme-color-rgb: var(--color-orange-rgb);
    }
    h2 { justify-content: space-between; }
    .active {
      margin: 0 0 0.75rem 0;
      padding: 0.6rem;
      background: var(--bg-panel-muted);
      border: 1px solid rgba(255, 255, 255, 0.1);
      font: 0.8rem/1.6 ui-monospace, "Fira Code", monospace;
      color: var(--text-main);
    }
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
    .hint {
      margin: 0;
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
    .actions button.primary { --theme-color: var(--color-orange); }
    .actions button.danger { --theme-color: var(--color-red); }
    .result {
      margin-top: 0.5rem;
      padding: 0.6rem;
      background: var(--bg-panel-muted);
      border: 1px solid rgba(199, 123, 40, 0.4);
      font: 0.8rem/1.5 ui-monospace, "Fira Code", monospace;
      color: var(--color-orange);
      white-space: pre-wrap;
    }
    .error {
      font-size: 0.8rem;
      margin-top: 0.5rem;
      font-family: ui-monospace, "Fira Code", monospace;
    }
  </style>
  <div class="panel">
    <h2>Set &amp; Drift
      <button id="close-btn" title="Close">✕</button>
    </h2>
    <div class="active" id="active-stats">Reading current state…</div>
    <form class="form" id="form-current">
      <div class="row">
        <label>Set (° true)
          <input name="set_true" type="number" step="0.1" required />
        </label>
        <label>Drift (kn)
          <input name="drift" type="number" step="0.01" min="0" required />
        </label>
      </div>
      <div class="row">
        <label>Valid for (minutes)
          <input name="ttl_minutes" type="number" min="1" max="1440" step="1" value="60" />
        </label>
      </div>
      <p class="hint">Set is the direction the current flows toward. The manual override outranks weather and pilot-chart sources until its TTL expires — DR integrates it immediately.</p>
      <div class="actions">
        <button type="button" class="primary" id="set-btn">Set override</button>
        <button type="button" class="danger" id="clear-btn" disabled>Clear override</button>
      </div>
    </form>
    <div class="result" id="result" hidden></div>
    <div class="error" id="error" hidden></div>
  </div>
`;

class DrCurrentPanel extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.appendChild(template.content.cloneNode(true));

    /** @type {HTMLFormElement|null} */
    this.form = root.querySelector("#form-current");
    /** @type {HTMLElement|null} */
    this.errorEl = root.querySelector("#error");
    /** @type {HTMLElement|null} */
    this.resultEl = root.querySelector("#result");
    /** @type {HTMLButtonElement|null} */
    this.clearBtn = root.querySelector("#clear-btn");

    root
      .querySelector("#set-btn")
      ?.addEventListener("click", () => this.setOverride());
    this.clearBtn?.addEventListener("click", () => this.clearOverride());
    root
      .querySelector("#close-btn")
      ?.addEventListener("click", () => this.dispatchClose());

    /** @type {number|null} auto-close timer after a successful action */
    this.closeTimer = null;
  }

  /**
   * Loads GET /status, renders the active vector + override state, and
   * prefills the form from the resolved vector (the watchkeeper
   * typically nudges the measured values rather than typing from
   * scratch).
   *
   * @returns {Promise<void>}
   */
  async refresh() {
    this.hideError();
    if (this.resultEl) this.resultEl.hidden = true;
    try {
      const res = await fetch(`${API}/status`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      this.renderActive(body);
    } catch (err) {
      const el = this.shadowRoot.querySelector("#active-stats");
      el.textContent = `Current state unavailable (${err.message})`;
    }
  }

  /**
   * Renders the active-vector block and prefills the form.
   *
   * @param {object} status - GET /status body
   * @returns {void}
   */
  renderActive(status) {
    const el = this.shadowRoot.querySelector("#active-stats");
    const c = status.current;
    el.innerHTML = "";
    if (c && Number.isFinite(c.setTrue)) {
      const set = String(Math.round(c.setTrue)).padStart(3, "0");
      const line = document.createElement("div");
      line.textContent = `Active: ${set}° · ${Number(c.drift || 0).toFixed(1)} kn (${c.source})`;
      el.appendChild(line);
      if (status.manualCurrent) {
        const minLeft = Math.max(
          0,
          Math.ceil((status.manualCurrent.validUntilMs - Date.now()) / 60_000),
        );
        const over = document.createElement("div");
        over.textContent = `Manual override active — ${minLeft} min left${status.manualCurrent.setBy ? `, set by ${status.manualCurrent.setBy}` : ""}`;
        el.appendChild(over);
      }
      // Prefill from the resolved vector (rounded to the input step).
      this.form.querySelector('input[name="set_true"]').value = String(
        Math.round(c.setTrue * 10) / 10,
      );
      this.form.querySelector('input[name="drift"]').value = String(
        Math.round((Number(c.drift) || 0) * 100) / 100,
      );
    } else {
      el.textContent = "No current vector resolved (zero vector in use).";
    }
    if (this.clearBtn) this.clearBtn.disabled = !status.manualCurrent;
  }

  /**
   * PUTs the manual override.
   *
   * @returns {Promise<void>}
   */
  async setOverride() {
    this.hideError();
    if (this.resultEl) this.resultEl.hidden = true;
    const setTrue = Number(
      this.form.querySelector('input[name="set_true"]').value,
    );
    const drift = Number(this.form.querySelector('input[name="drift"]').value);
    const ttlMinutes = Number(
      this.form.querySelector('input[name="ttl_minutes"]').value,
    );
    if (!Number.isFinite(setTrue) || !Number.isFinite(drift) || drift < 0) {
      this.showError("set (° true) and drift (kn ≥ 0) are required");
      return;
    }
    try {
      const res = await fetch(`${API}/current/manual`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          setTrue,
          drift,
          ttlMinutes:
            Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? ttlMinutes : 60,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      if (this.resultEl) {
        this.resultEl.textContent = `Override set — ${Math.round(data.manualCurrent.setTrue)}° · ${data.manualCurrent.drift.toFixed(1)} kn, valid ${Math.round((data.manualCurrent.validUntilMs - data.manualCurrent.setAtMs) / 60_000)} min`;
        this.resultEl.hidden = false;
      }
      this.dispatchEvent(
        new CustomEvent("dr-current-changed", {
          bubbles: true,
          composed: true,
        }),
      );
      this.autoClose();
    } catch (err) {
      this.showError(err.message);
    }
  }

  /**
   * DELETEs the override — the resolver falls back down the §6.2
   * hierarchy on the next tick.
   *
   * @returns {Promise<void>}
   */
  async clearOverride() {
    this.hideError();
    if (this.resultEl) this.resultEl.hidden = true;
    try {
      const res = await fetch(`${API}/current/manual`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      if (this.resultEl) {
        this.resultEl.textContent = "Override cleared";
        this.resultEl.hidden = false;
      }
      this.dispatchEvent(
        new CustomEvent("dr-current-changed", {
          bubbles: true,
          composed: true,
        }),
      );
      this.autoClose();
    } catch (err) {
      this.showError(err.message);
    }
  }

  /** @returns {void} */
  autoClose() {
    if (this.closeTimer != null) clearTimeout(this.closeTimer);
    this.closeTimer = setTimeout(() => this.dispatchClose(), 2500);
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

customElements.define("dr-current-panel", DrCurrentPanel);
