/**
 * `<dr-sight-panel>` — interactive observation entry (SPEC §14.1 "Manual
 * LOP & Sight Input"). Three input modes share a single panel:
 *
 *   1. Compass bearing → LOP (passes through the observer)
 *   2. Vertical-angle sight → CPL (distance to object of known height)
 *   3. Celestial sight → LOP via Marcq St. Hilaire (POST /celestial/sight)
 *
 * Submitted observations collect in a "pending" list; "Resolve" previews
 * a candidate fix, "Confirm" snaps the DR origin. `confirmed_by` is
 * shared. All REST body shaping + conversions live in dr-viewmodel.js
 * (pure, tested); this component is the DOM adapter.
 *
 * @file dr-sight-panel.js
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
    .tabs { display: flex; gap: 0.25rem; margin-bottom: 0.75rem; }
    .tabs button {
      flex: 1;
      font: inherit;
      padding: 0.4rem;
      border: 1px solid #2d3748;
      border-radius: 6px;
      background: #1a202c;
      color: var(--dr-fg, #e6edf3);
      cursor: pointer;
    }
    .tabs button.active {
      background: var(--dr-accent, #003399);
      border-color: var(--dr-accent, #003399);
    }
    .form { display: grid; gap: 0.5rem; }
    .form[hidden] { display: none; }
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
    .row { display: flex; gap: 0.5rem; }
    .row > label { flex: 1; }
    .sight-time { display: flex; gap: 0.5rem; align-items: end; }
    .sight-time > label { flex: 1; }
    .sight-time .tz-toggle { flex: 0 0 auto; }
    .sight-time .tz-toggle select { font: inherit; padding: 0.35rem; }
    .check { display: flex; align-items: center; gap: 0.4rem; }
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
    .pending {
      margin-top: 0.75rem;
      font-size: 0.8rem;
      color: var(--dr-muted, #8b949e);
    }
    .pending li { margin: 0.15rem 0; }
    .reduction {
      margin-top: 0.5rem;
      padding: 0.5rem;
      background: #0d1117;
      border: 1px solid #1f2937;
      border-radius: 4px;
      font: 0.8rem ui-monospace, monospace;
      color: #c9d1d9;
      white-space: pre-wrap;
    }
    .error {
      color: #f85149;
      font-size: 0.8rem;
      margin-top: 0.5rem;
    }
    .coord {
      border: 1px solid #1f2937;
      border-radius: 6px;
      padding: 0.5rem;
      margin: 0;
    }
    .coord legend {
      font-size: 0.8rem;
      color: var(--dr-muted, #8b949e);
      padding: 0 0.3rem;
    }
    .coord-row {
      display: flex;
      gap: 0.4rem;
      align-items: end;
      margin-bottom: 0.3rem;
    }
    .coord-row:last-child { margin-bottom: 0; }
    .coord-field {
      display: flex;
      flex-direction: column;
      font-size: 0.75rem;
      color: var(--dr-muted, #8b949e);
      gap: 0.15rem;
    }
    .coord-field input, .coord-field select {
      width: 3.5rem;
      padding: 0.25rem 0.3rem;
      font: inherit;
      border: 1px solid #2d3748;
      border-radius: 4px;
      background: #0d1117;
      color: var(--dr-fg, #e6edf3);
    }
    .coord-field input.deg { width: 2.5rem; }
    /* Decimal format: hide min/sec/hem, show a single decimal field */
    :host([data-pos-format="decimal"]) .coord-field.min,
    :host([data-pos-format="decimal"]) .coord-field.sec,
    :host([data-pos-format="decimal"]) .coord-field.hem { display: none; }
    :host([data-pos-format="decimal"]) .coord-field.dec { display: flex; }
    /* DM: hide seconds */
    :host([data-pos-format="dm"]) .coord-field.sec { display: none; }
    :host([data-pos-format="dm"]) .coord-field.dec { display: none; }
    /* DMS: show everything, hide decimal */
    :host([data-pos-format="dms"]) .coord-field.dec { display: none; }
  </style>
  <div class="panel">
    <h2>Sight &amp; LOP Input
      <button id="close-btn" title="Close">✕</button>
    </h2>
    <div class="tabs">
      <button data-tab="bearing" class="active">Bearing</button>
      <button data-tab="vertical">Vert. Angle</button>
      <button data-tab="celestial">Celestial</button>
    </div>

    <form class="form" id="form-bearing">
      <label>Object
        <input name="object" placeholder="lighthouse, tower…" />
      </label>
      <div class="row">
        <label>Bearing (° true)
          <input name="bearing_true" type="number" step="0.1" required />
        </label>
      </div>
      <div class="sight-time">
        <label>Sight time
          <input name="sight_time" type="datetime-local" step="1" required />
        </label>
        <label class="tz-toggle" title="Switch between local time and UTC">
          <select name="sight_tz">
            <option value="local">local</option>
            <option value="utc">UTC</option>
          </select>
        </label>
      </div>
      <fieldset class="coord" data-prefix="object">
        <legend>Object position (charted)</legend>
        <div class="coord-lat"></div>
        <div class="coord-lon"></div>
      </fieldset>
      <div class="actions">
        <button type="button" class="primary" data-submit="bearing">Add bearing LOP</button>
      </div>
    </form>

    <form class="form" id="form-vertical" hidden>
      <label>Object
        <input name="object" placeholder="lighthouse…" />
      </label>
      <div class="row">
        <label>Height (m)
          <input name="height_m" type="number" step="0.1" required />
        </label>
        <label>Vert. angle (°)
          <input name="angle_deg" type="number" step="0.1" required />
        </label>
        <label>Distance (nm)
          <output name="distance_nm">—</output>
        </label>
      </div>
      <div class="sight-time">
        <label>Sight time
          <input name="sight_time" type="datetime-local" step="1" required />
        </label>
        <label class="tz-toggle" title="Switch between local time and UTC">
          <select name="sight_tz">
            <option value="local">local</option>
            <option value="utc">UTC</option>
          </select>
        </label>
      </div>
      <fieldset class="coord" data-prefix="center">
        <legend>Object position</legend>
        <div class="coord-lat"></div>
        <div class="coord-lon"></div>
      </fieldset>
      <div class="actions">
        <button type="button" class="primary" data-submit="vertical">Add distance CPL</button>
      </div>
    </form>

    <form class="form" id="form-celestial" hidden>
      <label>Body
        <select name="body"></select>
      </label>
      <div class="row">
        <label>Sextant altitude Hs (°)
          <input name="hs_deg" type="number" step="0.1" required />
        </label>
        <label>Index correction (°)
          <input name="index_correction_deg" type="number" step="0.1" value="0" />
        </label>
        <label>Eye height (m)
          <input name="eye_height_m" type="number" step="0.1" value="2" />
        </label>
      </div>
      <label>Limb (Sun/Moon only)
        <select name="limb">
          <option value="">center</option>
          <option value="lower">lower</option>
          <option value="upper">upper</option>
        </select>
      </label>
      <div class="sight-time">
        <label>Sight time
          <input name="sight_time" type="datetime-local" step="1" required />
        </label>
        <label class="tz-toggle" title="Switch between local time and UTC">
          <select name="sight_tz">
            <option value="local">local</option>
            <option value="utc">UTC</option>
          </select>
        </label>
      </div>
      <label class="check" title="Meridian-altitude sight → latitude LOP only. Combine with a longitude source (another LOP/CPL) for a full fix.">
        <input type="checkbox" name="noon" />
        Noon sight (meridian latitude — latitude LOP only)
      </label>
      <fieldset class="coord" data-prefix="assumed" data-optional="true">
        <legend>Assumed position (optional — DR used when blank)</legend>
        <div class="coord-lat"></div>
        <div class="coord-lon"></div>
      </fieldset>
      <div class="actions">
        <button type="button" class="primary" data-submit="celestial">Reduce &amp; add LOP</button>
      </div>
      <div class="reduction" id="reduction" hidden></div>
    </form>

    <ul class="pending" id="pending"></ul>
    <div class="actions">
      <button type="button" id="resolve-btn" disabled>Resolve candidate</button>
      <button type="button" id="confirm-btn" disabled>Confirm fix</button>
    </div>
    <div class="error" id="error" hidden></div>
  </div>
