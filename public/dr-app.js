/**
 * `<dr-app>` — top-level layout for the Dead Reckoning webapp.
 *
 * Plotter layout (work doc #26): the chart IS the app — `<dr-map-view>`
 * fills the whole viewport, and every DR control floats over it as a
 * translucent `.sk-floating` overlay. Corner assignment: top-left =
 * taking bearings & fixes (Sight/LOP + Fix entry, plus the
 * pending-observations drawer when it has rows — the whole box only
 * appears when there ARE pending observations); top-right = GPS
 * status (engine status badge) and the failover control; bottom-right
 * = the water-track readout (log, elapsed, divergence + trend
 * sparkline, current, method) with the manual current entry beside
 * the figure it edits; bottom-left = the map's own control stack
 * (zoom, chart layers, follow). The overlay layer is
 * pointer-transparent except on the panels themselves, so the chart
 * stays draggable between the controls. Live data flows from the Signal K WebSocket stream
 * through the view-model (tracks, sparkline) into `<dr-map-view>`;
 * REST overlays (fixes, LOPs, CPLs, snap vectors) refresh on a slow
 * poll and after any confirm POST. AIS targets (work doc #23) ride
 * the same stream under `vessels.*`, accumulate in a pure store
 * (dr-viewmodel), and render through the map's AIS layer —
 * right-clicking a target seeds a bearing from its predicted
 * position.
 *
 * The webapp is also a plotter-extension **host** (work doc #27):
 * `PlotterExtHost` discovers other plugins' `plotterExtensions`
 * manifests and places their widgets in `<dr-ext-widget-area>` grids
 * anchored below this app's own top panels.
 *
 * @file dr-app.js
 */

