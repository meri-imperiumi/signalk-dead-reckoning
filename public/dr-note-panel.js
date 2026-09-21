/**
 * `<dr-note-panel>` — Signal K note create/edit form (work doc #30).
 * The point is one-handed hazard marking at the helm in seconds: a
 * small title/body form pre-seeded with the picked position, a quick
 * "Hazard" preset, and honest failure surfacing (a server that
 * rejects writes — read-only session, resource-provider backend —
 * shows the error in the form, never silently).
 *
 * Create mode POSTs /signalk/v2/api/resources/notes (server-assigned
 * id); edit mode PUTs /resources/notes/{id}. The submit result is
 * dispatched as `dr-note-saved` { id, resource } so dr-app can update
 * its cache and re-render the marker without a full refetch.
 *
 * @file dr-note-panel.js
 */

import { THEME_CSS } from "./dr-theme.js";
import * as vm from "./dr-viewmodel.js";

const template = document.createElement("template");
template.innerHTML = /* html */ `
  <style>
    ${THEME_CSS}
    :host { display: block; padding: 1rem; --theme-color: var(--color-orange); }
    h2 { justify-content: space-between; }
    label {
      display: flex;
      flex-direction: column;
      font-size: 0.75rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--text-muted);
      margin-top: 0.75rem;
    }
    input, textarea {
      appearance: none;
      background: transparent;
      border: none;
      border-bottom: 2px solid var(--color-grey);
      color: var(--text-main);
      font-family: ui-monospace, "Fira Code", monospace;
      font-size: 1rem;
      padding: 0.35rem 0;
      width: 100%;
    }
    input:focus, textarea:focus {
      outline: none;
      border-bottom-color: var(--theme-color);
    }
    textarea {
      min-height: 5rem;
      resize: vertical;
    }
    .presets {
      display: flex;
      gap: 0.5rem;
      margin-top: 0.75rem;
    }
    button {
      text-transform: uppercase;
      font-family: ui-monospace, "Fira Code", monospace;
      font-size: 0.8rem;
    }
    .presets button { color: var(--theme-color); }
    .actions {
      display: flex;
      gap: 0.5rem;
      margin-top: 1rem;
      justify-content: flex-end;
    }
    .error {
      color: var(--color-red);
      font-size: 0.8rem;
      margin-top: 0.5rem;
      white-space: pre-wrap;
    }
    .error:empty { display: none; }
  </style>
  <h2 id="dr-note-heading">New note <button id="dr-note-close" aria-label="Close note form" title="Close note form">✕</button></h2>
  <form novalidate>
    <div class="presets">
      <button type="button" id="dr-note-hazard" title="Hazard marking — the one-tap preset">⚠ Hazard</button>
    </div>
    <label>Title
      <input name="title" type="text" autocomplete="off" placeholder="Hazard" />
    </label>
    <label>Body
      <textarea name="body" placeholder="What did you see here?"></textarea>
    </label>
    <div class="error" id="dr-note-error" role="alert"></div>
    <div class="actions">
      <button type="submit" id="dr-note-submit">Save note</button>
    </div>
  </form>
`;

class DrNotePanel extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.appendChild(template.content.cloneNode(true));
    this.form = root.querySelector("form");
    this.titleEl = root.querySelector('input[name="title"]');
    this.bodyEl = root.querySelector('textarea[name="body"]');
    this.errorEl = root.querySelector("#dr-note-error");
    this.heading = root.querySelector("#dr-note-heading");

    root.querySelector("#dr-note-close")?.addEventListener("click", () => {
      this.dispatchEvent(
        new CustomEvent("dr-close", { bubbles: true, composed: true }),
      );
    });
    // The quick preset: a hazard annotation is the core use — one tap
    // names it, the helm writes what they saw and saves.
    root.querySelector("#dr-note-hazard")?.addEventListener("click", () => {
      this.titleEl.value = "Hazard";
      this.bodyEl.focus();
    });
    this.form.addEventListener("submit", (e) => {
      e.preventDefault();
      this.submit();
    });
  }

  /**
   * Opens the form: create mode (position required) or edit mode
   * (existing resource). Clears any prior error.
   *
   * @param {{position?: [number, number], note?: object}} seed
   * @returns {void}
   */
  open(seed = {}) {
    this.errorEl.textContent = "";
    this.position = seed.position ?? null;
    this.editId = seed.note?.id ?? null;
    this.titleEl.value = (seed.note ? seed.note.title : "") ?? "";
    this.bodyEl.value = (seed.note ? seed.note.body : "") ?? "";
    this.heading.childNodes[0].textContent = this.editId
      ? "Edit note "
      : "New note ";
    this.titleEl.focus();
  }

  /**
   * Validates and dispatches `dr-note-save` — dr-app owns the REST
   * call; the panel only shapes and reports. Client-side validation
   * (a position is the whole point of a chart note) never issues a
   * doomed request.
   *
   * @returns {void}
   */
  submit() {
    this.errorEl.textContent = "";
    if (!this.editId && !this.position) {
      this.errorEl.textContent = "No position — pick a point on the chart.";
      return;
    }
    this.dispatchEvent(
      new CustomEvent("dr-note-save", {
        bubbles: true,
        composed: true,
        detail: {
          id: this.editId,
          resource: vm.noteResourceFromForm({
            title: this.titleEl.value,
            body: this.bodyEl.value,
            position: this.position ?? [0, 0],
          }),
        },
      }),
    );
  }

  /**
   * Surfaces a failed write (server may reject: read-only session,
   * resource-provider backend) — the form shows it, never silent.
   *
   * @param {string} message
   * @returns {void}
   */
  showError(message) {
    this.errorEl.textContent = message;
  }
}

customElements.define("dr-note-panel", DrNotePanel);
