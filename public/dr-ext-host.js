/**
 * Plotter-extension **host** for the DR webapp (work doc #27): the
 * webapp is itself a chartplotter, so beside *providing* an extension
 * it also *hosts* them — discovering `plotterExtensions` manifests
 * served by any enabled server plugin and offering their widgets in
 * small grids anchored below the webapp's own floating panels.
 *
 * v1 surface (Plotter Extensions API v1): capabilities `widgets`,
 * `panels.iframe` (configuration panels), `signalk.stream`,
 * `signalk.put`. Widget cells reuse the webapp's visual language
 * (translucent panel + corner brackets from dr-theme.js) so hosted
 * widgets sit in the same frame as `.dr-tools`/`.dr-gps`; the
 * extension's own content stays inside its iframe and is
 * extension-owned.
 *
 * The wire protocol is `vendor/plotterext-bus` (host entry):
 * JSON-RPC 2.0 in a `plotterExt/1` envelope over postMessage, origin
 * pinned to this page. Pure logic lives in `dr-ext-host-core.js`.
 *
 * Iframes are never re-parented — moving an iframe in the DOM reloads
 * it, killing `keepAlive` state. Widget iframes live in their grid
 * cell for the placement's whole life; panel iframes live inside a
 * persistent `<dialog>` whose `close()` hides without destroying.
 *
 * @file dr-ext-host.js
 */

import * as core from "./dr-ext-host-core.js";
import { THEME_CSS } from "./dr-theme.js";
import {
  HostConnection,
  RPC_ERRORS,
  RpcError,
  windowPort,
} from "./vendor/plotterext-bus/host.js";

/** Display metadata for the handshake. The host *API* version is the
 * contract (core.API_VERSION); this is just who we are. */
export const HOST_NAME = "signalk-dead-reckoning";
export const HOST_VERSION = "0.1.0";

/** How often the manifest collection is re-fetched: presence in the
 * collection is the enablement signal, so a disabled plugin must be
 * noticed without a reload (contexts torn down, layout pruned). */
const DISCOVERY_POLL_MS = 60000;

/** Cell edge for the widget grid; a 2×2 widget is three gaps larger. */
const CELL_CSS = "clamp(96px, 13vw, 160px)";

/** Baseline sandbox for every extension iframe: fault containment,
 * not an adversarial boundary (install time is the trust decision). */
const IFRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms";

/**
 * A live extension context: one sandboxed iframe plus its bus
 * connection and the identity the handshake reports.
 *
 * @typedef {object} ExtContext
 * @property {"widget"|"panel"} kind
 * @property {string} extId
 * @property {string} id - widget or panel manifest-local id
 * @property {string|null} instanceId - widget placement id (widgets)
 * @property {string|null} targetInstance - configured widget (config panels)
 * @property {string|null} targetWidget
 * @property {object|null} manifestEntry - the widget/panel manifest entry
 * @property {HTMLIFrameElement} iframe
 * @property {HTMLDialogElement|null} dialog - persistent chrome (panels)
 * @property {HostConnection|null} conn
 */

/**
 * The host manager: discovery, layout persistence, context lifecycle,
 * the host-side bus API, and the Signal K relay.
 */
export class PlotterExtHost {
  /**
   * @param {object} opts
   * @param {object} opts.stream - the DrSignalkStream singleton
   * @param {Node} opts.mount - where dialogs are appended (the dr-app
   *   shadow root, so the app's dialog/theme styles apply)
   * @param {Storage} [opts.storage]
   * @param {(url: string, init?: object) => Promise<Response>} [opts.fetchImpl]
   * @param {string} [opts.origin]
   */
  constructor(opts) {
    this.stream = opts.stream;
    this.mount = opts.mount;
    this.storage = opts.storage ?? globalThis.localStorage;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch?.bind(globalThis);
    this.origin = opts.origin ?? globalThis.location?.origin ?? "";
    this.stateStore = new core.StateStore(this.storage);
    this.pathReg = new core.PathRefRegistry();

    /** @type {Map<string, object>} compatible extId → filtered bundle */
    this.compatible = new Map();
    /** @type {Map<string, DrExtWidgetArea>} anchor → area element */
    this.areas = new Map();
    /** @type {Map<string, ExtContext>} instanceId → widget context */
    this.widgetCtxs = new Map();
    /** @type {Map<string, ExtContext>} panel key (ext/panelId) → ctx */
    this.panelCtxs = new Map();
    /** @type {Set<ExtContext>} every live context */
    this.allCtxs = new Set();
    /** @type {{ctx: ExtContext|null, dialog: HTMLDialogElement,
     *          instanceId: string}|null} */
    this.openConfig = null;
    /** @type {HTMLDialogElement|null} */
    this.pickerDialog = null;
    /** Discovery never succeeded yet? */
    this.discovered = false;
    this.pollTimer = null;

    this.layout = this.loadLayout();
  }

