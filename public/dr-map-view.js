/**
 * `<dr-map-view>` — dual/continuous track rendering of GPS vs. the always-on
 * inertial "Ghost Track" (SPEC §14.1), with uncertainty polygon, fixes,
 * LOP/CPL overlays, snap-to-fix vectors, and the live divergence readout.
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
      /* Desktop aggressively consumes viewport height; mobile keeps a
         strict floor so the page stays scrollable (UI spec §7). */
      :host {
        display: block;
        position: relative;
        height: max(50vh, calc(100vh - 260px));
        min-height: 50vh;
        overflow: hidden;
      }
      .map-host { position: relative; width: 100%; height: 100%; }
      .map-wrap { width: 100%; height: 100%; background: var(--bg-base, #080a0c); }
      /* Floating overlays: semi-transparent dark panels with sharp 1px
         borders so they stay legible over any tileset (UI spec §7).
         Bottom-right: the top-right corner belongs to Leaflet's layers
         control — stacking the chip there covered the control's toggle
         (same z-index, later sibling wins), which both looked broken and
         swallowed the clicks that were meant to switch chart providers.
         The bottom-right corner is free here: attribution is off. */
      .dr-chip {
        position: absolute;
        bottom: 8px;
        right: 8px;
        z-index: 1000;
        display: flex;
        gap: 8px;
        align-items: center;
        padding: 4px 10px;
        background-color: rgba(17, 20, 20, 0.8);
        border: 1px solid rgba(75, 139, 153, 0.5);
        color: var(--color-teal, #4b8b99);
        font: 12px/1.4 ui-monospace, "Fira Code", monospace;
        font-variant-numeric: tabular-nums;
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

    const chip = document.createElement("div");
    chip.setAttribute("part", "divergence");
    chip.className = "dr-chip";

    const chipText = document.createElement("span");
    chipText.textContent = "— nm";
    const spark = document.createElement("canvas");
    spark.width = 80;
    spark.height = 20;
    spark.style.display = "block";
    spark.style.alignSelf = "center";
    chip.appendChild(chipText);
    chip.appendChild(spark);

    const host = document.createElement("div");
    host.className = "map-host";
    host.appendChild(wrap);
    host.appendChild(chip);
    root.appendChild(host);

    /** @type {HTMLDivElement} */
    this.mapEl = wrap;
    /** @type {HTMLElement} */
    this.chipText = chipText;
    /** @type {HTMLCanvasElement} */
    this.sparkCanvas = spark;
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
    };
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
      zoomControl: true,
      attributionControl: false,
    });
    for (const key of Object.keys(this.layers)) {
      this.layers[key] = L.layerGroup().addTo(this.map);
    }
    this.map.on("dragstart", () => {
      this.follow = false;
    });
    // Chart pick: right-click / long-press opens a small context menu
    // to pre-seed a sight form with the picked object position (and the
    // object's charted name, when a symbol was hit — see pickSymbolName).
    // An AIS target under the cursor (work doc #23) wins over the chart:
    // its *predicted* position seeds the bearing, with the sight time
    // anchored to the prediction instant.
    this.map.on("contextmenu", (e) => {
      const target = this._aisTargetAt(e.containerPoint);
      if (target) {
        this.showPickMenu(target.position, e.containerPoint, {
          label: target.label,
          tMs: this._aisRenderNowMs ?? Date.now(),
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
        // de-cluttered.
        L.control
          .layers(
            bases,
            { "AIS traffic": this.layers.ais },
            { collapsed: true },
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
   * Shows a small context menu at a chart point offering to pre-seed a
   * sight form with that position as the object. Dispatches
   * `dr-pick-position` (composed, bubbles) with `{ lat, lng, mode,
   * label, tMs }` — `label` carries the picked symbol's charted name
   * (or an AIS target's name, work doc #23), `tMs` the pick instant the
   * position is valid for (an AIS target's predicted position is
   * anchored to it).
   *
   * @param {L.LatLng|[number, number]} latlng
   * @param {L.Point|null|undefined} [containerPoint]
   * @param {{label?: string|null, tMs?: number}|null} [preset] - AIS
   *   picks resolve label/time here instead of the chart query
   * @returns {void}
   */
  showPickMenu(latlng, containerPoint, preset = null) {
    // Remove any prior menu.
    this.hidePickMenu();
    const label = preset?.label ?? this.pickSymbolName(containerPoint);
    const tMs = Number.isFinite(preset?.tMs) ? preset.tMs : Date.now();
    const menu = document.createElement("div");
    menu.className = "dr-pick-menu";
    const what = label ?? "this point";
    menu.textContent = `Add observation at ${what}…`;
    const items = [
      { label: ` Bearing to ${what}`, mode: "bearing" },
      { label: ` Distance CPL at ${what}`, mode: "vertical" },
    ];
    for (const it of items) {
      const btn = document.createElement("button");
      btn.textContent = it.label;
      btn.addEventListener("click", () => {
        this.hidePickMenu();
        this.dispatchEvent(
          new CustomEvent("dr-pick-position", {
            bubbles: true,
            composed: true,
            detail: {
              lat: Array.isArray(latlng) ? latlng[0] : latlng.lat,
              lng: Array.isArray(latlng) ? latlng[1] : latlng.lng,
              mode: it.mode,
              tMs,
              ...(label ? { label } : {}),
            },
          }),
        );
      });
      menu.appendChild(btn);
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

    // Ghost + GPS tracks (both always drawn, SPEC §14.1).
    if (snap.ghostTrack?.length > 0) {
      this.replacePolyline("ghost", snap.ghostTrack, {
        color: vm.STYLE.ghostTrack,
        weight: 2,
        opacity: 0.9,
      });
    }
    if (snap.gpsTrack?.length > 0) {
      this.replacePolyline("gps", snap.gpsTrack, {
        color: vm.STYLE.gpsTrack,
        weight: 2,
        opacity: 0.8,
      });
    }

    // GPS boat marker — drawn whenever we have a fix, even moored with no
    // DR. SPEC §14.1 shows both the live vessel and the ghost track.
    this.layers.gpsMarker?.clearLayers();
    if (snap.gpsPosition) {
      L.circleMarker(snap.gpsPosition, {
        radius: 5,
        color: vm.STYLE.gpsTrack,
        fillOpacity: 0.9,
        weight: 2,
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
      L.circleMarker(snap.drPosition, {
        radius: 6,
        color: vm.STYLE.drMarker,
        fillOpacity: 0.9,
        weight: 2,
      })
        .bindTooltip("DR", { direction: "top" })
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
    this.renderCpls(snap.cpls ?? [], vm, snap.highlight);
    this.renderSnaps(snap.corrections ?? [], vm);
    this.renderCandidate(snap.candidate);
    this.renderAdvancements(snap.candidate?.advancements ?? null, snap);

    // Divergence readout + sparkline.
    this.renderDivergence(snap.divergence, snap.sparkStats);
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
          spec.warning
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
        .bindTooltip("participates here", { direction: "top" })
        .addTo(layer);
      // The advanced constraint itself: LOP drawn at the advanced
      // position with the row's azimuth.
      if (spec.kind === "lop" && spec.azimuthDeg != null) {
        const line = vm.extendLineSpec(
          {
            anchor: spec.advanced,
            azimuthDeg: spec.azimuthDeg,
            lopType: rowsById.lop.get(spec.id)?.lop_type ?? "celestial",
          },
          40,
        );
        L.polyline(line, {
          color: warn ?? "#ffffff",
          weight: 1,
          opacity: 0.6,
          dashArray: "2 6",
        }).addTo(layer);
      }
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
      L.circleMarker(spec.position, {
        radius: 4,
        color: spec.color,
        fillOpacity: 0.9,
        weight: 1.5,
      })
        .bindTooltip(spec.label, { direction: "top" })
        .addEventListener("click", () => this.dispatchInspect("fix", f.fix_id))
        .addTo(this.layers.fixes);
    }
  }

  /**
   * @param {Array<object>} lops
   * @param {object} vm
   * @param {{kind: string, id: number}|null} [highlight]
   * @returns {void}
   */
  renderLops(lops, vm, highlight) {
    this.layers.lops.clearLayers();
    for (const lop of lops) {
      const spec = vm.lopLineSpec(lop);
      const line = vm.extendLineSpec(spec, 60);
      const hl = highlight?.kind === "lop" && highlight.id === lop.lop_id;
      L.polyline(line, {
        color: hl ? "#ffffff" : spec.used ? vm.STYLE.lopUsed : vm.STYLE.lop,
        weight: hl ? 3.5 : 1.5,
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
    }
  }

  /**
   * @param {Array<object>} cpls
   * @param {object} vm
   * @param {{kind: string, id: number}|null} [highlight]
   * @returns {void}
   */
  renderCpls(cpls, vm, highlight) {
    this.layers.cpls.clearLayers();
    for (const cpl of cpls) {
      const spec = vm.cplCircleSpec(cpl);
      const hl = highlight?.kind === "cpl" && highlight.id === cpl.cpl_id;
      L.circle(spec.center, {
        radius: spec.radiusNm * 1852,
        color: hl ? "#ffffff" : spec.used ? vm.STYLE.cplUsed : vm.STYLE.cpl,
        fillOpacity: 0.05,
        weight: hl ? 3.5 : 1.5,
        dashArray: "6 4",
      })
        .bindTooltip(
          `${cpl.source_object ?? "CPL"} r=${spec.radiusNm.toFixed(1)} nm${spec.used ? " (used)" : ""}`,
        )
        .addEventListener("click", () =>
          this.dispatchInspect("cpl", cpl.cpl_id),
        )
        .addTo(this.layers.cpls);
    }
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

  /**
   * @param {{distance_nm: number, bearing_true: number}|null} divergence
   * @param {object|null} [sparkStats]
   * @returns {void}
   */
  renderDivergence(divergence, sparkStats) {
    this.chipText.textContent = vm
      ? vm.divergenceText(divergence)
      : `${divergence?.distance_nm?.toFixed(2) ?? "—"} nm`;
    const ctx = this.sparkCanvas.getContext("2d");
    if (!ctx || !sparkStats || sparkStats.points.length < 2) return;
    const { width: w, height: h } = this.sparkCanvas;
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = "#4b8b99";
    ctx.lineWidth = 1;
    ctx.beginPath();
    sparkStats.points.forEach((y, i) => {
      const x = (i / (sparkStats.points.length - 1)) * (w - 2) + 1;
      const py = h - 2 - y * (h - 4);
      if (i === 0) ctx.moveTo(x, py);
      else ctx.lineTo(x, py);
    });
    ctx.stroke();
  }
}

customElements.define("dr-map-view", DrMapView);
