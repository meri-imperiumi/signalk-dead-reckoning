/**
 * Map-overlay machinery for the DR webapp's plotter-extension host
 * (work doc #27, chart-layer phase): background runtimes, the
 * `overlay.request` → `overlay.frame` cycle, compositing, the
 * plugin-layers dialog, and the `map`/`units` host methods.
 *
 * Everything here is a method of `PlotterExtHost`, assigned onto its
 * prototype by dr-ext-host.js (`Object.assign(PlotterExtHost.prototype,
 * OVERLAY_METHODS)`) — `this` is the host instance. The pure geometry
 * and frame-gate logic lives in `dr-ext-host-core.js`; this module is
 * the DOM/Leaflet/bus glue.
 *
 * Compositing model: the host keeps one canvas per map, inside a
 * Leaflet pane above the charts (tiles + vector layers render in the
 * tile pane, zIndex 200) and below the chartwork and vessel panes
 * (400+). Each accepted frame carries the mercator extent it covers,
 * so frames stay georeferenced even when the view has moved on since
 * they were requested; the canvas is redrawn on every map `move`,
 * which keeps the layer glued to the world while panning.
 *
 * @file dr-ext-host-overlays.js
 */

import * as core from "./dr-ext-host-core.js";
import { RPC_ERRORS, RpcError } from "./vendor/plotterext-bus/host.js";

/** Baseline sandbox for every extension iframe (fault containment,
 * not an adversarial boundary — install time is the trust decision).
 * Defined in core so the widget and background contexts agree. */
const IFRAME_SANDBOX = core.IFRAME_SANDBOX;

/** Least interval between two live (unrequested) overlay frames the
 * host accepts, in ms — sent as `overlay.request.liveInterval`. */
const LIVE_INTERVAL_MS = 200;
/** Retry cadence for an `overlay.request` the runtime had not yet
 * subscribed to receive (background iframe still booting). */
const REQUEST_RETRY_MS = 250;

/** Material Icons ligature names → 24px filled path data (Apache-2.0,
 * google/material-design-icons — license-compatible with EUPL-1.2).
 * Manifest `icon` fields carry these ligature names; Freeboard renders
 * them with its bundled icon font, and the webapp — which ships no
 * icon font — draws the same glyphs as inline SVG so extension buttons
 * get real icons offline. Unknown names fall back to the title. */
const ICON_PATHS = {
  explore:
    "M12 10.9c-.61 0-1.1.49-1.1 1.1s.49 1.1 1.1 1.1c.61 0 1.1-.49 1.1-1.1s-.49-1.1-1.1-1.1zM12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm2.19 12.19L6 18l3.81-8.19L18 6l-3.81 8.19z",
  swap_horizontal_circle:
    "M22 12c0-5.52-4.48-10-10-10S2 6.48 2 12s4.48 10 10 10 10-4.48 10-10zm-7-5.5l3.5 3.5-3.5 3.5V11h-4V9h4V6.5zm-6 11L5.5 14 9 10.5V13h4v2H9v2.5z",
  gps_off:
    "M20.94 11c-.46-4.17-3.77-7.48-7.94-7.94V1h-2v2.06c-1.13.12-2.19.46-3.16.97l1.5 1.5C10.16 5.19 11.06 5 12 5c3.87 0 7 3.13 7 7 0 .94-.19 1.84-.52 2.65l1.5 1.5c.5-.96.84-2.02.97-3.15H23v-2h-2.06zM3 4.27l2.04 2.04C3.97 7.62 3.25 9.23 3.06 11H1v2h2.06c.46 4.17 3.77 7.48 7.94 7.94V23h2v-2.06c1.77-.2 3.38-.91 4.69-1.98L19.73 21 21 19.73 4.27 3 3 4.27zm13.27 13.27C15.09 18.45 13.61 19 12 19c-3.87 0-7-3.13-7-7 0-1.61.55-3.09 1.46-4.27l9.81 9.81z",
  where_to_vote:
    "M12 2c3.86 0 7 3.14 7 7 0 5.25-7 13-7 13S5 14.25 5 9c0-3.86 3.14-7 7-7zm-1.53 12L17 7.41 15.6 6l-5.13 5.18L8.4 9.09 7 10.5l3.47 3.5z",
  fact_check:
    "M20,3H4C2.9,3,2,3.9,2,5v14c0,1.1,0.9,2,2,2h16c1.1,0,2-0.9,2-2V5 C22,3.9,21.1,3,20,3z M10,17H5v-2h5V17z M10,13H5v-2h5V13z M10,9H5V7h5V9z M14.82,15L12,12.16l1.41-1.41l1.41,1.42L17.99,9 l1.42,1.42L14.82,15z",
};

