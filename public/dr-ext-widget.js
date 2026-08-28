/**
 * `<dr-ext-widget>` — the plotter-extension status tile (SPEC §14.1 figures
 * in glanceable form).
 *
 * Runs inside a chart plotter's sandboxed iframe (Freeboard-SK and any
 * Plotter Extensions API v1 host): connects over the vendored bus client,
 * subscribes to the plugin's published paths through the host's multiplexed
 * Signal K relay, and renders divergence / uncertainty / DR health. The
 * pure wording decisions live in `dr-ext-model.js`; this file is the DOM
 * and bus adapter.
 *
 * Long-press asks the host for the config/remove dialog (pointer events
 * inside the iframe are invisible to the host, so the widget detects the
 * gesture itself — see the API spec, Widgets). Night mode (optional
 * capability) shifts the palette to amber/red.
 *
 * @file dr-ext-widget.js
 */

import { widgetModel } from "./dr-ext-model.js";
import { THEME_CSS } from "./dr-theme.js";
import { connectExtension } from "./vendor/plotterext-bus/extension.js";

/** Flat paths the tile consumes (scalar siblings per SPEC §3.1). */
const STREAM_PATHS = [
  "navigation.deadReckoning.state",
  "navigation.deadReckoning.method",
  "navigation.deadReckoning.active",
  "navigation.deadReckoning.divergence.distance",
  "navigation.deadReckoning.uncertainty.radius",
  "navigation.deadReckoning.elapsedSinceFix",
];

const template = document.createElement("template");
template.innerHTML = /* html */ `
  <style>
    ${THEME_CSS}
    :host {
      display: block;
      box-sizing: border-box;
      width: 100%;
      height: 100%;
      padding: 6px 8px;
      background: var(--bg-panel, #111414);
      border: 1px solid rgba(255, 255, 255, 0.1);
      font-family: ui-monospace, "Fira Code", monospace;
      color: var(--text-main, #ffffff);
      cursor: default;
      user-select: none;
      --tile-accent: var(--color-green, #6b9e78);
    }
    :host(.ok) { --tile-accent: var(--color-green, #6b9e78); }
    :host(.warn) { --tile-accent: var(--color-orange, #c77b28); }
    :host(.alert) { --tile-accent: var(--color-red, #c94b4b); }
    :host(.muted) { --tile-accent: var(--color-grey, #666677); }

    /* Night mode (host nightMode capability): amber/red palette so the
       tile doesn't glow blue-white on a dark bridge. */
    :host(.night) {
      --color-green: #c98f66;
      --color-teal: #c97b4f;
      --color-orange: #d99a4e;
      --color-red: #e06a5a;
      --color-grey: #6a4a3f;
      --text-main: #e8c9a0;
      --bg-panel: rgba(22, 11, 6, 0.88);
    }

    .tile {
      display: grid;
      grid-template-rows: 1fr auto;
      height: 100%;
      gap: 2px;
    }
    .figures {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      align-content: center;
      min-width: 0;
    }
    .figure { min-width: 0; }
    .figure .label {
      font-size: 0.55rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--tile-accent);
      white-space: nowrap;
    }
    .figure .value {
      font-size: clamp(0.95rem, 3.2vh, 1.4rem);
      font-weight: 700;
      line-height: 1.1;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .status {
      display: flex;
      gap: 6px;
      align-items: center;
      font-size: 0.6rem;
      letter-spacing: 0.06em;
      color: var(--text-muted, #9aa3ad);
      white-space: nowrap;
      overflow: hidden;
    }
    .dot {
      width: 7px;
      height: 7px;
      flex: 0 0 auto;
      background: var(--tile-accent);
    }
    .word { color: var(--tile-accent); font-weight: 700; }
    .override {
      margin-left: auto;
      padding: 0 4px;
      border: 1px solid var(--color-orange, #c77b28);
      color: var(--color-orange, #c77b28);
      font-size: 0.55rem;
      font-weight: 700;
      display: none;
    }
    .override.on { display: inline-block; }
  </style>
  <div class="tile">
    <div class="figures">
      <div class="figure">
        <div class="label">Divergence</div>
        <div class="value" id="divergence">—</div>
      </div>
      <div class="figure">
        <div class="label">Uncertainty</div>
        <div class="value" id="uncertainty">—</div>
      </div>
    </div>
    <div class="status">
      <span class="dot"></span>
      <span class="word" id="word">NO DR</span>
      <span id="method">—</span>
      <span id="since">—</span>
      <span class="override" id="override">OVERRIDE</span>
    </div>
  </div>
`;

