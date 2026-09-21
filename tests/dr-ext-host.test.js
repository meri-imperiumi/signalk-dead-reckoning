/**
 * Tests for the plotter-extension host glue (work doc #27). The
 * `PlotterExtHost` manager is exercised with fake stream/storage/fetch
 * — no DOM — covering the JSON-RPC method table, scope resolution,
 * event fan-out and placement persistence. The DOM-facing pieces
 * (widget-area element, iframes, dialogs) are pinned structurally,
 * following the dr-app-layout.test.js pattern.
 *
 * @file dr-ext-host.test.js
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PlotterExtHost } from "../public/dr-ext-host.js";

const read = (f) =>
  readFileSync(fileURLToPath(new URL(`../public/${f}`, import.meta.url)), {
    encoding: "utf8",
  });
const hostSrc = read("dr-ext-host.js");
const appSrc = read("dr-app.js");
const mapSrc = read("dr-map-view.js");
const streamSrc = read("dr-signalk-stream.js");

// ---- fakes --------------------------------------------------------------

function fakeStorage() {
  /** @type {Map<string, string>} */
  const backing = new Map();
  return {
    getItem: (k) => backing.get(k) ?? null,
    setItem: (k, v) => backing.set(k, v),
    removeItem: (k) => backing.delete(k),
    backing,
  };
}

/**
 * A fake stream capturing shared-subscription traffic.
 *
 * @returns {{stream: object, shared: Array<{op: string, paths: string[]}>}}
 */
function fakeStream() {
  const shared = [];
  return {
    shared,
    stream: {
      selfContext: "vessels.urn:self",
      on() {},
      subscribeShared(paths) {
        shared.push({ op: "add", paths: [...paths] });
      },
      unsubscribeShared(paths) {
        shared.push({ op: "remove", paths: [...paths] });
      },
    },
  };
}

/**
 * Builds a host with fakes (no DOM — constructor must stay DOM-free).
 *
 * @param {object} [opts]
 * @returns {{host: PlotterExtHost, storage: object, shared: Array}}
 */
function makeHost(opts = {}) {
  const storage = fakeStorage();
  const { stream, shared } = fakeStream();
  const host = new PlotterExtHost({
    stream,
    mount: null,
    storage,
    fetchImpl: opts.fetchImpl ?? null,
    origin: "http://sk.test",
  });
  return { host, storage, shared };
}

/**
 * A bare context record (what makeMethods closes over) with a
 * capturing fake connection.
 *
 * @param {object} [overrides]
 */
function fakeCtx(overrides = {}) {
  const published = [];
  return {
    kind: "widget",
    extId: "ext",
    id: "w",
    instanceId: "inst-1",
    targetInstance: null,
    targetWidget: null,
    conn: {
      published,
      publish(name, params) {
        published.push({ name, params });
      },
      close() {},
    },
    ...overrides,
  };
}

// ---- state scopes ---------------------------------------------------------

test("state: widget defaults to instance scope, panels target the widget", async () => {
  const { host } = makeHost();
  const widgetCtx = fakeCtx();
  const panelCtx = fakeCtx({
    kind: "panel",
    instanceId: null,
    targetInstance: "inst-9",
    targetWidget: "w",
  });
  const widgetApi = host.makeMethods(widgetCtx);
  const panelApi = host.makeMethods(panelCtx);

  await widgetApi["state.set"]({ values: { from: "widget" } });
  await panelApi["state.set"]({ values: { from: "panel" } });
  // Both wrote the *same* instance scope (inst-1 vs its target inst-9).
  assert.deepEqual((await widgetApi["state.get"]({})).values, {
    from: "widget",
  });
  assert.deepEqual((await panelApi["state.get"]({})).values, {
    from: "panel",
  });
  assert.deepEqual(
    (await panelApi["state.get"]({ scope: "instance" })).values,
    { from: "panel" },
  );
  // Extension scope is shared and separate.
  await widgetApi["state.set"]({ scope: "extension", values: { g: 1 } });
  assert.deepEqual(
    (await panelApi["state.get"]({ scope: "extension" })).values,
    { g: 1 },
  );
});

