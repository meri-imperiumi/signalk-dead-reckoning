/**
 * `<dr-map-view>` — dual/continuous track rendering of GPS vs. the always-on
 * inertial "Ghost Track" (SPEC §14.1), with uncertainty polygon, fixes,
 * LOP/CPL overlays, snap-to-fix vectors, and the live divergence readout.
 * Position-line overlays follow traditional chartwork conventions: a
 * bearing PL carries a single arrowhead at its outer end, an
 * astronomical PL single arrowheads at both ends, a transferred
 * (running-fix) PL a double arrowhead at both ends, and a range CPL
 * draws as an arc with single arrowheads at both ends.
 *
 * Defaults to the first chart provider so the plot never opens blank:
 * the server's *configured* charts
 * (`/signalk/v1/api/resources/charts` — offline MBTiles, tile proxies,
 * whatever the user set up) when available, otherwise the OSM online
 * fallback; the layers control switches between them. Only a failed
 * charts request leaves the canvas tile-less (plain dark background).
 * No hardcoded OSM-only default (referer-403s on self-hosted setups).
 *
 * Geometry/style decisions live in dr-viewmodel.js (pure); this file
 * is the Leaflet adapter. Leaflet is vendored at ./vendor/leaflet/
 * (BSD-2) — no CDN, no build tooling. Vector `.pbf` charts render
 * through MapLibre GL, vendored at ./vendor/maplibre-gl/ and mounted
 * as one Leaflet layer via the official bridge (work doc #20).
 *
 * AIS targets (work doc #23) render in their own layer group from
 * specs pushed by dr-app (`renderAis`, outside the snapshot path —
 * targets tick independently of DR ticks). Right-clicking a target
 * seeds the sight form from its predicted position, with the sight
 * time anchored to the prediction instant.
 *
 * @file dr-map-view.js
 */

/* global L */

import { THEME_CSS } from "./dr-theme.js";
import * as vm from "./dr-viewmodel.js";

