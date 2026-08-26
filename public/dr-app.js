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

import * as posfmt from "./dr-position-format.js";
import * as vm from "./dr-viewmodel.js";
import "./dr-map-view.js";
import "./dr-sight-panel.js";

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
    .dr-status.alert {
      color: #f85149;
      font-weight: 600;
    }
    .dr-status.transient {
      color: #f0b429;
    }
    .dr-status.retrying {
      color: #f85149;
    }
    .dr-toolbar {
      display: flex;
      gap: 0.5rem;
      margin-left: auto;
      align-items: center;
    }
    .dr-toolbar button {
      font: inherit;
      padding: 0.4rem 0.8rem;
      border-radius: 6px;
      border: 1px solid #2d3748;
      background: #1a202c;
      color: var(--dr-fg, #e6edf3);
      cursor: pointer;
    }
    dialog {
      max-width: 32rem;
      width: 90vw;
      border: 1px solid #2d3748;
      border-radius: 8px;
      background: var(--dr-panel, #111827);
      color: var(--dr-fg, #e6edf3);
      padding: 0;
    }
    dialog::backdrop {
      background: rgba(0, 0, 0, 0.6);
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
    <div class="dr-toolbar">
      <button id="btn-sight">⊕ Sight / LOP</button>
      <button id="btn-gps-fix" title="Confirm a fix at the current GNSS position (GPS reality check)">⊙ Fix at GPS</button>
    </div>
  </section>

  <section class="dr-panel dr-status" id="dr-status-panel">
    <span id="dr-status-text">Connecting to Signal K…</span>
  </section>

  <section class="dr-panel">
    <h2>Ghost Track <button id="dr-recenter" title="Follow DR position">◎</button></h2>
    <dr-map-view id="dr-map"></dr-map-view>
  </section>

  <dialog id="sight-dialog">
    <dr-sight-panel id="dr-sight"></dr-sight-panel>
  </dialog>

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
    // Chart pick: right-click an object on the map → open the sight
    // dialog with the object position pre-seeded.
    this.map?.addEventListener("dr-pick-position", (e) => {
      const { lat, lng, mode } = e.detail;
      openSight();
      this.sight?.seedObjectPosition(lat, lng, mode);
    });

    /** @type {HTMLDialogElement|null} */
    this.sightDialog = root.querySelector("#sight-dialog");
    /** Open the sight dialog and re-hydrate pending observations. */
    const openSight = () => {
      this.sightDialog?.showModal();
      this.sight?.hydratePending();
    };
    root.querySelector("#btn-sight")?.addEventListener("click", openSight);

    /** Confirm a fix at the current GNSS position (GPS reality check). */
    root
      .querySelector("#btn-gps-fix")
      ?.addEventListener("click", () => this.confirmGpsFix());

    /** @type {import("./dr-sight-panel.js").default|null} */
    this.sight = root.querySelector("#dr-sight");
    this.sight?.loadBodies();
    this.sight?.addEventListener("dr-observations-changed", () =>
      this.refreshOverlays(),
    );
    this.sight?.addEventListener("dr-candidate-resolved", (e) =>
      this.showCandidate(e.detail),
    );
    this.sight?.addEventListener("dr-fix-confirmed", () => {
      this.snap.candidate = null;
      this.refreshOverlays();
    });
    this.sight?.addEventListener("dr-close", () => this.sightDialog?.close());

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
      candidate: null,
      ghostTrack: [],
      gpsTrack: [],
      sparkStats: null,
    };

    this.connectStream();
    this.loadPluginConfig();
    this.bootstrapSelf();
    this.refreshOverlays();
    this.refreshGpsHistory();
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
      "navigation.deadReckoning.elapsedSinceFix",
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
  /**
   * Fetches the plugin config (mount `/signalk/v2/api/<id>/configuration`)
   * and applies the server-configured position format so the sight
   * panel, map tooltips, and fix labels all match the charts in use.
   * Mirrors the signalk-status-tiles config-load pattern. Falls back
   * to the default (DMS) when the endpoint is unavailable.
   *
   * @returns {Promise<void>>
   */
  async loadPluginConfig() {
    try {
      const res = await fetch(
        `/signalk/v2/api/signalk-dead-reckoning/configuration`,
      );
      if (!res.ok) return;
      const body = await res.json();
      const fmt = body?.config?.positionFormat;
      if (fmt === "decimal" || fmt === "dm" || fmt === "dms") {
        posfmt.setFormat(fmt);
        this.sight?.applyFormat(fmt);
      }
      this.lastConfigHash = body?.configHash ?? null;
    } catch {
      /* REST unavailable — keep the default format */
    }
  }

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
      if (dr?.elapsedSinceFix?.value != null) {
        this.applyValue(
          "navigation.deadReckoning.elapsedSinceFix",
          dr.elapsedSinceFix.value,
        );
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
          this.sight?.setDefaultPosition(value);
        }
        break;
      case "navigation.position":
        if (value?.latitude != null) {
          this.snap.gpsPosition = [value.latitude, value.longitude];
          this.gps.push(value.latitude, value.longitude);
          // Merge the live point onto the history track if we have one,
          // else use the live-session ring buffer alone.
          this.updateGpsTrack();
          this.renderGpsFixButton();
          // Default the sight panel's assumed position to GPS when DR
          // isn't running (moored). DR position takes priority when it
          // arrives (applied in its own case below).
          if (!this.snap.drPosition) {
            this.sight?.setDefaultPosition(value);
          }
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
      case "navigation.deadReckoning.elapsedSinceFix":
        this.shadowRoot.querySelector("#dr-elapsed").textContent =
          vm.elapsedText(value);
        break;
      case "navigation.deadReckoning.configHash": {
        // Server-side config edit → re-fetch the plugin config so the
        // position format and other settings update live.
        if (typeof value === "string" && value !== this.lastConfigHash) {
          this.lastConfigHash = value;
          this.loadPluginConfig();
        }
        break;
      }
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

  /**
   * Merges the historical GPS track with the live-session ring buffer
   * so the polyline is continuous (history → live continuation).
   *
   * @returns {void}
   */
  updateGpsTrack() {
    const live = this.gps.points();
    if (this.gpsHistory && this.gpsHistory.length > 0) {
      const last = this.gpsHistory[this.gpsHistory.length - 1];
      const extending = live.filter(
        (p) =>
          Math.abs(p[0] - last[0]) > 0.001 || Math.abs(p[1] - last[1]) > 0.001,
      );
      this.snap.gpsTrack = [...this.gpsHistory, ...extending];
    } else {
      this.snap.gpsTrack = live;
    }
  }

  /**
   * Fetches the historical GPS track from the Signal K history API (see
   * ../signalk-logbook's Map.jsx) and merges it with the live-session
   * track so the map shows where the boat has actually been — the
   * baseline against which DR divergence is measured. Falls back
   * silently to the live-session track when no history provider is
   * configured (the route 404s).
   *
   * @returns {Promise<void>}
   */
  async refreshGpsHistory() {
    try {
      const res = await fetch(vm.historyUrl());
      if (!res.ok) return;
      const data = await res.json();
      const history = vm.historyToTrack(data);
      if (history.length === 0) return;
      this.gpsHistory = history;
      this.updateGpsTrack();
      this.snap.gpsPosition = history[history.length - 1];
      this.render();
    } catch {
      /* no history provider — live stream track is the fallback */
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
   * Shows a resolved candidate fix on the map (distinct from confirmed
   * fixes) so the watchkeeper can sanity-check before confirming.
   *
   * @param {object} candidate - from POST /fix/resolve
   * @returns {void}
   */
  showCandidate(candidate) {
    this.snap.candidate = candidate;
    this.render();
  }

  /**
   * Enables/disables the "Fix at GPS" button based on whether a GPS
   * position is currently known.
   * @returns {void}
   */
  renderGpsFixButton() {
    const btn = this.shadowRoot?.querySelector("#btn-gps-fix");
    if (btn) btn.disabled = !this.snap.gpsPosition;
  }

  /**
   * Confirms a fix at the current GNSS position — the GPS reality check
   * (SPEC §9.3): the watchkeeper judges GPS good right now and snaps the
   * DR origin to it. This is a GPS *point* fix (source_type "gps"), not a
   * celestial/LOP fix; it records a `fixes` row and a `dr_corrections`
   * row if the origin moves, and refreshes the overlays. Disabled when
   * no GPS position is known.
   *
   * @returns {Promise<void>}
   */
  async confirmGpsFix() {
    const pos = this.snap.gpsPosition;
    if (!pos) return;
    const [latitude, longitude] = pos;
    try {
      const res = await fetch(`${API}/fix`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_type: "gps",
          latitude,
          longitude,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await this.refreshOverlays();
    } catch (err) {
      console.error("GPS fix confirm failed", err);
    }
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
    panel.classList.remove("idle", "underway", "alert", "transient");
    if (!value) {
      text.textContent = "No dead-reckoning data";
      return;
    }
    if (value.status === "idle") {
      panel.classList.add("idle");
      const reason = value.reason ?? "waiting for speed and heading";
      if (value.moving) {
        // Idle while making way — the dangerous case (fouled paddlewheel,
        // sensor dropout): DR is stale, not merely paused.
        panel.classList.add("alert");
        text.textContent = `⚠ DR stale — ${reason}, but the vessel is making way. DR position is NOT tracking; uncertainty is growing.`;
      } else {
        text.textContent = `Dead reckoning idle — ${reason}. GPS position still shown on map.`;
      }
    } else if (value.status === "underway") {
      panel.classList.add("underway");
      if (value.fouled) {
        panel.classList.add("alert");
        text.textContent =
          "⚠ Paddlewheel appears fouled — STW≈0 while making way. DR is integrating near-zero speed.";
      } else if (value.transient) {
        panel.classList.add("transient");
        text.textContent =
          "Dead reckoning active — tack/gybe in progress, divergence may spike temporarily.";
      } else {
        text.textContent = "Dead reckoning active";
      }
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