`;

class DrSightPanel extends HTMLElement {
  constructor() {
    super();
    // Default to DMS (matches the plugin default); updated when the
    // server config loads.
    this.setAttribute("data-pos-format", "dms");
    const root = this.attachShadow({ mode: "open" });
    root.appendChild(template.content.cloneNode(true));

    this.pendingIds = { lop: [], cpl: [] };
    this.candidate = null;

    // Tab switching
    root.querySelectorAll(".tabs button").forEach((btn) => {
      btn.addEventListener("click", () => this.switchTab(btn.dataset.tab));
    });

    // Submit handlers
    root.querySelectorAll("[data-submit]").forEach((btn) => {
      btn.addEventListener("click", () => this.submit(btn.dataset.submit));
    });

    // Resolve / confirm
    root
      .querySelector("#resolve-btn")
      .addEventListener("click", () => this.resolve());
    root
      .querySelector("#confirm-btn")
      .addEventListener("click", () => this.confirm());

    // Live distance calc for vertical-angle form
    const vForm = root.querySelector("#form-vertical");
    vForm.addEventListener("input", () => this.updateVerticalDistance());

    // Timezone toggle: re-express the current sight time in the newly
    // selected zone (local ↔ UTC) so the displayed digits match the
    // selected tz instead of silently reinterpreting them. Persists the
    // choice to localStorage so it's remembered across sessions, and syncs
    // the other forms' selects + re-seeds any non-user-edited time fields.
    root.querySelectorAll('select[name="sight_tz"]').forEach((sel) => {
      sel.value = this.loadSightTz();
      sel.addEventListener("change", () => {
        this.saveSightTz(sel.value);
        // Sync the other two forms' selects to match.
        root.querySelectorAll(`select[name="sight_tz"]`).forEach((s) => {
          if (s !== sel) s.value = sel.value;
        });
        // Re-seed every non-dirty sight_time field in the new tz. A
        // dirty field is a user value — convert it to the new zone in
        // place so the digits keep meaning the same instant.
        for (const form of root.querySelectorAll(".form")) {
          const input = form.querySelector('input[name="sight_time"]');
          if (!input || !input.value) continue;
          if (input.dataset.dirty === "true") {
            const other = sel.value === "utc" ? "local" : "utc";
            const iso = vm.sightTimeToIso(input.value, other);
            if (iso) input.value = vm.isoToSightTimeInput(iso, sel.value);
          } else {
            input.value = vm.isoToSightTimeInput(
              new Date().toISOString(),
              sel.value,
            );
          }
        }
      });
    });

    // Mark assumed-position sub-fields dirty on manual edit so they
    // stop tracking the boat.
    root
      .querySelectorAll(
        'fieldset.coord[data-prefix="assumed"] input, fieldset.coord[data-prefix="assumed"] select',
      )
      .forEach((el) => {
        el.addEventListener("input", () => {
          el.dataset.dirty = "true";
        });
      });
    // Mark sight-time fields dirty on manual edit so the tz toggle
    // converts them in place rather than re-seeding to now.
    root.querySelectorAll('input[name="sight_time"]').forEach((el) => {
      el.addEventListener("input", () => {
        el.dataset.dirty = "true";
      });
    });

    root
      .querySelector("#close-btn")
      ?.addEventListener("click", () =>
        this.dispatchEvent(
          new CustomEvent("dr-close", { bubbles: true, composed: true }),
        ),
      );

    /** @type {HTMLElement|null} */
    this.errorEl = root.querySelector("#error");

    // Build structured coordinate inputs for each fieldset.
    for (const fs of this.shadowRoot.querySelectorAll("fieldset.coord")) {
      this.buildCoordFields(fs);
    }
  }

  /**
   * Populates a `.coord` fieldset's lat/lon containers with deg/min/sec/
   * hem (and decimal) inputs. Field names use the fieldset's data-prefix
   * (e.g. assumed_lat_deg, center_lon_min). Optional fieldsets mark
   * their inputs non-required.
   *
   * @param {HTMLFieldSetElement} fs
   * @returns {void}
   */
  buildCoordFields(fs) {
    const prefix = fs.dataset.prefix;
    const optional = fs.dataset.optional === "true";
    for (const kind of ["lat", "lon"]) {
      const container = fs.querySelector(`.coord-${kind}`);
      const row = document.createElement("div");
      row.className = "coord-row";
      // Decimal field (shown only in decimal mode)
      row.appendChild(
        this.coordField(`${prefix}_${kind}`, "dec", kind, optional),
      );
      // Deg / min / sec / hem fields
      row.appendChild(
        this.coordField(`${prefix}_${kind}`, "deg", kind, optional),
      );
      row.appendChild(
        this.coordField(`${prefix}_${kind}`, "min", kind, optional),
      );
      row.appendChild(
        this.coordField(`${prefix}_${kind}`, "sec", kind, optional),
      );
      row.appendChild(
        this.coordField(`${prefix}_${kind}`, "hem", kind, optional),
      );
      container.appendChild(row);
    }
  }

  /**
   * Builds a single labeled coordinate sub-field.
   *
   * @param {string} name - base name (e.g. assumed_lat)
   * @param {"deg"|"min"|"sec"|"hem"|"dec"} part
   * @param {"lat"|"lon"} kind
   * @param {boolean} optional
   * @returns {HTMLLabelElement}
   */
  coordField(name, part, kind, optional) {
    const label = document.createElement("label");
    label.className = `coord-field ${part}`;
    const cap =
      part === "deg"
        ? "°"
        : part === "min"
          ? "'"
          : part === "sec"
            ? '"'
            : part === "hem"
              ? ""
              : "dec";
    label.textContent = cap || part;
    if (part === "dec") {
      const inp = document.createElement("input");
      inp.type = "number";
      inp.step = "0.0001";
      inp.name = `${name}`;
      inp.dataset.part = part;
      if (!optional) inp.required = true;
      label.appendChild(inp);
    } else if (part === "hem") {
      const sel = document.createElement("select");
      sel.name = `${name}_hem`;
      sel.dataset.part = part;
      const blank = document.createElement("option");
      blank.value = "";
      blank.textContent = kind === "lat" ? "N/S" : "E/W";
      sel.appendChild(blank);
      for (const h of kind === "lat" ? ["N", "S"] : ["E", "W"]) {
        const opt = document.createElement("option");
        opt.value = h;
        opt.textContent = h;
        sel.appendChild(opt);
      }
      if (!optional) sel.required = true;
      label.appendChild(sel);
    } else {
      const inp = document.createElement("input");
      inp.type = "number";
      inp.step = part === "sec" ? "0.1" : "0.001";
      inp.min = "0";
      inp.name = `${name}_${part}`;
      inp.dataset.part = part;
      if (!optional) inp.required = true;
      label.appendChild(inp);
    }
    return label;
  }

  /**
   * Called by dr-app when the DR or GPS position updates, so the
   * assumed-position defaults track the boat without the user typing.
   * Only fills fields the user hasn't manually edited (dirty flag).
   *
   * @param {{latitude: number, longitude: number}|null} pos
   * @returns {void}
   */
  /**
   * Called by dr-app when the DR or GPS position updates, so the
   * assumed-position defaults track the boat without the user typing.
   * Only fills fields the user hasn't manually edited (dirty flag).
   * Seeds the structured deg/min/sec/hem (or decimal) fields.
   *
   * @param {{latitude: number, longitude: number}|null} pos
   * @returns {void}
   */
  setDefaultPosition(pos) {
    if (!pos) return;
    this.lastKnownPosition = pos;
    for (const fs of this.shadowRoot.querySelectorAll("fieldset.coord")) {
      const prefix = fs.dataset.prefix;
      // Only seed the assumed-position fieldsets (not object positions).
      if (prefix !== "assumed") continue;
      this.seedCoord(fs, "lat", pos.latitude);
      this.seedCoord(fs, "lon", pos.longitude);
    }
  }

  /**
   * Seeds one coordinate's structured fields from a degree value,
   * skipping any the user has marked dirty.
   *
   * @param {HTMLFieldSetElement} fs
   * @param {"lat"|"lon"} kind
   * @param {number} deg
   * @returns {void}
   */
  seedCoord(fs, kind, deg) {
    const prefix = fs.dataset.prefix;
    const parts = posfmt.coordParts(deg, kind);
    const set = (part, val) => {
      const el = fs.querySelector(
        `[name="${prefix}_${kind}${part === "" ? "" : `_${part}`}"`,
      );
      if (!el || el.dataset.dirty === "true") return;
      if (el.tagName === "SELECT") el.value = String(val);
      else el.value = String(val);
    };
    set("dec", deg.toFixed(4));
    set("deg", parts.deg);
    set("min", parts.min);
    if (parts.sec != null) set("sec", parts.sec);
    set("hem", parts.hem);
  }

  /**
   * Fetches the celestial body list from the plugin and populates the
   * selector. Called once by dr-app after construction.
   *
   * @returns {Promise<void>}
   */
  async loadBodies() {
    try {
      const res = await fetch(`${API}/celestial/bodies`);
      if (!res.ok) return;
      const data = await res.json();
      const select = this.shadowRoot.querySelector(
        '#form-celestial [name="body"]',
      );
      select.innerHTML = "";
      for (const body of data.bodies) {
        const opt = document.createElement("option");
        opt.value = body;
        opt.textContent = body;
        select.appendChild(opt);
      }
      if (data.expired) {
        const note = document.createElement("option");
        note.disabled = true;
        note.textContent = `⚠ almanac expired (${data.valid_until})`;
        select.appendChild(note);
      }
    } catch {
      /* panel still works without the body list */
    }
  }

  /**
   * @param {string} tab - "bearing" | "vertical" | "celestial"
   * @returns {void}
   */
  switchTab(tab) {
    this.shadowRoot.querySelectorAll(".tabs button").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === tab);
    });
    this.shadowRoot.querySelectorAll(".form").forEach((f) => {
      const id = f.id.replace("form-", "");
      f.hidden = id !== tab;
    });
  }

  /**
   * Sets the position format shown in the coordinate fieldsets (decimal /
   * DM / DMS). Toggles the `data-pos-format` host attribute, which the
   * CSS uses to show/hide the deg/min/sec/hem/decimal sub-fields.
   *
   * @param {"decimal"|"dm"|"dms"} format
   * @returns {void}
   */
  applyFormat(format) {
    if (format === "decimal" || format === "dm" || format === "dms") {
      this.setAttribute("data-pos-format", format);
      // Re-seed defaults in the new format (if not dirty).
      if (this.lastKnownPosition)
        this.setDefaultPosition(this.lastKnownPosition);
    }
  }

  /**
   * Pre-fills each form's `sight_time` field with the current time
   * when the dialog opens and the field is empty — the common case
   * (recording a sight just taken on deck) needs no typing, but the
   * navigator can still edit it for sights taken earlier. Honors the
   * saved tz choice (local or UTC). Does not overwrite a value the user
   * has already set.
   *
   * @returns {void}
   */
  seedSightTime() {
    const now = new Date().toISOString();
    const tz = this.loadSightTz();
    for (const form of this.shadowRoot.querySelectorAll(".form")) {
      const input = form.querySelector('input[name="sight_time"]');
      if (!input || input.value) continue;
      input.value = vm.isoToSightTimeInput(now, tz);
    }
  }

  /** localStorage key for the remembered sight-timezone choice. */
  static get SIGHT_TZ_KEY() {
    return "dr-sight-tz";
  }

  /**
   * Reads the remembered sight-timezone preference from localStorage.
   * @returns {"local"|"utc"}
   */
  loadSightTz() {
    try {
      const v = localStorage.getItem(DrSightPanel.SIGHT_TZ_KEY);
      return v === "utc" ? "utc" : "local";
    } catch {
      return "local";
    }
  }

  /**
   * Persists the sight-timezone preference to localStorage.
   * @param {"local"|"utc"} tz
   * @returns {void}
   */
  saveSightTz(tz) {
    try {
      localStorage.setItem(DrSightPanel.SIGHT_TZ_KEY, tz);
    } catch {
      /* storage unavailable — keep the session value */
    }
  }

  /**
   * Pre-seeds an object-position fieldset from a chart pick (right-click
   * → "Add bearing to here" / "Distance CPL at here"). Switches to the
   * matching tab and fills the object/center coordinates (overwriting any
   * prior value — a fresh pick is intentional). Used by dr-app when the
   * map dispatches `dr-pick-position`.
   *
   * @param {number} lat
   * @param {number} lon
   * @param {"bearing"|"vertical"} mode
   * @returns {void}
   */
  seedObjectPosition(lat, lon, mode) {
    const prefix = mode === "vertical" ? "center" : "object";
    const tab = mode === "vertical" ? "vertical" : "bearing";
    this.switchTab(tab);
    const fs = this.shadowRoot.querySelector(
      `fieldset.coord[data-prefix="${prefix}"]`,
    );
    if (!fs) return;
    // Force-fill (a chart pick overwrites, no dirty check).
    this.seedCoordForced(fs, "lat", lat);
    this.seedCoordForced(fs, "lon", lon);
  }

  /**
   * Like {@link seedCoord} but overwrites regardless of the dirty flag
   * (used for explicit chart picks).
   *
   * @param {HTMLFieldSetElement} fs
   * @param {"lat"|"lon"} kind
   * @param {number} deg
   * @returns {void}
   */
  seedCoordForced(fs, kind, deg) {
    const prefix = fs.dataset.prefix;
    const parts = posfmt.coordParts(deg, kind);
    const set = (part, val) => {
      const el = fs.querySelector(
        `[name="${prefix}_${kind}${part === "" ? "" : `_${part}`}"]`,
      );
      if (!el) return;
      el.value = String(val);
    };
    set("dec", deg.toFixed(4));
    set("deg", parts.deg);
    set("min", parts.min);
    if (parts.sec != null) set("sec", parts.sec);
    set("hem", parts.hem);
  }

  /** @returns {void} */
  updateVerticalDistance() {
    const form = this.shadowRoot.querySelector("#form-vertical");
    const height = Number(form.height_m.value);
    const angle = Number(form.angle_deg.value);
    if (height > 0 && angle > 0) {
      const nm = vm.verticalAngleDistanceNm(height, angle);
      form.distance_nm.value = nm.toFixed(3);
    } else {
      form.distance_nm.value = "—";
    }
  }

  /**
   * Reads a form by mode name, builds the REST body via the view-model,
   * submits, and on success records the returned id.
   *
   * @param {"bearing"|"vertical"|"celestial"} mode
   * @returns {Promise<void>}
   */
  async submit(mode) {
    this.hideError();
    const form = this.shadowRoot.querySelector(`#form-${mode}`);
    const data = this.readForm(form);
    // Parse text coordinate fields (decimal/DM/DMS) → signed degrees
    // so the view-model shapers receive numbers.
    this.parseFormCoords(data, mode);

    try {
      let path;
      let body;
      let idKey;
      if (mode === "bearing") {
        path = "/fix/lop";
        body = vm.bearingLopBody(data);
        idKey = "lop_id";
      } else if (mode === "vertical") {
        path = "/fix/cpl";
        body = vm.verticalAngleCplBody(data);
        idKey = "cpl_id";
      } else {
        path = "/celestial/sight";
        body = vm.celestialSightBody(data);
        idKey = "lop_id";
      }

      const res = await fetch(`${API}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.message || `HTTP ${res.status}`);

      if (mode === "celestial" && result.reduction) {
        this.showReduction(result.reduction);
      }

      if (idKey === "lop_id" && result.lop_id != null) {
        this.pendingIds.lop.push({
          id: result.lop_id,
          label: this.describeLop(mode, data),
        });
      } else if (idKey === "cpl_id" && result.cpl_id != null) {
        this.pendingIds.cpl.push({
          id: result.cpl_id,
          label: this.describeCpl(data),
        });
      }
      this.renderPending();
      form.reset();
      // Clear dirty flags so the next sight re-seeds from the boat.
      form.querySelectorAll('[data-dirty="true"]').forEach((el) => {
        delete el.dataset.dirty;
      });
      // form.reset() resets the tz select to its first option ("local");
      // restore the saved preference so the next sight uses it.
      const tzSel = form.querySelector('select[name="sight_tz"]');
      if (tzSel) tzSel.value = this.loadSightTz();
      this.updateVerticalDistance();
      // Re-seed assumed position now that dirty flags are cleared.
      if (this.lastKnownPosition)
        this.setDefaultPosition(this.lastKnownPosition);
      // Re-seed the sight time to now (reset cleared it).
      this.seedSightTime();
      this.dispatchEvent(
        new CustomEvent("dr-observations-changed", { bubbles: true }),
      );
    } catch (err) {
      this.showError(err.message);
    }
  }

  /**
   * @param {HTMLFormElement} form
   * @returns {Record<string, string>}
   */
  /**
   * Builds a short human label for a just-added LOP so the pending
   * list is readable (e.g. "lighthouse bearing 045°").
   *
   * @param {string} mode
   * @param {Record<string,string>} data
   * @returns {string}
   */
  describeLop(mode, data) {
    if (mode === "celestial") {
      return `${data.body ?? "celestial"} sight`;
    }
    return `${data.object || "object"} brg ${data.bearing_true ?? ""}°`;
  }

  /**
   * Builds a short label for a just-added CPL (e.g. "lighthouse 0.46nm").
   *
   * @param {Record<string,string>} data
   * @returns {string}
   */
  describeCpl(data) {
    const nm = vm.verticalAngleDistanceNm(
      Number(data.height_m),
      Number(data.angle_deg),
    );
    return `${data.object || "object"} ${nm.toFixed(2)}nm`;
  }

  readForm(form) {
    const data = {};
    for (const el of form.querySelectorAll("input, select")) {
      if (el.name) data[el.name] = el.value;
    }
    return data;
  }

  /**
   * Converts text coordinate fields in the form data from the
   * configured position format (decimal/DM/DMS) to signed degrees so
   * the view-model shapers receive plain numbers. Skips empty optional
   * fields (e.g. celestial assumed position).
   *
   * @param {Record<string,string>} data - mutated in place
   * @param {string} mode
   * @returns {void}
   */
  parseFormCoords(data, mode) {
    const prefix =
      mode === "vertical"
        ? "center"
        : mode === "bearing"
          ? "object"
          : "assumed";
    for (const kind of ["lat", "lon"]) {
      const name = `${prefix}_${kind}`;
      // Decimal format: a single number field named `${prefix}_${kind}`.
      if (data[name] != null && data[name] !== "") {
        data[name] = Number(data[name]);
        continue;
      }
      // DM/DMS: assemble from deg/min/sec/hem sub-fields.
      const deg = data[`${name}_deg`];
      if (deg == null || deg === "") continue; // optional + blank
      data[name] = posfmt.parseParts({
        deg,
        min: data[`${name}_min`] ?? 0,
        sec: data[`${name}_sec`] ?? null,
        hem: data[`${name}_hem`] ?? "",
      });
    }
  }

  /** @returns {void} */
  /**
   * Re-hydrates the pending list from the server: any persisted LOP/CPL
   * not yet attached to a confirmed fix (`used_in_fix_id IS NULL`) is
   * work-in-progress and should appear here. Called by dr-app when the
   * dialog opens so a reload or dialog-close doesn't lose your pending
   * observations. Idempotent — merges with locally-added ids.
   *
   * @returns {Promise<void>}
   */
  async hydratePending() {
    this.seedSightTime();
    try {
      const res = await fetch(`${API}/observations?limit=200`);
      if (!res.ok) return;
      const data = await res.json();
      const have = (arr) => new Set(arr.map((o) => o.id));
      const lopHave = have(this.pendingIds.lop);
      const cplHave = have(this.pendingIds.cpl);
      for (const l of data.lops ?? []) {
        if (l.used_in_fix_id == null && !lopHave.has(l.lop_id)) {
          this.pendingIds.lop.push({
            id: l.lop_id,
            label: `${l.body_or_object ?? l.lop_type} LOP`,
          });
        }
      }
      for (const c of data.cpls ?? []) {
        if (c.used_in_fix_id == null && !cplHave.has(c.cpl_id)) {
          this.pendingIds.cpl.push({
            id: c.cpl_id,
            label: `${c.source_object ?? "CPL"} r=${(c.radius_nm ?? 0).toFixed(1)}nm`,
          });
        }
      }
      this.renderPending();
    } catch {
      /* REST unavailable — keep the in-memory list */
    }
  }

  renderPending() {
    const ul = this.shadowRoot.querySelector("#pending");
    ul.innerHTML = "";
    const total = this.pendingIds.lop.length + this.pendingIds.cpl.length;
    if (total === 0) {
      ul.innerHTML = "<li>No pending observations</li>";
    } else {
      for (const o of this.pendingIds.lop) {
        const li = document.createElement("li");
        li.textContent = `#${o.id} · ${o.label}`;
        ul.appendChild(li);
      }
      for (const o of this.pendingIds.cpl) {
        const li = document.createElement("li");
        li.textContent = `#${o.id} · ${o.label}`;
        ul.appendChild(li);
      }
    }
    this.shadowRoot.querySelector("#resolve-btn").disabled = total < 1;
  }

  /** @returns {Promise<void>} */
  async resolve() {
    this.hideError();
    if (this.pendingIds.lop.length + this.pendingIds.cpl.length === 0) return;
    try {
      const res = await fetch(`${API}/fix/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_type: "manual",
          lop_ids: this.pendingIds.lop.map((o) => o.id),
          cpl_ids: this.pendingIds.cpl.map((o) => o.id),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      this.candidate = data.candidate;
      this.shadowRoot.querySelector("#confirm-btn").disabled = false;
      this.dispatchEvent(
        new CustomEvent("dr-candidate-resolved", {
          bubbles: true,
          detail: this.candidate,
        }),
      );
    } catch (err) {
      this.showError(err.message);
    }
  }

  /** @returns {Promise<void>} */
  async confirm() {
    this.hideError();
    if (!this.candidate) return;
    try {
      const res = await fetch(`${API}/fix`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          candidate: this.candidate,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      // Clear pending after a successful confirm.
      this.pendingIds = { lop: [], cpl: [] };
      this.candidate = null;
      this.renderPending();
      this.shadowRoot.querySelector("#confirm-btn").disabled = true;
      this.dispatchEvent(
        new CustomEvent("dr-fix-confirmed", { bubbles: true, detail: data }),
      );
    } catch (err) {
      this.showError(err.message);
    }
  }

  /**
   * @param {object} r - reduction result from POST /celestial/sight
   * @returns {void}
   */
  showReduction(r) {
    const el = this.shadowRoot.querySelector("#reduction");
    el.hidden = false;
    const dir =
      r.intercept_direction || (r.intercept_nm >= 0 ? "toward" : "away");
    el.textContent = [
      `${r.body}: Hc ${r.hc_deg?.toFixed(2)}°  Ho ${r.ho_deg?.toFixed(2)}°`,
      `Zn ${r.azimuth_true?.toFixed(1)}°  intercept ${Math.abs(r.intercept_nm).toFixed(2)} nm ${dir}`,
      `LHA ${r.lha_deg?.toFixed(1)}°`,
    ].join("\n");
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

customElements.define("dr-sight-panel", DrSightPanel);