class DrMapView extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      ${THEME_CSS}
      /* Plotter layout (work doc #26): the map fills its host —
         dr-app gives it the whole viewport and floats its controls
         on top. Sizing is owned by the host app; the map just fills
         it (the ResizeObserver below keeps Leaflet honest). */
      :host {
        display: block;
        position: relative;
        width: 100%;
        height: 100%;
        overflow: hidden;
      }
      .map-host { position: relative; width: 100%; height: 100%; }
      .map-wrap { width: 100%; height: 100%; background: var(--bg-base, #080a0c); }
      /* Floating overlays: semi-transparent dark panels with sharp 1px
         borders so they stay legible over any tileset (UI spec §7).
         Corner map (work doc #26): the top edge + bottom-right corner
         belong to dr-app's floating panels (tools top-left, GPS
         status & override top-right, readout bottom-right); this
         component keeps only the bottom-left control stack — zoom,
         chart layers, re-center — and the pick menu. Attribution is
         off. */
      /* Re-center (follow DR position) control: the bottom-left corner
         is its own — the Leaflet zoom + layers stack sits directly
         above it (bottom-left container margin clears the button).
         Filled means auto-follow is ON; dragging the map pauses
         follow and outlines the button. */
      .dr-recenter {
        position: absolute;
        bottom: calc(8px + var(--dr-map-bottom-offset, 0px));
        left: 8px;
        z-index: 1000;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 48px;
        min-height: 48px;
        padding: 0;
        font-size: 1.2rem;
        line-height: 1;
        background-color: rgba(17, 20, 20, 0.8);
        border: 1px solid rgba(75, 139, 153, 0.5);
        color: var(--color-teal, #4b8b99);
      }
      .dr-recenter:hover:not(:disabled),
      .dr-recenter:active:not(:disabled) {
        background-color: var(--color-teal, #4b8b99);
        color: var(--bg-base, #080a0c);
      }
      .dr-recenter.engaged {
        background-color: var(--color-teal, #4b8b99);
        color: var(--bg-base, #080a0c);
        border-color: var(--color-teal, #4b8b99);
      }
      .dr-pick-menu {
        position: absolute;
        z-index: 1000;
        background-color: rgba(17, 20, 20, 0.8);
        border: 1px solid rgba(255, 255, 255, 0.25);
        padding: 0.4rem;
        font-family: ui-monospace, "Fira Code", monospace;
        font-size: 0.8rem;
        color: var(--text-muted, #888899);
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
        min-width: 12rem;
      }
      .dr-pick-menu button {
        text-align: left;
        padding: 0 0.75rem;
        background: transparent;
      }
      /* Target info panel rows (work doc #30): Freeboard-SK's field
         set, in the tactical readout style — muted keys, main values. */
      .dr-target-info {
        display: flex;
        flex-direction: column;
        gap: 0.15rem;
        padding-right: 0.25rem;
      }
      .dr-target-info div {
        display: flex;
        justify-content: space-between;
        gap: 1rem;
      }
      .dr-target-key {
        color: var(--text-muted, #888899);
      }
      /* Helm readouts (bearing/CPA rows) — emphasized: these are the
         numbers the watchkeeper opened the menu for. */
      .dr-pick-readout {
        color: var(--text-main, #ffffff);
        border-top: 1px solid rgba(255, 255, 255, 0.15);
        padding-top: 0.15rem;
      }
      /* Measure tool floating readout (work doc #30): per-leg
         bearing/distance lines + running total, top-center so it never
         collides with the corner control stacks. --dr-map-top-offset
         (set by dr-app, measured from the top control band) pushes it
         below the floating panels — the overlay layer paints above the
         map, so a naive top: 8px would slide the readout UNDER the GPS
         status panel and make both unreadable. */
      .dr-measure {
        position: absolute;
        top: calc(8px + var(--dr-map-top-offset, 0px));
        left: 50%;
        transform: translateX(-50%);
        z-index: 1000;
        background-color: rgba(17, 20, 20, 0.8);
        border: 1px solid rgba(255, 255, 255, 0.25);
        padding: 0.4rem 0.6rem;
        font-family: ui-monospace, "Fira Code", monospace;
        font-size: 0.8rem;
        color: var(--text-main, #ffffff);
        pointer-events: none;
      }
      .dr-measure-total {
        color: var(--color-teal, #4b8b99);
        border-top: 1px solid rgba(255, 255, 255, 0.15);
        margin-top: 0.15rem;
        padding-top: 0.15rem;
      }
      /* Note details (work doc #30): the body renders as content —
         pre-wrap for plain text, minimal markdown — capped so a long
         note doesn't take the whole chart. */
      .dr-note-info {
        max-width: 16rem;
      }
      .dr-note-body {
        max-height: 10rem;
        overflow-y: auto;
        color: var(--text-main, #ffffff);
      }
      .dr-note-body p {
        margin: 0 0 0.25rem 0;
        white-space: pre-wrap;
      }
      .dr-note-body ul {
        margin: 0.15rem 0 0.25rem 1rem;
        padding: 0;
      }
      .dr-note-body code {
        font-family: ui-monospace, "Fira Code", monospace;
      }
      .dr-note-actions {
        display: flex;
        gap: 0.25rem;
      }
      /* Leaflet chrome → tactical: dark, flat, teal */
      .leaflet-bar,
      .leaflet-control-layers {
        border: 1px solid rgba(255, 255, 255, 0.2) !important;
        border-radius: 0 !important;
        box-shadow: none !important;
      }
      .leaflet-bar a {
        background-color: rgba(17, 20, 20, 0.8) !important;
        color: var(--color-teal, #4b8b99) !important;
        border-radius: 0 !important;
        border-bottom: 1px solid rgba(255, 255, 255, 0.2) !important;
      }
      /* Bottom-left stack (work doc #26): zoom + layers live above the
         re-center button, which is not a Leaflet control and doesn't
         participate in Leaflet's stacking — an explicit bottom margin
         on the control container clears it (8px offset + 48px button
         + 8px gap). --dr-map-bottom-offset (set by dr-app on phones,
         where the full-width readout band owns the bottom edge)
         lifts the whole stack above that band — custom properties
         pierce the shadow boundary. */
      .leaflet-bottom.leaflet-left {
        margin-left: 8px;
        margin-bottom: calc(64px + var(--dr-map-bottom-offset, 0px));
      }
      /* Phones: pinch-zoom replaces the zoom button stack — with the
         pending bottom sheet open, the full stack would ride high
         enough to poke into the top control bands. The chart-layers
         control and the re-center button stay. While the sheet is
         open (data-controls-hidden) the whole stack hides: the sheet
         spans the full width and covers it anyway. */
      @media (max-width: 600px) {
        .leaflet-control-zoom { display: none; }
      }
      :host([data-controls-hidden]) .leaflet-bottom.leaflet-left,
      :host([data-controls-hidden]) .dr-recenter {
        display: none;
      }
      .leaflet-control-layers {
        background-color: rgba(17, 20, 20, 0.8) !important;
        color: var(--text-main, #ffffff) !important;
      }
      .leaflet-control-layers-expanded {
        background-color: rgba(17, 20, 20, 0.8) !important;
        color: var(--text-main, #ffffff) !important;
        border-radius: 0 !important;
      }
      .leaflet-tooltip {
        background-color: rgba(17, 20, 20, 0.85) !important;
        color: var(--text-main, #ffffff) !important;
        border: 1px solid rgba(255, 255, 255, 0.25) !important;
        border-radius: 0 !important;
        box-shadow: none !important;
        font: 11px ui-monospace, "Fira Code", monospace !important;
      }
      /* AIS target glyphs (work doc #23): a rotated arrow on a bare
         divIcon (Leaflet's default .leaflet-div-icon white box is
         replaced by className); the inner glyph's rotation eases
         between renders — the mark turns with the target. */
      .dr-ais-marker {
        background: transparent;
        border: none;
      }
      .dr-ais-glyph {
        transition: transform 0.5s linear;
      }
      /* Chartwork arrowheads (traditional position-line marking): a
         bare rotated chevron on a divIcon, same trick as the AIS
         glyphs — Leaflet's default white box replaced by className. */
      .dr-arrow,
      .dr-fix {
        background: transparent;
        border: none;
      }
      /* Permanent chartwork labels: fix/DR times ride along as tiny
         tooltips; the course-line label sits beside the track in the
         DR teal with a dark halo for legibility over any tileset. */
      .leaflet-tooltip.dr-plabel {
        font-size: 10px;
        padding: 0 4px;
      }
      .dr-course-label {
        background: transparent;
        border: none;
        pointer-events: none;
      }
      .dr-course-label span {
        display: inline-block;
        transform: translate(10px, 8px);
        color: var(--color-teal, #4b8b99);
        font: italic 11px/1 ui-monospace, "Fira Code", monospace;
        white-space: nowrap;
        text-shadow:
          0 0 3px var(--bg-base, #080a0c),
          0 0 3px var(--bg-base, #080a0c),
          0 0 3px var(--bg-base, #080a0c);
      }
    `;
    root.appendChild(style);
    // Leaflet's CSS must live INSIDE the shadow root — a document-level
    // <link> can't reach the .leaflet-* classes Leaflet creates here.
    // Same for MapLibre's: its canvas container (mounted by L.maplibreGL
    // inside a Leaflet pane) needs .maplibregl-map etc. scoped here.
    const leafletCss = document.createElement("link");
    leafletCss.rel = "stylesheet";
    leafletCss.href = "./vendor/leaflet/leaflet.css";
    root.appendChild(leafletCss);
    const maplibreCss = document.createElement("link");
    maplibreCss.rel = "stylesheet";
    maplibreCss.href = "./vendor/maplibre-gl/maplibre-gl.css";
    root.appendChild(maplibreCss);
    const wrap = document.createElement("div");
    wrap.setAttribute("part", "map");
    wrap.className = "map-wrap";

    // The divergence chip (readout + trend sparkline) used to float
    // here; since the plotter layout's corner assignment (work doc
    // #26) the bottom-right corner belongs to dr-app's readout panel,
    // which draws the divergence figure + sparkline itself.

    // Re-center (follow DR) control — floated over the map's bottom-left
    // corner now that the "Ghost Track" heading is gone, so the map
    // opens higher with no chrome above it. Calls recenter() directly;
    // the .engaged class mirrors the follow flag (set here, cleared on
    // drag, re-set on click).
    const recenterBtn = document.createElement("button");
    recenterBtn.type = "button";
    recenterBtn.id = "dr-recenter";
    recenterBtn.className = "dr-recenter engaged";
    recenterBtn.textContent = "◎";
    recenterBtn.title = "Follow DR position";
    recenterBtn.setAttribute("aria-label", "Follow DR position");
    recenterBtn.setAttribute("aria-pressed", "true");
    recenterBtn.addEventListener("click", () => this.recenter());

    const host = document.createElement("div");
    host.className = "map-host";
    host.appendChild(wrap);
    host.appendChild(recenterBtn);
    root.appendChild(host);
    /** @type {HTMLButtonElement} */
    this.recenterBtn = recenterBtn;

    /** @type {HTMLDivElement} */
    this.mapEl = wrap;
    /** @type {import("leaflet").Map|null} */
    this.map = null;
    this.layers = {
      ghost: null,
      gps: null,
      gpsMarker: null,
      uncertainty: null,
      fixes: null,
      lops: null,
      cpls: null,
      snaps: null,
      drMarker: null,
      candidate: null,
      advancements: null,
      ais: null,
      route: null,
      // Predictor vectors + range rings (work doc #30): created but
      // NOT added to the map — they mount through the layers control
      // (decluttering toggles), which adds/removes the group itself.
      vectors: null,
      rings: null,
      // Wind laylines (work doc #30) — layers-control toggle like the
      // other overlays.
      laylines: null,
      // Signal K notes (work doc #30) — layers-control toggle.
      notes: null,
      // Measure tool geometry (work doc #30) — transient, always on.
      measure: null,
    };
    /** Layer keys that mount through the layers control instead of
     * always-on (work doc #30). */
    this.toggleableLayers = new Set(["vectors", "rings", "laylines", "notes"]);
    this.tileLayers = {};
    this.follow = true;
    /**
     * Rendered AIS entries by target context (work doc #23) — markers
     * are reused across renderAis calls (position/style updates in
     * place) so ~1 Hz re-renders don't churn DOM and flicker tooltips.
     * @type {Map<string, {spec: object, marker: object, leader: object|null}>}
     */
    this._aisRendered = new Map();
    /** Instant the rendered AIS predictions are valid for — a pick
     * from a target dispatches it as the sight-time anchor. */
    this._aisRenderNowMs = null;
  }

  connectedCallback() {
    this.initMap();
    // Leaflet is a classic <head> script and should be ready before the
    // deferred module scripts run, but retry once if it isn't yet.
    if (!this.map) {
      setTimeout(() => {
        if (!this.map) this.initMap();
        if (this.map && this._pendingSnap) {
          this.map.invalidateSize();
          this.render(this._pendingSnap);
        }
      }, 50);
    }
  }

  /**
   * Creates the map and static layer groups. Tile-less canvas by
   * default; configured Signal K charts are added as base layers.
   *
   * @returns {void}
   */
  initMap() {
    if (this.map || typeof L === "undefined") return;
    this.map = L.map(this.mapEl, {
      center: [60, 24],
      zoom: 10,
      // Bottom-left, stacked above the re-center button (work doc
      // #26): the top corners belong to dr-app's floating controls.
      zoomControl: false,
      attributionControl: false,
    });
    L.control.zoom({ position: "bottomleft" }).addTo(this.map);
    for (const key of Object.keys(this.layers)) {
      this.layers[key] = L.layerGroup();
      if (!this.toggleableLayers.has(key)) this.layers[key].addTo(this.map);
    }
    // Nautical scale bar (work doc #30): a custom control — Leaflet's
    // stock L.control.scale only does metric/imperial, and the helm
    // wants NM. Updates on every zoom/pan (mpp depends on latitude).
    this._scaleCtrl = new NauticalScaleControl();
    this._scaleCtrl.addTo(this.map);
    // Range rings re-space with zoom (their spacing derives from the
    // current scale); the scale bar re-reads it too.
    this.map.on("zoomend moveend", () => {
      this._scaleCtrl.update(this.map);
      this.renderRangeRings();
      this.renderLaylines();
    });
    this.map.on("dragstart", () => {
      this.follow = false;
      this.recenterBtn?.classList.remove("engaged");
      this.recenterBtn?.setAttribute("aria-pressed", "false");
    });
    // Measure tool (work doc #30): double-click ends and clears. The
    // duplicate-click guard in _addMeasureLeg catches the two clicks
    // of the double-click first; this is the explicit gesture.
    this.map.on("dblclick", () => {
      if (this._measurePts) this.endMeasure();
    });
    // Chart pick: right-click / long-press opens a small context menu
    // to pre-seed a sight form with the picked object position (and the
    // object's charted name, when a symbol was hit — see pickSymbolName).
    // An AIS target under the cursor (work doc #23) wins over the chart:
    // its *predicted* position seeds the bearing, with the sight time
    // anchored to the prediction instant.
    this.map.on("contextmenu", (e) => {
      // Measuring: right-click ends the measure tool instead of picking
      // (work doc #30 — the same gesture that opened the menu closes
      // the measurement).
      if (this._measurePts) {
        this.endMeasure();
        return;
      }
      const target = this._aisTargetAt(e.containerPoint);
      if (target) {
        // An AIS target is a vessel, not a chart feature — pre-seed the
        // bearing object as "Vessel {name}" so logbook entries and the
        // pending-LOP label read unambiguously (a bare name could be a
        // buoy, a cape, another boat…). The map glyph itself keeps the
        // bare label (aisMarkerSpec.label). The full target spec rides
        // along: the pick menu doubles as the plotter target panel
        // (work doc #30) — details, DR/GPS bearings, CPA/TCPA.
        this.showPickMenu(target.position, e.containerPoint, {
          label: target.label ? `Vessel ${target.label}` : null,
          tMs: this._aisRenderNowMs ?? Date.now(),
          target,
        });
        return;
      }
      this.showPickMenu(e.latlng, e.containerPoint);
    });
    // Hover cursor: over a charted point object you can take a bearing
    // to (light, beacon, buoy, named peak, cape, landmark), the cursor
    // becomes a crosshair signalling "right-click to take a bearing
    // here". Only the mirrored vector chart exposes queryable features;
    // raster/OSM fallbacks keep Leaflet's grab cursor. Throttled to one
    // query per animation frame — `queryRenderedFeatures` is synchronous
    // and mousemove fires many times per second.
    this.map.on("mousemove", (e) => {
      this._hoverPoint = e.containerPoint;
      if (this._hoverRaf) return;
      this._hoverRaf = requestAnimationFrame(() => {
        this._hoverRaf = null;
        const pt = this._hoverPoint;
        this._hoverPoint = null;
        this.mapEl.style.cursor =
          pt && (this.isBearingableAt(pt) || this._aisTargetAt(pt) != null)
            ? "crosshair"
            : "";
      });
    });
    this.map.on("mouseout", () => {
      if (this._hoverRaf) {
        cancelAnimationFrame(this._hoverRaf);
        this._hoverRaf = null;
      }
      this._hoverPoint = null;
      this.mapEl.style.cursor = "";
    });
    // Shadow DOM layout settles asynchronously after connectedCallback;
    // force Leaflet to recompute the container size on every resize or
    // tiles render jumbled and markers land off-screen.
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => this.map?.invalidateSize());
      ro.observe(this.mapEl);
      this._resizeObserver = ro;
    }
    // Fallback: invalidate after a couple of frames in case RO isn't
    // available (older browsers).
    requestAnimationFrame(() =>
      requestAnimationFrame(() => this.map?.invalidateSize()),
    );

    // Basemap: Signal K configured charts (offline MBTiles / tile proxies)
    // when available, else the OSM online fallback. The first provider is
    // auto-selected either way — a blank chart on open reads as broken
    // (user feedback 2026-09); switching offline is one tap in the control.
    // Vector charts mount through MapLibre (work doc #20) in one of two
    // modes: the corridor downloader's MIRRORED upstream style (full
    // symbology — base map, bathymetry, labels, hillshade — discovered via
    // its asset manifest) when available, else per-chart geometry-only
    // styles composed client-side. Raster charts stay L.tileLayer; WebP
    // (terrarium DEM) stores are mirror internals, never image overlays.
    const chartsReady = fetch("/signalk/v1/api/resources/charts").then((r) =>
      r.ok ? r.json() : null,
    );
    const manifestReady = fetch(
      "/plugins/signalk-corridor-tile-downloader/assets/manifest.json",
    )
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    Promise.all([chartsReady, manifestReady])
      .then(([resource, manifest]) => {
        const configured = vm.parseChartLayers(resource);
        const charts =
          configured.length > 0 ? configured : [vm.DEFAULT_OSM_LAYER];
        const vectorCharts = charts.filter((c) => vm.isVectorChart(c));
        const rasterCharts = charts.filter(
          (c) => !vm.isVectorChart(c) && c.format !== "webp",
        );
        const bases = {};
        const ordered = [];
        const addBase = (label, layer) => {
          // The control is keyed by display name — dedupe so two charts
          // sharing a name don't clobber each other's radio entry.
          let name = label;
          for (let n = 2; bases[name]; n++) name = `${label} (${n})`;
          bases[name] = layer;
          ordered.push(layer);
        };
        const assets = vm.chartAssetsFromManifest(manifest);
        let vectorMounted = false;
        if (assets) {
          if (typeof L.maplibreGL === "function") {
            this.tileLayers.__chart_mirror__ = L.maplibreGL({
              style: assets.style,
            });
            addBase("Open Waters chart", this.tileLayers.__chart_mirror__);
            vectorMounted = true;
          } else {
            console.warn(
              "mirrored chart style skipped: MapLibre bridge not loaded",
            );
          }
        }
        if (!vectorMounted) {
          for (const c of vectorCharts) {
            const layer = this.chartLayer(c);
            if (!layer) continue;
            this.tileLayers[c.identifier] = layer;
            addBase(c.name, layer);
          }
        }
        for (const c of rasterCharts) {
          const layer = this.chartLayer(c);
          if (!layer) continue;
          this.tileLayers[c.identifier] = layer;
          addBase(c.name, layer);
        }
        // Default: the mirrored/composed vector chart when present, else
        // the first configured provider (list is name-sorted).
        const first =
          this.tileLayers.__chart_mirror__ ??
          this.tileLayers[charts[0].identifier] ??
          ordered[0];
        first?.addTo(this.map);
        // Always mounted (even single-chart installs): the AIS traffic
        // overlay (work doc #23) needs its checkbox so the chart can be
        // de-cluttered, and the active Signal K route too (a route
        // crossing the leg being sailed shouldn't be forced on top of
        // the chartwork). Work doc #30 adds the plotter overlays:
        // predictor vectors and range rings (off by default — declutter
        // first, enable on demand).
        L.control
          .layers(
            bases,
            {
              "AIS traffic": this.layers.ais,
              "Active route": this.layers.route,
              Vectors: this.layers.vectors,
              "Range rings": this.layers.rings,
              Laylines: this.layers.laylines,
              Notes: this.layers.notes,
            },
            { collapsed: true, position: "bottomleft" },
          )
          .addTo(this.map);
      })
      .catch((e) => {
        // Offline stays tile-less by design, but a chart that fails to
        // *mount* (e.g. MapLibre rejecting the style) must not vanish
        // silently — that reads as "charts don't render" with no trace.
        console.warn("chart layers not mounted:", e?.message || e);
      });
  }

  /**
   * Builds the Leaflet layer for a parsed chart: `L.maplibreGL` with a
   * client-built vector style for `.pbf` charts (work doc #20), plain
   * `L.tileLayer` for raster. Returns null when a vector chart can't be
   * rendered (bridge or engine failed to load — script blocked/missing):
   * adding it as an image layer would decode garbage, so it's skipped
   * rather than shipped broken.
   *
   * @param {object} c - parsed chart layer (vm.parseChartLayers entry)
   * @returns {object|null} Leaflet layer
   */
  chartLayer(c) {
    if (vm.isVectorChart(c)) {
      if (typeof L.maplibreGL !== "function") {
        console.warn(
          `vector chart ${c.identifier} skipped: MapLibre bridge not loaded`,
        );
        return null;
      }
      return L.maplibreGL({ style: vm.maplibreStyleFor(c) });
    }
    return L.tileLayer(c.url, {
      minZoom: c.minZoom,
      maxZoom: c.maxZoom,
      maxNativeZoom: c.maxZoom,
    });
  }

  /** @returns {void} */
  recenter() {
    this.follow = true;
    this.recenterBtn?.classList.add("engaged");
    this.recenterBtn?.setAttribute("aria-pressed", "true");
    if (this.lastDrPosition && this.map) {
      this.map.panTo(this.lastDrPosition);
    }
  }

  /**
   * Queries the mirrored vector chart for rendered features near a
   * Leaflet container point. `radius` 0 is an exact pixel query
   * (`[x, y]`); larger is a `[[x1,y1],[x2,y2]]` box of ±radius px so a
   * click "on" a thin light icon that isn't pixel-perfect still hits it.
   * Returns null when the mirror/MapLibre isn't mounted.
   *
   * The geometry MUST be an array: MapLibre's `queryRenderedFeatures`
   * treats any argument that is neither a Point instance nor an Array
   * (e.g. a plain `{left, top, right, bottom}`) as "no geometry" and
   * silently falls back to the WHOLE viewport — which is how a pick used
   * to resolve to the first point feature anywhere on screen, 1 NM (or,
   * before the Point-geometry filter, 100 NM via a sea-area label) from
   * the click. The bridge pads the GL canvas around the Leaflet viewport
   * by `options.padding` (default 0.1) on each side, so Leaflet container
   * coords are translated into GL canvas coords first.
   *
   * @param {L.Point|null|undefined} containerPoint
   * @param {number} [radius=10]
   * @returns {Array<object>|null} `map.queryRenderedFeatures` result, or null
   */
  _queryChartHits(containerPoint, radius = 10) {
    const mirror = this.tileLayers.__chart_mirror__;
    const gl = mirror?.getMaplibreMap?.();
    if (!gl || !containerPoint) return null;
    try {
      const size = this.map.getSize();
      const pad = mirror.options?.padding ?? 0.1;
      const x = containerPoint.x + size.x * pad;
      const y = containerPoint.y + size.y * pad;
      if (radius <= 0) return gl.queryRenderedFeatures([x, y]);
      const r = radius;
      return gl.queryRenderedFeatures([
        [x - r, y - r],
        [x + r, y + r],
      ]);
    } catch {
      return null;
    }
  }

  /**
   * Finds the point chart object nearest the cursor — light, beacon,
   * buoy, named peak, cape, landmark. Grows the catchment from the exact
   * pixel outward (0 → 5 → 10 px) so the first hit is the closest charted
   * object, not a neighbour inside the box that merely renders earlier.
   * Returns the feature (for `vm.pointSymbolName`) or null.
   *
   * @param {L.Point|null|undefined} containerPoint
   * @returns {object|null}
   */
  _pickClosestPointSymbol(containerPoint) {
    for (const r of [0, 5, 10]) {
      const f = vm.firstPointSymbolHit(this._queryChartHits(containerPoint, r));
      if (f) return f;
    }
    return null;
  }

  /**
   * Resolves the charted name of the symbol nearest a Leaflet container
   * point — lights, seamarks, named peaks, capes, landmarks, place
   * points rendered by the mirrored chart style (the composed fallback
   * has no symbols). Bearings are taken to identified objects, so the
   * pick menu and sight form carry the name whenever one is hit; an
   * unnamed point leaves the field for the user to type. Selection goes
   * through `_pickClosestPointSymbol` so a point symbol under the cursor
   * wins over an area label (e.g. a light inside a 100 NM nature reserve
   * resolves to the light, not the reserve).
   *
   * @param {L.Point|null|undefined} containerPoint
   * @returns {string|null} symbol name/characteristic, or null when nothing named is hit
   */
  pickSymbolName(containerPoint) {
    return vm.pointSymbolName(this._pickClosestPointSymbol(containerPoint));
  }

  /**
   * Whether a Leaflet container point is over a bearing-able chart
   * object (any point symbol — light, beacon, buoy, named peak, cape,
   * landmark — named or not). Drives the crosshair hover cursor; uses a
   * single ±10 px box query (one per animation frame on mousemove).
   *
   * @param {L.Point|null|undefined} containerPoint
   * @returns {boolean}
   */
  isBearingableAt(containerPoint) {
    return vm.isBearingablePointHit(this._queryChartHits(containerPoint, 10));
  }

  /**
   * Finds the rendered AIS target nearest a Leaflet container point
   * (work doc #23), within a finger-friendly catchment — targets are
   * picked by proximity to the rendered glyph, not by DOM hit-testing,
   * so it works identically for touch long-presses. Returns the target's
   * render spec (whose `position` is the predicted position the pick
   * will seed) or null.
   *
   * @param {L.Point|null|undefined} containerPoint
   * @returns {object|null}
   */
  _aisTargetAt(containerPoint) {
    if (!this.map || !containerPoint || this._aisRendered.size === 0) {
      return null;
    }
    let best = null;
    let bestD = 16;
    for (const entry of this._aisRendered.values()) {
      const p = this.map.latLngToContainerPoint(entry.spec.position);
      const d = p.distanceTo(containerPoint);
      if (d < bestD) {
        bestD = d;
        best = entry.spec;
      }
    }
    return best;
  }

  /**
   * Hosted-widget-area hit test, registered by dr-app: given a client
   * point, returns the `<dr-ext-widget-area>` anchor it lands on (or
   * null). The areas carry no buttons of their own — widget placement
   * rides the pick menu when the right-click lands on a reserved area
   * footprint.
   *
   * @type {((clientX: number, clientY: number) => (string|null))|null}
   */
  areaAt = null;

  /**
   * Shows a small context menu at a chart point. Work doc #30 turns it
   * into the plotter's target surface: every pick shows bearing &
   * distance from BOTH own-ship references (DR and GPS — hide the row
   * whose source is absent); an AIS pick adds the target details panel
   * (name/MMSI, type, flag, dimensions, destination & ETA — Freeboard-SK's
   * field set) plus CPA/TCPA for both references; and every menu offers
   * the measure tool start. Dispatches `dr-pick-position` (composed,
   * bubbles) with `{ lat, lng, mode, label, tMs }` — `label` carries the
   * picked symbol's charted name (or an AIS target's name, work doc #23),
   * `tMs` the pick instant the position is valid for (an AIS target's
   * predicted position is anchored to it). When the pick lands on a
   * hosted widget-area footprint (`areaAt`), the menu also offers widget
   * placement via a `dr-open-ext-picker` event.
   *
   * @param {L.LatLng|[number, number]} latlng
   * @param {L.Point|null|undefined} [containerPoint]
   * @param {{label?: string|null, tMs?: number, target?: object}|null} [preset]
   *   AIS picks resolve label/time/target here instead of the chart query
   * @returns {void}
   */
  showPickMenu(latlng, containerPoint, preset = null) {
    // Remove any prior menu.
    this.hidePickMenu();
    const label = preset?.label ?? this.pickSymbolName(containerPoint);
    const tMs = Number.isFinite(preset?.tMs) ? preset.tMs : Date.now();
    const picked = [
      Array.isArray(latlng) ? latlng[0] : latlng.lat,
      Array.isArray(latlng) ? latlng[1] : latlng.lng,
    ];
    const menu = document.createElement("div");
    menu.className = "dr-pick-menu";
    const what = label ?? "this point";
    menu.textContent = `Add observation at ${what}…`;
    // Target details (AIS picks, work doc #30): Freeboard-SK's field
    // set — type, flag, dimensions, destination & ETA. Rows hide when
    // the data never arrived; nothing fabricates.
    const t = preset?.target;
    if (t) {
      const info = document.createElement("div");
      info.className = "dr-target-info";
      const rows = [];
      const typeName = vm.aisShipTypeName(t.shipType) ?? t.typeName ?? null;
      if (typeName) rows.push(["Type", typeName]);
      const flag = vm.flagForCountry(t.country);
      if (flag) rows.push(["Flag", flag]);
      if (t.lengthM != null && t.beamM != null) {
        rows.push([
          "Dimensions",
          `${t.lengthM.toFixed(0)} × ${t.beamM.toFixed(0)} m`,
        ]);
      } else if (t.lengthM != null) {
        rows.push(["Length", `${t.lengthM.toFixed(0)} m`]);
      }
      if (t.destination) rows.push(["Destination", t.destination]);
      const eta = vm.etaLabel(t.destinationEtaMs);
      if (eta) rows.push(["ETA", eta]);
      if (rows.length > 0) {
        for (const [k, v] of rows) {
          const row = document.createElement("div");
          const key = document.createElement("span");
          key.className = "dr-target-key";
          key.textContent = k;
          const val = document.createElement("span");
          val.textContent = v;
          row.appendChild(key);
          row.appendChild(val);
          info.appendChild(row);
        }
        menu.appendChild(info);
      }
    }
    // Note details (work doc #30): the same detail surface as other
    // chart objects — title, body rendered per mimeType, timestamp —
    // plus Edit/Delete affordances riding the dr-detail-popover
    // pattern. dr-app owns the REST side.
    const note = preset?.note;
    if (note) {
      const info = document.createElement("div");
      info.className = "dr-target-info dr-note-info";
      const title = document.createElement("strong");
      title.textContent = note.title;
      info.appendChild(title);
      const body = document.createElement("div");
      body.className = "dr-note-body";
      // renderNoteBody escapes all input before any markup — the body
      // is other clients' content, synced through the server.
      body.innerHTML = vm.renderNoteBody(note.body, note.mimeType);
      info.appendChild(body);
      if (note.timestamp) {
        const when = document.createElement("span");
        when.className = "dr-target-key";
        when.textContent = vm.fixTimeLabel(note.timestamp) || "";
        info.appendChild(when);
      }
      menu.appendChild(info);
      const actions = document.createElement("div");
      actions.className = "dr-note-actions";
      for (const [label, event] of [
        ["Edit note", "dr-note-edit"],
        ["Delete note", "dr-note-delete"],
      ]) {
        const btn = document.createElement("button");
        btn.textContent = ` ${label}`;
        btn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this.hidePickMenu();
          this.dispatchEvent(
            new CustomEvent(event, {
              bubbles: true,
              composed: true,
              detail: { id: note.id },
            }),
          );
        });
        actions.appendChild(btn);
      }
      menu.appendChild(actions);
    }
    // The helm readout (work doc #30): bearing & distance from BOTH
    // own-ship references. Computed at menu-open from the last known
    // positions — hidden per source when that reference is absent.
    const own = {
      dr: this._lastSnap?.drPosition ?? null,
      gps: this._lastSnap?.gpsPosition ?? null,
    };
    for (const row of vm.ownBearingRows(own, picked)) {
      const div = document.createElement("div");
      div.className = "dr-pick-readout";
      div.textContent = `${row.source} ${String(Math.round(row.bearingDeg)).padStart(3, "0")}° ${row.distNm.toFixed(2)} nm`;
      menu.appendChild(div);
    }
    // CPA/TCPA for both references (work doc #30): the DR-based figure
    // is the navigator's conservative view, the GPS-based one the
    // conventional plotter number. Shown on AIS picks when both sides
    // of the pair carry motion.
    if (t) {
      const cogDeg = t.cogDeg;
      const sogKn = t.sogKn;
      const refs = [];
      if (own.dr && this._lastSnap?.drCourse?.speedKn) {
        refs.push([
          "DR",
          vm.cpaTcpa(
            own.dr,
            this._lastSnap.drCourse.courseDeg,
            this._lastSnap.drCourse.speedKn,
            picked,
            cogDeg,
            sogKn,
          ),
        ]);
      }
      if (own.gps && this._lastSnap?.gpsSogKn) {
        refs.push([
          "GPS",
          vm.cpaTcpa(
            own.gps,
            this._lastSnap.gpsCogDeg,
            this._lastSnap.gpsSogKn,
            picked,
            cogDeg,
            sogKn,
          ),
        ]);
      }
      for (const [source, cpa] of refs) {
        if (!cpa) continue;
        const div = document.createElement("div");
        div.className = "dr-pick-readout";
        div.textContent =
          `CPA (${source}) ${cpa.cpaNm.toFixed(2)} nm` +
          (cpa.tcpaMin != null ? ` / ${Math.round(cpa.tcpaMin)} min` : "");
        menu.appendChild(div);
      }
    }
    const items = [
      { label: ` Bearing to ${what}`, mode: "bearing" },
      { label: ` Distance CPL at ${what}`, mode: "vertical" },
      { label: " Measure from here…", mode: "_measure" },
      // Hazard marking at the helm (work doc #30): every pick can
      // become a Signal K note, pre-seeded with the picked position.
      { label: " New note at…", mode: "_note" },
    ];
    for (const it of items) {
      const btn = document.createElement("button");
      btn.textContent = it.label;
      // stopPropagation: the menu lives inside the map container, so
      // the activating click would otherwise ALSO reach Leaflet's
      // container click handler — a measure start would immediately
      // add a phantom second vertex at the menu position (a tiny
      // un-movable segment), and every other action left a stray map
      // click behind.
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.hidePickMenu();
        if (it.mode === "_measure") {
          this.startMeasure(picked);
          return;
        }
        if (it.mode === "_note") {
          this.dispatchEvent(
            new CustomEvent("dr-note-new", {
              bubbles: true,
              composed: true,
              detail: { lat: picked[0], lng: picked[1] },
            }),
          );
          return;
        }
        this.dispatchEvent(
          new CustomEvent("dr-pick-position", {
            bubbles: true,
            composed: true,
            detail: {
              lat: picked[0],
              lng: picked[1],
              mode: it.mode,
              tMs,
              ...(label ? { label } : {}),
            },
          }),
        );
      });
      menu.appendChild(btn);
    }
    // Hosted plotter widgets (dr-app registers the hit test): a pick
    // landing on a widget-area footprint offers placement there in
    // the same menu — the areas carry no on-chart buttons.
    if (containerPoint && this.areaAt) {
      const r = this.mapEl.getBoundingClientRect();
      const anchor = this.areaAt(
        r.left + containerPoint.x,
        r.top + containerPoint.y,
      );
      if (anchor) {
        const btn = document.createElement("button");
        btn.textContent = ` Plotter widgets (${anchor})…`;
        btn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this.hidePickMenu();
          this.dispatchEvent(
            new CustomEvent("dr-open-ext-picker", {
              bubbles: true,
              composed: true,
              detail: { anchor },
            }),
          );
        });
        menu.appendChild(btn);
      }
    }
    // Position the menu at the screen point of the click.
    const point = this.map.latLngToContainerPoint(latlng);
    menu.style.left = `${point.x}px`;
    menu.style.top = `${point.y}px`;
    this.mapEl.appendChild(menu);
    this._pickMenu = menu;
    // Dismiss on the next map click / pan / zoom.
    const dismiss = () => this.hidePickMenu();
    this.map.once("click", dismiss);
    this.map.once("zoomstart", dismiss);
    this.map.once("dragstart", dismiss);
  }

  /** @returns {void} */
  hidePickMenu() {
    this._pickMenu?.remove();
    this._pickMenu = null;
  }

  /**
   * Measure tool (work doc #30): tap points on the chart, get true
   * bearing + distance leg by leg with a running total. Started from
   * the pick menu ("Measure from here…"); each map click adds a leg;
   * double-click / right-click / Esc ends and clears. Pure geometry
   * (bearingBetween/distanceNm) — pure chartwork, no persistence.
   *
   * @param {[number, number]} first - picked starting point
   * @returns {void}
   */
  startMeasure(first) {
    this.endMeasure();
    this._measurePts = [first];
    this._measureReadout = document.createElement("div");
    this._measureReadout.className = "dr-measure";
    this.mapEl.appendChild(this._measureReadout);
    this.mapEl.style.cursor = "crosshair";
    this._measureClick = (e) =>
      this._addMeasureLeg([e.latlng.lat, e.latlng.lng]);
    this.map.on("click", this._measureClick);
    // Rubber band: the working leg follows the cursor from the last
    // fixed vertex — the chartplotter measure convention. Touch
    // devices skip it (no hover); taps fix vertices directly.
    this._measureMove = (e) => {
      if (!this._measurePts) return;
      this._renderMeasure([e.latlng.lat, e.latlng.lng]);
    };
    this.map.on("mousemove", this._measureMove);
    // Esc ends and clears — the keyboard is the helm's third hand.
    this._measureKey = (e) => {
      if (e.key === "Escape") this.endMeasure();
    };
    document.addEventListener("keydown", this._measureKey);
    this._renderMeasure();
  }

  /**
   * Adds a leg vertex; a click within a hair of the previous vertex
   * (the second click of a double-click) ends the tool instead of
   * stacking a zero-length leg.
   *
   * @param {[number, number]} pt
   * @returns {void}
   */
  _addMeasureLeg(pt) {
    const pts = this._measurePts;
    if (!pts) return;
    const last = pts[pts.length - 1];
    if (last && vm.distanceNm(last, pt) < 1e-7) {
      this.endMeasure();
      return;
    }
    pts.push(pt);
    this._renderMeasure();
  }

  /** @returns {void} */
  _renderMeasure(preview = null) {
    this.layers.measure?.clearLayers();
    const pts = this._measurePts;
    if (!pts || !this._measureReadout) return;
    // Legs: dashed line over a dark casing, vertex dots, like the
    // chartwork symbology but neutral (a measurement, not data).
    if (pts.length >= 2) {
      L.polyline(pts, {
        color: vm.STYLE.track.casingColor,
        weight: 4,
        opacity: 0.6,
        interactive: false,
      }).addTo(this.layers.measure);
      L.polyline(pts, {
        color: "#ffffff",
        weight: 1.5,
        opacity: 0.9,
        dashArray: "4 4",
        interactive: false,
      }).addTo(this.layers.measure);
    }
    for (const pt of pts) {
      L.circleMarker(pt, {
        radius: 3,
        color: "#ffffff",
        fillColor: "#ffffff",
        fillOpacity: 0.9,
        weight: 1,
        interactive: false,
      }).addTo(this.layers.measure);
    }
    // Rubber-band preview: the un-committed leg to the cursor, drawn
    // fainter so the fixed chartwork reads through it.
    if (preview && pts.length > 0) {
      L.polyline([pts[pts.length - 1], preview], {
        color: "#ffffff",
        weight: 1,
        opacity: 0.5,
        dashArray: "2 6",
        interactive: false,
      }).addTo(this.layers.measure);
    }
    // Readout: per-leg bearing/distance + cumulative distance.
    // The in-progress (rubber-band) leg reads live at the end of the
    // list; it disappears un-committed when the tool ends.
    const measured = preview ? [...pts, preview] : pts;
    let total = 0;
    const lines = [];
    for (let i = 1; i < measured.length; i++) {
      const brg = vm.bearingBetween(measured[i - 1], measured[i]);
      const dist = vm.distanceNm(measured[i - 1], measured[i]);
      total += dist;
      lines.push(
        `${String(Math.round(brg)).padStart(3, "0")}° ${dist.toFixed(2)} nm`,
      );
    }
    this._measureReadout.innerHTML = "";
    for (const line of lines) {
      const div = document.createElement("div");
      div.textContent = line;
      this._measureReadout.appendChild(div);
    }
    if (lines.length > 1) {
      const totalDiv = document.createElement("div");
      totalDiv.className = "dr-measure-total";
      totalDiv.textContent = `Σ ${total.toFixed(2)} nm`;
      this._measureReadout.appendChild(totalDiv);
    }
  }

  /** @returns {void} */
  endMeasure() {
    if (this._measurePts && this.map && this._measureClick) {
      this.map.off("click", this._measureClick);
    }
    if (this._measureMove) {
      this.map.off("mousemove", this._measureMove);
    }
    if (this._measureKey) {
      document.removeEventListener("keydown", this._measureKey);
    }
    this._measureClick = null;
    this._measureMove = null;
    this._measureKey = null;
    this._measurePts = null;
    this._measureReadout?.remove();
    this._measureReadout = null;
    this.layers.measure?.clearLayers();
    this.mapEl.style.cursor = "";
  }

  /**
   * Renders a full view-model snapshot (dr-app pushes these).
   *
   * @param {object} snap - { drPosition, gpsPosition, ghostTrack,
   *   gpsTrack, uncertainty, fixes, lops, cpls, corrections,
   *   divergence }
   * @returns {void}
   */
  render(snap) {
    if (!this.map) {
      this._pendingSnap = snap;
      return;
    }

    // Ghost + GPS tracks (both always drawn, SPEC §14.1). The ghost
    // (DR) track is the plugin's primary output, so it draws heavier
    // over a dark casing — the dominant line on any tileset — while
    // GPS rides thinner and slightly faded.
    if (snap.ghostTrack?.length > 0) {
      this.renderGhostTrack(snap.ghostTrack, snap.drCourse);
    }
    if (snap.gpsTrack?.length > 0) {
      this.replacePolyline("gps", snap.gpsTrack, {
        color: vm.STYLE.gpsTrack,
        weight: vm.STYLE.track.gpsWeight,
        opacity: 0.75,
      });
    }

    // GPS boat marker — drawn whenever we have a fix, even moored with no
    // DR. SPEC §14.1 shows both the live vessel and the ghost track.
    // Work doc #30: a boat-shaped glyph rotated to COG (dot fallback when
    // COG is unknown), sized constant on screen like the AIS glyphs.
    this.layers.gpsMarker?.clearLayers();
    if (snap.gpsPosition) {
      L.marker(snap.gpsPosition, {
        icon: this._gpsIcon(snap.gpsCogDeg ?? null),
        keyboard: false,
      })
        .bindTooltip("GPS", { direction: "top" })
        .addTo(this.layers.gpsMarker);
      // Recentre on the first fix we see (DR or GPS) so the map isn't
      // stuck on the default 60N/24E until the user pans.
      if (!this.lastDrPosition && !this._didInitialFit) {
        this._didInitialFit = true;
        this.map.invalidateSize();
        this.map.setView(snap.gpsPosition, this.map.getZoom() || 12);
      }
    }

    // DR marker + uncertainty circle.
    if (snap.drPosition) {
      this.lastDrPosition = snap.drPosition;
      if (this.follow) this.map.panTo(snap.drPosition, { animate: true });
      this.layers.drMarker.clearLayers();
      // The DR position plots as the navigator's mark: a boat glyph
      // rotated to the DR course (work doc #30), with the traditional
      // X kept as a small detail inside the hull — X = dead reckoned
      // position, distinct from any fix symbol. Without a course
      // (moored, no DR movement yet) the bare X remains. Labeled with
      // its time — always Z.
      const drLabel = vm.drTimeLabel(snap.drTimeMs);
      L.marker(snap.drPosition, {
        icon: this._drIcon(snap.drCourse?.courseDeg ?? null),
        keyboard: false,
      })
        .bindTooltip(drLabel || "DR", {
          direction: "right",
          permanent: true,
          className: "dr-plabel",
        })
        .addTo(this.layers.drMarker);

      this.layers.uncertainty.clearLayers();
      const u = vm.uncertaintySpec(snap.drPosition, snap.uncertainty);
      if (u.radiusNm > 0) {
        L.circle(u.center, {
          radius: u.radiusNm * 1852,
          color: vm.STYLE.uncertainty,
          fillColor: vm.STYLE.uncertainty,
          fillOpacity: 0.08,
          weight: 1,
          dashArray: "4 4",
        })
          .bindTooltip(`uncertainty ±${u.radiusNm.toFixed(2)} nm (${u.method})`)
          .addTo(this.layers.uncertainty);
      }
    }

    // REST-sourced overlays.
    this.renderFixes(snap.fixes ?? [], vm);
    this.renderLops(snap.lops ?? [], vm, snap.highlight);
    this.renderCpls(
      snap.cpls ?? [],
      vm,
      snap.highlight,
      snap.drPosition ?? this.lastDrPosition,
    );
    this.renderSnaps(snap.corrections ?? [], vm);
    this.renderCandidate(snap.candidate);
    this.renderAdvancements(snap.candidate?.advancements ?? null, snap);
    // Plotter predictors (work doc #30): 10-minute vectors for both
    // own-ship references, range rings re-spaced for the zoom, and
    // wind laylines from the DR vessel (re-lengthed on zoom — the
    // zoomend handler re-renders rings and laylines together).
    this.renderVectors(snap);
    this.renderRangeRings(snap);
    this.renderLaylines(snap);
  }

  /**
   * Renders a resolved-but-unconfirmed candidate fix distinctly from
   * confirmed fixes (hollow ring) so the watchkeeper can sanity-check
   * before confirming.
   *
   * @param {object|null} candidate
   * @returns {void}
   */
  renderCandidate(candidate) {
    this.layers.candidate?.clearLayers();
    if (!candidate || candidate.latitude == null) return;
    const unadvanced = vm.hasUnadvanced(candidate.advancements);
    L.circleMarker([candidate.latitude, candidate.longitude], {
      radius: 8,
      color: unadvanced ? "#c94b4b" : "#c77b28",
      fill: false,
      weight: 2,
      dashArray: "3 3",
    })
      .bindTooltip(
        `candidate${candidate.residual_nm != null ? ` (residual ${candidate.residual_nm.toFixed(2)} nm)` : ""}${unadvanced ? " — ⚠ includes un-advanced observation" : ""} — confirm?`,
        { direction: "top" },
      )
      .addTo(this.layers.candidate);
  }

  /**
   * Renders the running-fix advancement layer (work doc #13 stage B):
   * for each observation in the preview candidate, the faded original
   * point, the dashed DR-run vector to the advanced point, and — when
   * the observation participates in the intersection at a moved
   * position — the advanced constraint geometry (LOP line / CPL arc
   * hint). Older observations that couldn't be advanced draw in a
   * warning style: the honest failure made visible, not hidden behind
   * a plausible-looking intersection.
   *
   * @param {Array<object>|null} advancements - candidate.advancements
   * @param {object} snap - for the observation rows (azimuth/radius by id)
   * @returns {void}
   */
  renderAdvancements(advancements, snap) {
    const layer = this.layers.advancements;
    layer?.clearLayers();
    if (!advancements || advancements.length === 0) return;
    const rowsById = {
      lop: new Map((snap.lops ?? []).map((l) => [l.lop_id, l])),
      cpl: new Map((snap.cpls ?? []).map((c) => [c.cpl_id, c])),
    };
    for (const spec of vm.advancementLayerSpecs(advancements, rowsById)) {
      const warn = spec.warning ? "#c94b4b" : null;
      // Faded original point — where the observation was taken.
      L.circleMarker(spec.original, {
        radius: 3,
        color: warn ?? vm.STYLE.lop,
        fillOpacity: 0.5,
        opacity: 0.5,
        weight: 1,
      })
        .bindTooltip(
          spec.kind === "point"
            ? "previous fix position"
            : spec.warning
              ? "taken here — not advanced (no DR track)"
              : "taken here",
          { direction: "top" },
        )
        .addTo(layer);
      if (spec.displacementNm == null) continue;
      // DR-run vector — the transport over the interval.
      L.polyline([spec.original, spec.advanced], {
        color: "#888899",
        weight: 1.5,
        opacity: 0.9,
        dashArray: "4 4",
      })
        .bindTooltip(
          `advanced ${spec.displacementNm.toFixed(1)} nm along DR track`,
          { direction: "top" },
        )
        .addTo(layer);
      // Solid advanced point.
      L.circleMarker(spec.advanced, {
        radius: 4,
        color: warn ?? vm.STYLE.lop,
        fillOpacity: 0.9,
        weight: 2,
      })
        .bindTooltip(
          spec.kind === "point" ? "fix advanced here" : "participates here",
          { direction: "top" },
        )
        .addTo(layer);
      // The advanced constraint itself: LOP drawn at the advanced
      // position with the row's azimuth — a transferred position
      // line, marked with a double arrowhead at both ends.
      if (spec.kind === "lop" && spec.azimuthDeg != null) {
        const lopType = rowsById.lop.get(spec.id)?.lop_type ?? "celestial";
        const line = vm.extendLineSpec(
          {
            anchor: spec.advanced,
            azimuthDeg: spec.azimuthDeg,
            lopType,
          },
          40,
        );
        const color = warn ?? "#ffffff";
        L.polyline(line, {
          color,
          weight: 1,
          opacity: 0.6,
          dashArray: "2 6",
        })
          .bindTooltip("transferred position line", { direction: "top" })
          .addTo(layer);
        this.renderArrows(
          vm.lopArrowheads(line, spec.azimuthDeg, lopType, true),
          color,
          layer,
        );
      }
    }
  }

  /**
   * Ghost (DR) track — the primary rendered output (SPEC §14.1): a
   * dark casing under a heavier teal line, the cartographic trick
   * that keeps the DR track readable over any tileset (light raster
   * charts included) and visually dominant over GPS. Both lines are
   * non-interactive so chart picks and the context menu keep working
   * on and near the track. When movement data is available the track
   * also carries the traditional course-line label ("C 290° S 6.1")
   * just behind the DR head.
   *
   * @param {Array<[number, number]>} pts
   * @param {{courseDeg: number, speedKn: number}|null} [movement]
   * @returns {void}
   */
  renderGhostTrack(pts, movement = null) {
    this.layers.ghost?.clearLayers();
    if (pts.length < 2) return;
    const t = vm.STYLE.track;
    L.polyline(pts, {
      color: t.casingColor,
      weight: t.ghostWeight + t.casingWidth,
      opacity: 0.85,
      interactive: false,
    }).addTo(this.layers.ghost);
    L.polyline(pts, {
      color: vm.STYLE.ghostTrack,
      weight: t.ghostWeight,
      opacity: 0.95,
      interactive: false,
    }).addTo(this.layers.ghost);
    const course = vm.courseText(movement);
    if (course) {
      L.marker(pts[pts.length - 2], {
        icon: L.divIcon({
          className: "dr-course-label",
          html: `<span>${course}</span>`,
        }),
        interactive: false,
        keyboard: false,
      }).addTo(this.layers.ghost);
    }
  }

  /**
   * @param {string} key - layer-group key
   * @param {Array<[number, number]>} pts
   * @param {object} opts - Leaflet polyline options
   * @returns {void}
   */
  replacePolyline(key, pts, opts) {
    this.layers[key]?.clearLayers();
    if (pts.length >= 2) {
      L.polyline(pts, opts).addTo(this.layers[key]);
    }
  }

  /**
   * @param {Array<object>} fixes
   * @param {object} vm
   * @returns {void}
   */
  renderFixes(fixes, vm) {
    this.layers.fixes.clearLayers();
    for (const f of fixes) {
      const spec = vm.fixPointSpec(f);
      // Traditional chartwork fix symbols: outlined triangle with a
      // dot for an electronic (GPS) fix, outlined circle with a dot
      // for fixes by observation or manual plotting — color still
      // carries the source type.
      L.marker(spec.position, {
        icon: this._fixIcon(vm.fixSymbolType(f.source_type), spec.color),
      })
        .bindTooltip(vm.fixTimeLabel(f.timestamp) || spec.label, {
          direction: "right",
          permanent: true,
          className: "dr-plabel",
        })
        .addEventListener("click", () => this.dispatchInspect("fix", f.fix_id))
        .addTo(this.layers.fixes);
    }
  }

  /**
   * @param {Array<object>} lops
   * @param {object} vm
   * @param {Set<string>|null} [highlight] - selected `kind:id` keys —
   *   every selected LOP renders highlighted, not just the latest
   * @returns {void}
   */
  renderLops(lops, vm, highlight) {
    this.layers.lops.clearLayers();
    for (const lop of lops) {
      const spec = vm.lopLineSpec(lop);
      const line = vm.extendLineSpec(spec, 60);
      const hl = highlight?.has(`lop:${lop.lop_id}`) === true;
      // Selection keeps the line's semantic color (orange = active
      // constraint, grey = used) — white vanished over light chart
      // tiles — and emphasizes with weight instead.
      const color = spec.used ? vm.STYLE.lopUsed : vm.STYLE.lop;
      L.polyline(line, {
        color,
        weight: hl ? 4.5 : 1.5,
        opacity: 0.9,
      })
        .bindTooltip(
          `${lop.body_or_object ?? lop.lop_type} LOP${spec.used ? " (used)" : ""}`,
          { direction: "top" },
        )
        .addEventListener("click", () =>
          this.dispatchInspect("lop", lop.lop_id),
        )
        .addTo(this.layers.lops);
      // Traditional chartwork marking: single arrowhead at the object
      // end, pointing into the sighted mark, for a bearing PL; single
      // arrowheads at both ends for an astronomical PL.
      this.renderArrows(
        vm.lopArrowheads(line, spec.azimuthDeg, spec.lopType),
        color,
        this.layers.lops,
      );
    }
  }

  /**
   * @param {Array<object>} cpls
   * @param {object} vm
   * @param {Set<string>|null} [highlight] - selected `kind:id` keys
   *   (every selected CPL renders highlighted)
   * @param {[number, number]|null|undefined} [drPosition] - live DR
   *   position; centers the traditional range arc on the navigator
   * @returns {void}
   */
  renderCpls(cpls, vm, highlight, drPosition) {
    this.layers.cpls.clearLayers();
    for (const cpl of cpls) {
      const spec = vm.cplCircleSpec(cpl);
      const hl = highlight?.has(`cpl:${cpl.cpl_id}`) === true;
      // Selection keeps the semantic color and emphasizes with
      // weight (white was invisible over light tiles — see LOPs).
      const color = spec.used ? vm.STYLE.cplUsed : vm.STYLE.cpl;
      // Traditional chartwork marking: a range CPL draws as an arc
      // around the navigator with a single arrowhead at both arc
      // ends; the full dashed circle stays underneath (faded) as the
      // complete constraint — the position lies anywhere on it.
      const arc = vm.cplArcSpec(cpl, drPosition ?? this.lastDrPosition);
      L.circle(spec.center, {
        radius: spec.radiusNm * 1852,
        color,
        fillOpacity: 0.05,
        weight: hl ? 4.5 : 1.5,
        opacity: arc ? 0.4 : 0.9,
        dashArray: "6 4",
      })
        .bindTooltip(
          `${cpl.source_object ?? "CPL"} r=${spec.radiusNm.toFixed(1)} nm${spec.used ? " (used)" : ""}`,
        )
        .addEventListener("click", () =>
          this.dispatchInspect("cpl", cpl.cpl_id),
        )
        .addTo(this.layers.cpls);
      if (arc) {
        L.polyline(arc.points, {
          color,
          weight: hl ? 5 : 2,
          opacity: 0.9,
          dashArray: "6 4",
          interactive: false,
        }).addTo(this.layers.cpls);
        this.renderArrows(arc.arrowheads, color, this.layers.cpls);
      }
    }
  }

  /**
   * Builds the divIcon for a traditional chartwork fix symbol: an
   * outlined shape with a dot in the middle — triangle for an
   * electronic (GPS) fix, circle for a fix by observation or manual
   * plotting — stroked in the fix's source-type color.
   *
   * @param {"triangle"|"circle"} shape - fixSymbolType result
   * @param {string} color
   * @returns {object} Leaflet divIcon
   */
  _fixIcon(shape, color) {
    const s = `stroke="${color}" fill="none" stroke-width="1.5"`;
    const dot = `<circle cx="12" cy="12" r="2" fill="${color}" />`;
    const body =
      shape === "triangle"
        ? `<polygon points="12,3.5 21.5,19.5 2.5,19.5" ${s} />`
        : `<circle cx="12" cy="12" r="8.5" ${s} />`;
    return L.divIcon({
      className: "dr-fix",
      iconSize: [24, 24],
      iconAnchor: [12, 12],
      html: `<svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">${body}${dot}</svg>`,
    });
  }

  /**
   * Builds the divIcon for an own-ship boat glyph (work doc #30): a
   * pointed-hull vessel shape rotated to its course (north-up SVG,
   * rotate transform — same trick as the AIS glyphs). Screen-constant
   * size. The DR variant carries the navigator's X inside the hull —
   * the traditional chartwork symbol for a dead reckoned position,
   * kept as a subtle detail so the two-ship picture stays honest.
   *
   * @param {number|null|undefined} rotationDeg - true course the boat
   *   points (null → glyph upright, caller falls back to a bare mark)
   * @param {string} color - hull stroke/fill family color
   * @param {{x?: boolean, size?: number}} [opts] - `x` draws the DR
   *   X detail; `size` overrides the on-screen px size
   * @returns {object} Leaflet divIcon
   */
  _boatIcon(rotationDeg, color, opts = {}) {
    const size = opts.size ?? 20;
    const rot =
      rotationDeg != null
        ? `transform:rotate(${Math.round(rotationDeg)}deg);`
        : "";
    // Pointed hull pointing up (north): bow at top, stern at bottom,
    // slightly rounded bilge — reads as a vessel at 20 px without
    // covering the chart.
    const hull =
      `<path d="M10 1.5 C14 5.5 16 11 16 17 L10 14.2 L4 17 " ` +
      `C4 11 6 5.5 10 1.5 Z" fill="${color}" fill-opacity="0.35" ` +
      `stroke="${color}" stroke-width="1.4" stroke-linejoin="round"/>`;
    // The navigator's X — small, centered in the hull, in the marker
    // white so it reads on the tinted hull over any tileset.
    const x = opts.x
      ? `<path d="M7.6 8 L12.4 11.8 M12.4 8 L7.6 11.8" ` +
        `stroke="${vm.STYLE.drMarker}" stroke-width="1.1" fill="none"/>`
      : "";
    return L.divIcon({
      className: "dr-ais-marker",
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
      html:
        `<div class="dr-ais-glyph" style="${rot}">` +
        `<svg width="${size}" height="${size}" viewBox="0 0 20 20" ` +
        `xmlns="http://www.w3.org/2000/svg">${hull}${x}</svg></div>`,
    });
  }

  /**
   * GPS own-ship glyph (work doc #30): the boat rotated to COG, in the
   * GPS track color; falls back to the plain dot when COG is unknown
   * (the old marker — an honest mark beats a lying heading).
   *
   * @param {number|null|undefined} cogDeg
   * @returns {object} Leaflet divIcon
   */
  _gpsIcon(cogDeg) {
    if (!Number.isFinite(cogDeg)) {
      return L.divIcon({
        className: "dr-ais-marker",
        iconSize: [10, 10],
        iconAnchor: [5, 5],
        html:
          `<svg width="10" height="10" viewBox="0 0 10 10" ` +
          `xmlns="http://www.w3.org/2000/svg">` +
          `<circle cx="5" cy="5" r="4" fill="${vm.STYLE.gpsTrack}" ` +
          `fill-opacity="0.9"/></svg>`,
      });
    }
    return this._boatIcon(cogDeg, vm.STYLE.gpsTrack);
  }

  /**
   * DR own-ship glyph (work doc #30): the boat rotated to the DR
   * course with the navigator's X in the hull; falls back to the bare
   * traditional X when no DR course is known (moored / no movement).
   *
   * @param {number|null|undefined} courseDeg
   * @returns {object} Leaflet divIcon
   */
  _drIcon(courseDeg) {
    if (!Number.isFinite(courseDeg)) {
      return L.divIcon({
        className: "dr-fix",
        iconSize: [14, 14],
        iconAnchor: [7, 7],
        html:
          `<svg width="14" height="14" viewBox="0 0 14 14" ` +
          `xmlns="http://www.w3.org/2000/svg">` +
          `<path d="M2 2 L12 12 M12 2 L2 12" stroke="${vm.STYLE.drMarker}" ` +
          `stroke-width="2.2" fill="none"/></svg>`,
      });
    }
    return this._boatIcon(courseDeg, vm.STYLE.drMarker, { x: true });
  }

  /**
   * Renders the chartplotter predictor vectors (work doc #30): the
   * 10-minute line for each own-ship reference — GPS along COG at SOG
   * (dashed, tick marks every 2 minutes), DR along the DR course at DR
   * speed. Each draws in its track's family color so the vector reads
   * as an extension of the track it belongs to. Ticks are small
   * cross-marks on the line, non-interactive like the line itself.
   *
   * @param {object} snap - needs gpsPosition/gpsCogDeg/gpsSogKn and
   *   drPosition/drCourse
   * @returns {void}
   */
  renderVectors(snap) {
    const layer = this.layers.vectors;
    if (!layer) return;
    layer.clearLayers();
    const refs = [
      {
        position: snap.gpsPosition,
        courseDeg: snap.gpsCogDeg,
        speedKn: snap.gpsSogKn,
        color: vm.STYLE.vector.gps,
      },
      {
        position: snap.drPosition,
        courseDeg: snap.drCourse?.courseDeg,
        speedKn: snap.drCourse?.speedKn,
        color: vm.STYLE.vector.dr,
      },
    ];
    for (const ref of refs) {
      if (!ref.position) continue;
      const v = vm.predictorVector(ref.position, ref.courseDeg, ref.speedKn);
      if (!v) continue;
      L.polyline([v.from, v.to], {
        color: ref.color,
        weight: 1.5,
        opacity: 0.8,
        dashArray: "4 4",
        interactive: false,
      }).addTo(layer);
      // Tick marks at 2/4/6/8 minutes — short cross-marks ON the line
      // (the endpoint itself is the 10-minute mark; a tick there would
      // be redundant). Screen-constant: tiny polylines perpendicular
      // to the course drawn in screen terms need screen coords, so the
      // tick is a small circleMarker — reads as a gradation dot.
      for (const tick of v.ticks) {
        L.circleMarker(tick.at, {
          radius: 1.5,
          color: ref.color,
          fillOpacity: 0.9,
          weight: 1,
          interactive: false,
        }).addTo(layer);
      }
    }
  }

  /**
   * Renders wind laylines (work doc #30): two rays from the DR vessel
   * at the beat/gybe courses for the current point of sail, fixed
   * screen-relative length (re-lengthed on zoom). Red = port tack,
   * green = starboard (navigation-light convention). Inputs absent →
   * the layer just doesn't render — no fake defaults.
   *
   * @param {object} [snap] - render snapshot; omitted when re-rendering
   *   after a zoom (the last snap's inputs are reused)
   * @returns {void}
   */
  renderLaylines(snap) {
    if (snap) this._lastSnap = snap;
    const layer = this.layers.laylines;
    if (!layer || !this.map) return;
    layer.clearLayers();
    const s = this._lastSnap;
    const dr = s?.drPosition;
    if (!dr) return;
    // Laylines render only when SAILING (navigation.state) — under
    // power the beat/gybe angles answer a question nobody is asking.
    if (!s.sailing) return;
    // Fixed screen-relative length: ~18% of the viewport height, in NM
    // at the current zoom — geometry rides the view, not the chart.
    const size = this.map.getSize();
    const mpp = vm.metersPerPixel(this.map.getZoom(), dr[0]);
    const lengthNm = (size.y * 0.18 * mpp) / vm.METRES_PER_NM;
    const spec = vm.laylineSpec(dr, {
      twdDeg: s.twdDeg,
      beatAngleDeg: s.beatAngleDeg,
      gybeAngleDeg: s.gybeAngleDeg,
      headingDeg: s.drCourse?.courseDeg ?? null,
      lengthNm,
    });
    if (!spec) return;
    for (const ray of spec.rays) {
      L.polyline([dr, ray.to], {
        color: ray.color,
        weight: 1.5,
        opacity: 0.8,
      })
        .bindTooltip(
          `${ray.tack} tack · ${String(Math.round(ray.courseDeg)).padStart(3, "0")}° (${spec.mode})`,
          { direction: "top" },
        )
        .addTo(layer);
    }
  }

  /**
   * Renders range rings (work doc #30): three concentric rings at the
   * zoom-derived ladder spacing, centered on the GPS position (the
   * helm's quick bearing/distance reference; rings around the ghost
   * would read as DR data). Re-spaced on zoom — the layer is cleared
   * and re-drawn from the last known snap.
   *
   * @param {object} [snap] - render snapshot; omitted when re-rendering
   *   after a zoom (the last snap's GPS position is reused)
   * @returns {void}
   */
  renderRangeRings(snap) {
    if (snap) this._lastSnap = snap;
    const layer = this.layers.rings;
    if (!layer || !this.map) return;
    layer.clearLayers();
    const center = this._lastSnap?.gpsPosition;
    if (!center) return;
    const mpp = vm.metersPerPixel(this.map.getZoom(), center[0]);
    const spacingNm = vm.rangeRingSpacingNm(mpp);
    if (spacingNm == null) return;
    for (let i = 1; i <= 3; i++) {
      L.circle(center, {
        radius: spacingNm * i * vm.METRES_PER_NM,
        color: vm.STYLE.ring,
        fill: false,
        weight: 1,
        opacity: 0.4,
        dashArray: "2 6",
        interactive: true,
      })
        .bindTooltip(`${(spacingNm * i).toFixed(spacingNm < 1 ? 2 : 1)} nm`, {
          direction: "right",
          permanent: false,
        })
        .addTo(layer);
    }
  }

  /**
   * Adds non-interactive arrowhead markers (traditional chartwork
   * position-line marking) to a layer group. The arrows decorate
   * their line — clicks and hovers stay with the line itself.
   *
   * @param {Array<{at: [number, number], rotationDeg: number,
   *   double: boolean}>} arrows - lopArrowheads/cplArcSpec result
   * @param {string} color - must match the line it decorates
   * @param {object} layer - Leaflet layer group
   * @returns {void}
   */
  renderArrows(arrows, color, layer) {
    for (const a of arrows ?? []) {
      L.marker(a.at, {
        icon: this._arrowIcon(a.rotationDeg, color, a.double),
        interactive: false,
        keyboard: false,
      }).addTo(layer);
    }
  }

  /**
   * Builds the divIcon for a traditional chartwork arrowhead: a solid
   * chevron rotated to point outward along its line — single for a
   * position line from an observation, double for a transferred
   * position line. Bare divIcon (className drops Leaflet's default
   * white box), same trick as the AIS glyphs.
   *
   * @param {number} rotationDeg - compass bearing the chevron points
   * @param {string} color
   * @param {boolean} [double=false] - double chevron (transferred PL)
   * @returns {object} Leaflet divIcon
   */
  _arrowIcon(rotationDeg, color, double = false) {
    const rot = `transform:rotate(${Math.round(rotationDeg)}deg);`;
    const f = ` fill="${color}"`;
    const size = double ? 16 : 12;
    const paths = double
      ? `<path d="M8 1 L13 8.5 L3 8.5 Z"${f}/><path d="M8 7 L13 14.5 L3 14.5 Z"${f}/>`
      : `<path d="M6 1 L11 10 L1 10 Z"${f}/>`;
    return L.divIcon({
      className: "dr-arrow",
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
      html: `<div style="${rot}"><svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">${paths}</svg></div>`,
    });
  }

  /**
   * Renders the currently active Signal K route
   * (`navigation.course.activeRoute`, discovered the Freeboard-SK
   * way — href → `/resources/routes/{id}` fetch): a magenta leg line
   * through the route's waypoints with one marker per waypoint, the
   * point currently being navigated to emphasized. Dr-app pushes a
   * `routeRenderSpec`; null (course cleared, or a destination that
   * isn't a route) empties the layer. The whole layer is toggleable
   * via the layers control ("Active route").
   *
   * @param {{name: string, points: Array<[number, number]>,
   *   targetIndex: number, labels?: Array<string>}|null} spec
   * @returns {void}
   */
  renderRoute(spec) {
    const layer = this.layers.route;
    if (!layer) return;
    layer.clearLayers();
    if (!spec || spec.points?.length < 2) return;
    // Route line over a dark casing — same cartographic trick as the
    // ghost track so the magenta stays legible over light raster tiles.
    L.polyline(spec.points, {
      color: vm.STYLE.track.casingColor,
      weight: 4.5,
      opacity: 0.85,
      interactive: false,
    }).addTo(layer);
    L.polyline(spec.points, {
      color: vm.STYLE.route,
      weight: 2.5,
      opacity: 0.95,
    })
      .bindTooltip(spec.name, { direction: "top" })
      .addTo(layer);
    for (let i = 0; i < spec.points.length; i++) {
      const target = i === spec.targetIndex;
      const label = spec.labels?.[i] ?? `WP ${i + 1}`;
      L.circleMarker(spec.points[i], {
        radius: target ? 6 : 4,
        color: vm.STYLE.route,
        fillColor: target ? vm.STYLE.route : "transparent",
        fillOpacity: target ? 0.9 : 0,
        weight: 2,
      })
        .bindTooltip(target ? `${label} — next` : label, { direction: "top" })
        .addTo(layer);
    }
  }

  /**
   * Renders the Signal K notes collection (work doc #30): one marker
   * per positioned note on the toggleable "Notes" layer. Clicking or
   * right-clicking a marker opens the pick menu at the note's position
   * with the note detail block (title/body/timestamp + Edit/Delete),
   * the DR/GPS bearing rows and all the usual pick actions working on
   * the note's position. Markers are rebuilt each render (notes change
   * rarely; the collection is small).
   *
   * @param {Array<{id: string, position: [number, number], title: string}>} specs
   * @param {Map<string, object>} [resourcesById] - full note resources
   *   by id (dr-app's cache) — the detail surface reads title/body/
   *   mimeType/timestamp from it
   * @returns {void}
   */
  renderNotes(specs, resourcesById) {
    this.notesById = resourcesById ?? new Map();
    const layer = this.layers.notes;
    if (!layer) return;
    layer.clearLayers();
    for (const spec of specs ?? []) {
      L.marker(spec.position, { icon: this._noteIcon() })
        .bindTooltip(spec.title, { direction: "top" })
        .addEventListener("click", () => this.openNoteDetail(spec))
        // Right-click opens the same surface (work doc #30) — the
        // pick menu is the detail surface, from either gesture.
        .addEventListener("contextmenu", () => this.openNoteDetail(spec))
        .addTo(layer);
    }
  }

  /**
   * Opens the note detail surface: the pick menu at the note position
   * with the full note resource attached. Also used by right-clicks on
   * the marker (same surface, work doc #30).
   *
   * @param {{id: string, position: [number, number], title: string}} spec
   * @returns {void}
   */
  openNoteDetail(spec) {
    const note = this.notesById?.get(spec.id) ?? null;
    this.showPickMenu(spec.position, null, {
      label: spec.title,
      note: note
        ? { ...note, id: spec.id }
        : { id: spec.id, title: spec.title },
    });
  }

  /**
   * Builds the divIcon for a Signal K note marker (work doc #30): a
   * small note/pin glyph in our own symbology language — a chart
   * annotation, not app chrome.
   *
   * @returns {object} Leaflet divIcon
   */
  _noteIcon() {
    return L.divIcon({
      className: "dr-fix",
      iconSize: [20, 20],
      iconAnchor: [10, 18],
      html:
        `<svg width="20" height="20" viewBox="0 0 20 20" ` +
        `xmlns="http://www.w3.org/2000/svg">` +
        // Pin: a pointed drop with a note-line mark inside.
        `<path d="M10 19 C10 19 4 11.5 4 7 A6 6 0 0 1 16 7 "` +
        `C16 11.5 10 19 10 19 Z" fill="#080a0c" ` +
        `stroke="var(--color-orange, #c77b28)" stroke-width="1.5"/>` +
        `<path d="M7 6.5 H13 M7 9.5 H11" ` +
        `stroke="var(--color-orange, #c77b28)" stroke-width="1.3"/>` +
        `</svg>`,
    });
  }

  /**
   * Dispatches a map-click inspection event (work doc #13): the app
   * opens the detail popover for the clicked record.
   *
   * @param {"lop"|"cpl"|"fix"} kind
   * @param {number} id
   * @returns {void}
   */
  dispatchInspect(kind, id) {
    this.dispatchEvent(
      new CustomEvent("dr-inspect", {
        bubbles: true,
        composed: true,
        detail: { kind, id },
      }),
    );
  }

  /**
   * @param {Array<object>} corrections
   * @param {object} vm
   * @returns {void}
   */
  renderSnaps(corrections, vm) {
    this.layers.snaps.clearLayers();
    for (const c of corrections) {
      const s = vm.correctionSegmentSpec(c);
      L.polyline([s.from, s.to], {
        color: vm.STYLE.snapVector,
        weight: 1.5,
        opacity: 0.8,
        dashArray: "3 5",
      })
        .bindTooltip(
          `snap: ${s.deviationNm.toFixed(2)} nm / ${String(Math.round(s.bearingDeg)).padStart(3, "0")}°`,
          { direction: "top" },
        )
        .addTo(this.layers.snaps);
    }
  }

  /**
   * Builds the divIcon for an AIS target glyph (work doc #23): a bare
   * rotated arrow (className drops Leaflet's default white box), sized
   * for a finger-ish target without covering the chart. Expiring marks
   * drop opacity — the plotter's "data decaying" cue.
   *
   * @param {object} spec - aisMarkerSpec result
   * @returns {object} Leaflet divIcon
   */
  _aisIcon(spec) {
    const rot =
      spec.rotationDeg != null
        ? `transform:rotate(${Math.round(spec.rotationDeg)}deg);`
        : "";
    const opacity = spec.expiring ? "opacity:0.55;" : "";
    return L.divIcon({
      className: "dr-ais-marker",
      iconSize: [16, 16],
      iconAnchor: [8, 8],
      html: `<div class="dr-ais-glyph" style="${rot}${opacity}"><svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="M8 1.5 L13.5 13.5 L8 10.8 L2.5 13.5 Z" fill="${spec.color}" stroke="${spec.color}" stroke-width="0.6"/></svg></div>`,
    });
  }

  /**
   * Renders the AIS target set (work doc #23). Dr-app pushes specs built
   * by `aisTargetsForRender` — outside `render(snap)`, since targets tick
   * independently of the DR snapshot. Markers are REUSED across calls
   * (position/rotation/leader update in place) so ~1 Hz refreshes don't
   * churn DOM or flicker tooltips. Targets absent from `specs` (aged
   * out, range-filtered) are removed.
   *
   * @param {Array<object>} specs - aisMarkerSpec results
   * @param {number} nowMs - instant the predicted positions are valid
   *   for; a right-click pick dispatches it as the sight-time anchor
   * @returns {void}
   */
  renderAis(specs, nowMs) {
    if (!this.map) return;
    this._aisRenderNowMs = nowMs;
    const incoming = new Map(specs.map((s) => [s.context, s]));
    for (const [ctx, entry] of this._aisRendered) {
      if (incoming.has(ctx)) continue;
      this.layers.ais?.removeLayer(entry.marker);
      if (entry.leader) this.layers.ais?.removeLayer(entry.leader);
      this._aisRendered.delete(ctx);
    }
    for (const spec of incoming.values()) {
      let entry = this._aisRendered.get(spec.context);
      if (!entry) {
        const icon = this._aisIcon(spec);
        icon._drAis = {
          rotationDeg: spec.rotationDeg,
          color: spec.color,
          expiring: spec.expiring,
        };
        const marker = L.marker(spec.position, { icon })
          .bindTooltip(spec.tooltip, { direction: "top" })
          .addTo(this.layers.ais);
        entry = { spec, marker, leader: null };
        this._aisRendered.set(spec.context, entry);
      } else {
        entry.spec = spec;
        entry.marker.setLatLng(spec.position);
        // Icon rebuild only when something visible changed — setIcon
        // recreates the DOM node, so skip it when only position moved.
        const prev = entry.marker.options?.icon ?? null;
        const changed =
          !prev ||
          prev._drAis?.rotationDeg !== spec.rotationDeg ||
          prev._drAis?.color !== spec.color ||
          prev._drAis?.expiring !== spec.expiring;
        if (changed) {
          const icon = this._aisIcon(spec);
          icon._drAis = {
            rotationDeg: spec.rotationDeg,
            color: spec.color,
            expiring: spec.expiring,
          };
          entry.marker.setIcon(icon);
        }
        entry.marker.setTooltipContent?.(spec.tooltip);
      }
      // Velocity leader: 6-minute run from the predicted position;
      // drops when the target expires (nothing trustworthy to project).
      if (spec.leader) {
        const pts = [spec.leader.from, spec.leader.to];
        if (entry.leader) {
          entry.leader.setLatLngs(pts);
          entry.leader.setStyle({
            color: spec.color,
            opacity: spec.expiring ? 0.4 : 0.8,
          });
        } else {
          entry.leader = L.polyline(pts, {
            color: spec.color,
            weight: 1,
            opacity: spec.expiring ? 0.4 : 0.8,
            dashArray: "2 4",
            interactive: false,
          }).addTo(this.layers.ais);
        }
      } else if (entry.leader) {
        this.layers.ais?.removeLayer(entry.leader);
        entry.leader = null;
      }
    }
  }
}

customElements.define("dr-map-view", DrMapView);

/**
 * Nautical scale bar (work doc #30): a Leaflet control showing a bar
 * + NM label (metric fallback at deep zooms), snapped to the nautical
 * ladder from dr-viewmodel so the figure is always a "reasonable unit"
 * (0.1, 0.25, 0.5, 1, 2, 3, 5, 10 NM…). No `1:x` numeric readout — the
 * bar itself is the scale. Re-measures on every update() call, which
 * the map wires to zoomend/moveend (mpp depends on latitude too).
 */
class NauticalScaleControl extends L.Control {
  constructor() {
    super({ position: "bottomleft" });
  }

  onAdd(map) {
    const div = L.DomUtil.create(
      "div",
      "dr-scalebar leaflet-control-attribution-style-none",
    );
    div.style.cssText =
      "margin-bottom:2px;font:11px ui-monospace,'Fira Code',monospace;" +
      "color:var(--text-main,#fff);text-shadow:0 0 3px #080a0c,0 0 3px #080a0c;" +
      "white-space:nowrap;";
    this._div = div;
    this.update(map);
    return div;
  }

  /**
   * Re-measures the bar for the current view. Exposed for the map's
   * zoom/move handlers (Leaflet's own scale control re-adds itself on
   * zoom; ours is told explicitly).
   *
   * @param {object} map
   * @returns {void}
   */
  update(map) {
    if (!this._div) return;
    const zoom = map.getZoom();
    const center = map.getCenter();
    const mpp = vm.metersPerPixel(zoom, center?.lat ?? 0);
    const spec = vm.scaleBarSpec(mpp);
    if (!spec) {
      this._div.textContent = "";
      this._div.style.width = "0";
      return;
    }
    // Bar: a solid line with end ticks, the label to the right — the
    // plotter convention, readable over any tileset.
    this._div.innerHTML =
      `<span style="display:inline-block;vertical-align:middle;` +
      `width:${Math.round(spec.px)}px;height:0;` +
      `border-bottom:2px solid var(--text-main,#fff);` +
      `border-left:2px solid var(--text-main,#fff);` +
      `border-right:2px solid var(--text-main,#fff);"></span> ` +
      `<span>${spec.label}</span>`;
  }
}