test("state: invalid params rejected with INVALID_PARAMS", async () => {
  const { host } = makeHost();
  const api = host.makeMethods(fakeCtx());
  await assert.rejects(api["state.set"]({ values: "nope" }), /values object/);
  await assert.rejects(
    api["state.set"]({ scope: "bogus", values: {} }),
    /scope/,
  );
  // instance scope with nothing addressable
  const orphan = host.makeMethods(
    fakeCtx({ kind: "panel", instanceId: null, targetInstance: null }),
  );
  await assert.rejects(
    orphan["state.get"]({ scope: "instance" }),
    /no widget instance/,
  );
});

test("state.set fans out state.changed to the extension's contexts", async () => {
  const { host } = makeHost();
  const a = fakeCtx();
  const b = fakeCtx({ instanceId: "inst-2" });
  host.allCtxs.add(a);
  host.allCtxs.add(b);
  const other = fakeCtx({ extId: "other-ext" });
  host.allCtxs.add(other);

  await host.makeMethods(a)["state.set"]({ values: { k: 1 } });
  assert.equal(a.conn.published.length, 1);
  assert.equal(b.conn.published.length, 1);
  assert.equal(other.conn.published.length, 0);
  assert.deepEqual(a.conn.published[0], {
    name: "state.changed",
    params: { scope: "instance", instanceId: "inst-1", keys: ["k"] },
  });
});

// ---- signalk relay --------------------------------------------------------

test("signalk.subscribe/unsubscribe track refs on the stream", async () => {
  const { host, shared } = makeHost();
  const ctx = fakeCtx();
  host.allCtxs.add(ctx);
  const api = host.makeMethods(ctx);

  const r = await api["signalk.subscribe"]({
    paths: ["navigation.speedOverGround"],
  });
  assert.match(r.subscriptionId, /^sks-/);
  assert.deepEqual(shared, [
    { op: "add", paths: ["navigation.speedOverGround"] },
  ]);
  await api["signalk.unsubscribe"]({ subscriptionId: r.subscriptionId });
  assert.deepEqual(shared[1], {
    op: "remove",
    paths: ["navigation.speedOverGround"],
  });
  await assert.rejects(
    api["signalk.unsubscribe"]({ subscriptionId: "nope" }),
    /Unknown subscriptionId/,
  );
  // Widget contexts must never steal the app's own paths: only
  // paths the shared layer holds respond to unsubscribeShared.
  await assert.rejects(api["signalk.subscribe"]({ paths: [] }), /paths/);
});

test("onDelta delivers sk.<path> only to subscribing contexts", () => {
  const { host } = makeHost();
  const speedCtx = fakeCtx();
  const tempCtx = fakeCtx({ instanceId: "inst-2" });
  host.pathReg.subscribe(speedCtx, ["navigation.speedOverGround"]);
  host.onDelta({
    context: "vessels.urn:self",
    updates: [
      {
        timestamp: "2026-09-19T09:00:00Z",
        $source: "src",
        values: [
          { path: "navigation.speedOverGround", value: 5.2 },
          { path: "environment.water.temperature", value: 291 },
        ],
      },
    ],
  });
  assert.equal(speedCtx.conn.published.length, 1);
  assert.deepEqual(speedCtx.conn.published[0], {
    name: "sk.navigation.speedOverGround",
    params: {
      path: "navigation.speedOverGround",
      value: 5.2,
      timestamp: "2026-09-19T09:00:00Z",
      $source: "src",
    },
  });
  // Non-subscribers and foreign-vessel deltas stay silent.
  assert.equal(tempCtx.conn.published.length, 0);
  host.onDelta({
    context: "vessels.urn:other",
    updates: [{ values: [{ path: "navigation.speedOverGround", value: 1 }] }],
  });
  assert.equal(speedCtx.conn.published.length, 1);
});

test("signalk.put relays a PUT and maps failures to PUT_FAILED", async () => {
  const { host } = makeHost({
    fetchImpl: async (url, init) => {
      assert.equal(url, "http://sk.test/signalk/v2/api/paths/x.y");
      assert.equal(init.method, "PUT");
      return { ok: true, json: async () => ({ state: "COMPLETED" }) };
    },
  });
  const api = host.makeMethods(fakeCtx());
  assert.deepEqual(await api["signalk.put"]({ path: "x.y", value: 3 }), {
    state: "COMPLETED",
  });

  const failing = makeHost({
    fetchImpl: async () => ({ ok: false, status: 401 }),
  });
  await assert.rejects(
    failing.host.makeMethods(fakeCtx())["signalk.put"]({ path: "x", value: 1 }),
    (err) => {
      assert.equal(err.reason, "PUT_FAILED");
      return true;
    },
  );
});

