/**
 * `<dr-detail-popover>` — map-click detail + edit/delete affordance
 * (work doc #13 update #1). The map-side counterpart to the pending
 * list: both manipulate the same records via the same stage-D CRUD
 * routes.
 *
 * Shows the record's fields (LOP: type, object, bearing/azimuth,
 * position, timestamp, pending/attached state; CPL: object, center,
 * radius; fix: source, position, error radius, confirmed-by, attached
 * observation ids) with actions:
 *   - **Edit** (LOP/CPL): dispatches `dr-edit-observation` — dr-app
 *     opens the sight-entry form pre-seeded (submit PUTs). Fixes edit
 *     their notes/confirmed-by inline via PUT /fix/:id (position is
 *     guarded server-side).
 *   - **Delete**: confirm dialog → DELETE route. Fix deletion warns
 *     that its observations return to pending.
 *
 * @file dr-detail-popover.js
 */

import * as posfmt from "./dr-position-format.js";

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
      min-width: 44px;
      min-height: 44px;
      border: 1px solid #2d3748;
      border-radius: 4px;
      background: #1a202c;
      color: var(--dr-fg, #e6edf3);
      cursor: pointer;
    }
    dl {
      margin: 0 0 0.5rem 0;
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 0.15rem 0.75rem;
      font-size: 0.85rem;
    }
    dt { color: var(--dr-muted, #8b949e); }
    dd { margin: 0; color: var(--dr-fg, #e6edf3); word-break: break-word; }
    .actions { display: flex; gap: 0.5rem; margin-top: 0.5rem; flex-wrap: wrap; }
    .actions button {
      font: inherit;
      padding: 0.5rem 0.9rem;
      min-height: 44px;
      border-radius: 6px;
      border: 1px solid #2d3748;
      background: #1a202c;
      color: var(--dr-fg, #e6edf3);
      cursor: pointer;
    }
    .actions button.danger { border-color: #f85149; color: #f85149; }
    .actions button:disabled { opacity: 0.4; cursor: not-allowed; }
    label {
      display: flex;
      flex-direction: column;
      font-size: 0.8rem;
      color: var(--dr-muted, #8b949e);
      gap: 0.2rem;
      margin-top: 0.5rem;
    }
    input, textarea {
      font: inherit;
      padding: 0.4rem;
      border: 1px solid #2d3748;
      border-radius: 4px;
      background: #0d1117;
      color: var(--dr-fg, #e6edf3);
    }
    .warn {
      margin-top: 0.5rem;
      font-size: 0.78rem;
      color: #f0b429;
    }
    .error {
      color: #f85149;
      font-size: 0.8rem;
      margin-top: 0.5rem;
    }
  </style>
  <div class="panel">
    <h2 id="title">Detail
      <button id="close-btn" title="Close">✕</button>
    </h2>
    <dl id="fields"></dl>
    <div class="actions" id="actions"></div>
    <div id="edit-area" hidden></div>
    <p class="warn" id="warn" hidden></p>
    <div class="error" id="error" hidden></div>
  </div>
`;

class DrDetailPopover extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.appendChild(template.content.cloneNode(true));

    /** @type {{kind: string, id: number, row: object}|null} */
    this.record = null;

    root
      .querySelector("#close-btn")
      .addEventListener("click", () => this.dispatchClose());
    this.errorEl = root.querySelector("#error");
    this.warnEl = root.querySelector("#warn");
  }

  /**
   * Shows a record. `row` is the db row from the app's overlay fetches
   * (GET /observations, /fixes).
   *
   * @param {{kind: "lop"|"cpl"|"fix", id: number, row: object}} record
   * @param {object} [context] - { lops, cpls } for fix attachment info
   * @returns {void}
   */
  show(record, context = {}) {
    this.record = record;
    this.hideError();
    this.warnEl.hidden = true;
    const editArea = this.shadowRoot.querySelector("#edit-area");
    editArea.hidden = true;
    editArea.innerHTML = "";
    this.renderFields(context);
    this.renderActions(context);
  }

  /** @returns {void} */
  dispatchClose() {
    this.dispatchEvent(
      new CustomEvent("dr-close", { bubbles: true, composed: true }),
    );
  }

  /**
   * @param {object} context
   * @returns {Array<{label: string, value: string}>}
   */
  fieldRows(context) {
    const { kind, row } = this.record;
    if (kind === "lop") {
      return [
        { label: "Type", value: `${row.lop_type ?? ""} LOP` },
        { label: "Object", value: row.body_or_object ?? "—" },
        {
          label: "Bearing",
          value: `${((((row.azimuth_true ?? 0) - 90) % 360) + 360) % 360}° true`,
        },
        {
          label: "Position",
          value: `${posfmt.fmt(row.assumed_lat, "lat")} ${posfmt.fmt(row.assumed_lon, "lon")}`,
        },
        { label: "Time", value: row.timestamp ?? "—" },
        {
          label: "State",
          value:
            row.used_in_fix_id != null
              ? `attached to fix #${row.used_in_fix_id}`
              : "pending",
        },
      ];
    }
    if (kind === "cpl") {
      return [
        { label: "Type", value: `${row.cpl_type ?? ""} CPL` },
        { label: "Object", value: row.source_object ?? "—" },
        {
          label: "Center",
          value: `${posfmt.fmt(row.center_lat, "lat")} ${posfmt.fmt(row.center_lon, "lon")}`,
        },
        { label: "Radius", value: `${(row.radius_nm ?? 0).toFixed(2)} nm` },
        { label: "Time", value: row.timestamp ?? "—" },
        {
          label: "State",
          value:
            row.used_in_fix_id != null
              ? `attached to fix #${row.used_in_fix_id}`
              : "pending",
        },
      ];
    }
    const attached = [
      ...(context.lops ?? [])
        .filter((l) => l.used_in_fix_id === row.fix_id)
        .map((l) => `LOP #${l.lop_id}`),
      ...(context.cpls ?? [])
        .filter((c) => c.used_in_fix_id === row.fix_id)
        .map((c) => `CPL #${c.cpl_id}`),
    ];
    return [
      { label: "Fix", value: `#${row.fix_id}` },
      { label: "Source", value: row.source_type ?? "—" },
      {
        label: "Position",
        value: `${posfmt.fmt(row.latitude, "lat")} ${posfmt.fmt(row.longitude, "lon")}`,
      },
      { label: "Time", value: row.timestamp ?? "—" },
      {
        label: "Error radius",
        value:
          row.estimated_error_radius != null
            ? `${row.estimated_error_radius.toFixed(2)} nm`
            : "—",
      },
      { label: "Confirmed by", value: row.confirmed_by ?? "—" },
      { label: "Observations", value: attached.join(", ") || "point fix" },
    ];
  }

  /**
   * @param {object} context
   * @returns {void}
   */
  renderFields(context) {
    const dl = this.shadowRoot.querySelector("#fields");
    dl.innerHTML = "";
    const { kind, row } = this.record;
    this.shadowRoot.querySelector("#title").firstChild.textContent =
      kind === "lop"
        ? `LOP #${row.lop_id} `
        : kind === "cpl"
          ? `CPL #${row.cpl_id} `
          : `Fix #${row.fix_id} `;
    for (const f of this.fieldRows(context)) {
      const dt = document.createElement("dt");
      dt.textContent = f.label;
      const dd = document.createElement("dd");
      dd.textContent = f.value;
      dl.appendChild(dt);
      dl.appendChild(dd);
    }
  }

  /**
   * @param {object} context
   * @returns {void}
   */
  renderActions(context) {
    const { kind, row } = this.record;
    const area = this.shadowRoot.querySelector("#actions");
    area.innerHTML = "";

    if (kind === "fix") {
      const edit = document.createElement("button");
      edit.textContent = "Edit notes";
      edit.addEventListener("click", () => this.beginFixEdit(row));
      area.appendChild(edit);
      const del = document.createElement("button");
      del.className = "danger";
      del.textContent = "Delete fix";
      del.addEventListener("click", () => this.deleteFix(row, context));
      area.appendChild(del);
      return;
    }

    const attached = row.used_in_fix_id != null;
    const edit = document.createElement("button");
    edit.textContent = "Edit";
    edit.disabled = attached || (kind === "lop" && row.lop_type !== "bearing");
    edit.title = attached
      ? `attached to fix #${row.used_in_fix_id} — delete the fix first`
      : kind === "lop" && row.lop_type !== "bearing"
        ? "celestial LOPs must be deleted and re-reduced"
        : "edit this observation";
    edit.addEventListener("click", () => {
      this.dispatchClose();
      this.dispatchEvent(
        new CustomEvent("dr-edit-observation", {
          bubbles: true,
          composed: true,
          detail: { kind, id: this.record.id, row },
        }),
      );
    });
    area.appendChild(edit);

    const del = document.createElement("button");
    del.className = "danger";
    del.textContent = "Delete";
    del.disabled = attached;
    del.title = attached
      ? `attached to fix #${row.used_in_fix_id} — delete the fix first`
      : "delete this observation";
    del.addEventListener("click", () => this.deleteObservation());
    area.appendChild(del);

    if (attached) {
      this.warnEl.textContent = `This observation is part of confirmed fix #${row.used_in_fix_id}. Delete the fix instead — its observations return to pending.`;
      this.warnEl.hidden = false;
    }
  }

  /**
   * Inline fix-notes editor (PUT /fix/:id — position and source_type
   * are guarded server-side).
   *
   * @param {object} row
   * @returns {void}
   */
  beginFixEdit(row) {
    const area = this.shadowRoot.querySelector("#edit-area");
    area.hidden = false;
    area.innerHTML = "";
    const label = document.createElement("label");
    label.textContent = "Notes";
    const input = document.createElement("input");
    input.value = row.notes ?? "";
    label.appendChild(input);
    const save = document.createElement("button");
    save.textContent = "Save";
    save.style.marginTop = "0.5rem";
    save.addEventListener("click", async () => {
      this.hideError();
      try {
        const res = await fetch(`${API}/fix/${row.fix_id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ notes: input.value }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
        this.dispatchEvent(
          new CustomEvent("dr-observations-changed", {
            bubbles: true,
            composed: true,
          }),
        );
        this.dispatchClose();
      } catch (err) {
        this.showError(err.message);
      }
    });
    area.appendChild(label);
    area.appendChild(save);
  }

  /**
   * @returns {Promise<void>}
   */
  async deleteObservation() {
    this.hideError();
    const { kind, id } = this.record;
    if (!window.confirm(`Delete this ${kind === "lop" ? "LOP" : "CPL"}?`))
      return;
    try {
      const res = await fetch(`${API}/fix/${kind}/${id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      this.dispatchEvent(
        new CustomEvent("dr-observations-changed", {
          bubbles: true,
          composed: true,
        }),
      );
      this.dispatchClose();
    } catch (err) {
      this.showError(err.message);
    }
  }

  /**
   * @param {object} row
   * @param {object} context
   * @returns {Promise<void>}
   */
  async deleteFix(row, context) {
    this.hideError();
    const attached = [
      ...(context.lops ?? []).filter((l) => l.used_in_fix_id === row.fix_id),
      ...(context.cpls ?? []).filter((c) => c.used_in_fix_id === row.fix_id),
    ];
    const warn = attached.length
      ? `Its ${attached.length} observation(s) return to pending.`
      : "";
    if (
      !window.confirm(
        `Delete fix #${row.fix_id}? ${warn} The DR origin is NOT rewound.`,
      )
    )
      return;
    try {
      const res = await fetch(`${API}/fix/${row.fix_id}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      this.dispatchEvent(
        new CustomEvent("dr-observations-changed", {
          bubbles: true,
          composed: true,
        }),
      );
      this.dispatchClose();
    } catch (err) {
      this.showError(err.message);
    }
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

customElements.define("dr-detail-popover", DrDetailPopover);
