/**
 * `<dr-map-view>` — dual/continuous track rendering of GPS vs. the always-on
 * inertial "Ghost Track" (SPEC §14.1), with uncertainty polygon, fixes,
 * LOP/CPL overlays, snap-to-fix vectors, and the live divergence readout.
 *
 * Tile-less by default (offline-first): geometry renders on a plain
 * dark background. Basemaps come from the server's *configured*
 * charts (`/signalk/v1/api/resources/charts` — offline MBTiles, tile
 * proxies, whatever the user set up), exposed via the layers control.
 * No hardcoded OSM (referer-403s on self-hosted setups, and the EW
 * operating mode is comms-denied).
 *
 * Geometry/style decisions live in dr-viewmodel.js (pure); this file
 * is the Leaflet adapter. Leaflet is vendored at ./vendor/leaflet/
 * (BSD-2) — no CDN, no build tooling.
 *
 * @file dr-map-view.js
 */

/* global L */

import * as vm from "./dr-viewmodel.js";

class DrMapView extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host { display: block; height: 60vh; border-radius: 8px; overflow: hidden; }
      .map-host { position: relative; width: 100%; height: 100%; }
      .map-wrap { width: 100%; height: 100%; background: #0d1117; }
      .dr-pick-menu {
        position: absolute;
        z-index: 1000;
        background: var(--dr-panel, #111827);
        border: 1px solid #2d3748;
        border-radius: 6px;
        padding: 0.25rem;
        font-size: 0.8rem;
        color: var(--dr-muted, #8b949e);
        box-shadow: 0 4px 12px rgba(0,0,0,0.5);
        display: flex;
        flex-direction: column;
        gap: 0.2rem;
        min-width: 12rem;
      }
      .dr-pick-menu button {
        font: inherit;
        text-align: left;
        padding: 0.3rem 0.5rem;
        border: 1px solid #1f2937;
        border-radius: 4px;
        background: #1a202c;
        color: var(--dr-fg, #e6edf3);
        cursor: pointer;
      }
      .dr-pick-menu button:hover { background: #2d3748; }
    `;
    root.appendChild(style);
    // Leaflet's CSS must live INSIDE the shadow root — a document-level
    // <link> can't reach the .leaflet-* classes Leaflet creates here.
    const leafletCss = document.createElement("link");
    leafletCss.rel = "stylesheet";
    leafletCss.href = "./vendor/leaflet/leaflet.css";
    root.appendChild(leafletCss);
    const wrap = document.createElement("div");
    wrap.setAttribute("part", "map");
    wrap.className = "map-wrap";

    const chip = document.createElement("div");
    chip.setAttribute("part", "divergence");
    chip.style.position = "absolute";
    chip.style.top = "8px";
    chip.style.right = "8px";
    chip.style.zIndex = "1000";
    chip.style.display = "flex";
    chip.style.gap = "8px";
    chip.style.alignItems = "center";
    chip.style.padding = "4px 8px";
    chip.style.background = "rgba(13, 17, 23, 0.85)";
    chip.style.border = "1px solid #30363d";
    chip.style.borderRadius = "6px";
    chip.style.color = "#c9d1d9";
    chip.style.font = "12px/1.4 ui-monospace, monospace";

    const chipText = document.createElement("span");
    chipText.textContent = "— nm";
    const spark = document.createElement("canvas");
    spark.width = 80;
    spark.height = 20;
    spark.style.display = "block";
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
    };
    this.tileLayers = {};
    this.follow = true;
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
    // to pre-seed a sight form with the picked object position.
    this.map.on("contextmenu", (e) => this.showPickMenu(e.latlng));
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
    // when available, falling back to online OSM when the server has none
    // configured (route 404s or returns empty). The first available layer
    // is added to the map so the plot has context immediately; the rest
    // are registered in the layers control for switching.
    fetch("/signalk/v1/api/resources/charts")
      .then((r) => (r.ok ? r.json() : null))
      .then((resource) => {
        const charts = vm.chartLayersWithFallback(resource);
        if (charts.length === 0) return;
        const bases = {};
        let first = null;
        for (const c of charts) {
          const layer = L.tileLayer(c.url, {
            minZoom: c.minZoom,
            maxZoom: c.maxZoom,
            maxNativeZoom: c.maxZoom,
          });
          this.tileLayers[c.identifier] = layer;
          bases[c.name] = layer;
          if (!first) first = layer;
        }
        first.addTo(this.map);
        if (Object.keys(bases).length > 1) {
          L.control.layers(bases, {}, { collapsed: true }).addTo(this.map);
        }
      })
      .catch(() => {
        /* tile-less stays */
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
   * Shows a small context menu at a chart point offering to pre-seed a
   * sight form with that position as the object. Dispatches
   * `dr-pick-position` (composed, bubbles) with `{ lat, lng, mode }`.
   *
   * @param {L.LatLng} latlng
   * @returns {void}
   */
  showPickMenu(latlng) {
    // Remove any prior menu.
    this.hidePickMenu();
    const menu = document.createElement("div");
    menu.className = "dr-pick-menu";
    menu.textContent = "Add observation at this point…";
    const items = [
      { label: " Bearing to here", mode: "bearing" },
      { label: " Distance CPL at here", mode: "vertical" },
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
            detail: { lat: latlng.lat, lng: latlng.lng, mode: it.mode },
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
    this.renderLops(snap.lops ?? [], vm);
    this.renderCpls(snap.cpls ?? [], vm);
    this.renderSnaps(snap.corrections ?? [], vm);
    this.renderCandidate(snap.candidate);

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
    L.circleMarker([candidate.latitude, candidate.longitude], {
      radius: 8,
      color: "#ffcc00",
      fill: false,
      weight: 2,
      dashArray: "3 3",
    })
      .bindTooltip(
        `candidate${candidate.residual_nm != null ? ` (residual ${candidate.residual_nm.toFixed(2)} nm)` : ""} — confirm?`,
        { direction: "top" },
      )
      .addTo(this.layers.candidate);
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
        .addTo(this.layers.fixes);
    }
  }

  /**
   * @param {Array<object>} lops
   * @param {object} vm
   * @returns {void}
   */
  renderLops(lops, vm) {
    this.layers.lops.clearLayers();
    for (const lop of lops) {
      const spec = vm.lopLineSpec(lop);
      const line = vm.extendLineSpec(spec, 60);
      L.polyline(line, {
        color: spec.used ? vm.STYLE.lopUsed : vm.STYLE.lop,
        weight: 1.5,
        opacity: 0.9,
      })
        .bindTooltip(
          `${lop.body_or_object ?? lop.lop_type} LOP${spec.used ? " (used)" : ""}`,
          { direction: "top" },
        )
        .addTo(this.layers.lops);
    }
  }

  /**
   * @param {Array<object>} cpls
   * @param {object} vm
   * @returns {void}
   */
  renderCpls(cpls, vm) {
    this.layers.cpls.clearLayers();
    for (const cpl of cpls) {
      const spec = vm.cplCircleSpec(cpl);
      L.circle(spec.center, {
        radius: spec.radiusNm * 1852,
        color: spec.used ? vm.STYLE.cplUsed : vm.STYLE.cpl,
        fillOpacity: 0.05,
        weight: 1.5,
        dashArray: "6 4",
      })
        .bindTooltip(
          `${cpl.source_object ?? "CPL"} r=${spec.radiusNm.toFixed(1)} nm${spec.used ? " (used)" : ""}`,
        )
        .addTo(this.layers.cpls);
    }
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
    ctx.strokeStyle = "#64b5f6";
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
