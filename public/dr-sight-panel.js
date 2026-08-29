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

import {
  buildCoordFieldset,
  COORD_FIELD_CSS,
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
    :host { display: block; padding: 1rem; }
    h2 { justify-content: space-between; }
    /* Bracketed mode toggle — active tab inverts */
    .tabs { display: flex; gap: 0.5rem; margin-bottom: 0.75rem; }
    .tabs button { flex: 1; }
    .tabs button.active {
      background: var(--theme-color);
      color: var(--bg-base);
    }
    .form { display: grid; gap: 0.75rem; }
    .form[hidden] { display: none; }
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
    /* Bearing reference (true/mag): variation + true-bearing readout
       only exist in magnetic mode; the ref select stays a stable
       width so the row doesn't jump when switching. */
    .bearing-ref label.ref-toggle { flex: 0 0 auto; min-width: 0; }
    .bearing-ref select[name="bearing_ref"] { min-width: 4.5rem; }
    .bearing-ref .var-group {
      display: flex;
      gap: 0.3rem;
      align-items: center;
    }
    .bearing-ref .var-group input { width: 4rem; }
    .bearing-ref .var-group select { width: auto; }
    output[name="bearing_true_out"] {
      font-family: ui-monospace, "Fira Code", monospace;
      font-size: 0.95rem;
      color: var(--text-main);
    }
    .sight-time { display: flex; gap: 0.75rem; align-items: end; flex-wrap: wrap; }
    .sight-time > label { flex: 1; }
    .sight-time .tz-toggle { flex: 0 0 auto; }
    .sight-time .tz-toggle select { min-width: 6rem; }
    .sight-time .ago-toggle { flex: 0 0 auto; }
    .sight-time .ago-toggle select { min-width: 5.5rem; }
    /* Stopwatch method ("N min N sec ago") — shown when the time mode
       select is on "ago"; the converted clock time lands in the
       sight_time field above. */
    .sight-ago {
      display: flex;
      gap: 0.75rem;
      align-items: center;
      flex-wrap: wrap;
    }
    .sight-ago[hidden] { display: none; }
    .sight-ago label { flex: 0 0 auto; }
    .sight-ago input { width: 5rem; }
    .sight-ago .ago-note {
      font-size: 0.7rem;
      color: var(--text-muted);
      font-family: ui-monospace, "Fira Code", monospace;
    }
    .check {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      flex-direction: row;
      text-transform: none;
      letter-spacing: 0;
      font-size: 0.85rem;
      font-weight: 400;
      color: var(--text-main);
    }
    .actions {
      display: flex;
      gap: 0.5rem;
      margin-top: 0.75rem;
      align-items: center;
      flex-wrap: wrap;
    }
    .actions button.primary { --theme-color: var(--color-teal); }
    .pending {
      margin-top: 0.75rem;
      font-size: 0.8rem;
      color: var(--text-muted);
    }
    .status {
      margin-top: 0.5rem;
      font-size: 0.8rem;
      color: var(--color-green);
      font-family: ui-monospace, "Fira Code", monospace;
    }
    .editing-note {
      margin-top: 0.5rem;
      font-size: 0.8rem;
      color: var(--color-orange);
      font-family: ui-monospace, "Fira Code", monospace;
    }
    .reduction {
      margin-top: 0.5rem;
      padding: 0.6rem;
      background: var(--bg-panel-muted);
      border: 1px solid rgba(255, 255, 255, 0.1);
      font: 0.8rem/1.5 ui-monospace, "Fira Code", monospace;
      color: var(--text-main);
      white-space: pre-wrap;
    }
    .error {
      font-size: 0.8rem;
      margin-top: 0.5rem;
      font-family: ui-monospace, "Fira Code", monospace;
    }
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
      <div class="row bearing-ref">
        <label>Bearing (°)
          <input name="bearing" type="number" step="0.1" required />
        </label>
        <label class="ref-toggle" title="Compass reference of the bearing entry">
          <select name="bearing_ref">
            <option value="mag">mag</option>
            <option value="true">true</option>
          </select>
        </label>
        <label class="ref-mag-only" title="Local magnetic variation — auto-filled from navigation.magneticVariation when the server provides it" hidden>
          Variation (°)
          <span class="var-group">
            <input name="variation_deg" type="number" step="0.1" min="0" placeholder="4.5" inputmode="decimal" />
            <select name="variation_hem">
              <option value="E">E</option>
              <option value="W">W</option>
            </select>
          </span>
        </label>
        <label class="ref-mag-only" title="The bearing converted to true — what gets submitted" hidden>
          True
          <output name="bearing_true_out">—</output>
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
        <label class="ago-toggle" title="Stopwatch method: start a watch at the sight, then enter the minutes/seconds elapsed — converted to clock time as you type">
          <select name="sight_time_mode">
            <option value="clock">clock</option>
            <option value="ago">ago</option>
          </select>
        </label>
      </div>
      <div class="sight-ago" hidden>
        <label>Min ago
          <input name="sight_ago_min" type="number" min="0" step="1" inputmode="numeric" placeholder="0" />
        </label>
        <label>Sec ago
          <input name="sight_ago_sec" type="number" min="0" step="0.1" inputmode="numeric" placeholder="0" />
        </label>
        <span class="ago-note">converted on entry</span>
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
        <label class="ago-toggle" title="Stopwatch method: start a watch at the sight, then enter the minutes/seconds elapsed — converted to clock time as you type">
          <select name="sight_time_mode">
            <option value="clock">clock</option>
            <option value="ago">ago</option>
          </select>
        </label>
      </div>
      <div class="sight-ago" hidden>
        <label>Min ago
          <input name="sight_ago_min" type="number" min="0" step="1" inputmode="numeric" placeholder="0" />
        </label>
        <label>Sec ago
          <input name="sight_ago_sec" type="number" min="0" step="0.1" inputmode="numeric" placeholder="0" />
        </label>
        <span class="ago-note">converted on entry</span>
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
        <label class="ago-toggle" title="Stopwatch method: start a watch at the sight, then enter the minutes/seconds elapsed — converted to clock time as you type">
          <select name="sight_time_mode">
            <option value="clock">clock</option>
            <option value="ago">ago</option>
          </select>
        </label>
      </div>
      <div class="sight-ago" hidden>
        <label>Min ago
          <input name="sight_ago_min" type="number" min="0" step="1" inputmode="numeric" placeholder="0" />
        </label>
        <label>Sec ago
          <input name="sight_ago_sec" type="number" min="0" step="0.1" inputmode="numeric" placeholder="0" />
        </label>
        <span class="ago-note">converted on entry</span>
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

    <div class="editing-note" id="editing-note" hidden></div>
    <ul class="status" id="status" hidden></ul>
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

    /** @type {{kind: "lop"|"cpl", id: number}|null} PUT-instead-of-POST target */
    this.editing = null;

    // Tab switching
    root.querySelectorAll(".tabs button").forEach((btn) => {
      btn.addEventListener("click", () => this.switchTab(btn.dataset.tab));
    });

    // Submit handlers
    root.querySelectorAll("[data-submit]").forEach((btn) => {
      btn.addEventListener("click", () => this.submit(btn.dataset.submit));
    });

    // Live distance calc for vertical-angle form
    const vForm = root.querySelector("#form-vertical");
    vForm.addEventListener("input", () => this.updateVerticalDistance());

    // Bearing reference (true/mag): switching toggles the variation +
    // true-bearing fields, and the choice persists to localStorage (a
    // hand-bearing compass navigator wants it to stick, like the tz).
    const bForm = root.querySelector("#form-bearing");
    const refSel = bForm.querySelector('select[name="bearing_ref"]');
    refSel.value = this.loadBearingRef();
    refSel.addEventListener("change", () => {
      this.saveBearingRef(refSel.value);
      this.applyBearingRef();
    });
    this.applyBearingRef();
    // Live true-bearing readout as the bearing/variation are typed.
    bForm.addEventListener("input", () => this.updateBearingTrue());

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
    // Mark the variation fields dirty on manual edit so a later
    // navigation.magneticVariation delta doesn't overwrite the user's
    // local value (e.g. the chart's variation for the sight's area).
    bForm
      .querySelectorAll('[name="variation_deg"], [name="variation_hem"]')
      .forEach((el) => {
        el.addEventListener("input", () => {
          el.dataset.dirty = "true";
        });
        el.addEventListener("change", () => {
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

    // Stopwatch method ("N min N sec ago"): entering an elapsed offset
    // converts it into the sight_time field AT ENTRY — every keystroke
    // re-bases "now", so the committed value is anchored to the moment
    // the offset was entered, not to when the form is submitted.
    for (const form of root.querySelectorAll(".form")) {
      const modeSel = form.querySelector('select[name="sight_time_mode"]');
      const agoRow = form.querySelector(".sight-ago");
      const timeInput = form.querySelector('input[name="sight_time"]');
      const tzSel = form.querySelector('select[name="sight_tz"]');
      const minInput = form.querySelector('input[name="sight_ago_min"]');
      const secInput = form.querySelector('input[name="sight_ago_sec"]');
      if (
        !modeSel ||
        !agoRow ||
        !timeInput ||
        !tzSel ||
        !minInput ||
        !secInput
      ) {
        continue;
      }
      modeSel.addEventListener("change", () => {
        agoRow.hidden = modeSel.value !== "ago";
      });
      const convert = () => {
        // Wait until at least one offset field holds a value.
        if (minInput.value === "" && secInput.value === "") return;
        const iso = vm.stopwatchToIso(minInput.value, secInput.value);
        timeInput.value = vm.isoToSightTimeInput(iso, tzSel.value);
        timeInput.dataset.dirty = "true";
      };
      minInput.addEventListener("input", convert);
      secInput.addEventListener("input", convert);
    }

    root.querySelector("#close-btn")?.addEventListener("click", () => {
      this.endEdit();
      this.dispatchEvent(
        new CustomEvent("dr-close", { bubbles: true, composed: true }),
      );
    });

    /** @type {HTMLElement|null} */
    this.errorEl = root.querySelector("#error");

    // Build structured coordinate inputs for each fieldset.
    for (const fs of this.shadowRoot.querySelectorAll("fieldset.coord")) {
      buildCoordFieldset(fs);
    }
  }

  /**
   * Called by dr-app when the DR or GPS position updates, so the
   * assumed-position defaults track the boat without the user typing.
   * Seeds the structured deg/min/sec/hem (or decimal) fields, skipping
   * any the user has manually edited (dirty flag).
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
      seedCoord(fs, "lat", pos.latitude);
      seedCoord(fs, "lon", pos.longitude);
    }
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

  /** localStorage key for the remembered bearing-reference choice. */
  static get BEARING_REF_KEY() {
    return "dr-bearing-ref";
  }

  /**
   * Reads the remembered bearing-reference preference from
   * localStorage. Defaults to "mag" — the hand-bearing compass is the
   * common instrument for LOP bearings.
   * @returns {"true"|"mag"}
   */
  loadBearingRef() {
    try {
      const v = localStorage.getItem(DrSightPanel.BEARING_REF_KEY);
      return v === "true" ? "true" : "mag";
    } catch {
      return "mag";
    }
  }

  /**
   * Persists the bearing-reference preference to localStorage.
   * @param {"true"|"mag"} ref
   * @returns {void}
   */
  saveBearingRef(ref) {
    try {
      localStorage.setItem(DrSightPanel.BEARING_REF_KEY, ref);
    } catch {
      /* storage unavailable — keep the session value */
    }
  }

  /**
   * Shows/hides the magnetic-only fields (variation, true-bearing
   * readout) to match the bearing_ref select's current value.
   * @returns {void}
   */
  applyBearingRef() {
    const form = this.shadowRoot.querySelector("#form-bearing");
    const mag =
      form?.querySelector('select[name="bearing_ref"]')?.value === "mag";
    form?.querySelectorAll(".ref-mag-only").forEach((el) => {
      el.hidden = !mag;
    });
    this.updateBearingTrue();
  }

  /**
   * Live true-bearing readout for magnetic entry — what will be
   * submitted — updated as the bearing/variation are typed.
   * @returns {void}
   */
  updateBearingTrue() {
    const form = this.shadowRoot.querySelector("#form-bearing");
    const out = form?.querySelector('[name="bearing_true_out"]');
    if (!form || !out) return;
    const ref = form.querySelector('select[name="bearing_ref"]');
    if (ref?.value !== "mag") {
      out.textContent = "—";
      return;
    }
    const bearing = Number(form.querySelector('[name="bearing"]').value);
    const variation = vm.variationFromForm({
      variation_deg: form.querySelector('[name="variation_deg"]').value,
      variation_hem: form.querySelector('[name="variation_hem"]').value,
    });
    out.textContent =
      Number.isFinite(bearing) && Number.isFinite(variation)
        ? `${String(Math.round(vm.bearingToTrue(bearing, variation))).padStart(3, "0")}° true`
        : "—";
  }

  /**
   * Called by dr-app when a `navigation.magneticVariation` delta
   * arrives (radians on the bus; the app converts to east-positive
   * degrees). Seeds the variation fields unless the user edited them.
   *
   * @param {number} degEast - variation, east positive / west negative
   * @returns {void}
   */
  setMagneticVariation(degEast) {
    if (!Number.isFinite(degEast) || Math.abs(degEast) > 180) return;
    this.magneticVariation = degEast;
    this.seedVariation();
  }

  /**
   * Seeds the variation magnitude + hemisphere from the last stream
   * value, skipping when the user manually edited the fields.
   * @returns {void}
   */
  seedVariation() {
    if (this.magneticVariation == null) return;
    const form = this.shadowRoot?.querySelector("#form-bearing");
    const input = form?.querySelector('[name="variation_deg"]');
    if (!input || input.dataset.dirty === "true") return;
    input.value = String(Math.abs(this.magneticVariation).toFixed(1));
    const hem = form.querySelector('[name="variation_hem"]');
    if (hem) hem.value = this.magneticVariation < 0 ? "W" : "E";
    this.updateBearingTrue();
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
   * prior value — a fresh pick is intentional), plus the object *name*
   * when the pick resolved a charted symbol (light, seamark, peak…) or an
   * AIS target (work doc #23): bearings are taken to identified objects,
   * not bare coordinates. `tMs` (the pick instant) pre-fills the sight
   * time — for an AIS target the seeded position is its *predicted*
   * position valid at exactly that instant, so position and timestamp
   * stay consistent. Marked dirty so the tz toggle converts it in place
   * instead of re-seeding to "now".
   * Used by dr-app when the map dispatches `dr-pick-position`.
   *
   * @param {number} lat
   * @param {number} lon
   * @param {"bearing"|"vertical"} mode
   * @param {string} [label] - charted name / AIS target name, if any
   * @param {number} [tMs] - pick instant the position is valid for
   * @returns {void}
   */
  seedObjectPosition(lat, lon, mode, label, tMs = null) {
    const prefix = mode === "vertical" ? "center" : "object";
    const tab = mode === "vertical" ? "vertical" : "bearing";
    this.switchTab(tab);
    const form = this.shadowRoot.querySelector(`#form-${tab}`);
    const fs = this.shadowRoot.querySelector(
      `fieldset.coord[data-prefix="${prefix}"]`,
    );
    if (typeof label === "string" && label.length > 0) {
      const nameInput = form?.querySelector('input[name="object"]');
      if (nameInput) nameInput.value = label;
    }
    if (Number.isFinite(tMs)) {
      const input = form?.querySelector('input[name="sight_time"]');
      if (input) {
        input.value = vm.isoToSightTimeInput(
          new Date(tMs).toISOString(),
          this.loadSightTz(),
        );
        input.dataset.dirty = "true";
      }
    }
    if (!fs) return;
    // Force-fill (a chart pick overwrites, no dirty check).
    seedCoord(fs, "lat", lat, true);
    seedCoord(fs, "lon", lon, true);
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
      let method = "POST";
      let path;
      let body;
      if (this.editing) {
        // Edit mode (work doc #13): the forms PUT their editable
        // columns instead of creating a new observation.
        const edited = this.editBody(mode, data);
        if (!edited) return;
        method = "PUT";
        path = `/fix/${this.editing.kind}/${this.editing.id}`;
        body = edited;
      } else if (mode === "bearing") {
        path = "/fix/lop";
        body = vm.bearingLopBody(data);
      } else if (mode === "vertical") {
        path = "/fix/cpl";
        body = vm.verticalAngleCplBody(data);
      } else {
        path = "/celestial/sight";
        body = vm.celestialSightBody(data);
      }

      const res = await fetch(`${API}${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.message || `HTTP ${res.status}`);

      if (mode === "celestial" && result.reduction) {
        this.showReduction(result.reduction);
      }

      const wasEditing = this.editing != null;
      this.endEdit();
      form.reset();
      // form.reset() restores the time-mode select's first option
      // ("clock") — re-hide the stopwatch row to match.
      for (const row of form.querySelectorAll(".sight-ago")) row.hidden = true;
      // Clear dirty flags so the next sight re-seeds from the boat.
      form.querySelectorAll('[data-dirty="true"]').forEach((el) => {
        delete el.dataset.dirty;
      });
      // form.reset() resets the tz select to its first option ("local");
      // restore the saved preference so the next sight uses it.
      const tzSel = form.querySelector('select[name="sight_tz"]');
      if (tzSel) tzSel.value = this.loadSightTz();
      // Same for the bearing reference (reset lands on "mag" — the
      // default — but the navigator's saved preference wins), plus
      // re-seed the variation from the stream now that dirty flags
      // are cleared.
      const refSel = form.querySelector('select[name="bearing_ref"]');
      if (refSel) {
        refSel.value = this.loadBearingRef();
        this.applyBearingRef();
      }
      this.seedVariation();
      this.updateVerticalDistance();
      // Re-seed assumed position now that dirty flags are cleared.
      if (this.lastKnownPosition)
        this.setDefaultPosition(this.lastKnownPosition);
      // Re-seed the sight time to now (reset cleared it).
      this.seedSightTime();
      this.showStatus(
        wasEditing ? "Observation updated" : "Observation added to pending",
      );
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
   * Builds the PUT body for an edit-mode submit, or null (with an
   * error shown) when this record can't be edited in the forms.
   *
   * @param {"bearing"|"vertical"|"celestial"} mode
   * @param {Record<string,string>} data - parsed form data
   * @returns {object|null}
   */
  editBody(mode, data) {
    if (this.editing.kind === "lop") {
      if (this.editing.type !== "bearing" || mode !== "bearing") {
        this.showError(
          "Only bearing LOPs are editable in this form — celestial LOPs must be deleted and re-reduced",
        );
        return null;
      }
      let bearing;
      try {
        // Honors a magnetic entry (converted with the form's
        // variation), same as a fresh bearingLopBody submit.
        bearing = vm.bearingFromFormTrue(data);
      } catch {
        this.showError("variation required for a magnetic bearing");
        return null;
      }
      if (!Number.isFinite(bearing)) {
        this.showError("bearing required");
        return null;
      }
      return {
        body_or_object: data.object || null,
        assumed_lat: data.object_lat,
        assumed_lon: data.object_lon,
        // The engine's azimuth convention: bearing + 90° (see
        // bearingLopBody).
        azimuth_true: (bearing + 90) % 360,
      };
    }
    // CPL edit: object + center always; radius only when the user
    // re-entered a height/angle pair (a radius can't round-trip into
    // those two fields).
    if (mode !== "vertical") {
      this.showError("Switch to the vertical-angle tab to edit this CPL");
      return null;
    }
    const body = {
      source_object: data.object || null,
      center_lat: data.center_lat,
      center_lon: data.center_lon,
    };
    const height = Number(data.height_m);
    const angle = Number(data.angle_deg);
    if (height > 0 && angle > 0) {
      body.radius_nm = vm.verticalAngleDistanceNm(height, angle);
    }
    return body;
  }

  /**
   * Starts edit mode for a persisted observation (work doc #13):
   * pre-seeds the matching form and marks the panel so submit PUTs
   * instead of POSTs.
   *
   * @param {{kind: "lop"|"cpl", id: number, [k: string]: unknown}} record - db row
   * @returns {void}
   */
  beginEdit(record) {
    if (record.kind === "lop" && record.lop_type !== "bearing") {
      this.showError(
        "Celestial LOPs can't be edited in the form — delete and re-reduce the sight",
      );
      return;
    }
    this.endEdit();
    this.editing = {
      kind: record.kind,
      id: record.kind === "lop" ? record.lop_id : record.cpl_id,
      type: record.kind === "lop" ? record.lop_type : record.cpl_type,
    };
    const mode = record.kind === "lop" ? "bearing" : "vertical";
    this.switchTab(mode);
    const form = this.shadowRoot.querySelector(`#form-${mode}`);
    const note = this.shadowRoot.querySelector("#editing-note");
    note.hidden = false;
    note.textContent = `Editing ${record.kind === "lop" ? "LOP" : "CPL"} #${this.editing.id} — submit writes the change`;
    if (record.kind === "lop") {
      form.querySelector('[name="object"]').value = record.body_or_object ?? "";
      // The stored azimuth is TRUE (magnetic entry was converted at
      // submit time) — seed the form as a true reference so the value
      // round-trips unchanged; the navigator can switch to mag for a
      // corrected re-entry.
      form.querySelector('[name="bearing"]').value = String(
        (((record.azimuth_true - 90) % 360) + 360) % 360,
      );
      const refSel = form.querySelector('select[name="bearing_ref"]');
      if (refSel) {
        refSel.value = "true";
        this.applyBearingRef();
      }
      const fs = form.querySelector('fieldset.coord[data-prefix="object"]');
      seedCoord(fs, "lat", record.assumed_lat, true);
      seedCoord(fs, "lon", record.assumed_lon, true);
    } else {
      form.querySelector('[name="object"]').value = record.source_object ?? "";
      const fs = form.querySelector('fieldset.coord[data-prefix="center"]');
      seedCoord(fs, "lat", record.center_lat, true);
      seedCoord(fs, "lon", record.center_lon, true);
    }
    const tz = this.loadSightTz();
    const timeInput = form.querySelector('input[name="sight_time"]');
    timeInput.value = vm.isoToSightTimeInput(record.timestamp, tz);
    timeInput.dataset.dirty = "true";
  }

  /** @returns {void} */
  endEdit() {
    this.editing = null;
    const note = this.shadowRoot?.querySelector("#editing-note");
    if (note) note.hidden = true;
  }

  /**
   * @param {string} msg
   * @returns {void}
   */
  showStatus(msg) {
    const el = this.shadowRoot.querySelector("#status");
    el.textContent = msg;
    el.hidden = false;
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
    const format = this.getAttribute("data-pos-format") ?? "dms";
    for (const kind of ["lat", "lon"]) {
      const name = `${prefix}_${kind}`;
      const deg = readCoordData(data, prefix, kind, format);
      if (deg != null) data[name] = deg;
      // Optional + blank → leave unset; the shapers treat missing as
      // "use DR" / "no position".
      else delete data[name];
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
