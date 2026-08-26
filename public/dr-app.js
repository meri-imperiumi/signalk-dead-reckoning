/**
 * `<dr-app>` — top-level layout for the Dead Reckoning webapp.
 *
 * Composes the map view, headline figures, and the manual OVERRIDE control
 * (SPEC §14.1: prominent, always human-initiated). Live data flows from
 * the Signal K WebSocket stream through the view-model (tracks,
 * sparkline) into `<dr-map-view>`; REST overlays (fixes, LOPs, CPLs,
 * snap vectors) refresh on a slow poll and after any confirm POST.
 *
 * @file dr-app.js
 */

import * as vm from "./dr-viewmodel.js";
import "./dr-map-view.js";

/** Signal K mounts plugin REST routes under /plugins/<name>/. */
const API = "/plugins/signalk-dead-reckoning";

const template = document.createElement("template");
template.innerHTML = /* html */ `
  <style>
    :host { display: block; padding: 1rem; }
    .dr-panel {
      background: var(--dr-panel, #111827);
      border: 1px solid #1f2937;
      border-radius: 8px;
      padding: 1rem;
      margin-bottom: 1rem;
    }
    .dr-panel h2 {
      margin: 0 0 0.75rem 0;
      font-size: 1rem;
      color: var(--dr-muted, #8b949e);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    h2 button {
      font: inherit;
      padding: 0 0.25rem;
      border: 1px solid #2d3748;
      border-radius: 4px;
      background: #1a202c;
      color: var(--dr-fg, #e6edf3);
      cursor: pointer;
    }
    .dr-headline { display: flex; gap: 1.5rem; flex-wrap: wrap; }
    .dr-figure { display: flex; flex-direction: column; }
    .dr-figure .value { font-size: 1.75rem; font-weight: 600; }
    .dr-figure .label { font-size: 0.75rem; color: var(--dr-muted, #8b949e); }
    .dr-override { display: flex; align-items: center; gap: 0.75rem; }
    .dr-override button {
      font: inherit;
      padding: 0.5rem 1rem;
      border-radius: 6px;
      border: 1px solid #2d3748;
      background: #1a202c;
      color: var(--dr-fg, #e6edf3);
      cursor: pointer;
    }
    .dr-override button.engaged {
      background: var(--dr-accent, #003399);
      border-color: var(--dr-accent, #003399);
    }
    .dr-status {
      font-size: 0.9rem;
      color: var(--dr-muted, #8b949e);
      text-align: center;
    }
    .dr-status.idle {
      color: #f0b429;
    }
    .dr-status.underway {
      color: #56d364;
    }
    .dr-status.retrying {
      color: #f85149;
    }
  </style>
  <section class="dr-panel dr-headline">
    <div class="dr-figure">
      <span class="value" id="dr-log">— nm</span>
      <span class="label">Water-track log</span>
    </div>
    <div class="dr-figure">
      <span class="value" id="dr-elapsed">—</span>
      <span class="label">Since last fix</span>
    </div>
    <div class="dr-figure">
      <span class="value" id="dr-divergence">— nm</span>
      <span class="label">DR vs GPS</span>
    </div>
    <div class="dr-figure">
      <span class="value" id="dr-method">—</span>
      <span class="label">Active method</span>
    </div>
  </section>

  <section class="dr-panel dr-status" id="dr-status-panel">
    <span id="dr-status-text">Connecting to Signal K…</span>
  </section>

  <section class="dr-panel">
    <h2>Ghost Track <button id="dr-recenter" title="Follow DR position">◎</button></h2>
    <dr-map-view id="dr-map"></dr-map-view>
  </section>

  <section class="dr-panel dr-override">
    <h2>Failover Control</h2>
    <button id="dr-override-btn">Engage OVERRIDE</button>
    <span id="dr-override-state">NORMAL (GPS authoritative)</span>
  </section>
`;

