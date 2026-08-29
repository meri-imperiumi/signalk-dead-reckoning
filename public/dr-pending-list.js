/**
 * `<dr-pending-list>` — first-class pending-observations surface (work
 * doc #13 stage A). Un-resolved LOPs/CPLs (`used_in_fix_id IS NULL`)
 * used to be buried in a `<ul>` inside the sight-entry modal; they are
 * work-in-progress constraints and belong alongside the map, glanceable
 * without opening the entry form.
 *
 * Rows carry a select checkbox (drives the map highlight via
 * `dr-select-observation`), and edit/delete actions (stage D's CRUD
 * routes). "Preview selected" resolves *just the selected subset* via
 * POST /fix/resolve and surfaces the candidate (stage B) — preview is
 * cheap and reversible; confirm stays the deliberate second step.
 *
 * Pure row shaping lives in dr-viewmodel.js; this is the DOM adapter.
 *
 * @file dr-pending-list.js
 */

import { THEME_CSS } from "./dr-theme.js";
import * as vm from "./dr-viewmodel.js";

/** Signal K plugin REST mount (kept in sync with dr-app.js). */
const API = "/plugins/signalk-dead-reckoning";

const template = document.createElement("template");
template.innerHTML = /* html */ `
  <style>
    ${THEME_CSS}
    :host {
      display: block;
      --theme-color: var(--color-teal);
      --theme-color-rgb: var(--color-teal-rgb);
    }
    .rows { display: flex; flex-direction: column; gap: 0.4rem; }
    .row {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.35rem 0.6rem;
      border: 1px solid rgba(255, 255, 255, 0.12);
      background: var(--bg-panel-muted);
      font-size: 0.85rem;
      color: var(--text-main);
      min-height: 48px; /* phone-first tap target */
      box-sizing: border-box;
    }
    .row.selected {
      border-color: var(--theme-color);
      background: rgba(var(--theme-color-rgb), 0.12);
    }
    .row input[type="checkbox"] { flex: 0 0 auto; }
    .icon {
      flex: 0 0 auto;
      width: 1.2rem;
      text-align: center;
      font-family: ui-monospace, "Fira Code", monospace;
    }
    .icon.lop { color: var(--color-orange); }
    .icon.cpl { color: var(--color-teal); }
    .meta { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .meta .label {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .meta .time {
      font-size: 0.72rem;
      color: var(--text-muted);
      font-family: ui-monospace, "Fira Code", monospace;
    }
    .actions { display: flex; gap: 0.5rem; flex: 0 0 auto; }
    .actions button { padding: 0 0.75rem; }
    .empty {
      font-size: 0.8rem;
      color: var(--text-muted);
      padding: 0.25rem 0;
    }
    .hint {
      font-size: 0.75rem;
      margin: 0.25rem 0 0 0;
      font-family: ui-monospace, "Fira Code", monospace;
    }
    .footer {
      display: flex;
      gap: 0.5rem;
      align-items: center;
      margin-top: 0.75rem;
      flex-wrap: wrap;
    }
    .footer button.primary { --theme-color: var(--color-green); }
    .footer .status {
      font-size: 0.75rem;
      color: var(--text-muted);
      font-family: ui-monospace, "Fira Code", monospace;
    }
    .error {
      font-size: 0.8rem;
      margin-top: 0.5rem;
      font-family: ui-monospace, "Fira Code", monospace;
    }
  </style>
  <div class="rows" id="rows"></div>
  <p class="hint" id="partner-hint" hidden></p>
  <div class="footer">
    <button id="preview-btn" class="primary" disabled>Preview selected</button>
    <button id="confirm-btn" disabled>Confirm fix</button>
    <span class="status" id="status"></span>
  </div>
  <div class="error" id="error" hidden></div>
`;

