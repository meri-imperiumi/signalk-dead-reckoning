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

import {
  fetchHistory,
  mergeHistoryTrack,
  seriesToTrack,
} from "./dr-history.js";
import * as posfmt from "./dr-position-format.js";
import { THEME_CSS } from "./dr-theme.js";
import * as vm from "./dr-viewmodel.js";
import "./dr-map-view.js";
import "./dr-current-panel.js";
import "./dr-sight-panel.js";
import "./dr-fix-panel.js";
import "./dr-pending-list.js";
import "./dr-detail-popover.js";

/** Signal K mounts plugin REST routes under /plugins/<name>/. */
const API = "/plugins/signalk-dead-reckoning";

const template = document.createElement("template");
template.innerHTML = /* html */ `
  <style>
    ${THEME_CSS}
    :host { display: block; padding: 1rem; }
    /* Headline figures: massive monospace payload, tracked labels */
    .dr-headline {
      display: flex;
      gap: clamp(1rem, 3vw, 2.5rem);
      flex-wrap: wrap;
      align-items: end;
    }
    .dr-figure { display: flex; flex-direction: column; gap: 0.15rem; }
    .dr-figure .value {
      font-family: ui-monospace, "Fira Code", monospace;
      font-size: clamp(1.5rem, 4vw, 2.5rem);
      font-weight: 700;
      line-height: 1.05;
      color: var(--text-main);
      font-variant-numeric: tabular-nums;
    }
    .dr-figure .label {
      font-size: 0.75rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--theme-color);
    }
    .dr-toolbar {
      display: flex;
      gap: 0.5rem;
      margin-left: auto;
      align-items: center;
      flex-wrap: wrap;
    }
    /* Engine status line — semantic theme per state */
    .dr-status {
      font-family: ui-monospace, "Fira Code", monospace;
      font-size: 0.9rem;
      text-align: center;
      color: var(--text-muted);
      --theme-color: var(--color-green);
    }
    .dr-status.idle,
    .dr-status.transient {
      --theme-color: var(--color-orange);
      color: var(--color-orange);
    }
    .dr-status.underway {
      --theme-color: var(--color-green);
      color: var(--color-green);
    }
    .dr-status.alert,
    .dr-status.retrying {
      --theme-color: var(--color-red);
      color: var(--color-red);
      font-weight: 600;
    }
    /* Failover control — alternate-power semantics: orange, red when
       engaged (DR authoritative). */
    .dr-override {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      flex-wrap: wrap;
    }
    .dr-override button {
      --theme-color: var(--color-orange);
      min-width: 13rem;
    }
    .dr-override button.engaged,
    .dr-override button.engaged:hover,
    .dr-override button.engaged:active {
      --theme-color: var(--color-red);
      background: var(--color-red);
      border-color: var(--color-red);
      color: var(--bg-base);
    }
    .dr-override #dr-override-state {
      font-family: ui-monospace, "Fira Code", monospace;
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--text-muted);
    }
    dialog {
      max-width: 32rem;
      width: 90vw;
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 0;
      background: var(--bg-panel);
      color: var(--text-main);
      padding: 0;
    }
    dialog::backdrop {
      background: rgba(8, 10, 12, 0.7);
    }
    /* Phone-first (work doc #13 update #2): dialogs become bottom
       sheets on narrow viewports — the map stays visible around the
       form, dismissable with ✕, re-visible on submit. */
    @media (max-width: 600px) {
      dialog {
        margin: auto auto 0 auto;
        width: 100vw;
        max-width: none;
        border-left: none;
        border-right: none;
        border-bottom: none;
        max-height: 85vh;
      }
    }
  </style>
  <section class="sk-card theme-teal dr-headline">
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
    <div class="dr-figure" id="dr-current-fig">
      <span class="value" id="dr-current">—</span>
      <span class="label" id="dr-current-label">Current set/drift</span>
    </div>
    <div class="dr-figure">
      <span class="value" id="dr-method">—</span>
      <span class="label">Active method</span>
    </div>
    <div class="dr-toolbar">
      <button id="btn-current" title="Manual set &amp; drift — the override outranks weather/pilot-chart sources while its TTL lasts">≋ Current</button>
      <button id="btn-sight">⊕ Sight / LOP</button>
      <button id="btn-coord-fix" title="Confirm a fix at coordinates — prefilled from the current GNSS position, editable for offline/known-position fixes">⊙ Fix at coordinates</button>
    </div>
  </section>

  <section class="sk-card dr-status" id="dr-status-panel">
    <span id="dr-status-text">Connecting to Signal K…</span>
  </section>

  <section class="sk-card">
    <h2>Ghost Track <button id="dr-recenter" title="Follow DR position">◎</button></h2>
    <dr-map-view id="dr-map"></dr-map-view>
  </section>

  <section class="sk-card">
    <h2>Pending Observations</h2>
    <dr-pending-list id="dr-pending"></dr-pending-list>
  </section>

  <dialog id="current-dialog">
    <dr-current-panel id="dr-current-panel"></dr-current-panel>
  </dialog>

  <dialog id="sight-dialog">
    <dr-sight-panel id="dr-sight"></dr-sight-panel>
  </dialog>

  <dialog id="fix-dialog">
    <dr-fix-panel id="dr-fix"></dr-fix-panel>
  </dialog>

  <dialog id="detail-dialog">
    <dr-detail-popover id="dr-detail"></dr-detail-popover>
  </dialog>

  <section class="sk-card dr-override">
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

    /** @type {string|null} vessel's navigation.state ("moored", …) */
    this.vesselNavState = null;
    /** @type {object|null} last navigation.deadReckoning.state value */
    this.drStateValue = null;

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
    // dialog with the object position pre-seeded (and its charted name,
    // when the picked symbol carries one — light, seamark, peak…).
    this.map?.addEventListener("dr-pick-position", (e) => {
      const { lat, lng, mode, label } = e.detail;
      openSight();
      this.sight?.seedObjectPosition(lat, lng, mode, label);
    });

    /** @type {HTMLDialogElement|null} */
    this.sightDialog = root.querySelector("#sight-dialog");
    /** Opens the sight dialog (entry form — the pending list lives
     *  alongside the map now, work doc #13 stage A). */
    const openSight = () => {
      this.sightDialog?.showModal();
    };
    root.querySelector("#btn-sight")?.addEventListener("click", openSight);

    // "Fix at coordinates" — opens the prefilled confirm dialog.
    /** @type {HTMLDialogElement|null} */
    this.fixDialog = root.querySelector("#fix-dialog");
    /** @type {import("./dr-fix-panel.js").default|null} */
    this.fixPanel = root.querySelector("#dr-fix");
    const openFix = () => {
      this.fixPanel?.seed({
        position: this.snap.gpsPosition,
        gnss: this.snap.gnss,
      });
      this.fixDialog?.showModal();
    };
    root.querySelector("#btn-coord-fix")?.addEventListener("click", openFix);
    this.fixPanel?.addEventListener("dr-fix-confirmed", () => {
      this.snap.candidate = null;
      this.refreshOverlays();
    });
    this.fixPanel?.addEventListener("dr-close", () => this.fixDialog?.close());

    // Manual set & drift (§6.2 tier 1): the panel edits the override;
    // changes re-read /status so the header figure updates even when
    // the DR engine is idle (no deltas flowing).
    /** @type {HTMLDialogElement|null} */
    this.currentDialog = root.querySelector("#current-dialog");
    /** @type {import("./dr-current-panel.js").default|null} */
    this.currentPanel = root.querySelector("#dr-current-panel");
    root.querySelector("#btn-current")?.addEventListener("click", () => {
      this.currentPanel?.refresh();
      this.currentDialog?.showModal();
    });
    this.currentPanel?.addEventListener("dr-current-changed", () =>
      this.fetchStatus(),
    );
    this.currentPanel?.addEventListener("dr-close", () =>
      this.currentDialog?.close(),
    );

    /** @type {import("./dr-sight-panel.js").default|null} */
    this.sight = root.querySelector("#dr-sight");
    this.sight?.loadBodies();

    // Pending observations list (work doc #13 stage A): selection drives
    // the map highlight; preview/confirm resolve the selected subset.
    /** @type {import("./dr-pending-list.js").default|null} */
    this.pendingList = root.querySelector("#dr-pending");
    this.pendingList?.refresh();
    this.pendingList?.addEventListener("dr-select-observation", (e) => {
      const { kind, id, selected } = e.detail;
      const key = `${kind}:${id}`;
      this.selectedObservations ??= new Set();
      if (selected) this.selectedObservations.add(key);
      else this.selectedObservations.delete(key);
      // Highlight the most recent selection; clear when none remain.
      this.snap.highlight =
        this.selectedObservations.size > 0 ? { kind, id } : null;
      this.render();
    });
    this.pendingList?.addEventListener("dr-candidate-resolved", (e) =>
      this.showCandidate(e.detail),
    );
    this.pendingList?.addEventListener("dr-fix-confirmed", () => {
      this.snap.candidate = null;
      this.snap.highlight = null;
      this.selectedObservations = new Set();
      this.refreshOverlays();
    });

    // Detail popover (work doc #13 update #1): map-click inspection.
    /** @type {HTMLDialogElement|null} */
    this.detailDialog = root.querySelector("#detail-dialog");
    /** @type {import("./dr-detail-popover.js").default|null} */
    this.detail = root.querySelector("#dr-detail");
    this.detail?.addEventListener("dr-close", () => this.detailDialog?.close());
    this.map?.addEventListener("dr-inspect", (e) => {
      const { kind, id } = e.detail;
      const row =
        kind === "lop"
          ? this.snap.lops.find((l) => l.lop_id === id)
          : kind === "cpl"
            ? this.snap.cpls.find((c) => c.cpl_id === id)
            : this.snap.fixes.find((f) => f.fix_id === id);
      if (!row) return;
      this.detail?.show({ kind, id, row }, this.snap);
      this.detailDialog?.showModal();
    });

    // Edit requests (pending list rows + popover) → sight form seeded,
    // submit PUTs via the panel's edit mode.
    const beginEdit = (detail) => {
      const { kind, id, row } = detail;
      const record =
        row ??
        (kind === "lop"
          ? this.snap.lops.find((l) => l.lop_id === id)
          : this.snap.cpls.find((c) => c.cpl_id === id));
      if (!record) return;
      openSight();
      this.sight?.beginEdit({ ...record, kind });
    };
    this.addEventListener("dr-edit-observation", (e) => beginEdit(e.detail));

    // Any observation create/edit/delete (sight panel submit, pending
    // list, popover) refreshes overlays + the pending list.
    this.addEventListener("dr-observations-changed", () => {
      this.refreshOverlays();
      this.pendingList?.refresh();
    });
    this.sight?.addEventListener("dr-close", () => this.sightDialog?.close());
    // Esc closes the native dialog without a dr-close event — clear
    // any lingering edit mode so the next submit creates, not PUTs.
    this.sightDialog?.addEventListener("close", () => this.sight?.endEdit());

    // View-model state
    this.ghost = new vm.TrackLog(3600);
    this.gps = new vm.TrackLog(3600);
    this.spark = new vm.Sparkline(120);
    this.lastElapsedS = null;
    /** History-API backfill tracks (null until a provider answers). */
    this.gpsHistory = [];
    this.ghostHistory = [];
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
      gnss: null,
      highlight: null,
      current: null,
      manualCurrent: null,
    };

    this.connectStream();
    this.loadPluginConfig();
    this.bootstrapSelf();
    this.fetchStatus();
    this.refreshOverlays();
    this.refreshTrackHistory();
    // Slow REST refresh for persisted overlays; stream drives the live parts.
    // /status also refreshes the header current figure (manual TTL
    // countdown) between deltas.
    setInterval(() => {
      this.refreshOverlays();
      this.fetchStatus();
    }, 30000);
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
      "navigation.state",
      "navigation.position",
      "navigation.gnss.type",
      "navigation.gnss.method",
      "navigation.gnss.satellites",
      "navigation.gnss.satellitesVisible",
      "navigation.gnss.horizontalDilution",
      "environment.mode",
      "environment.current.setTrue",
      "environment.current.drift",
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
        this.fixPanel?.applyFormat(fmt);
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
      const navState = nav?.navigation?.state?.value ?? nav?.navigation?.state;
      if (navState != null) this.applyValue("navigation.state", navState);
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
      // GNSS fix-quality snapshot for the fix dialog's stats block.
      const gnss = nav?.navigation?.gnss;
      if (gnss) {
        const pick = (key) => gnss[key]?.value ?? gnss[key] ?? undefined;
        this.applyGnss({
          type: pick("type"),
          method: pick("method"),
          satellites: pick("satellites"),
          satellitesVisible: pick("satellitesVisible"),
          hdop: pick("horizontalDilution"),
        });
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
          this.updateGhostTrack();
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
          this.liveUpdateFixPanel();
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
        // Bus value is metres; the sparkline normalizes to its own
        // min/max so the unit only matters for consistency.
        this.spark.push(value?.distance_m);
        this.snap.sparkStats = this.spark.stats();
        break;
      case "navigation.deadReckoning.log":
        this.shadowRoot.querySelector("#dr-log").textContent =
          `${vm.metresToNm(Number(value ?? 0)).toFixed(2)} nm`;
        break;
      case "navigation.deadReckoning.method": {
        const methodEl = this.shadowRoot.querySelector("#dr-method");
        methodEl.textContent = vm.methodLabel(value);
        // Full spec token on hover — the short label is for the glance,
        // the tooltip for the manual.
        methodEl.title = typeof value === "string" ? value : "";
        break;
      }
      case "navigation.deadReckoning.active":
        this.renderOverride(Boolean(value));
        break;
      case "navigation.state":
        this.vesselNavState = typeof value === "string" ? value : null;
        // Re-render the DR status line — its wording depends on the
        // vessel state ("DR warm — moored").
        if (this.drStateValue) this.renderDrState(this.drStateValue);
        break;
      case "navigation.deadReckoning.state":
        this.drStateValue = value;
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
      case "navigation.gnss.type":
        this.applyGnss({ type: value });
        break;
      case "navigation.gnss.method":
        this.applyGnss({ method: value });
        break;
      case "navigation.gnss.satellites":
        this.applyGnss({ satellites: value });
        break;
      case "navigation.gnss.satellitesVisible":
        this.applyGnss({ satellitesVisible: value });
        break;
      case "navigation.gnss.horizontalDilution":
        this.applyGnss({ hdop: value });
        break;
      case "environment.mode":
        // Day/night theme hook (UI spec): the document root carries
        // data-mode so the tactical palette can lift the canvas for
        // daylight legibility.
        if (value === "night" || value === "day") {
          document.documentElement.setAttribute("data-mode", value);
        }
        break;
      case "environment.current.setTrue":
        // Bus value is radians; the snap (and /status) carry degrees.
        if (Number.isFinite(value)) {
          this.snap.current = {
            ...this.snap.current,
            setTrue: vm.radToDeg(value),
          };
        }
        this.renderCurrent();
        break;
      case "environment.current.drift":
        // Bus value is m/s; the snap (and /status) carry knots.
        if (Number.isFinite(value)) {
          this.snap.current = { ...this.snap.current, drift: vm.msToKn(value) };
        }
        this.renderCurrent();
        break;
      default:
        break;
    }
  }

  /**
   * Merges GNSS fix-quality fields into the snap state and pushes a live
   * update into the fix dialog when it's open (stats + prefilled
   * coordinates the user hasn't edited).
   *
   * @param {Partial<{type: string, method: string, satellites: number, satellitesVisible: number, hdop: number}>} fields
   * @returns {void}
   */
  applyGnss(fields) {
    this.snap.gnss = { ...(this.snap.gnss ?? {}), ...fields };
    this.liveUpdateFixPanel();
  }

  /**
   * Feeds the current position + GNSS quality into an open fix dialog.
   * @returns {void}
   */
  liveUpdateFixPanel() {
    if (!this.fixDialog?.open || !this.fixPanel) return;
    this.fixPanel.updateGnss({
      position: this.snap.gpsPosition,
      gnss: this.snap.gnss,
    });
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
    this.snap.gpsTrack = mergeHistoryTrack(this.gpsHistory, this.gps.points());
  }

  /**
   * Same merge for the DR ghost track — a page reload no longer blanks
   * it when a history provider is configured.
   *
   * @returns {void}
   */
  updateGhostTrack() {
    this.snap.ghostTrack = mergeHistoryTrack(
      this.ghostHistory,
      this.ghost.points(),
    );
  }

  /**
   * Backfills restart-survival series from the Signal K History API in
   * a single multi-path request: the GPS track (the baseline DR
   * divergence is measured against), the DR ghost track, and the
   * divergence record (an object — `:last` aggregation, the only kind
   * non-numeric paths accept). Falls back silently to the live-session
   * buffers when no history provider is configured (request fails).
   *
   * @returns {Promise<void>}
   */
  async refreshTrackHistory() {
    const series = await fetchHistory({
      paths: [
        "navigation.position",
        "navigation.deadReckoning.position",
        "navigation.deadReckoning.divergence:last",
      ],
      durationSec: 6 * 3600,
      resolutionSec: 60,
    });
    if (!series) return; // no history provider — live buffers only
    const byPath = new Map(series.map((s) => [s.path, s]));
    const gps = byPath.get("navigation.position");
    if (gps && gps.points.length > 0) {
      this.gpsHistory = seriesToTrack(gps.points);
      this.updateGpsTrack();
      this.snap.gpsPosition = this.gpsHistory[this.gpsHistory.length - 1];
    }
    const ghost = byPath.get("navigation.deadReckoning.position");
    if (ghost && ghost.points.length > 0) {
      this.ghostHistory = seriesToTrack(ghost.points);
      this.updateGhostTrack();
    }
    const dvg = byPath.get("navigation.deadReckoning.divergence");
    if (dvg) {
      for (const { v } of dvg.points) {
        const nm = v?.distance_nm;
        if (nm != null && Number.isFinite(nm)) this.spark.push(nm);
      }
      this.snap.sparkStats = this.spark.stats();
    }
    this.render();
  }

  /** @returns {void} */
  render() {
    // Headline: divergence + elapsed since last fix.
    this.shadowRoot.querySelector("#dr-divergence").textContent =
      vm.divergenceText(this.snap.divergence);
    this.map?.render(this.snap);
  }

  /**
   * Fetches the plugin status snapshot so the header's current figure
   * reflects the resolved vector + manual override even before (or
   * without) live `environment.current` deltas.
   *
   * @returns {Promise<void>}
   */
  async fetchStatus() {
    try {
      const res = await fetch(`${API}/status`);
      if (!res.ok) return;
      const body = await res.json();
      this.snap.current = body.current ?? this.snap.current;
      this.snap.manualCurrent = body.manualCurrent ?? null;
      this.renderCurrent();
    } catch {
      /* REST unavailable — stream will drive when it can */
    }
  }

  /**
   * Renders the header set/drift figure with its semantic source
   * theme (manual = orange, weather/pilot = teal, none = offline).
   *
   * @returns {void}
   */
  renderCurrent() {
    const fig = this.shadowRoot.querySelector("#dr-current-fig");
    const value = this.shadowRoot.querySelector("#dr-current");
    const label = this.shadowRoot.querySelector("#dr-current-label");
    if (!fig || !value || !label) return;
    const f = vm.currentFigure(this.snap.current, this.snap.manualCurrent);
    value.textContent = f.value;
    label.textContent = f.label;
    fig.classList.remove("theme-orange", "theme-teal", "theme-offline");
    if (f.theme) fig.classList.add(f.theme);
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
      if (value.moving) panel.classList.add("alert");
    } else if (value.status === "underway") {
      panel.classList.add("underway");
      if (value.fouled) panel.classList.add("alert");
      else if (value.transient) panel.classList.add("transient");
    } else if (value.status === "warm") {
      // Engine alive, boat tied up — muted, no status color crying wolf.
      if (value.fouled) panel.classList.add("alert");
    }
    const next = vm.drStatusText({ ...value, navState: this.vesselNavState });
    if (next != null) text.textContent = next;
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