import { PlotterExtHost } from "./dr-ext-host.js";
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
    /* Plotter layout (work doc #26): no page scroll — the host is the
       viewport, the map fills it, controls float on top. */
    :host {
      position: relative;
      display: block;
      height: 100vh; /* fallback for pre-dvh browsers */
      height: 100dvh;
      overflow: hidden;
    }
    /* The chart IS the app. */
    #dr-map {
      position: absolute;
      inset: 0;
      z-index: 1;
    }
    /* Floating control layer: transparent to pointer events except
       where a panel sits, so the chart stays draggable/zoomable in
       every gap between the controls. */
    .dr-overlay {
      position: absolute;
      inset: 0;
      z-index: 1100;
      pointer-events: none;
      display: flex;
      flex-direction: column;
    }
    .dr-top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 0.5rem;
      padding: 8px;
    }
    .dr-tools,
    .dr-gps,
    .dr-readout,
    .dr-drawer {
      pointer-events: auto;
    }
    /* Corner assignment (work doc #26 update #2): top-left = taking
       bearings & fixes (+ the pending list when it has rows); top-right
       = GPS status & override; bottom-right = water-track readout &
       other status; bottom-left = the map's own control stack. */
    /* Headline figures: compact strip payload — still tabular-nums
       monospace, sized for a glance without eating the viewport. */
    .dr-headline {
      display: flex;
      gap: clamp(0.75rem, 2vw, 1.5rem);
      flex-wrap: wrap;
      align-items: end;
    }
    .dr-figure { display: flex; flex-direction: column; gap: 0.15rem; }
    .dr-figure .value {
      font-family: ui-monospace, "Fira Code", monospace;
      font-size: clamp(1.2rem, 2.5vw, 1.9rem);
      font-weight: 700;
      line-height: 1.05;
      color: var(--text-main);
      font-variant-numeric: tabular-nums;
    }
    .dr-figure .label {
      font-size: 0.7rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--theme-color);
    }
    /* Divergence figure carries its trend sparkline beside the
       value (SPEC §14.1) — moved here from the map's old bottom-right
       chip when that corner was assigned to this panel. */
    .dr-figure .value-row {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .dr-figure canvas {
      display: block;
    }
    /* Engine status badge — inline in the GPS panel, semantic theme
       per state. Single line with ellipsis so the panel stays one row
       tall (matching the tools panel); the full text rides along as
       the hover title — the long alert wording is for the deliberate
       look, the glance gets the gist. */
    .dr-status {
      margin: 0;
      max-width: 22rem;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-family: ui-monospace, "Fira Code", monospace;
      font-size: 0.75rem;
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
    /* Entry tools — top-left panel: taking bearings and fixes. The
       pending toggle only renders when there ARE pending observations
       (hidden while the list is empty). */
    .dr-tools {
      display: flex;
      gap: 0.5rem;
      align-items: center;
      flex-wrap: wrap;
      justify-content: flex-start;
    }
    .dr-tools #btn-pending[aria-expanded="true"] {
      --theme-color: var(--color-teal);
      background: var(--color-teal);
      color: var(--bg-base);
    }
    /* Failover control — top-right panel, inline with the status
       badge: one row, same vertical size as the tools panel. Alternate-
       power semantics: orange, red when engaged (DR authoritative).
       The button keeps its minimum width — SPEC §14.1: prominent,
       always human-initiated. */
    .dr-gps {
      display: flex;
      flex-direction: row;
      align-items: center;
      justify-content: flex-end;
      gap: 0.75rem;
      flex-wrap: wrap;
    }
    .dr-override {
      display: flex;
      align-items: center;
      justify-content: flex-end;
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
    /* Pending-observations drawer: docked left, below the entry
       tools; the list scrolls inside, the panel never grows past the
       viewport. The whole box (toggle included) disappears when there
       are no pending observations. */
    .dr-pane {
      flex: 1;
      min-height: 0;
      display: flex;
      justify-content: flex-start;
      align-items: flex-start;
      padding: 0 8px 8px 8px;
    }
    .dr-drawer {
      width: min(24rem, 100%);
      max-height: 100%;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .dr-drawer[hidden] { display: none; }
    .dr-drawer dr-pending-list {
      min-height: 0;
      overflow-y: auto;
    }
    /* Widget areas for hosted plotter extensions (work doc #27) ride
       below the webapp's own panels in the same column — anchored,
       not at the literal viewport corner, so they can never cover
       the entry tools or GPS status. The area reserves its 2×2
       footprint but is pointer-transparent except its cells, so the
       chart still drags through; placement is offered by the chart
       context menu (right-click on the footprint), not by any
       on-chart button. */
    .dr-top-col {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      align-items: flex-start;
    }
    .dr-top-col > .dr-gps {
      align-self: flex-end;
    }
    /* Water-track readout: bottom-right panel — figures + the manual
       current entry that edits the set/drift figure beside it. */
    .dr-bottom {
      display: flex;
      justify-content: flex-end;
      padding: 0 8px 8px 0;
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
    /* Plotter-extension host dialogs (work doc #27): the picker and
       the configuration dialogs share the app's dialog chrome; the
       hosted panel iframe gets working room inside it. */
    dialog.ext-picker,
    dialog.ext-config {
      /* compound value — the layout smoketest pins the old card-stack
         page padding marker, and dialogs are not that. */
      padding: 0.75rem 1rem;
    }
    dialog.ext-config iframe {
      display: block;
      width: min(80vw, 30rem);
      height: min(70vh, 30rem);
      border: 0;
      background: var(--bg-panel);
    }
    .ext-manage-row {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin: 0.25rem 0;
    }
    .ext-manage-row span {
      font-size: 0.8rem;
      color: var(--text-muted);
      margin-right: auto;
    }
    .ext-config-footer {
      display: flex;
      justify-content: flex-end;
      gap: 0.5rem;
      margin-top: 0.75rem;
    }
    /* Phone-first (work doc #13 update #2): dialogs become bottom
       sheets on narrow viewports — the map stays visible around the
       form, dismissable with ✕, re-visible on submit. The corners
       collapse to full-width bands: tools + GPS panels stack at the
       top, the pending drawer docks as a bottom sheet directly above
       the readout band, and the readout collapses to the
       safety-critical figures (elapsed, divergence, current) so the
       chart keeps the bulk of the screen. */
    @media (max-width: 600px) {
      /* Compact bands: a phone screen is ~840px tall and the chart
         must keep the bulk of it — tighter padding, figures as inline
         value+label chips instead of stacked columns, buttons sharing
         rows. */
      .dr-top,
      .dr-bottom {
        padding: 6px;
      }
      .dr-tools,
      .dr-gps,
      .dr-readout,
      .dr-drawer {
        padding: 0.35rem 0.5rem;
      }
      .dr-top {
        flex-direction: column;
        align-items: stretch;
      }
      .dr-tools,
      .dr-override,
      .dr-gps {
        justify-content: flex-start;
      }
      .dr-tools button {
        flex: 1 1 calc(50% - 0.5rem);
      }
      .dr-gps {
        gap: 0.35rem;
      }
      .dr-status {
        font-size: 0.7rem;
        max-width: 14rem;
      }
      .dr-override button {
        min-width: 11rem;
        padding: 0 0.6rem;
      }
      #dr-log-fig,
      #dr-method-fig {
        display: none;
      }
      /* Figures become inline chips: value + label on one baseline,
         so the figures fit fewer rows; the manual-current entry
         collapses to its ≋ glyph (meaning in the tooltip) and the
         sparkline hides — 80px of chart is meaningless at a glance
         on a phone. */
      .dr-figure {
        flex-direction: row;
        align-items: baseline;
        gap: 0.35rem;
      }
      .dr-figure .value {
        font-size: clamp(1.05rem, 4.5vw, 1.3rem);
      }
      .dr-figure .label {
        font-size: 0.6rem;
      }
      .dr-readout .btn-label {
        display: none;
      }
      #dr-spark {
        display: none;
      }
      .dr-pane {
        justify-content: stretch;
        align-items: flex-end;
        padding: 0 6px;
      }
      .dr-drawer {
        width: 100%;
        max-height: 50vh;
      }
      .dr-bottom {
        justify-content: stretch;
        padding: 0 6px 6px;
      }
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

  <dr-map-view id="dr-map"></dr-map-view>

  <div class="dr-overlay">
    <div class="dr-top">
      <div class="dr-top-col">
        <section class="sk-floating dr-tools">
          <button id="btn-sight">⊕ Sight / LOP</button>
          <button id="btn-coord-fix" title="Confirm a fix at coordinates — prefilled from the current GNSS position, editable for offline/known-position fixes">⊙ Fix at coordinates</button>
          <button id="btn-pending" aria-expanded="false" aria-controls="dr-pending-drawer" hidden>◧ Pending</button>
        </section>
        <dr-ext-widget-area anchor="top-left"></dr-ext-widget-area>
      </div>
      <div class="dr-top-col dr-top-col-right">
        <section class="sk-floating dr-gps">
          <div class="dr-status" id="dr-status-panel">
            <span id="dr-status-text">Connecting to Signal K…</span>
          </div>
          <div class="dr-override">
            <button id="dr-override-btn">Engage OVERRIDE</button>
            <span id="dr-override-state">NORMAL (GPS authoritative)</span>
          </div>
        </section>
        <dr-ext-widget-area anchor="top-right"></dr-ext-widget-area>
      </div>
    </div>

    <div class="dr-pane">
      <aside class="sk-floating dr-drawer" id="dr-pending-drawer" hidden>
        <h2>Pending Observations <button id="btn-pending-close" title="Close pending observations" aria-label="Close pending observations">✕</button></h2>
        <dr-pending-list id="dr-pending"></dr-pending-list>
      </aside>
    </div>

    <div class="dr-bottom">
      <section class="sk-floating theme-teal dr-readout">
        <div class="dr-headline">
          <div class="dr-figure" id="dr-log-fig">
            <span class="value" id="dr-log">— nm</span>
            <span class="label">Water-track log</span>
          </div>
          <div class="dr-figure" id="dr-elapsed-fig">
            <span class="value" id="dr-elapsed">—</span>
            <span class="label">Since last fix</span>
          </div>
          <div class="dr-figure" id="dr-divergence-fig">
            <span class="value-row">
              <span class="value" id="dr-divergence">— nm</span>
              <canvas id="dr-spark" width="80" height="20"></canvas>
            </span>
            <span class="label">DR vs GPS</span>
          </div>
          <div class="dr-figure" id="dr-current-fig">
            <span class="value" id="dr-current">—</span>
            <span class="label" id="dr-current-label">Current set/drift</span>
          </div>
          <div class="dr-figure" id="dr-method-fig">
            <span class="value" id="dr-method">—</span>
            <span class="label">Active method</span>
          </div>
          <button id="btn-current" title="Manual set &amp; drift — the override outranks weather/pilot-chart sources while its TTL lasts">≋ <span class="btn-label">Current</span></button>
        </div>
      </section>
    </div>
  </div>

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
    // Chart pick: right-click an object on the map → open the sight
    // dialog with the object position pre-seeded (and its charted name,
    // when the picked symbol carries one — light, seamark, peak…). AIS
    // picks (work doc #23) also carry tMs — the instant the seeded
    // (predicted) position is valid for — so the sight time defaults to
    // the moment the target was clicked.
    this.map?.addEventListener("dr-pick-position", (e) => {
      const { lat, lng, mode, label, tMs } = e.detail;
      openSight();
      this.sight?.seedObjectPosition(lat, lng, mode, label, tMs);
    });
    // Hosted plotter-widget areas (work doc #27) carry no buttons: the
    // chart context menu offers placement when the pick lands on a
    // reserved area footprint. dr-app owns the hit test (the areas
    // live in this shadow root) and opens the ext host's picker.
    if (this.map) {
      this.map.areaAt = (x, y) => {
        for (const el of root.querySelectorAll("dr-ext-widget-area")) {
          const r = el.getBoundingClientRect();
          if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) {
            return el.getAttribute("anchor") ?? "top-left";
          }
        }
        return null;
      };
      this.map.addEventListener("dr-open-ext-picker", (e) => {
        this.extHost?.openPicker(e.detail.anchor);
      });
    }

    /** @type {HTMLDialogElement|null} */
    this.sightDialog = root.querySelector("#sight-dialog");
    /** Opens the sight dialog (entry form — the pending list lives
     *  alongside the map now, work doc #13 stage A). Seeds the sight
     *  time first: the field is required and only self-seeds after a
     *  submit, so a first-open would otherwise sit empty (and, since
     *  the forms went novalidate, block on requiredMissing).
     */
    const openSight = () => {
      this.sight?.seedSightTime();
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
    /** @type {Set<string>} */
    this.selectedObservations = new Set();
    /** @type {import("./dr-pending-list.js").default|null} */
    this.pendingList = root.querySelector("#dr-pending");
    this.refreshPending();
    this.pendingList?.addEventListener("dr-select-observation", (e) => {
      const { kind, id, selected } = e.detail;
      const key = `${kind}:${id}`;
      if (selected) this.selectedObservations.add(key);
      else this.selectedObservations.delete(key);
      this.render();
    });
    this.pendingList?.addEventListener("dr-candidate-resolved", (e) =>
      this.showCandidate(e.detail),
    );
    this.pendingList?.addEventListener("dr-fix-confirmed", () => {
      this.snap.candidate = null;
      this.selectedObservations.clear();
      this.refreshOverlays();
      this.refreshPending();
    });

    // Pending-observations drawer (work doc #26): the pending list
    // docks over the chart instead of stacking under it. The whole
    // box — toggle included — only appears once there ARE pending
    // observations (refreshPending drives visibility); when rows
    // first appear the drawer opens on wide screens, stays a closed
    // bottom sheet on phones. Deliberately stateless — no
    // persistence, every load starts from the viewport class.
    /** @type {HTMLElement|null} */
    this.drawer = root.querySelector("#dr-pending-drawer");
    /** @type {HTMLButtonElement|null} */
    this.drawerToggle = root.querySelector("#btn-pending");
    /** @type {boolean} */
    this.drawerOpen = false;
    /** @type {boolean} whether the pending list had rows last refresh */
    this._hadPending = false;
    this.renderDrawer();
    this.drawerToggle?.addEventListener("click", () => {
      this.drawerOpen = !this.drawerOpen;
      this.renderDrawer();
    });
    root.querySelector("#btn-pending-close")?.addEventListener("click", () => {
      this.drawerOpen = false;
      this.renderDrawer();
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
      this.refreshPending();
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
    /**
     * AIS target store (work doc #23): context → target state, fed by
     * `vessels.*` deltas + the REST snapshot seed, rendered through
     * `aisTargetsForRender`. Owned by dr-viewmodel's pure helpers.
     * @type {Map<string, object>}
     */
    this.aisStore = new Map();
    /**
     * DR shadow vessel context (work doc #21), filtered from the AIS
     * layer — the webapp already draws the DR position as its own marker.
     * @type {string|null}
     */
    this.shadowContext = null;
    /**
     * Active Signal K route (navigation.course.activeRoute), discovered
     * the Freeboard-SK way: the course state carries a resource href,
     * the route geometry is fetched from `/resources/routes/{id}`.
     * @type {{id: string, pointIndex: number}|null}
     */
    this.activeRoute = null;
    /** Route resources fetched this session — pointIndex deltas
     * re-render from cache without a refetch. @type {Map<string, object>} */
    this.routeCache = new Map();
    /** Cache-buster key of the route spec currently on the map. */
    this.routeRenderedKey = null;
    /** Route ids with a fetch in progress — the 1 Hz course stream
     * would otherwise re-issue the request until it lands.
     * @type {Set<string>|null} */
    this.routeFetchInFlight = null;
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
      drTimeMs: null,
      drCourse: null,
      sparkStats: null,
      gnss: null,
      // The pending selection (Set of `kind:id` keys) — the map
      // highlights EVERY selected observation, not just the latest
      // click, so the whole subset can be sanity-checked on the
      // chart before previewing it.
      highlight: this.selectedObservations,
      current: null,
      manualCurrent: null,
    };

    // Phone fit (verified headless 2026-09-19): the full-width readout
    // band owns the bottom edge, so the map's bottom-left control
    // stack (zoom, chart layers, re-center) must ride above it —
    // otherwise the band covers the controls. The band's height is
    // dynamic (figures wrap), so measure it and export the offset to
    // the map as a custom property (it pierces the shadow boundary);
    // an open pending sheet hides the stack entirely (see below).
    // Desktop keeps 0: the readout is right-docked, no collision.
    const readout = root.querySelector(".dr-readout");
    if (readout && typeof ResizeObserver !== "undefined") {
      const mq = window.matchMedia("(max-width: 600px)");
      const syncMapOffset = () => {
        let off = 0;
        // An open pending sheet spans the full phone width — keeping
        // the map's control stack reachable would mean pushing it up
        // into the top control bands (verified: it landed on the GPS
        // panel). The sheet covers the controls anyway, so hide the
        // stack while it's open: pinch-zoom still works, and re-center
        // + chart layers return the moment the sheet closes.
        const sheetOpen = mq.matches && this.drawerOpen;
        this.map?.toggleAttribute("data-controls-hidden", sheetOpen);
        if (mq.matches) {
          off =
            Math.ceil(
              window.innerHeight - readout.getBoundingClientRect().top,
            ) + 8;
        }
        this.map?.style.setProperty("--dr-map-bottom-offset", `${off}px`);
      };
      const ro = new ResizeObserver(syncMapOffset);
      ro.observe(readout);
      if (this.drawer) ro.observe(this.drawer);
      mq.addEventListener?.("change", syncMapOffset);
      this._syncMapOffset = syncMapOffset;
      syncMapOffset();
    }

    this.connectStream();
    this.loadPluginConfig();
    this.bootstrapSelf();
    this.fetchStatus().then(() => this.bootstrapAis());
    this.refreshOverlays();
    this.refreshTrackHistory();
    // Slow REST refresh for persisted overlays; stream drives the live parts.
    // /status also refreshes the header current figure (manual TTL
    // countdown) between deltas.
    setInterval(() => {
      this.refreshOverlays();
      this.fetchStatus();
    }, 30000);
    // AIS tick (work doc #23): predictions, expiring styling, and
    // age-out must advance even when nothing else flows (moored, DR
    // idle, quiet targets) — a slow dedicated pulse.
    setInterval(() => this.renderAis(), 5000);

    // Plotter-extension host (work doc #27): the webapp is itself a
    // chartplotter, so it hosts other plugins' extensions in the
    // widget areas below its own panels. Discovery is async — the
    // areas render empty until the first collection lands.
    this.extHost = new PlotterExtHost({
      stream: window.drSignalkStream,
      mount: root,
    });
    for (const el of root.querySelectorAll("dr-ext-widget-area")) {
      this.extHost.attachArea(el);
    }
    void this.extHost.start();
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
      "navigation.magneticVariation",
      "environment.mode",
      "environment.current.setTrue",
      "environment.current.drift",
      // Active route (Freeboard-SK's discovery pattern): the course
      // provider publishes the whole activeRoute object — href, name,
      // pointIndex, pointTotal — as ONE delta value at this path (not
      // leaf paths; verified on the wire), pointing at
      // `/resources/routes/{id}`.
      "navigation.course.activeRoute",
    ]);
    // AIS targets (work doc #23): same socket, `vessels.*` scope — the
    // protocol scopes each subscribe message to its context. Static
    // data (name/mmsi) seeds from the REST snapshot (bootstrapAis);
    // these paths carry the live motion. The "" root path catches
    // identification from providers that publish it only as root
    // values (the common AIS-plugin pattern — Freeboard-SK subscribes
    // "" for the same reason); the reducer picks name/mmsi/buddy out
    // of root values and ignores the rest.
    stream.subscribeAis([
      "navigation.position",
      "navigation.courseOverGroundTrue",
      "navigation.speedOverGround",
      "navigation.headingTrue",
      "name",
      "mmsi",
      "",
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
      // Active route seed (Freeboard-SK pattern): the REST self snapshot
      // carries the full course subtree, so a route activated before the
      // page loaded shows immediately without waiting for a delta.
      const active = vm.activeRouteFromCourse(nav?.navigation?.course);
      if (active && active.id !== this.activeRoute?.id) {
        this.activeRoute = active;
        this.refreshActiveRoute();
      }
      this.render();
    } catch {
      /* REST unavailable — stream will drive when it can */
    }
  }

  /**
   * Fetches and renders the currently active Signal K route. The course
   * state names the route by href (Freeboard-SK's discovery pattern);
   * the geometry — a GeoJSON Feature per Signal K's route resources —
   * comes from `/resources/routes/{id}` and is cached for the session
   * so pointIndex advances re-render without a refetch. A null route
   * (course cleared, single-waypoint destination) clears the map layer.
   *
   * @returns {Promise<void>}
   */
  async refreshActiveRoute() {
    const active = this.activeRoute;
    if (!active) {
      this.routeRenderedKey = null;
      this.map?.renderRoute(null);
      return;
    }
    let resource = this.routeCache.get(active.id);
    if (!resource) {
      if (this.routeFetchInFlight?.has(active.id)) return; // already fetching
      // Signal K v2 resources API — route/waypoint resources with a
      // resource-provider backend are served under /signalk/v2 (the v1
      // path 404s; Freeboard-SK also uses v2).
      (this.routeFetchInFlight ??= new Set()).add(active.id);
      try {
        const res = await fetch(
          `/signalk/v2/api/resources/routes/${encodeURIComponent(active.id)}`,
        );
        if (!res.ok) return; // resource unavailable — next course delta retries
        resource = await res.json();
        this.routeCache.set(active.id, resource);
      } catch {
        return; // REST unavailable — next course delta retries
      } finally {
        this.routeFetchInFlight.delete(active.id);
      }
    }
    const spec = vm.routeRenderSpec(resource, active.id, active.pointIndex);
    if (!spec) return;
    // Skip re-renders for course updates that don't change anything
    // visible (the stream repeats the whole course subtree at 1 Hz).
    const key = `${active.id}:${active.pointIndex}:${spec.points.length}`;
    if (key === this.routeRenderedKey) return;
    this.routeRenderedKey = key;
    spec.labels = vm.routeWaypointLabels(resource, spec.points.length);
    this.map?.renderRoute(spec);
  }

  /**
   * Seeds the AIS target store from the REST vessel snapshot (work doc
   * #23): static data (name/mmsi) arrives here; live motion rides the
   * `vessels.*` deltas. Also re-run on stream reconnect — targets that
   * aged out while offline come straight back with names intact.
   *
   * @returns {Promise<void>}
   */
  async bootstrapAis() {
    try {
      const res = await fetch("/signalk/v1/api/vessels");
      if (!res.ok) return;
      const body = await res.json();
      vm.seedAisFromSnapshot(this.aisStore, body, {
        selfContext: window.drSignalkStream?.selfContext,
        shadowContext: this.shadowContext,
      });
      this.renderAis();
    } catch {
      /* REST unavailable — deltas will drive when they can */
    }
  }

  /**
   * Renders the AIS layer (work doc #23): prunes aged-out targets, then
   * pushes range-filtered marker specs to the map with the prediction
   * instant. Own position prefers DR (the chart's own-boat reference);
   * GPS when DR hasn't started.
   *
   * @returns {void}
   */
  renderAis() {
    const nowMs = Date.now();
    vm.pruneAisStore(this.aisStore, nowMs);
    const own = this.snap.drPosition ?? this.snap.gpsPosition;
    this.map?.renderAis(
      vm.aisTargetsForRender(this.aisStore, nowMs, own),
      nowMs,
    );
  }

  /**
   * Streams a delta into the view-model and re-renders. Deltas from
   * other vessels (the `vessels.*` AIS subscription, work doc #23) feed
   * the target store instead — own vessel (by real context or the
   * literal `vessels.self`) is processed here. The DR shadow vessel
   * (work doc #21/#23) is dropped entirely: it renders from
   * `navigation.deadReckoning.position`, and letting its deltas through
   * here overwrote the own-vessel GPS position with the ghost position
   * (sea trial 2026-09-05: the map boat flipped ~50 NM back and forth,
   * and fix #9 recorded the ghost as a "GNSS" fix 87.5 km from the
   * boat).
   *
   * @param {object} delta
   * @returns {void}
   */
  onDelta(delta) {
    const ctx = delta?.context;
    const selfCtx = window.drSignalkStream?.selfContext;
    if (
      typeof ctx === "string" &&
      ctx.startsWith("vessels.") &&
      ctx !== "vessels.self" &&
      ctx !== selfCtx
    ) {
      if (ctx === this.shadowContext) return;
      vm.applyAisDelta(this.aisStore, delta);
      this.renderAis();
      return;
    }
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
          // Traditional chartwork labels: the DR position carries its
          // time ("DR 02:50Z"), the track its course ("C 290° S 6.1").
          // Times are always Z — prefer the delta's own timestamp.
          const t = Date.parse(value.timestamp);
          this.snap.drTimeMs = Number.isFinite(t) ? t : Date.now();
          this.snap.drCourse = this.ghost.recentMovement();
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
      case "navigation.magneticVariation":
        // Bus value is radians (east positive); the sight panel wants
        // east-positive degrees for magnetic bearing entry.
        if (Number.isFinite(value)) {
          this.sight?.setMagneticVariation(vm.radToDeg(value));
        }
        break;
      case "navigation.course.activeRoute": {
        // Route activation / advancement / cancellation (null when the
        // course clears). The value carries href, pointIndex and
        // pointTotal together — one parse covers all three; only an
        // actual change triggers work (the stream repeats the subtree).
        const next = vm.activeRouteFromCourse({ activeRoute: value });
        const prev = this.activeRoute;
        if (
          (next?.id ?? null) === (prev?.id ?? null) &&
          (next?.pointIndex ?? -1) === (prev?.pointIndex ?? -1)
        ) {
          break;
        }
        this.activeRoute = next;
        this.refreshActiveRoute();
        break;
      }
      case "environment.current.setTrue":
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
    this.renderSparkline();
    this.map?.render(this.snap);
    // AIS ranges/leaders move with the own boat — cheap to re-shape
    // alongside the snapshot (markers are reused in the map).
    this.renderAis();
  }

  /**
   * Draws the divergence trend sparkline (SPEC §14.1) beside the
   * DR-vs-GPS figure — ported from the map's old bottom-right chip
   * when that corner was assigned to this readout panel (work doc
   * #26). The view-model's Sparkline normalizes points to 0–1, so
   * the canvas just maps them to pixels.
   *
   * @returns {void}
   */
  renderSparkline() {
    const canvas = this.shadowRoot.querySelector("#dr-spark");
    const stats = this.snap.sparkStats;
    if (!canvas || !stats || stats.points.length < 2) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { width: w, height: h } = canvas;
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = "#4b8b99";
    ctx.lineWidth = 1;
    ctx.beginPath();
    stats.points.forEach((y, i) => {
      const x = (i / (stats.points.length - 1)) * (w - 2) + 1;
      const py = h - 2 - y * (h - 4);
      if (i === 0) ctx.moveTo(x, py);
      else ctx.lineTo(x, py);
    });
    ctx.stroke();
  }

  /**
   * Refreshes the pending-observations list and drives the pending
   * box's visibility (work doc #26): the whole box — toggle included
   * — only appears when there ARE pending observations. When the
   * first row arrives the drawer opens on wide screens (the new
   * observation is immediately glanceable); resolving the last one
   * closes and hides the box again.
   *
   * @returns {Promise<void>}
   */
  async refreshPending() {
    await this.pendingList?.refresh();
    const has = (this.pendingList?.rows?.length ?? 0) > 0;
    if (has && !this._hadPending) {
      this.drawerOpen = !window.matchMedia("(max-width: 600px)").matches;
    } else if (!has) {
      this.drawerOpen = false;
    }
    this._hadPending = has;
    this.drawer?.toggleAttribute("hidden", !has);
    this.drawerToggle?.toggleAttribute("hidden", !has);
    this.renderDrawer();
  }

  /**
   * Applies the pending-drawer open/closed state (work doc #26):
   * `hidden` on the aside, mirrored as aria-expanded on the toggle
   * (which inverts to a filled “engaged” look while open).
   *
   * @returns {void}
   */
  renderDrawer() {
    this.drawer?.toggleAttribute("hidden", !this.drawerOpen);
    this.drawerToggle?.setAttribute("aria-expanded", String(this.drawerOpen));
    // The open/closed flip moves the phone bottom sheet — re-sync the
    // map control stack's bottom offset (no resize fires for a
    // display:none toggle on some engines).
    this._syncMapOffset?.();
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
      // Shadow vessel context (work doc #21/#23): once known, the AIS
      // layer filters it (the DR marker already covers that position).
      this.shadowContext = body.shadowVesselContext ?? this.shadowContext;
      this.renderCurrent();
      this.renderAis();
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
    } else if (status.state === "open") {
      // Re-seed AIS static data on (re)connect (work doc #23) — names
      // and MMSIs don't ride position deltas.
      this.bootstrapAis();
    }
    // "open" — let the DR state panel take over once data flows.
  }
}

customElements.define("dr-app", DrApp);