  /**
   * Loads (and validates) the persisted widget layout; missing/corrupt
   * storage yields an empty layout.
   *
   * @returns {{version: number, areas: Record<string, Array<object>>}}
   */
  loadLayout() {
    let raw = null;
    try {
      raw = JSON.parse(this.storage.getItem(core.layoutKey()) ?? "null");
    } catch {
      raw = null;
    }
    return core.layoutFromJSON(raw) ?? { version: 1, areas: {} };
  }

  /**
   * @returns {void}
   */
  saveLayout() {
    this.storage.setItem(core.layoutKey(), JSON.stringify(this.layout));
  }

  /**
   * Starts discovery (initial fetch + slow poll) and the stream relay.
   *
   * @returns {Promise<void>}
   */
  async start() {
    if (!this.stream || !this.fetchImpl) return;
    this.stream.on((delta) => this.onDelta(delta));
    await this.refresh();
    this.pollTimer = setInterval(() => {
      void this.refresh();
    }, DISCOVERY_POLL_MS);
  }

  /**
   * Stops polling (page teardown).
   *
   * @returns {void}
   */
  stop() {
    if (this.pollTimer != null) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  /**
   * Fetches the `plotterExtensions` collection; a transport/auth
   * failure keeps the previous state (a boat LAN blip must not tear
   * down working widgets).
   *
   * @returns {Promise<object|null>}
   */
  async discover() {
    try {
      const res = await this.fetchImpl(
        `${this.origin}/signalk/v2/api/resources/plotterExtensions`,
        { headers: { Accept: "application/json" } },
      );
      if (!res.ok) return null;
      const json = await res.json();
      return json && typeof json === "object" ? json : null;
    } catch {
      return null;
    }
  }

  /**
   * Re-runs discovery and reconciles: prune placements whose
   * extension/widget vanished, tear their contexts down, ensure
   * contexts for survivors, preload `whileEnabled` panels.
   *
   * @returns {Promise<void>}
   */
  async refresh() {
    const collection = await this.discover();
    if (collection == null) {
      if (!this.discovered) this.renderAllAreas();
      return; // transient failure — keep what works
    }
    this.discovered = true;
    this.compatible = core.compatibleExtensions(
      collection,
      core.HOST_CAPABILITIES,
    );

    const pruned = core.pruneLayout(this.layout, this.compatible);
    if (pruned.changed) {
      const survivors = new Set(
        core.AREA_ANCHORS.flatMap((a) =>
          pruned.layout.areas[a].map((p) => p.instanceId),
        ),
      );
      for (const instanceId of [...this.widgetCtxs.keys()]) {
        if (!survivors.has(instanceId)) this.teardownWidget(instanceId);
      }
      this.layout = pruned.layout;
      this.saveLayout();
    }

    // Ensure contexts for every surviving placement.
    for (const anchor of core.AREA_ANCHORS) {
      for (const p of this.layout.areas[anchor] ?? []) {
        const ext = this.compatible.get(p.extensionId);
        const widget = ext?.widgets.find((w) => w.id === p.widgetId);
        if (widget && !this.widgetCtxs.has(p.instanceId)) {
          this.ensureWidgetContext(p, widget);
        }
      }
    }

    // Panels: tear down contexts of vanished extensions (and close
    // their dialogs); preload `whileEnabled` panels — their iframes
    // load inside a closed <dialog>, which is still in the document.
    for (const ctx of [...this.panelCtxs.values()]) {
      if (!this.compatible.has(ctx.extId)) this.teardownPanelCtx(ctx);
    }
    for (const [extId, ext] of this.compatible) {
      for (const panel of ext.panels) {
        // Preload only when not live at all — a parked targeted config
        // panel must not restart (its iframe would reload) on a poll.
        if (
          panel.lifecycle === "whileEnabled" &&
          !this.panelCtxs.has(`${extId}/${panel.id}`)
        ) {
          this.ensurePanelCtx(extId, panel, null);
        }
      }
    }

    this.renderAllAreas();
  }

  /**
   * Registers a widget-area element (called by dr-app for the areas in
   * its template).
   *
   * @param {DrExtWidgetArea} el
   * @returns {void}
   */
  attachArea(el) {
    this.areas.set(el.anchor, el);
    el.manager = this;
    this.renderArea(el.anchor);
  }

  /**
   * @returns {void}
   */
  renderAllAreas() {
    for (const anchor of this.areas.keys()) this.renderArea(anchor);
  }

  /**
   * @param {string} anchor
   * @returns {void}
   */
  renderArea(anchor) {
    const el = this.areas.get(anchor);
    if (el) el.setModel(this.layout.areas[anchor] ?? []);
  }

  // ---- contexts ---------------------------------------------------------

  /**
   * Creates the iframe + bus context for a placed widget (idempotent;
   * the area element adopts the iframe into its cell).
   *
   * @param {object} placement - layout entry
   * @param {object} widget - manifest widget entry
   * @returns {ExtContext}
   */
  ensureWidgetContext(placement, widget) {
    let ctx = this.widgetCtxs.get(placement.instanceId);
    if (ctx) return ctx;
    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", IFRAME_SANDBOX);
    iframe.setAttribute("title", widget.title ?? widget.id);
    iframe.src = new URL(widget.url, this.origin).href;
    ctx = {
      kind: "widget",
      extId: placement.extensionId,
      id: widget.id,
      instanceId: placement.instanceId,
      targetInstance: null,
      targetWidget: null,
      manifestEntry: widget,
      iframe,
      dialog: null,
      conn: null,
    };
    this.widgetCtxs.set(placement.instanceId, ctx);
    this.allCtxs.add(ctx);
    this.connectCtx(ctx);
    return ctx;
  }

  /**
   * Wires the bus connection for a context. `bus.ready` repeats until
   * we answer, so attaching after the iframe's first paint is fine.
   *
   * @param {ExtContext} ctx
   * @returns {void}
   */
  connectCtx(ctx) {
    const conn = new HostConnection({
      port: windowPort(ctx.iframe.contentWindow, { origin: this.origin }),
      hostInfo: {
        host: HOST_NAME,
        hostVersion: HOST_VERSION,
        apiVersion: core.API_VERSION,
        capabilities: core.HOST_CAPABILITIES,
      },
      context: {
        kind: ctx.kind,
        id: ctx.id,
        instanceId: ctx.instanceId,
        targetInstance: ctx.targetInstance,
        targetWidget: ctx.targetWidget,
      },
      methods: this.makeMethods(ctx),
      onError: (err) => console.warn("[plotterext]", ctx.extId, err),
    });
    ctx.conn = conn;
  }

  /**
   * Drops a context's stream refs and bus connection (shared by
   * widget and panel teardown).
   *
   * @param {ExtContext} ctx
   * @returns {void}
   */
  releaseCtx(ctx) {
    const held = this.pathReg.dropContext(ctx);
    if (held.length > 0) this.stream?.unsubscribeShared(held);
    ctx.conn?.close();
    ctx.conn = null;
    this.allCtxs.delete(ctx);
  }

  /**
   * Tears a widget context down: close any dialog targeting it, drop
   * stream refs, close the bus, remove the iframe. The area's cell is
   * pruned on the next render.
   *
   * @param {string} instanceId
   * @returns {void}
   */
  teardownWidget(instanceId) {
    const ctx = this.widgetCtxs.get(instanceId);
    if (!ctx) return;
    // Config panels targeting this widget become meaningless.
    for (const pc of [...this.panelCtxs.values()]) {
      if (pc.targetInstance === instanceId) this.teardownPanelCtx(pc);
    }
    this.releaseCtx(ctx);
    this.widgetCtxs.delete(instanceId);
    ctx.iframe.remove();
  }

  /**
   * Creates (or returns) a panel context. The context owns a
   * persistent `<dialog>` — `close()` hides it without destroying the
   * iframe, which is what makes `keepAlive`/`whileEnabled` panels
   * survive close/reopen. A kept-alive config panel is pinned to one
   * widget target (its handshake must not lie), so re-targeting
   * restarts the context.
   *
   * @param {string} extId
   * @param {object} panel - manifest panel entry
   * @param {{instanceId: string, widgetId: string, title: string}|null} target
   * @returns {ExtContext}
   */
  ensurePanelCtx(extId, panel, target) {
    const key = `${extId}/${panel.id}`;
    let ctx = this.panelCtxs.get(key);
    const wantTarget = target?.instanceId ?? null;
    if (ctx && ctx.targetInstance !== wantTarget) {
      this.teardownPanelCtx(ctx);
      ctx = undefined;
    }
    if (ctx) return ctx;

    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", IFRAME_SANDBOX);
    iframe.setAttribute("title", panel.title ?? panel.id);
    iframe.src = new URL(panel.url, this.origin).href;
    ctx = {
      kind: "panel",
      extId,
      id: panel.id,
      instanceId: null,
      targetInstance: wantTarget,
      targetWidget: target?.widgetId ?? null,
      manifestEntry: panel,
      iframe,
      dialog: null,
      conn: null,
    };
    this.panelCtxs.set(key, ctx);
    this.allCtxs.add(ctx);

    // Persistent dialog chrome: title, iframe, footer. Built once per
    // context; open/close only toggles visibility.
    const dlg = document.createElement("dialog");
    dlg.className = "ext-config";
    const h = document.createElement("h2");
    h.textContent =
      target?.title ?? panel.title ?? panel.id ?? "Extension panel";
    dlg.appendChild(h);
    dlg.appendChild(iframe);
    const footer = document.createElement("div");
    footer.className = "ext-config-footer";
    if (target) {
      const remove = document.createElement("button");
      remove.textContent = "Remove widget";
      remove.addEventListener("click", () => {
        this.closeConfigDialog();
        this.removePlacement(target.instanceId);
      });
      footer.appendChild(remove);
    }
    const close = document.createElement("button");
    close.textContent = "✕ Close";
    close.addEventListener("click", () => this.closeConfigDialog());
    footer.appendChild(close);
    dlg.appendChild(footer);
    dlg.addEventListener("close", () => {
      if (this.openConfig?.dialog === dlg) this.openConfig = null;
      // onOpen panels die on close; keepAlive/whileEnabled stay parked.
      if (
        panel.lifecycle !== "keepAlive" &&
        panel.lifecycle !== "whileEnabled"
      ) {
        this.teardownPanelCtx(ctx);
      }
    });
    this.mount.appendChild(dlg);
    ctx.dialog = dlg;
    this.connectCtx(ctx);
    return ctx;
  }

  /**
   * @param {ExtContext} ctx
   * @returns {void}
   */
  teardownPanelCtx(ctx) {
    if (!this.allCtxs.has(ctx)) return; // idempotent (close handlers)
    if (this.openConfig?.ctx === ctx) this.closeConfigDialog();
    this.releaseCtx(ctx);
    for (const [key, c] of [...this.panelCtxs]) {
      if (c === ctx) this.panelCtxs.delete(key);
    }
    ctx.dialog?.close();
    ctx.dialog?.remove();
    ctx.iframe.remove();
  }

  // ---- the host API -----------------------------------------------------

  /**
   * Builds the JSON-RPC method table a context is offered. `events.*`
   * are handled inside HostConnection.
   *
   * @param {ExtContext} ctx
   * @returns {Record<string, (params: object) => Promise<object>>}
   */
  makeMethods(ctx) {
    return {
      "state.get": async (params) => {
        const t = this.resolveScope(ctx, params?.scope);
        return {
          values: this.stateStore.get(
            ctx.extId,
            t.instanceId,
            keyList(params?.keys),
          ),
        };
      },
      "state.set": async (params) => {
        const values = params?.values;
        if (!values || typeof values !== "object" || Array.isArray(values)) {
          throw badParams("state.set requires a values object");
        }
        const t = this.resolveScope(ctx, params?.scope);
        const keys = this.stateStore.write(ctx.extId, t.instanceId, values);
        if (keys.length > 0) {
          this.publishToExtension(ctx.extId, "state.changed", {
            scope: t.scope,
            instanceId: t.instanceId,
            keys,
          });
        }
        return {};
      },
      "signalk.subscribe": async (params) => {
        const paths = pathList(params?.paths);
        const subscriptionId = this.pathReg.subscribe(ctx, paths);
        this.stream?.subscribeShared(paths);
        return { subscriptionId };
      },
      "signalk.unsubscribe": async (params) => {
        const subId = params?.subscriptionId;
        if (typeof subId !== "string") {
          throw badParams("signalk.unsubscribe requires subscriptionId");
        }
        const paths = this.pathReg.unsubscribe(subId);
        if (paths == null) throw badParams("Unknown subscriptionId");
        this.stream?.unsubscribeShared(paths);
        return {};
      },
      "signalk.put": async (params) => {
        if (typeof params?.path !== "string" || params.path === "") {
          throw badParams("signalk.put requires a path");
        }
        if (!params || !("value" in params)) {
          throw badParams("signalk.put requires a value");
        }
        return await this.skPut(params.path, params.value);
      },
      "ui.openConfigPanel": async () => {
        if (ctx.kind !== "widget") throw notKind("widget", "openConfigPanel");
        this.openConfigFor(ctx.instanceId);
        return {};
      },
      "ui.toggleConfigPanel": async () => {
        if (ctx.kind !== "widget") throw notKind("widget", "toggleConfigPanel");
        if (this.openConfig?.instanceId === ctx.instanceId) {
          this.closeConfigDialog();
        } else {
          this.openConfigFor(ctx.instanceId);
        }
        return {};
      },
      "ui.closePanel": async () => {
        if (ctx.kind !== "panel") throw notKind("panel", "closePanel");
        if (this.openConfig?.ctx === ctx) this.closeConfigDialog();
        return {};
      },
    };
  }

  /**
   * Resolves a `state.*` scope for a context: instance scope defaults
   * for widget contexts (config panels target the configured widget),
   * extension scope when no instance is addressable.
   *
   * @param {ExtContext} ctx
   * @param {unknown} scopeParam
   * @returns {{scope: "instance"|"extension", instanceId: string|null}}
   */
  resolveScope(ctx, scopeParam) {
    const instanceId =
      ctx.kind === "widget" ? ctx.instanceId : (ctx.targetInstance ?? null);
    if (scopeParam === undefined || scopeParam === null) {
      return instanceId
        ? { scope: "instance", instanceId }
        : { scope: "extension", instanceId: null };
    }
    if (scopeParam === "extension") {
      return { scope: "extension", instanceId: null };
    }
    if (scopeParam === "instance") {
      if (!instanceId) {
        throw badParams("no widget instance addressable in this context");
      }
      return { scope: "instance", instanceId };
    }
    throw badParams('scope must be "instance" or "extension"');
  }

  /**
   * Publishes an event to every live context of an extension.
   *
   * @param {string} extId
   * @param {string} eventName
   * @param {object} params
   * @returns {void}
   */
  publishToExtension(extId, eventName, params) {
    for (const ctx of [...this.allCtxs]) {
      if (ctx.extId === extId) ctx.conn?.publish(eventName, params);
    }
  }

  /**
   * Stream delta → `sk.<path>` events, delivered only to contexts
   * holding a subscription for the path.
   *
   * @param {object} delta
   * @returns {void}
   */
  onDelta(delta) {
    const vals = core.selfDeltaValues(delta, this.stream?.selfContext);
    if (vals.length === 0) return;
    for (const v of vals) {
      for (const ctx of this.pathReg.contextsForPath(v.path)) {
        ctx.conn?.publish(`sk.${v.path}`, v);
      }
    }
  }

  /**
   * Relays a Signal K PUT through the user's session.
   *
   * @param {string} path
   * @param {unknown} value
   * @returns {Promise<object>} server PUT response
   */
  async skPut(path, value) {
    let res;
    try {
      res = await this.fetchImpl(
        `${this.origin}/signalk/v2/api/paths/${path}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(value),
        },
      );
    } catch (err) {
      throw new RpcError(`PUT ${path} failed: ${err?.message ?? err}`, {
        code: RPC_ERRORS.HOST_ERROR,
        reason: "PUT_FAILED",
      });
    }
    if (!res.ok) {
      throw new RpcError(`PUT ${path} rejected: ${res.status}`, {
        code: RPC_ERRORS.HOST_ERROR,
        reason: "PUT_FAILED",
        data: { status: res.status },
      });
    }
    try {
      return await res.json();
    } catch {
      return {};
    }
  }

  // ---- placement --------------------------------------------------------

  /**
   * Places a widget into an area (first free slot) and persists it.
   *
   * @param {string} anchor
   * @param {string} extId
   * @param {object} widget
   * @returns {object|null} the placement, or null when the area is full
   */
  place(anchor, extId, widget) {
    const list = this.layout.areas[anchor] ?? [];
    const slot = core.firstFreeSlot(list, widget.size);
    if (!slot) return null;
    const placement = {
      extensionId: extId,
      widgetId: widget.id,
      instanceId: core.newInstanceId(),
      size: widget.size,
      row: slot.row,
      col: slot.col,
    };
    list.push(placement);
    this.layout.areas[anchor] = list;
    this.saveLayout();
    this.ensureWidgetContext(placement, widget);
    this.renderArea(anchor);
    return placement;
  }

  /**
   * Removes a placement (and its context) — the remove affordance
   * every widget gets, gesture-independent.
   *
   * @param {string} instanceId
   * @returns {void}
   */
  removePlacement(instanceId) {
    for (const anchor of core.AREA_ANCHORS) {
      const list = this.layout.areas[anchor] ?? [];
      const idx = list.findIndex((p) => p.instanceId === instanceId);
      if (idx >= 0) {
        list.splice(idx, 1);
        this.saveLayout();
        this.teardownWidget(instanceId);
        this.renderArea(anchor);
        return;
      }
    }
  }

  /**
   * Finds a placement across areas.
   *
   * @param {string} instanceId
   * @returns {{placement: object, anchor: string}|null}
   */
  findPlacement(instanceId) {
    for (const anchor of core.AREA_ANCHORS) {
      const placement = (this.layout.areas[anchor] ?? []).find(
        (p) => p.instanceId === instanceId,
      );
      if (placement) return { placement, anchor };
    }
    return null;
  }

  // ---- dialogs ----------------------------------------------------------

  /**
   * The placement/manager picker for one area: placeable widgets plus
   * per-placement Configure/Remove (the gesture-independent path the
   * spec requires).
   *
   * @param {string} anchor
   * @returns {void}
   */
  openPicker(anchor) {
    this.closePicker();
    const dlg = document.createElement("dialog");
    dlg.className = "ext-picker";
    const title = document.createElement("h2");
    title.textContent = `Plotter widgets — ${anchor}`;
    dlg.appendChild(title);

    const placeable = [];
    for (const [extId, ext] of this.compatible) {
      for (const widget of ext.widgets) {
        placeable.push({ extId, widget });
      }
    }
    if (placeable.length === 0) {
      const p = document.createElement("p");
      p.textContent = this.discovered
        ? "No plotter extensions available on this server."
        : "Plotter extensions could not be loaded (server unreachable).";
      dlg.appendChild(p);
    } else {
      for (const { extId, widget } of placeable) {
        const b = document.createElement("button");
        b.textContent = `＋ ${widget.title ?? widget.id} (${widget.size})`;
        b.addEventListener("click", () => {
          const placement = this.place(anchor, extId, widget);
          if (!placement) {
            b.textContent = `${widget.title ?? widget.id} — no room in this area`;
            return;
          }
          this.closePicker();
        });
        dlg.appendChild(b);
      }
    }

    const placed = this.layout.areas[anchor] ?? [];
    if (placed.length > 0) {
      const h = document.createElement("h2");
      h.textContent = "Placed here";
      dlg.appendChild(h);
      for (const p of placed) {
        const row = document.createElement("div");
        row.className = "ext-manage-row";
        const label = document.createElement("span");
        const ext = this.compatible.get(p.extensionId);
        const widget = ext?.widgets.find((w) => w.id === p.widgetId);
        label.textContent = widget?.title ?? `${p.extensionId}/${p.widgetId}`;
        const cfg = document.createElement("button");
        cfg.textContent = "Configure";
        cfg.addEventListener("click", () => {
          this.closePicker();
          this.openConfigFor(p.instanceId);
        });
        const rm = document.createElement("button");
        rm.textContent = "Remove";
        rm.addEventListener("click", () => {
          this.removePlacement(p.instanceId);
          this.closePicker();
        });
        row.append(label, cfg, rm);
        dlg.appendChild(row);
      }
    }

    const close = document.createElement("button");
    close.textContent = "✕ Close";
    close.addEventListener("click", () => this.closePicker());
    dlg.appendChild(close);

    dlg.addEventListener("close", () => {
      dlg.remove();
      if (this.pickerDialog === dlg) this.pickerDialog = null;
    });
    this.mount.appendChild(dlg);
    dlg.showModal();
    this.pickerDialog = dlg;
  }

  /**
   * @returns {void}
   */
  closePicker() {
    this.pickerDialog?.close();
  }

  /**
   * Opens the configuration dialog for a placed widget: its
   * `configPanel` (a persistent dialog — state survives close/reopen
   * for keepAlive panels), or a transient remove-only dialog when it
   * has none. The spec requires the remove affordance either way.
   *
   * @param {string} instanceId
   * @returns {void}
   */
  openConfigFor(instanceId) {
    const found = this.findPlacement(instanceId);
    if (!found) return;
    const { placement } = found;
    const ext = this.compatible.get(placement.extensionId);
    const widget = ext?.widgets.find((w) => w.id === placement.widgetId);
    if (!ext || !widget) return;
    this.closeConfigDialog();

    if (widget.configPanel) {
      const panel = ext.panels.find((pn) => pn.id === widget.configPanel);
      if (panel) {
        const ctx = this.ensurePanelCtx(placement.extensionId, panel, {
          instanceId,
          widgetId: widget.id,
          title: widget.title ?? widget.id,
        });
        ctx.dialog.showModal();
        this.openConfig = {
          ctx,
          dialog: ctx.dialog,
          instanceId,
        };
        return;
      }
    }

    // Remove-only dialog (no configPanel, or the panel entry is gone).
    const dlg = document.createElement("dialog");
    dlg.className = "ext-config";
    const h = document.createElement("h2");
    h.textContent = widget.title ?? widget.id;
    dlg.appendChild(h);
    const p = document.createElement("p");
    p.textContent = "This widget has no configuration panel.";
    dlg.appendChild(p);
    const footer = document.createElement("div");
    footer.className = "ext-config-footer";
    const remove = document.createElement("button");
    remove.textContent = "Remove widget";
    remove.addEventListener("click", () => {
      dlg.close();
      this.removePlacement(instanceId);
    });
    const close = document.createElement("button");
    close.textContent = "✕ Close";
    close.addEventListener("click", () => dlg.close());
    footer.append(remove, close);
    dlg.appendChild(footer);
    dlg.addEventListener("close", () => {
      if (this.openConfig?.dialog === dlg) this.openConfig = null;
      dlg.remove();
    });
    this.mount.appendChild(dlg);
    dlg.showModal();
    this.openConfig = { ctx: null, dialog: dlg, instanceId };
  }

  /**
   * @returns {void}
   */
  closeConfigDialog() {
    this.openConfig?.dialog.close();
  }
}

/** Base class that also loads under Node (tests import the manager
 * from this module — only the element needs a browser). */
const AreaBase = typeof HTMLElement !== "undefined" ? HTMLElement : class {};

/**
 * `<dr-ext-widget-area>` — a 2×2 widget grid anchored below one of the
 * webapp's own floating panels. Pure chrome: the frames are owned by
 * the manager; the visual language (translucent panel, corner
 * brackets) comes from dr-theme.js so hosted widgets sit in the same
 * frame as `.dr-tools`/`.dr-gps`. Empty cells stay pointer-transparent
 * so the chart keeps dragging through the gaps; the compact "＋ EXT"
 * affordance opens the placement picker.
 */
export class DrExtWidgetArea extends AreaBase {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = /* css */ `
      ${THEME_CSS}
      :host {
        --theme-color: var(--color-teal, #4b8b99);
        pointer-events: none; /* chart drags through empty space */
        display: block;
      }
      .grid {
        display: none; /* only with placements */
        grid-template-columns: repeat(2, ${CELL_CSS});
        grid-auto-rows: ${CELL_CSS};
        gap: 6px;
        pointer-events: auto;
      }
      .grid.active { display: grid; }
      .cell {
        position: relative;
        background: var(--bg-panel, #111414);
        background: color-mix(in srgb, var(--bg-panel, #111414) 88%, transparent);
        border: 1px solid rgba(255, 255, 255, 0.1);
        overflow: hidden;
        min-width: 0;
        min-height: 0;
      }
      /* Corner brackets — same hardware-mounting language as the app
         panels, but thinner so the widget content dominates. */
      .cell::before,
      .cell::after {
        content: "";
        position: absolute;
        width: 8px;
        height: 8px;
        border: 1px solid var(--theme-color);
        pointer-events: none;
        z-index: 1;
      }
      .cell::before {
        top: 0; left: 0;
        border-right: none; border-bottom: none;
      }
      .cell::after {
        bottom: 0; right: 0;
        border-left: none; border-top: none;
      }
      .cell iframe {
        display: block;
        width: 100%;
        height: 100%;
        border: 0;
        background: transparent;
      }
      .add {
        pointer-events: auto;
        margin-top: 6px;
        min-height: 32px;
        padding: 0 0.6rem;
        font-size: 0.7rem;
      }
    `;
    root.appendChild(style);
    const grid = document.createElement("div");
    grid.className = "grid";
    const add = document.createElement("button");
    add.className = "add";
    add.type = "button";
    add.textContent = "＋ EXT";
    add.title = "Place a plotter-extension widget";
    root.append(grid, add);
    this.grid = grid;
    this.addButton = add;
    /** @type {Map<string, HTMLDivElement>} instanceId → cell */
    this.cells = new Map();
    /** @type {Array<object>} current placements */
    this.placements = [];
  }

  /**
   * @returns {string}
   */
  get anchor() {
    return this.getAttribute("anchor") ?? "top-left";
  }

  connectedCallback() {
    this.addButton.addEventListener("click", () => {
      this.manager?.openPicker(this.anchor);
    });
    this.render();
  }

  /**
   * New placements from the manager; reuses existing cells so placed
   * iframes are never re-parented (re-parenting reloads an iframe).
   *
   * @param {Array<object>} placements
   * @returns {void}
   */
  setModel(placements) {
    this.placements = placements;
    this.render();
  }

  /**
   * @returns {void}
   */
  render() {
    const live = new Set(this.placements.map((p) => p.instanceId));
    for (const [instanceId, cell] of [...this.cells]) {
      if (!live.has(instanceId)) {
        cell.remove();
        this.cells.delete(instanceId);
      }
    }
    for (const p of this.placements) {
      if (this.cells.has(p.instanceId)) continue;
      const size = core.parseSize(p.size) ?? { cols: 1, rows: 1 };
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.style.gridArea = `${p.row + 1} / ${p.col + 1} / span ${size.rows} / span ${size.cols}`;
      this.grid.appendChild(cell);
      this.cells.set(p.instanceId, cell);
      const ctx = this.manager?.widgetCtxs.get(p.instanceId);
      if (ctx) cell.appendChild(ctx.iframe);
    }
    this.grid.classList.toggle("active", this.placements.length > 0);
  }
}

if (
  typeof customElements !== "undefined" &&
  !customElements.get("dr-ext-widget-area")
) {
  customElements.define("dr-ext-widget-area", DrExtWidgetArea);
}

/**
 * @param {string} kind
 * @param {string} method
 * @returns {RpcError}
 */
function notKind(kind, method) {
  return new RpcError(`${method} is a ${kind} affordance`, {
    code: RPC_ERRORS.HOST_ERROR,
    reason: `NOT_${kind.toUpperCase()}`,
  });
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

/**
 * @param {unknown} keys
 * @returns {string[]|undefined}
 */
function keyList(keys) {
  if (keys === undefined || keys === null) return undefined;
  if (!Array.isArray(keys) || !keys.every((k) => typeof k === "string")) {
    throw badParams("keys must be an array of strings");
  }
  return keys;
}

/**
 * @param {unknown} paths
 * @returns {string[]}
 */
function pathList(paths) {
  if (
    !Array.isArray(paths) ||
    paths.length === 0 ||
    !paths.every((p) => typeof p === "string" && p !== "")
  ) {
    throw badParams("paths must be a non-empty array of strings");
  }
  return paths;
}