// ---- ui affordances -------------------------------------------------------

test("ui methods are kind-gated", async () => {
  const { host } = makeHost();
  const widget = host.makeMethods(fakeCtx());
  const panel = host.makeMethods(fakeCtx({ kind: "panel", instanceId: null }));
  // Panel contexts cannot openConfigPanel; widget cannot closePanel.
  await assert.rejects(widget["ui.closePanel"](), /panel affordance/);
  await assert.rejects(panel["ui.openConfigPanel"](), /widget affordance/);
});

// ---- placement --------------------------------------------------------------

test("place/remove persist to localStorage and mint stable instance ids", () => {
  const { host, storage } = makeHost();
  const widget = {
    id: "gauge",
    title: "Gauge",
    type: "iframe",
    url: "/plotterext/ext/gauge.html",
    size: "1x1",
  };
  host.compatible.set("ext", {
    manifest: { name: "Ext" },
    widgets: [widget],
    panels: [],
  });
  // place() normally creates a widget context (DOM); stub it out.
  host.ensureWidgetContext = () => null;
  host.renderArea = () => null;

  const p = host.place("top-left", "ext", widget);
  assert.deepEqual([p.row, p.col], [0, 0]);
  assert.match(p.instanceId, /^[0-9a-f-]{36}$/);
  const stored = JSON.parse(storage.backing.get("dr.plotterext.layout.v1"));
  assert.equal(stored.areas["top-left"].length, 1);

  host.removePlacement(p.instanceId);
  const stored2 = JSON.parse(storage.backing.get("dr.plotterext.layout.v1"));
  assert.equal(stored2.areas["top-left"].length, 0);
});

test("refresh prunes stale placements without touching the DOM", async () => {
  const { host, storage } = makeHost({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({}), // empty collection: nothing enabled
    }),
  });
  storage.setItem(
    "dr.plotterext.layout.v1",
    JSON.stringify({
      version: 1,
      areas: {
        "top-left": [
          {
            extensionId: "gone",
            widgetId: "w",
            instanceId: "i",
            size: "1x1",
            row: 0,
            col: 0,
          },
        ],
        "top-right": [],
      },
    }),
  );
  host.layout = host.loadLayout();
  await host.refresh();
  const stored = JSON.parse(storage.backing.get("dr.plotterext.layout.v1"));
  assert.equal(stored.areas["top-left"].length, 0);
});

// ---- structural smoketests ---------------------------------------------------