class DrApp extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.appendChild(template.content.cloneNode(true));

    /** @type {HTMLButtonElement|null} */
    this.btn = root.querySelector("#dr-override-btn");
    /** @type {HTMLElement|null} */
    this.stateLabel = root.querySelector("#dr-override-state");
    this.btn?.addEventListener("click", () => this.toggleOverride());

    /** @type {import("./dr-map-view.js").default|null} */
    this.map = root.querySelector("#dr-map");
    root
      .querySelector("#dr-recenter")
      ?.addEventListener("click", () => this.map?.recenter());

    // View-model state
    this.ghost = new vm.TrackLog(3600);
    this.gps = new vm.TrackLog(3600);
    this.spark = new vm.Sparkline(120);
    this.lastElapsedS = null;
    this.snap = {
      drPosition: null,
      gpsPosition: null,
      uncertainty: null,
      divergence: null,
      fixes: [],
      lops: [],
      cpls: [],
      corrections: [],
      ghostTrack: [],
      gpsTrack: [],
      sparkStats: null,
    };

    this.connectStream();
    this.bootstrapSelf();
    this.refreshOverlays();
    // Slow REST refresh for persisted overlays; stream drives the live parts.
    setInterval(() => this.refreshOverlays(), 30000);
  }

  /**
   * Subscribes to the DR + GPS paths via the stream helper component.
   *
   * @returns {void}
   */
  connectStream() {
    const stream = window.drSignalkStream;
    if (!stream) return;
    stream.subscribe([
      "navigation.deadReckoning.position",
      "navigation.deadReckoning.active",
      "navigation.deadReckoning.method",
      "navigation.deadReckoning.log",
      "navigation.deadReckoning.uncertainty",
      "navigation.deadReckoning.divergence",
      "navigation.deadReckoning.state",
      "navigation.position",
    ]);
    stream.on((delta) => this.onDelta(delta));
    stream.onStatus((s) => this.renderLinkStatus(s));
  }

  /**
   * Seeds the current position + DR state from the REST self snapshot so
   * the map shows the boat immediately, even when the live stream hasn't
   * pushed a delta yet (e.g. a moored vessel whose position isn't
   * changing).
   *
   * @returns {Promise<void>}
   */
  async bootstrapSelf() {
    try {
      const res = await fetch("/signalk/v1/api/vessels/self");
      if (!res.ok) return;
      const self = await res.json();
      const nav = self?.vessels?.self ?? self;
      const pos = nav?.navigation?.position?.value ?? nav?.navigation?.position;
      if (pos?.latitude != null) {
        this.applyValue("navigation.position", pos);
      }
      const dr = nav?.navigation?.deadReckoning;
      if (dr?.position?.value) {
        this.applyValue("navigation.deadReckoning.position", dr.position.value);
      }
      if (dr?.log?.value != null) {
        this.applyValue("navigation.deadReckoning.log", dr.log.value);
      }
      if (dr?.method?.value) {
        this.applyValue("navigation.deadReckoning.method", dr.method.value);
      }
      if (dr?.uncertainty?.value) {
        this.applyValue(
          "navigation.deadReckoning.uncertainty",
          dr.uncertainty.value,
        );
      }
      if (dr?.divergence?.value) {
        this.applyValue(
          "navigation.deadReckoning.divergence",
          dr.divergence.value,
        );
      }
      if (dr?.state?.value) {
        this.applyValue("navigation.deadReckoning.state", dr.state.value);
      }
      this.render();
    } catch {
      /* REST unavailable — stream will drive when it can */
    }
  }

  /**
   * Streams a delta into the view-model and re-renders.
   *
   * @param {object} delta
   * @returns {void}
   */
  onDelta(delta) {
    for (const update of delta?.updates ?? []) {
      for (const v of update.values ?? []) {
        this.applyValue(v.path, v.value);
      }
    }
    this.render();
  }

  /**
   * @param {string} path
   * @param {unknown} value
   * @returns {void}
   */
  applyValue(path, value) {
    switch (path) {
      case "navigation.deadReckoning.position":
        if (value?.latitude != null) {
          this.snap.drPosition = [value.latitude, value.longitude];
          this.ghost.push(value.latitude, value.longitude);
          this.snap.ghostTrack = this.ghost.points();
        }
        break;
      case "navigation.position":
        if (value?.latitude != null) {
          this.snap.gpsPosition = [value.latitude, value.longitude];
          this.gps.push(value.latitude, value.longitude);
          this.snap.gpsTrack = this.gps.points();
        }
        break;
      case "navigation.deadReckoning.uncertainty":
        this.snap.uncertainty = value;
        break;
      case "navigation.deadReckoning.divergence":
        this.snap.divergence = value;
        this.spark.push(value?.distance_nm);
        this.snap.sparkStats = this.spark.stats();
        break;
      case "navigation.deadReckoning.log":
        this.shadowRoot.querySelector("#dr-log").textContent =
          `${Number(value ?? 0).toFixed(2)} nm`;
        break;
      case "navigation.deadReckoning.method":
        this.shadowRoot.querySelector("#dr-method").textContent = String(
          value ?? "—",
        );
        break;
      case "navigation.deadReckoning.active":
        this.renderOverride(Boolean(value));
        break;
      case "navigation.deadReckoning.state":
        this.renderDrState(value);
        break;
      default:
        break;
    }
  }

  /**
   * Loads persisted overlays (fixes, LOPs/CPLs, snap vectors) from the
   * plugin REST API.
   *
   * @returns {Promise<void>}
   */
  async refreshOverlays() {
    try {
      const [fixes, observations, corrections] = await Promise.all([
        fetch(`${API}/fixes?limit=200`).then((r) => r.json()),
        fetch(`${API}/observations?limit=200`).then((r) => r.json()),
        fetch(`${API}/corrections?limit=50`).then((r) => r.json()),
      ]);
      this.snap.fixes = fixes.fixes ?? [];
      // Oldest-first renders stacked nicely; db returns newest-first.
      this.snap.fixes.reverse();
      this.snap.lops = observations.lops ?? [];
      this.snap.cpls = observations.cpls ?? [];
      this.snap.corrections = corrections.corrections ?? [];
      this.render();
    } catch {
      /* REST unavailable — live stream parts still render */
    }
  }

  /** @returns {void} */
  render() {
    // Headline: divergence + elapsed since last fix.
    this.shadowRoot.querySelector("#dr-divergence").textContent =
      vm.divergenceText(this.snap.divergence);
    this.map?.render(this.snap);
  }

  /**
   * Toggles the manual NORMAL ↔ OVERRIDE switch via the plugin REST API.
   * Always human-initiated (SPEC §7, §14.1).
   *
   * @returns {Promise<void>}
   */
  async toggleOverride() {
    const active = !this.btn?.classList.contains("engaged");
    try {
      const res = await fetch(`${API}/override`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this.renderOverride(data.active);
    } catch (err) {
      console.error("override toggle failed", err);
    }
  }

  /**
   * Renders the override button/label state.
   *
   * @param {boolean} active
   * @returns {void}
   */
  renderOverride(active) {
    if (!this.btn || !this.stateLabel) return;
    this.btn.classList.toggle("engaged", active);
    this.btn.textContent = active ? "Release OVERRIDE" : "Engage OVERRIDE";
    this.stateLabel.textContent = active
      ? "OVERRIDE (DR authoritative)"
      : "NORMAL (GPS authoritative)";
  }

  /**
   * Renders the DR engine state — explains why the readout is empty
   * when idle (moored, no speed/heading) so the user isn't left
   * guessing.
   *
   * @param {{status: string, reason?: string}|null} value
   * @returns {void}
   */
  renderDrState(value) {
    const panel = this.shadowRoot.querySelector("#dr-status-panel");
    const text = this.shadowRoot.querySelector("#dr-status-text");
    if (!panel || !text) return;
    panel.classList.remove("idle", "underway");
    if (!value) {
      text.textContent = "No dead-reckoning data";
      return;
    }
    if (value.status === "idle") {
      panel.classList.add("idle");
      const reason = value.reason ?? "waiting for speed and heading";
      text.textContent = `Dead reckoning idle — ${reason}. GPS position still shown on map.`;
    } else if (value.status === "underway") {
      panel.classList.add("underway");
      text.textContent = "Dead reckoning active";
    }
  }

  /**
   * Renders the stream link state so a dropped connection is visible
   * immediately.
   *
   * @param {{state: "connecting"|"open"|"retrying"}} status
   * @returns {void}
   */
  renderLinkStatus(status) {
    const panel = this.shadowRoot.querySelector("#dr-status-panel");
    const text = this.shadowRoot.querySelector("#dr-status-text");
    if (!panel || !text) return;
    panel.classList.remove("retrying");
    if (status.state === "connecting") {
      text.textContent = "Connecting to Signal K…";
    } else if (status.state === "retrying") {
      panel.classList.add("retrying");
      text.textContent = "Signal K link lost — reconnecting…";
    }
    // "open" — let the DR state panel take over once data flows.
  }
}

customElements.define("dr-app", DrApp);
