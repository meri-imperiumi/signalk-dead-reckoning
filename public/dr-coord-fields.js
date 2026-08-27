/**
 * Structured coordinate entry (deg / min / sec / hemisphere, or a
 * single decimal field) shared by the sight panel's fieldsets and the
 * fix panel's position entry.
 *
 * The visible sub-fields follow the host panel's `data-pos-format`
 * attribute ("decimal" | "dm" | "dms"), set from the server's plugin
 * configuration — one chart format across the whole webapp. CSS custom
 * rules keyed on that attribute live in COORD_FIELD_CSS; the DOM
 * builder, seeding (with per-field dirty tracking) and pure reading
 * helpers live here so both panels behave identically.
 *
 * @module dr-coord-fields.js
 */

import * as posfmt from "./dr-position-format.js";

/**
 * Styles for `.coord` fieldsets and their sub-fields, including the
 * `data-pos-format` show/hide rules. Interpolated into a panel's
 * shadow-root <style> — the `:host(...)` selectors resolve against the
 * importing panel, which must carry the `data-pos-format` attribute.
 */
export const COORD_FIELD_CSS = `
  .coord {
    border: 1px solid rgba(255, 255, 255, 0.15);
    padding: 0.6rem;
    margin: 0;
  }
  .coord legend {
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--theme-color);
    padding: 0 0.35rem;
  }
  .coord-row {
    display: flex;
    gap: 0.5rem;
    align-items: end;
    margin-bottom: 0.35rem;
  }
  .coord-row:last-child { margin-bottom: 0; }
  .coord-field {
    display: flex;
    flex-direction: column;
    font-size: 0.7rem;
    color: var(--text-muted);
    gap: 0.1rem;
  }
  .coord-field input, .coord-field select {
    width: 4rem;
    padding: 0.2rem 0.3rem;
    font-size: 0.9rem;
  }
  .coord-field input.deg { width: 3rem; }
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
`;

/**
 * Populates a `.coord` fieldset's lat/lon containers with the
 * dec/deg/min/sec/hem sub-field rows. Field names use the fieldset's
 * data-prefix (e.g. `assumed_lat_deg`, `center_lon_hem`); fieldsets
 * marked data-optional="true" leave their inputs non-required.
 *
 * @param {HTMLFieldSetElement} fs
 * @returns {void}
 */
export function buildCoordFieldset(fs) {
  const prefix = fs.dataset.prefix;
  const optional = fs.dataset.optional === "true";
  for (const kind of ["lat", "lon"]) {
    const container = fs.querySelector(`.coord-${kind}`);
    const row = document.createElement("div");
    row.className = "coord-row";
    // Decimal field (shown only in decimal mode)
    row.appendChild(coordField(`${prefix}_${kind}`, "dec", kind, optional));
    // Deg / min / sec / hem fields
    row.appendChild(coordField(`${prefix}_${kind}`, "deg", kind, optional));
    row.appendChild(coordField(`${prefix}_${kind}`, "min", kind, optional));
    row.appendChild(coordField(`${prefix}_${kind}`, "sec", kind, optional));
    row.appendChild(coordField(`${prefix}_${kind}`, "hem", kind, optional));
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
function coordField(name, part, kind, optional) {
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
 * Seeds one coordinate's structured fields from a signed degree value.
 * Sub-fields the user has edited (`data-dirty="true"`) are skipped
 * unless `force` is set (explicit chart picks / edit-mode prefill).
 *
 * @param {HTMLFieldSetElement} fs
 * @param {"lat"|"lon"} kind
 * @param {number} deg
 * @param {boolean} [force=false]
 * @returns {void}
 */
export function seedCoord(fs, kind, deg, force = false) {
  const prefix = fs.dataset.prefix;
  const parts = posfmt.coordParts(deg, kind);
  const set = (part, val) => {
    const el = fs.querySelector(
      `[name="${prefix}_${kind}${part === "" ? "" : `_${part}`}"]`,
    );
    if (!el) return;
    if (!force && el.dataset.dirty === "true") return;
    el.value = String(val);
  };
  set("dec", Number(deg).toFixed(4));
  set("deg", parts.deg);
  set("min", parts.min);
  if (parts.sec != null) set("sec", parts.sec);
  set("hem", parts.hem);
}

/**
 * Clears the per-field dirty flags on a coordinate fieldset so the
 * next seed re-populates everything (e.g. a reopened dialog).
 *
 * @param {HTMLFieldSetElement} fs
 * @returns {void}
 */
export function clearCoordDirty(fs) {
  fs?.querySelectorAll("[data-dirty]").forEach((el) => {
    delete el.dataset.dirty;
  });
}

/**
 * Reads one coordinate from flat form data (as collected by
 * `form.querySelectorAll("input, select")`) in the given position
 * format and returns signed degrees, or null when the entry is empty.
 * In "decimal" mode only the `${prefix}_${kind}` field is read; in
 * DM/DMS the deg/min/sec/hem sub-fields are assembled — matching the
 * fields the user actually sees.
 *
 * @param {Record<string, string>} data
 * @param {string} prefix
 * @param {"lat"|"lon"} kind
 * @param {"decimal"|"dm"|"dms"} format
 * @returns {number|null}
 */
export function readCoordData(data, prefix, kind, format) {
  const name = `${prefix}_${kind}`;
  if (format === "decimal") {
    const dec = data[name];
    if (dec == null || dec === "") return null;
    const n = Number(dec);
    return Number.isFinite(n) ? n : null;
  }
  const deg = data[`${name}_deg`];
  if (deg == null || deg === "") return null;
  return posfmt.parseParts({
    deg,
    min: data[`${name}_min`] ?? 0,
    sec: data[`${name}_sec`] ?? null,
    hem: data[`${name}_hem`] ?? "",
  });
}