test("dr-app: widget areas sit below the app's own top panels", () => {
  const col = appSrc.match(
    /<div class="dr-top-col">[\s\S]*?<dr-ext-widget-area anchor="top-left">/,
  );
  assert.ok(col, "top-left area follows the tools panel in its column");
  const colRight = appSrc.match(
    /<div class="dr-top-col dr-top-col-right">[\s\S]*?<dr-ext-widget-area anchor="top-right">/,
  );
  assert.ok(colRight, "top-right area follows the GPS panel in its column");
  assert.match(appSrc, /\.dr-top-col \{[^}]*flex-direction: column/s);
  assert.match(
    appSrc,
    /new PlotterExtHost\(\{\s*stream: window\.drSignalkStream,\s*mount: root,/s,
  );
});

test("dr-ext-host: sandboxed same-origin iframes, origin-pinned bus", () => {
  assert.match(
    hostSrc,
    /IFRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms"/,
  );
  assert.doesNotMatch(
    hostSrc,
    /allow-top-navigation|allow-popups|allow-modals/,
  );
  // The bus port must resolve the iframe's CURRENT window per message:
  // an iframe's Window object is replaced when it navigates from
  // about:blank to its src (and is null while the frame is still
  // detached — contexts are created before the area adopts the
  // iframe). A port that captured the peer window at context creation
  // silently dropped every message from the loaded widget (sea trial
  // 2026-09-21: the dr-status tile showed an empty dark square).
  assert.match(hostSrc, /liveWindowPort\(ctx\.iframe, this\.origin\)/);
  assert.match(
    hostSrc,
    /iframe\.contentWindow\?\.postMessage\(data, origin\)/,
    "port posts to the live window",
  );
  assert.match(
    hostSrc,
    /ev\.source !== iframe\.contentWindow/,
    "port listens against the live window",
  );
});

test("dr-ext-host: widget cells reuse the theme's visual language", () => {
  assert.match(hostSrc, /import \{ THEME_CSS \} from "\.\/dr-theme\.js"/);
  // The area's shadow stylesheet is built on the shared theme block.
  assert.match(hostSrc, /\$\{THEME_CSS\}/);
  // Translucent panel + brackets on cells; iframes transparent so
  // extension content blends.
  assert.match(hostSrc, /\.cell::before,[\s\S]*?\.cell::after \{/);
  assert.match(hostSrc, /background: transparent;/);
  // Empty space stays chart-draggable.
  assert.match(hostSrc, /:host \{[^}]*pointer-events: none/s);
});

test("placement rides the chart context menu, not an on-chart button", () => {
  // No “＋ EXT” button stuck to the chart.
  assert.doesNotMatch(hostSrc, /＋ EXT/);
  assert.doesNotMatch(hostSrc, /\.add \{/);
  // The empty area still reserves its 2×2 footprint so there is a
  // stable region for the context-menu hit test.
  assert.match(hostSrc, /min-width: calc\(2 \* \$\{CELL_CSS\} \+ 6px\)/);
  assert.match(hostSrc, /min-height: calc\(2 \* \$\{CELL_CSS\} \+ 6px\)/);
  // Only the cells capture pointer events — gaps and empty cells
  // stay clickable as chart (right-click reaches the map).
  assert.match(hostSrc, /\.grid \{[\s\S]*?pointer-events: none/s);
  assert.match(hostSrc, /\.cell \{[^}]*pointer-events: auto/s);
  // The pick menu grows the placement entry over an area footprint.
  assert.match(mapSrc, /areaAt = null;/);
  assert.match(mapSrc, /this\.areaAt\(/);
  assert.match(mapSrc, / Plotter widgets \(\$\{anchor\}\)…/);
  assert.match(mapSrc, /dr-open-ext-picker/);
  // dr-app owns the hit test and opens the host's picker.
  assert.match(appSrc, /this\.map\.areaAt = /);
  assert.match(appSrc, /this\.extHost\?\.openPicker\(e\.detail\.anchor\)/);
});

test("dr-ext-host: dialogs are persistent for panels, transient for removal", () => {
  // Panel contexts own their dialog; closing must not destroy it.
  assert.match(hostSrc, /ctx\.dialog = dlg;/);
  assert.match(hostSrc, /dlg\.addEventListener\("close", \(\) => \{/);
  assert.match(hostSrc, /this\.openConfig = \{\s*ctx,\s*dialog: ctx\.dialog,/s);
});

test("dr-ext-host: a restored placement's iframe is adopted once its context exists", () => {
  // Page-load ordering: attachArea renders cells BEFORE discovery
  // creates the widget contexts, so a placement restored from layout
  // storage would render an empty dark square forever if the iframe
  // were only adopted at cell creation (sea trial 2026-09-21).
  // Adoption must be idempotent per render — and never re-parent a
  // live iframe (re-parenting reloads the frame).
  assert.match(
    hostSrc,
    /const ctx = this\.manager\?\.widgetCtxs\.get\(p\.instanceId\);/,
    "render looks the context up on every pass",
  );
  assert.match(
    hostSrc,
    /if \(ctx && ctx\.iframe\.parentElement !== cell\) \{/,
    "iframe adopted only when not already home",
  );
});

test("vendor: host bus entry is vendored alongside the extension side", () => {
  const hostJs = read("vendor/plotterext-bus/host.js");
  assert.match(hostJs, /HostConnection/);
  read("vendor/plotterext-bus/chunk-RED55KML.js");
});

test("dr-signalk-stream: browser bootstrap is guarded for Node imports", () => {
  assert.match(streamSrc, /typeof window !== "undefined"/);
  assert.match(streamSrc, /subscribeShared\(paths\)/);
  assert.match(streamSrc, /unsubscribeShared\(paths\)/);
});