/**
 * Builds the inline-SVG icon for a manifest button's `icon` ligature
 * name, or null when the name is missing/unknown (the caller falls
 * back to text).
 *
 * @param {string|undefined} name - Material Icons ligature name
 * @returns {SVGElement|null}
 */
function buttonIcon(name) {
  const d = ICON_PATHS[name ?? ""];
  if (!d) return null;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "20");
  svg.setAttribute("height", "20");
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  svg.appendChild(path);
  return svg;
}

/**
 * @param {string} message
 * @returns {RpcError}
 */
function badParams(message) {
  return new RpcError(message, {
    code: RPC_ERRORS.INVALID_PARAMS,
    reason: "INVALID_PARAMS",
  });
}

export const OVERLAY_METHODS = {
  // ---- map view ---------------------------------------------------------

  /**
   * The current viewport in the shape the core math wants, or null
   * when no chart exists yet (the overlay machinery no-ops).
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @returns {{centerLng: number, centerLat: number, zoom: number,
   *   width: number, height: number}|null}
   */
  currentView() {
    const map = this.getMap?.();
    if (!map) return null;
    const size = map.getSize();
    if (size.x < 1 || size.y < 1) return null;
    const c = map.getCenter();
    return {
      centerLng: c.lng,
      centerLat: c.lat,
      zoom: map.getZoom(),
      width: size.x,
      height: size.y,
    };
  },

  /**
   * The current viewport as a lon/lat box, in the API's form:
   * longitudes in [-180, 180], west > east across the antimeridian.
   * Leaflet keeps unwrapped longitudes after panning past the
   * dateline; they normalize into the crossing form.
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @returns {[number, number, number, number]|null}
   */
  currentBounds() {
    const map = this.getMap?.();
    if (!map) return null;
    const b = map.getBounds();
    let west = core.normalizeLng(b.getWest());
    let east = core.normalizeLng(b.getEast());
    if (east <= west) {
      const span = b.getEast() - b.getWest();
      if (span >= 360) {
        west = -180;
        east = 180;
      } else {
        // Crossing form: west keeps its normalized value, east rides
        // past it (east > west unwrapped, east - 360 < west normalized).
        east = west + span;
        if (east > 180) east -= 360;
      }
    }
    return [west, b.getSouth(), east, b.getNorth()];
  },

  /**
   * The map view changed (settled): sync the composite canvas and
   * re-request frames for every visible overlay. dr-app calls this on
   * the map's `dr-view-changed`; Leaflet events call it internally.
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @returns {void}
   */
  viewChanged() {
    this.hookMap();
    this.syncCanvasSize();
    this.requestOverlays();
    this.drawOverlays();
  },

  /**
   * Subscribes the host to the map's view events (once). `move` fires
   * continuously during a drag: each redraw re-grounds the composite
   * canvas to the world, so panning keeps the layer glued in place;
   * frames are re-requested only on the settled events.
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @returns {void}
   */
  hookMap() {
    if (this.mapHooked) return;
    const map = this.getMap?.();
    if (!map) return;
    this.mapHooked = true;
    map.on("move", () => this.drawOverlays());
    map.on("moveend zoomend viewreset resize", () => this.viewChanged());
    // Animated zooms transform each layer individually, not the map
    // pane — a stale composite would visibly disagree with the world
    // for the animation's span, so hide it until the zoom settles.
    map.on("zoomanim", () => {
      if (this.overlayCanvas) this.overlayCanvas.style.opacity = "0";
    });
    map.on("zoomend viewreset", () => {
      if (this.overlayCanvas) this.overlayCanvas.style.opacity = "1";
    });
  },

  /**
   * Creates the composite canvas in its own pane above the charts and
   * below the chartwork/vessel panes. Never interactive.
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @returns {void}
   */
  ensureOverlayCanvas() {
    if (this.overlayCanvas) return;
    const map = this.getMap?.();
    if (!map) return;
    const pane = map.createPane("dr-ext-overlays");
    pane.style.zIndex = "350";
    pane.style.pointerEvents = "none";
    const canvas = document.createElement("canvas");
    canvas.style.position = "absolute";
    canvas.style.left = "0";
    canvas.style.top = "0";
    canvas.style.pointerEvents = "none";
    pane.appendChild(canvas);
    this.overlayCanvas = canvas;
    this.syncCanvasSize();
  },

  /**
   * Sizes the composite canvas to the viewport.
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @returns {void}
   */
  syncCanvasSize() {
    if (!this.overlayCanvas) return;
    const map = this.getMap?.();
    if (!map) return;
    const size = map.getSize();
    if (
      this.overlayCanvas.width !== size.x ||
      this.overlayCanvas.height !== size.y
    ) {
      this.overlayCanvas.width = size.x;
      this.overlayCanvas.height = size.y;
    }
  },

  // ---- overlay state ------------------------------------------------------

  /**
   * Effective user-facing state of an overlay (manifest defaults
   * merged with persisted overrides; this host never suspends yet).
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @param {string} extId
   * @param {object} spec - core.overlaySpec() output
   * @returns {{visible: boolean, opacity: number, suspended: boolean}}
   */
  overlayState(extId, spec) {
    const eff = this.overlayStore.effective(spec, extId);
    return { ...eff, suspended: false };
  },

  /**
   * Broadcasts an overlay's state to the extension's contexts.
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @param {string} extId
   * @param {string} overlayId
   * @param {{visible: boolean, opacity: number, suspended: boolean}} state
   * @returns {void}
   */
  publishOverlayState(extId, overlayId, state) {
    this.publishToExtension(extId, "overlay.state", { overlayId, ...state });
  },

  /**
   * Reconciles one extension's overlay hosting with its (fresh)
   * filtered bundle: spec table, background runtimes, stale gates and
   * frames. Idempotent per poll tick.
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @param {string} extId
   * @param {object} ext - compatibleExtensions() bundle
   * @returns {void}
   */
  syncOverlays(extId, ext) {
    const specs = new Map();
    for (const entry of ext.overlays) {
      specs.set(entry.id, core.overlaySpec(entry));
    }
    const prev = this.overlaySpecs.get(extId);
    this.overlaySpecs.set(extId, specs);

    // Stale gates/frames for overlays the manifest no longer declares.
    if (prev) {
      for (const id of prev.keys()) {
        if (specs.has(id)) continue;
        const key = `${extId}/${id}`;
        this.closeFrame(key);
        this.overlayGates.delete(key);
        this.clearRetry(key);
      }
    }

    // Teardown runtimes whose entry vanished or changed URL (before
    // re-creating, so a URL change restarts the runtime in one tick).
    for (const [key, ctx] of [...this.bgCtxs]) {
      if (!key.startsWith(`${extId}/`)) continue;
      const bgId = key.slice(extId.length + 1);
      const bg = ext.background.find((b) => b.id === bgId);
      if (!bg || bg.url !== ctx.manifestEntry.url) {
        this.teardownBackgroundCtx(key);
      }
    }
    for (const bg of ext.background) {
      this.ensureBackgroundCtx(extId, bg);
    }
    // Tell a (re)started runtime where its layers stand.
    for (const [id, spec] of specs) {
      this.publishOverlayState(extId, id, this.overlayState(extId, spec));
    }
  },

  /**
   * Tears down every overlay affordance of an extension that left the
   * collection: background runtimes, gates, frames, persisted state.
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @param {string} extId
   * @returns {void}
   */
  teardownOverlays(extId) {
    const prefix = `${extId}/`;
    for (const key of [...this.bgCtxs.keys()]) {
      if (key.startsWith(prefix)) this.teardownBackgroundCtx(key);
    }
    for (const key of [...this.overlayGates.keys()]) {
      if (key.startsWith(prefix)) {
        this.closeFrame(key);
        this.overlayGates.delete(key);
      }
    }
    for (const key of [...this.overlayRetries.keys()]) {
      if (key.startsWith(prefix)) this.clearRetry(key);
    }
    this.overlaySpecs.delete(extId);
    this.overlayStore.dropExtension(extId);
    this.drawOverlays();
  },

  // ---- background runtimes -----------------------------------------------

  /**
   * Creates (or returns) a headless background context: a hidden
   * sandboxed iframe running the extension's runtime page.
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @param {string} extId
   * @param {object} entry - manifest background entry
   * @returns {object} the context
   */
  ensureBackgroundCtx(extId, entry) {
    const key = `${extId}/${entry.id}`;
    let ctx = this.bgCtxs.get(key);
    if (ctx) return ctx;
    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", IFRAME_SANDBOX);
    iframe.setAttribute("title", entry.id);
    iframe.src = new URL(entry.url, this.origin).href;
    // Headless: parked at 1×1 with opacity 0 rather than display:none,
    // so the runtime's timers and workers are not throttled to a stop.
    iframe.style.position = "absolute";
    iframe.style.width = "1px";
    iframe.style.height = "1px";
    iframe.style.opacity = "0";
    iframe.style.pointerEvents = "none";
    iframe.style.border = "0";
    this.mount.appendChild(iframe);
    ctx = {
      kind: "background",
      extId,
      id: entry.id,
      instanceId: null,
      targetInstance: null,
      targetWidget: null,
      manifestEntry: entry,
      iframe,
      dialog: null,
      conn: null,
    };
    this.bgCtxs.set(key, ctx);
    this.allCtxs.add(ctx);
    this.connectCtx(ctx);
    return ctx;
  },

  /**
   * Tears a background context down.
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @param {string} key - "extId/bgId"
   * @returns {void}
   */
  teardownBackgroundCtx(key) {
    const ctx = this.bgCtxs.get(key);
    if (!ctx) return;
    this.releaseCtx(ctx);
    this.bgCtxs.delete(key);
    ctx.iframe?.remove();
  },

  /**
   * The background context an overlay renders in — the manifest names
   * it via the overlay's `runtime`; a missing field falls back to the
   * extension's sole background entry.
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @param {string} extId
   * @param {object} spec - overlaySpec() output
   * @returns {object|null} the context, or null when unresolvable
   */
  runtimeFor(extId, spec) {
    const prefix = `${extId}/`;
    let sole = null;
    let count = 0;
    for (const [key, ctx] of this.bgCtxs) {
      if (!key.startsWith(prefix)) continue;
      if (spec.runtime != null) {
        if (spec.runtime === ctx.id) return ctx;
      } else {
        sole = ctx;
        count++;
      }
    }
    return spec.runtime == null && count === 1 ? sole : null;
  },

  // ---- frame requests -----------------------------------------------------

  /**
   * Sends `overlay.request` to every visible overlay's runtime.
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @returns {void}
   */
  requestOverlays() {
    const view = this.currentView();
    if (!view) return;
    for (const [extId, specs] of this.overlaySpecs) {
      for (const spec of specs.values()) {
        const state = this.overlayState(extId, spec);
        if (!state.visible) continue;
        if (view.zoom < spec.minZoom) continue;
        this.requestOverlay(extId, spec, view);
      }
    }
  },

  /**
   * Requests one frame for one overlay. The request is delivered when
   * the runtime has subscribed to `overlay.request` — a background
   * iframe still booting gets a retry until it lands.
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @param {string} extId
   * @param {object} spec - overlaySpec() output
   * @param {object} view - currentView() output
   * @returns {void}
   */
  requestOverlay(extId, spec, view) {
    const ctx = this.runtimeFor(extId, spec);
    if (!ctx?.conn) return;
    const key = `${extId}/${spec.id}`;
    const gate = this.gateFor(key);
    const req = core.buildFrameRequest(view, {
      overlayId: spec.id,
      requestId: `r${++this.overlaySeq}`,
      pixelRatio: this.pixelRatioFor(spec),
      liveInterval: LIVE_INTERVAL_MS,
    });
    gate.lastRequestId = req.requestId;
    const delivered = ctx.conn.publish("overlay.request", req);
    if (delivered) {
      this.clearRetry(key);
    } else {
      this.scheduleRetry(key, extId, spec, view);
    }
  },

  /**
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @param {string} key
   * @returns {object} the overlay's frame gate (created on demand)
   */
  gateFor(key) {
    let gate = this.overlayGates.get(key);
    if (!gate) {
      gate = {
        lastRequestId: null,
        lastLiveAt: 0,
        liveInterval: LIVE_INTERVAL_MS,
      };
      this.overlayGates.set(key, gate);
    }
    return gate;
  },

  /**
   * Image pixels per CSS pixel for a request: the display's density,
   * clamped to what the overlay asked for.
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @param {object} spec - overlaySpec() output
   * @returns {number}
   */
  pixelRatioFor(spec) {
    const dpr = globalThis.devicePixelRatio || 1;
    return spec.preferredPixelRatio != null
      ? Math.min(dpr, spec.preferredPixelRatio)
      : dpr;
  },

  /**
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @param {string} key
   * @param {string} extId
   * @param {object} spec
   * @param {object} view
   * @returns {void}
   */
  scheduleRetry(key, extId, spec, view) {
    if (this.overlayRetries.has(key)) return;
    const timer = setTimeout(() => {
      this.overlayRetries.delete(key);
      if (!this.overlaySpecs.get(extId)?.has(spec.id)) return;
      this.requestOverlay(extId, spec, view);
    }, REQUEST_RETRY_MS);
    this.overlayRetries.set(key, timer);
  },

  /**
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @param {string} key
   * @returns {void}
   */
  clearRetry(key) {
    const timer = this.overlayRetries.get(key);
    if (timer != null) {
      clearTimeout(timer);
      this.overlayRetries.delete(key);
    }
  },

  // ---- frame handling -----------------------------------------------------

  /**
   * Host side of `overlay.frame`: gate the frame, then either keep it
   * (the host takes ownership of the bitmap) or refuse and close it.
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @param {object} ctx - the sending context
   * @param {object} params - OverlayFrameParams
   * @returns {{accepted: boolean, reason?: string}}
   */
  acceptOverlayFrame(ctx, params) {
    const spec = this.overlaySpecs.get(ctx.extId)?.get(params?.overlayId);
    if (!spec) {
      this.closeImage(params?.image);
      throw badParams(`unknown overlay: ${params?.overlayId}`);
    }
    if (
      !Array.isArray(params.extent) ||
      params.extent.length !== 4 ||
      params.extent.some((n) => typeof n !== "number" || !Number.isFinite(n))
    ) {
      this.closeImage(params.image);
      throw badParams("overlay.frame requires extent [minX, minY, maxX, maxY]");
    }
    const image = params.image;
    if (
      !image ||
      typeof image.width !== "number" ||
      typeof image.height !== "number"
    ) {
      throw badParams("overlay.frame requires an image");
    }
    const key = `${ctx.extId}/${params.overlayId}`;
    const gate = this.gateFor(key);
    const verdict = core.acceptFrame(gate, params, Date.now());
    if (!verdict.accepted) {
      this.closeImage(image);
      return { accepted: false, reason: verdict.reason };
    }
    this.closeFrame(key);
    this.overlayFrames.set(key, { image, extent: [...params.extent] });
    this.drawOverlays();
    return { accepted: true };
  },

  /**
   * Drops (and closes) an overlay's latest frame.
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @param {string} key
   * @returns {void}
   */
  closeFrame(key) {
    const frame = this.overlayFrames.get(key);
    if (!frame) return;
    this.overlayFrames.delete(key);
    this.closeImage(frame.image);
  },

  /**
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @param {ImageBitmap|null|undefined} image
   * @returns {void}
   */
  closeImage(image) {
    try {
      image?.close?.();
    } catch {
      // A bitmap closes once; a second close is harmless but guarded.
    }
  },

  /**
   * Repaints the composite canvas: every visible overlay's latest
   * frame, aboveCharts before aboveResources, manifest order within a
   * band, each at its own opacity. Frames carry their own extent, so
   * a view that has moved on since the request still places them
   * correctly; world copies on either side are covered too (the chart
   * wraps).
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @returns {void}
   */
  drawOverlays() {
    const canvas = this.overlayCanvas;
    const view = this.currentView();
    const map = this.getMap?.();
    if (!canvas || !view || !map) return;
    const g = canvas.getContext("2d");
    g.clearRect(0, 0, canvas.width, canvas.height);
    const origin = map.containerPointToLayerPoint([0, 0]);
    const worldPx =
      core.WEB_MERCATOR_SIZE / core.metersPerPixel(view.centerLat, view.zoom);
    for (const band of core.OVERLAY_BANDS) {
      for (const [extId, specs] of this.overlaySpecs) {
        for (const [id, spec] of specs) {
          if (spec.band !== band) continue;
          const state = this.overlayState(extId, spec);
          if (!state.visible) continue;
          if (view.zoom < spec.minZoom) continue;
          const frame = this.overlayFrames.get(`${extId}/${id}`);
          if (!frame) continue;
          const p = core.framePlacement(frame, view);
          for (let k = -1; k <= 1; k++) {
            const x = p.x + k * worldPx;
            if (x > view.width || x + p.width < 0) continue;
            g.globalAlpha = state.opacity;
            g.drawImage(
              frame.image,
              x + origin.x,
              p.y + origin.y,
              p.width,
              p.height,
            );
          }
        }
      }
    }
    g.globalAlpha = 1;
  },

  // ---- overlay host API ---------------------------------------------------

  /**
   * `overlay.list` for one extension: its overlays with effective
   * state.
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @param {string} extId
   * @returns {{overlays: object[]}}
   */
  listOverlays(extId) {
    const specs = this.overlaySpecs.get(extId);
    const overlays = [];
    for (const [id, spec] of specs ?? []) {
      const { visible, opacity, suspended } = this.overlayState(extId, spec);
      overlays.push({
        id,
        title: spec.title,
        type: "image",
        band: spec.band,
        visible,
        opacity,
        suspended,
      });
    }
    return { overlays };
  },

  /**
   * Shared body of `overlay.setVisibility` / `overlay.setOpacity`:
   * persists the override, repaints, and broadcasts state.
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @param {string} extId
   * @param {object} params - `{ids: string[], visible?|opacity?}`
   * @param {"visible"|"opacity"} field
   * @returns {{}}
   */
  setOverlaysState(extId, params, field) {
    const ids = params?.ids;
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      !ids.every((id) => typeof id === "string" && id !== "")
    ) {
      throw badParams(
        `overlay.${field === "visible" ? "setVisibility" : "setOpacity"} requires ids`,
      );
    }
    const specs = this.overlaySpecs.get(extId);
    if (!specs || specs.size === 0) {
      throw badParams(`extension ${extId} has no overlays`);
    }
    for (const id of ids) {
      const spec = specs.get(id);
      if (!spec) continue;
      const patch = {};
      if (field === "visible") {
        if (typeof params.visible !== "boolean") {
          throw badParams("overlay.setVisibility requires visible");
        }
        patch.visible = params.visible;
      } else {
        const op = params.opacity;
        if (typeof op !== "number" || !(op >= 0 && op <= 1)) {
          throw badParams("overlay.setOpacity requires opacity 0..1");
        }
        patch.opacity = op;
      }
      this.overlayStore.set(extId, id, patch);
      const state = this.overlayState(extId, spec);
      this.publishOverlayState(extId, id, state);
      if (field === "visible" && state.visible) this.viewChanged();
    }
    this.drawOverlays();
    if (this.layersDialog?.open) this.renderLayersDialog();
    return {};
  },

  /**
   * `events.publish`: validates with the bus's shared parser, then
   * delivers to the subscribed contexts — every context for the
   * default `all` scope, the publishing extension's contexts only for
   * `extension`.
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @param {object} ctx - the publishing context
   * @param {{topic: string, params?: unknown, scope?: string}} p
   * @returns {void}
   */
  publishEvent(ctx, p) {
    for (const other of [...this.allCtxs]) {
      if (p.scope === "extension" && other.extId !== ctx.extId) continue;
      other.conn?.publish(p.topic, p.params);
    }
  },

  /**
   * Opens the layer settings panel an overlay declared
   * (`configPanel`).
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @param {string} extId
   * @param {string} overlayId
   * @returns {void}
   */
  openOverlayConfig(extId, overlayId) {
    const ext = this.compatible.get(extId);
    const spec = this.overlaySpecs.get(extId)?.get(overlayId);
    if (!ext || !spec?.configPanel) return;
    const panel = ext.panels.find((pn) => pn.id === spec.configPanel);
    if (!panel) return;
    this.closeConfigDialog();
    const ctx = this.ensurePanelCtx(extId, panel, null);
    ctx.dialog.showModal();
    this.openConfig = { ctx, dialog: ctx.dialog, instanceId: null };
  },

  // ---- map chrome: layers dialog and toolbar buttons ----------------------

  /**
   * The map control stack: one square button per extension
   * `mapToolbar` button, plus the plugin-layers toggle when any
   * overlay is hosted. Styled after the re-center control so the
   * stack reads as one piece of hardware.
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @returns {void}
   */
  ensureMapChrome() {
    if (this.mapControl) return;
    const L = globalThis.L;
    const map = this.getMap?.();
    if (!L || !map) return;
    // The control lives inside the map element's shadow root; the
    // app's styles don't reach it, so bring the button language here.
    const root = map.getContainer().getRootNode();
    if (root && !root.getElementById?.("dr-ext-mapctl-style")) {
      const style = document.createElement("style");
      style.id = "dr-ext-mapctl-style";
      style.textContent = `
        .dr-ext-mapctl {
          display: flex;
          flex-direction: column;
          border: 1px solid rgba(255, 255, 255, 0.2);
          background-color: rgba(17, 20, 20, 0.8);
        }
        .dr-ext-mapctl button {
          width: 34px;
          height: 34px;
          padding: 0;
          font-size: 1rem;
          line-height: 1;
          background: transparent;
          border: 0;
          border-bottom: 1px solid rgba(255, 255, 255, 0.2);
          color: var(--color-teal, #4b8b99);
        }
        .dr-ext-mapctl button:last-child { border-bottom: 0; }
        .dr-ext-mapctl button:hover {
          background-color: var(--color-teal, #4b8b99);
          color: var(--bg-base, #080a0c);
        }
        /* Text fallback for buttons without a known icon: keep the
           initial inside the 34 px square. */
        .dr-ext-mapctl button.dr-ext-btn-fallback {
          overflow: hidden;
          font-size: 0.85rem;
          font-weight: 600;
        }
      `;
      (root.appendChild ? root : document.head).appendChild(style);
    }
    const div = document.createElement("div");
    div.className = "dr-ext-mapctl leaflet-bar";
    L.DomEvent.disableClickPropagation(div);
    const Control = L.Control.extend({
      onAdd: () => div,
    });
    this.mapControl = new Control({ position: "bottomleft" }).addTo(map);
    this.mapControlDiv = div;
  },

  /**
   * Rebuilds the map control's buttons from the fresh collection.
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @returns {void}
   */
  renderButtons() {
    let anyOverlay = false;
    for (const specs of this.overlaySpecs.values()) {
      if (specs.size > 0) {
        anyOverlay = true;
        break;
      }
    }
    // The webapp is served by the DR plugin, whose own extension's
    // mapToolbar buttons duplicate the webapp's native toolbar — never
    // render them (SELF_EXTENSION_ID). hostButtons also drops
    // `visible: false` entries, whose rendering the host cannot drive.
    const buttons = core.hostButtons(this.compatible, [core.SELF_EXTENSION_ID]);
    if (!anyOverlay && buttons.length === 0) {
      if (this.mapControl) {
        this.mapControl.remove();
        this.mapControl = null;
        this.mapControlDiv = null;
      }
      return;
    }
    this.ensureMapChrome();
    const div = this.mapControlDiv;
    if (!div) return;
    div.replaceChildren();
    if (anyOverlay) {
      const layersBtn = document.createElement("button");
      layersBtn.type = "button";
      layersBtn.textContent = "▤";
      layersBtn.title = "Plugin layers";
      layersBtn.setAttribute("aria-label", "Plugin layers");
      layersBtn.addEventListener("click", () => this.openLayersDialog());
      div.appendChild(layersBtn);
    }
    for (const { extId, button } of buttons) {
      const btn = document.createElement("button");
      btn.type = "button";
      const icon = buttonIcon(button.icon);
      if (icon) {
        btn.appendChild(icon);
      } else {
        // No icon or an unknown (non-Material ligature) name: the
        // title's initial reads better than a clipped ligature word in
        // a 34 px button.
        btn.textContent = (button.title ?? button.id ?? "·").charAt(0);
        btn.classList.add("dr-ext-btn-fallback");
      }
      btn.title = button.title ?? button.id;
      btn.setAttribute("aria-label", button.title ?? button.id);
      btn.addEventListener("click", () => this.runButtonAction(extId, button));
      div.appendChild(btn);
    }
  },

  /**
   * Runs a manifest button action. Supported: `togglePanel` (opens or
   * closes the named panel of the button's extension), `openWindow` /
   * `toggleWindow` (floating windows; see dr-ext-host-windows.js).
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @param {string} extId
   * @param {object} button
   * @returns {void}
   */
  runButtonAction(extId, button) {
    const action = button?.action;
    if (action?.type === "togglePanel") {
      const ext = this.compatible.get(extId);
      const panel = ext?.panels.find((pn) => pn.id === action.panel);
      if (!panel) return;
      const ctx = this.panelCtxs.get(`${extId}/${panel.id}`);
      if (ctx && this.openConfig?.ctx === ctx) {
        this.closeConfigDialog();
        return;
      }
      this.closeConfigDialog();
      const opened = this.ensurePanelCtx(extId, panel, null);
      opened.dialog.showModal();
      this.openConfig = {
        ctx: opened,
        dialog: opened.dialog,
        instanceId: null,
      };
      return;
    }
    if (action?.type === "openWindow" || action?.type === "toggleWindow") {
      this.runWindowButton(extId, button, action);
    }
  },

  /**
   * The plugin-layers dialog: one row per hosted overlay — show/hide,
   * opacity, and its settings panel (the "Layer settings" affordance
   * the Chart list has on Freeboard-SK).
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @returns {void}
   */
  openLayersDialog() {
    if (this.layersDialog?.open) {
      this.renderLayersDialog();
      return;
    }
    this.closeLayersDialog();
    const dlg = document.createElement("dialog");
    dlg.className = "ext-picker";
    const title = document.createElement("h2");
    title.textContent = "Plugin layers";
    dlg.appendChild(title);
    const body = document.createElement("div");
    body.className = "dr-ext-layers-body";
    dlg.appendChild(body);
    const close = document.createElement("button");
    close.textContent = "✕ Close";
    close.addEventListener("click", () => this.closeLayersDialog());
    dlg.appendChild(close);
    dlg.addEventListener("close", () => {
      dlg.remove();
      if (this.layersDialog === dlg) this.layersDialog = null;
    });
    this.mount.appendChild(dlg);
    dlg.showModal();
    this.layersDialog = dlg;
    this.renderLayersDialog();
  },

  /**
   * Rebuilds the plugin-layers dialog's rows.
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @returns {void}
   */
  renderLayersDialog() {
    const dlg = this.layersDialog;
    if (!dlg) return;
    const body = dlg.querySelector(".dr-ext-layers-body");
    if (!body) return;
    body.replaceChildren();
    let any = false;
    for (const [extId, specs] of this.overlaySpecs) {
      const ext = this.compatible.get(extId);
      if (!ext) continue;
      for (const [id, spec] of specs) {
        any = true;
        body.appendChild(this.layerRow(extId, id, spec));
      }
    }
    if (!any) {
      const p = document.createElement("p");
      p.textContent = this.discovered
        ? "No plugin layers available on this server."
        : "Plotter extensions could not be loaded (server unreachable).";
      body.appendChild(p);
    }
  },

  /**
   * One dialog row for one overlay.
   *
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @param {string} extId
   * @param {string} id
   * @param {object} spec
   * @returns {Element}
   */
  layerRow(extId, id, spec) {
    const state = this.overlayState(extId, spec);
    const row = document.createElement("div");
    row.className = "ext-manage-row dr-ext-layer-row";
    const label = document.createElement("span");
    label.textContent = spec.title;
    const show = document.createElement("button");
    show.textContent = state.visible ? "Hide" : "Show";
    show.addEventListener("click", () => {
      this.setOverlaysState(
        extId,
        { ids: [id], visible: !state.visible },
        "visible",
      );
    });
    row.append(label, show);
    if (spec.configPanel) {
      const cfg = document.createElement("button");
      cfg.textContent = "Settings";
      cfg.addEventListener("click", () => this.openOverlayConfig(extId, id));
      row.appendChild(cfg);
    }
    const opacity = document.createElement("input");
    opacity.type = "range";
    opacity.min = "0";
    opacity.max = "100";
    opacity.value = String(Math.round(state.opacity * 100));
    opacity.setAttribute("aria-label", `${spec.title} opacity`);
    opacity.addEventListener("input", () => {
      this.setOverlaysState(
        extId,
        { ids: [id], opacity: Number(opacity.value) / 100 },
        "opacity",
      );
    });
    row.appendChild(opacity);
    return row;
  },

  /**
   * @this {import("./dr-ext-host.js").PlotterExtHost}
   * @returns {void}
   */
  closeLayersDialog() {
    this.layersDialog?.close();
  },
};