class DrExtWidget extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.append(template.content.cloneNode(true));

    /** @type {Record<string, unknown>} latest per-path bus values */
    this.values = {};
    this.connected = false;

    // Long-press → host config/remove dialog. A short tap currently has
    // no action (the fix panel arrives with the sight-panel work item);
    // the flag keeps a future tap handler from firing after a hold.
    /** @type {number|null} */
    this.pressTimer = null;
    /** @type {boolean} */
    this.longPressed = false;
    this.addEventListener("pointerdown", this.onPointerDown);
    this.addEventListener("pointerup", this.onPointerUp);
    this.addEventListener("pointercancel", this.onPointerUp);
    this.addEventListener("pointerleave", this.onPointerUp);
    this.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  /**
   * @param {PointerEvent} e
   * @returns {void}
   */
  onPointerDown(e) {
    if (!this.connected || e.button !== 0) return;
    this.longPressed = false;
    this.pressTimer = setTimeout(() => {
      this.longPressed = true;
      this.client?.call("ui.toggleConfigPanel").catch(() => {});
    }, 1200);
  }

  /**
   * @returns {void}
   */
  onPointerUp() {
    if (this.pressTimer) {
      clearTimeout(this.pressTimer);
      this.pressTimer = null;
    }
  }

  async connectedCallback() {
    if (this.connected) return;
    let client;
    try {
      client = await connectExtension();
    } catch {
      // No host handshake (opened standalone while developing, or the
      // host vanished): render the placeholder grid and give up.
      this.render();
      return;
    }
    this.connected = true;
    this.client = client;

    try {
      await client.signalk.subscribe(STREAM_PATHS, (ev) => {
        // Event name is `sk.<path>`; the path is the dict key.
        const path = ev?.path;
        if (typeof path === "string") this.values[path] = ev.value;
        this.render();
      });
    } catch {
      // Host without signalk.stream (or relay failure): the tile shows
      // placeholders — manifest `requires` should prevent this, but the
      // widget degrades rather than blanking.
    }

    if (client.hasCapability("nightMode")) {
      try {
        const { enabled } = await client.nightMode.get();
        this.classList.toggle("night", Boolean(enabled));
      } catch {
        /* best-effort seed */
      }
      await client
        .subscribe(["nightMode.changed"], (_name, params) => {
          this.classList.toggle("night", Boolean(params?.enabled));
        })
        .catch(() => {});
    }

    this.render();
  }

  disconnectedCallback() {
    this.onPointerUp();
    this.client?.close();
    this.client = null;
    this.connected = false;
  }

  /**
   * Applies the latest bus values to the DOM.
   *
   * @returns {void}
   */
  render() {
    const model = widgetModel({
      state: this.values["navigation.deadReckoning.state"],
      method: this.values["navigation.deadReckoning.method"],
      active: this.values["navigation.deadReckoning.active"],
      divergenceDistance:
        this.values["navigation.deadReckoning.divergence.distance"],
      uncertaintyRadius:
        this.values["navigation.deadReckoning.uncertainty.radius"],
      elapsedSinceFix: this.values["navigation.deadReckoning.elapsedSinceFix"],
    });
    const root = this.shadowRoot;
    this.classList.remove("ok", "warn", "alert", "muted");
    this.classList.add(model.severity);
    root.querySelector("#divergence").textContent = model.divergence;
    root.querySelector("#uncertainty").textContent = model.uncertainty;
    root.querySelector("#word").textContent = model.statusWord;
    root.querySelector("#method").textContent = `· ${model.method}`;
    root.querySelector("#since").textContent = `· ${model.sinceFix}`;
    root.querySelector("#override").classList.toggle("on", model.override);
  }
}

customElements.define("dr-ext-widget", DrExtWidget);