class DrPendingList extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.appendChild(template.content.cloneNode(true));

    /** @type {Array<object>} pending row specs (vm.pending*Row) */
    this.rows = [];
    /** @type {Set<string>} selected row keys ("lop:12") */
    this.selection = new Set();
    /** @type {object|null} resolved-but-unconfirmed candidate */
    this.candidate = null;
    /** Row specs by key, for re-render on selection toggle */
    this.rowsByKey = new Map();

    root
      .querySelector("#preview-btn")
      .addEventListener("click", () => this.preview());
    root
      .querySelector("#confirm-btn")
      .addEventListener("click", () => this.confirm());

    /** @type {HTMLElement|null} */
    this.errorEl = root.querySelector("#error");
    /** @type {HTMLElement|null} */
    this.statusEl = root.querySelector("#status");
  }

  /**
   * Fetches un-attached observations and re-renders. Called on load,
   * after any observation create/edit/delete, and after a fix confirm
   * or delete (both change `used_in_fix_id`).
   *
   * @returns {Promise<void>}
   */
  async refresh() {
    try {
      const res = await fetch(`${API}/observations?limit=200`);
      if (!res.ok) return;
      const data = await res.json();
      this.rows = [
        ...(data.lops ?? []).map(vm.pendingLopRow),
        ...(data.cpls ?? []).map(vm.pendingCplRow),
      ]
        .filter((r) => !r.used)
        // Oldest first — the running fix reads top-to-bottom.
        .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
      // Drop selections that no longer exist.
      for (const key of [...this.selection]) {
        if (!this.rows.some((r) => this.key(r) === key)) {
          this.selection.delete(key);
        }
      }
      if (this.candidate) {
        // A confirm/delete may have invalidated the candidate.
        const ids = new Set(
          (this.candidate.observationIds?.lopIds ?? []).map(
            (id) => `lop:${id}`,
          ),
        );
        for (const id of this.candidate.observationIds?.cplIds ?? []) {
          ids.add(`cpl:${id}`);
        }
        const stillValid = [...ids].every((k) => this.selection.has(k));
        if (!stillValid) this.clearCandidate();
      }
      this.render();
    } catch {
      /* REST unavailable — keep the in-memory rows */
    }
  }

  /** @param {object} row */
  key(row) {
    return `${row.kind}:${row.id}`;
  }

  /** @returns {void} */
  render() {
    const rowsEl = this.shadowRoot.querySelector("#rows");
    rowsEl.innerHTML = "";
    this.rowsByKey = new Map(this.rows.map((r) => [this.key(r), r]));

    if (this.rows.length === 0) {
      const el = document.createElement("p");
      el.className = "empty";
      el.textContent =
        "No pending observations — take a bearing or sight to start a fix.";
      rowsEl.appendChild(el);
    }
    for (const row of this.rows) {
      rowsEl.appendChild(this.renderRow(row));
    }

    const hint = this.shadowRoot.querySelector("#partner-hint");
    hint.hidden = !vm.needsPartner(this.rows);
    hint.textContent =
      "One observation is a constraint, not a fix — select a partner sight/bearing, or resolve it alone against the last confirmed fix as a running fix.";

    this.renderFooter();
  }

  /**
   * @param {object} row
   * @returns {HTMLElement}
   */
  renderRow(row) {
    const key = this.key(row);
    const div = document.createElement("div");
    div.className = `row kind-${row.kind}${this.selection.has(key) ? " selected" : ""}`;

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = this.selection.has(key);
    cb.addEventListener("change", () => {
      this.toggle(row, cb.checked);
    });
    div.appendChild(cb);

    const icon = document.createElement("span");
    icon.className = `icon ${row.kind}`;
    icon.textContent = row.kind === "lop" ? "╱" : "◯";
    div.appendChild(icon);

    const meta = document.createElement("div");
    meta.className = "meta";
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = row.label;
    const time = document.createElement("span");
    time.className = "time";
    const rel = vm.relativeTimeText(row.timestamp);
    time.textContent = rel;
    time.title = row.timestamp;
    meta.appendChild(label);
    meta.appendChild(time);
    div.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "actions";
    const edit = document.createElement("button");
    edit.textContent = "Edit";
    edit.title = "Edit this observation";
    edit.addEventListener("click", () => this.edit(row));
    actions.appendChild(edit);
    const del = document.createElement("button");
    del.textContent = "Del";
    del.title = "Delete this observation";
    del.addEventListener("click", () => this.remove(row));
    actions.appendChild(del);
    div.appendChild(actions);

    return div;
  }

  /**
   * Toggles selection for a row and notifies the map highlight.
   *
   * @param {object} row
   * @param {boolean} selected
   * @returns {void}
   */
  toggle(row, selected) {
    const key = this.key(row);
    if (selected) this.selection.add(key);
    else this.selection.delete(key);
    this.dispatchEvent(
      new CustomEvent("dr-select-observation", {
        bubbles: true,
        composed: true,
        detail: { kind: row.kind, id: row.id, selected },
      }),
    );
    this.render();
  }

  /** @returns {Array<{kind: string, id: number}>} */
  selectedRows() {
    return [...this.selection]
      .map((k) => this.rowsByKey.get(k))
      .filter((r) => r != null)
      .map((r) => ({ kind: r.kind, id: r.id }));
  }

  /** @returns {void} */
  renderFooter() {
    const n = this.selection.size;
    const previewBtn = this.shadowRoot.querySelector("#preview-btn");
    const confirmBtn = this.shadowRoot.querySelector("#confirm-btn");
    // One selected observation resolves as a running fix against the
    // last confirmed fix; two or more resolve as an ordinary fix.
    previewBtn.disabled = n < 1;
    previewBtn.textContent =
      n === 1
        ? "Running fix (1)"
        : n > 1
          ? `Preview selected (${n})`
          : "Preview selected";
    confirmBtn.disabled = !this.candidate;
    const runTag = this.candidate?.derived_from_fix_id ? " · running fix" : "";
    this.statusEl.textContent = this.candidate
      ? `candidate ready${runTag}${this.candidate.residual_nm != null ? ` · residual ${this.candidate.residual_nm.toFixed(2)} nm` : ""}`
      : n > 0
        ? `${n} selected`
        : "";
  }

  /**
   * Resolves the selected subset into a preview candidate (stage B).
   * Cheap and reversible — no rows are written.
   *
   * @returns {Promise<void>}
   */
  async preview() {
    this.hideError();
    const selection = this.selectedRows();
    if (selection.length < 1) return;
    try {
      const res = await fetch(`${API}/fix/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vm.resolvePreviewBody(selection)),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      this.candidate = data.candidate;
      if (vm.hasUnadvanced(this.candidate.advancements)) {
        this.showError(
          "⚠ one or more older observations could not be advanced (no DR track over the interval) — the candidate may be wrong",
        );
      }
      this.renderFooter();
      this.dispatchEvent(
        new CustomEvent("dr-candidate-resolved", {
          bubbles: true,
          composed: true,
          detail: this.candidate,
        }),
      );
    } catch (err) {
      this.showError(err.message);
    }
  }

  /** @returns {void} */
  clearCandidate() {
    this.candidate = null;
    this.renderFooter();
  }

  /**
   * Confirms the previewed candidate — the deliberate second step
   * (SPEC §9.1): writes the fix, attaches the observations, snaps DR.
   *
   * @returns {Promise<void>}
   */
  async confirm() {
    this.hideError();
    if (!this.candidate) return;
    try {
      const res = await fetch(`${API}/fix`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidate: this.candidate }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      this.candidate = null;
      this.selection.clear();
      await this.refresh();
      this.dispatchEvent(
        new CustomEvent("dr-fix-confirmed", {
          bubbles: true,
          composed: true,
          detail: data,
        }),
      );
    } catch (err) {
      this.showError(err.message);
    }
  }

  /**
   * Deletes a pending observation (stage D) and refreshes.
   *
   * @param {object} row
   * @returns {Promise<void>}
   */
  async remove(row) {
    this.hideError();
    if (!window.confirm(`Delete ${row.label}?`)) return;
    try {
      const res = await fetch(`${API}/fix/${row.kind}/${row.id}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      // The app's dr-observations-changed listener refreshes us.
      this.dispatchEvent(
        new CustomEvent("dr-observations-changed", {
          bubbles: true,
          composed: true,
        }),
      );
    } catch (err) {
      this.showError(err.message);
    }
  }

  /**
   * Dispatches an edit request — dr-app opens the sight-entry form
   * pre-seeded with the record; the form submits to the PUT route.
   *
   * @param {object} row
   * @returns {void}
   */
  edit(row) {
    this.dispatchEvent(
      new CustomEvent("dr-edit-observation", {
        bubbles: true,
        composed: true,
        detail: { kind: row.kind, id: row.id },
      }),
    );
  }

  /**
   * @param {string} msg
   * @returns {void}
   */
  showError(msg) {
    this.errorEl.textContent = msg;
    this.errorEl.hidden = false;
  }

  /** @returns {void} */
  hideError() {
    this.errorEl.hidden = true;
  }
}

customElements.define("dr-pending-list", DrPendingList);
