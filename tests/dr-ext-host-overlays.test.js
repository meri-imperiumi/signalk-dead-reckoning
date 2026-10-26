/**
 * Tests for the plotter-extension host's chart-layer phase (work doc
 * #27): overlay manifest filtering and spec normalization, the
 * persisted overlay state store, Web Mercator frame-request geometry,
 * the frame gate (superseded/throttled), and the host-side overlay
 * API methods (with fakes — no DOM, no Leaflet).
 *
 * @file dr-ext-host-overlays.test.js
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { PlotterExtHost } from "../public/dr-ext-host.js";
import * as core from "../public/dr-ext-host-core.js";

const require = createRequire(import.meta.url);
const { buildManifest } = require("../plugin/plotterext.js");

// ---- fakes --------------------------------------------------------------

function fakeStorage() {
  /** @type {Map<string, string>} */
  const backing = new Map();
  return {
    getItem: (k) => backing.get(k) ?? null,
    setItem: (k, v) => backing.set(k, v),
    backing,
  };
}

function fakeStream() {
  return {
    stream: {
      selfContext: "vessels.urn:self",
      on() {},
      subscribeShared() {},
      unsubscribeShared() {},
    },
  };
}

/** A LiveDepth-shaped manifest: headless runtime + image overlay. */
function overlayManifest(overrides = {}) {
  return {
    name: "LiveDepth",
    description: "",
    version: "1.0.0",
    apiVersion: "1",
    requires: ["background.iframe", "overlays.image", "signalk.stream"],
    background: [
      {
        id: "renderer",
        type: "iframe",
        url: "/plotterext/signalk-livedepth-plugin/renderer.html",
      },
    ],
    overlays: [
      {
        id: "depth",
        title: "Live depth",
        type: "image",
        runtime: "renderer",
        band: "aboveCharts",
        visible: true,
        opacity: 0.85,
        minZoom: 4,
        preferredPixelRatio: 2,
        configPanel: "livedepth-settings",
      },
    ],
    panels: [
      {
        id: "livedepth-settings",
        title: "LiveDepth",
        type: "iframe",
        url: "/plotterext/signalk-livedepth-plugin/config.html",
        lifecycle: "keepAlive",
      },
    ],
    buttons: [
      {
        id: "open-livedepth-settings",
        title: "LiveDepth",
        slot: "mapToolbar",
        action: { type: "togglePanel", panel: "livedepth-settings" },
      },
    ],
    ...overrides,
  };
}

/**
 * A host whose background-context creation is stubbed (no DOM): the
 * fake contexts carry a delivered-on-first-publish connection.
 *
 * @param {object} [opts]
 * @returns {{host: PlotterExtHost, storage: object, created: string[]}}
 */
function makeOverlayHost(opts = {}) {
  const storage = opts.storage ?? fakeStorage();
  const { stream } = fakeStream();
  const created = [];
  class StubHost extends PlotterExtHost {
    ensureBackgroundCtx(extId, entry) {
      const key = `${extId}/${entry.id}`;
      let ctx = this.bgCtxs.get(key);
      if (ctx) return ctx;
      created.push(key);
      ctx = {
        kind: "background",
        extId,
        id: entry.id,
        instanceId: null,
        targetInstance: null,
        targetWidget: null,
        manifestEntry: entry,
        iframe: null,
        dialog: null,
        conn: {
          publish() {
            return true; // delivered — no retry timers
          },
          close() {},
        },
      };
      this.bgCtxs.set(key, ctx);
      this.allCtxs.add(ctx);
      return ctx;
    }
  }
  const host = new StubHost({
    stream,
    mount: null,
    storage,
    fetchImpl: null,
    origin: "http://sk.test",
    ...opts,
  });
  return { host, storage, created };
}

// ---- manifest filtering ---------------------------------------------------

test("compatibleExtensions: a LiveDepth-shaped manifest is offered", () => {
  const compat = core.compatibleExtensions(
    { livedepth: overlayManifest() },
    core.HOST_CAPABILITIES,
  );
  assert.deepEqual([...compat.keys()], ["livedepth"]);
  const ext = compat.get("livedepth");
  assert.equal(ext.overlays.length, 1);
  assert.equal(ext.background.length, 1);
  assert.equal(ext.buttons.length, 1);
  assert.equal(ext.panels.length, 1);
});

test("compatibleExtensions: overlay requirements gate on the new capabilities", () => {
  const collection = { livedepth: overlayManifest() };
  // Without overlays.image (or background.iframe) the manifest must
  // not be offered at all — the host cannot run it.
  for (const missing of ["overlays.image", "background.iframe"]) {
    const caps = core.HOST_CAPABILITIES.filter((c) => c !== missing);
    assert.equal(
      core.compatibleExtensions(collection, caps).size,
      0,
      `dropped without ${missing}`,
    );
  }
});

test("overlaySpec: manifest defaults fill in, user overrides ride along", () => {
  const spec = core.overlaySpec({ id: "depth", runtime: "renderer" });
  assert.equal(spec.band, "aboveCharts");
  assert.equal(spec.visible, true);
  assert.equal(spec.opacity, 0.85);
  assert.equal(spec.minZoom, 0);
  assert.equal(spec.configPanel, null);
  assert.equal(spec.preferredPixelRatio, null);
  assert.equal(spec.runtime, "renderer");
  const full = core.overlaySpec({
    id: "d",
    title: "Depth",
    band: "aboveResources",
    opacity: 2,
    minZoom: 4,
    preferredPixelRatio: 2,
  });
  assert.equal(full.band, "aboveResources");
  assert.equal(full.opacity, 0.85); // 2 is out of range → default
  assert.equal(full.preferredPixelRatio, 2);
});

test("overlayUsable: data overlays and unknown bands are not hosted", () => {
  assert.equal(core.overlayUsable({ id: "depth" }), true);
  assert.equal(core.overlayUsable({ id: "depth", type: "image" }), true);
  assert.equal(core.overlayUsable({ id: "depth", type: "data" }), false);
  assert.equal(core.overlayUsable({ id: "depth", band: "underwater" }), false);
  assert.equal(core.overlayUsable({}), false);
  assert.equal(core.overlayUsable(null), false);
});

test("buttonUsable: mapToolbar only", () => {
  assert.equal(core.buttonUsable({ id: "b", slot: "mapToolbar" }), true);
  assert.equal(core.buttonUsable({ id: "b" }), true);
  assert.equal(core.buttonUsable({ id: "b", slot: "topBar" }), false);
  assert.equal(core.buttonUsable({ slot: "mapToolbar" }), false);
});

test("hostButtons: skips excluded extensions and statically hidden buttons", () => {
  const compatible = new Map([
    [
      "signalk-dead-reckoning",
      {
        manifest: {},
        buttons: [
          { id: "open-sight", icon: "explore", visible: true },
          { id: "override-release", visible: false },
        ],
      },
    ],
    [
      "signalk-livedepth",
      {
        manifest: {},
        buttons: [
          { id: "toggle-depth", icon: "waves", visible: true },
          { id: "hidden-by-default", visible: false },
          { id: "not-mapToolbar", slot: "topBar" },
        ],
      },
    ],
  ]);
  // The webapp's own plugin never renders (its buttons duplicate the
  // native toolbar), and visible:false means the static manifest
  // default is "hidden" — this host cannot drive visibility.
  assert.deepEqual(
    core
      .hostButtons(compatible, [core.SELF_EXTENSION_ID])
      .map(({ extId, button }) => `${extId}/${button.id}`),
    ["signalk-livedepth/toggle-depth"],
  );
  // Without the exclusion only the hidden/unusable entries drop.
  assert.deepEqual(
    core.hostButtons(compatible).map(({ button }) => button.id),
    ["open-sight", "toggle-depth"],
  );
  // Defensive: a non-map (discovery failed) yields no buttons.
  assert.deepEqual(core.hostButtons(null), []);
});

test("hostButtons: the DR plugin's own manifest renders nothing in the webapp", () => {
  // The real manifest the plugin publishes, discovered by the real
  // compatibility filter — the exact path the webapp host takes.
  const manifest = buildManifest("/plotterext/signalk-dead-reckoning", "0.0.0");
  const compatible = core.compatibleExtensions(
    { ["signalk-dead-reckoning"]: manifest },
    core.HOST_CAPABILITIES,
  );
  // The webapp's own plugin's buttons duplicate the native toolbar →
  // none render.
  assert.deepEqual(core.hostButtons(compatible, [core.SELF_EXTENSION_ID]), []);
  // Without the exclusion only the statically visible buttons would
  // render — the context-only ones (release, confirm, pending) stay
  // hidden, as their manifest default says.
  assert.deepEqual(
    core.hostButtons(compatible).map(({ button }) => button.id),
    ["open-sight", "override-engage", "open-current"],
  );
});

// ---- overlay state store ----------------------------------------------------

test("OverlayStateStore: manifest defaults until the user overrides", () => {
  const storage = fakeStorage();
  const store = new core.OverlayStateStore(storage);
  const spec = core.overlaySpec({ id: "depth", opacity: 0.9 });
  assert.deepEqual(store.effective(spec, "ext"), {
    visible: true,
    opacity: 0.9,
  });
  store.set("ext", "depth", { visible: false });
  assert.deepEqual(store.effective(spec, "ext"), {
    visible: false,
    opacity: 0.9,
  });
  // Out-of-range persisted opacity falls back to the manifest value.
  store.set("ext", "depth", { opacity: 7 });
  assert.deepEqual(store.effective(spec, "ext"), {
    visible: false,
    opacity: 0.9,
  });
  // Persistence round-trips through a fresh store.
  const reloaded = new core.OverlayStateStore(storage);
  assert.deepEqual(reloaded.effective(spec, "ext").visible, false);
  // Dropping the extension resets to defaults.
  store.dropExtension("ext");
  assert.deepEqual(store.effective(spec, "ext").visible, true);
});

// ---- geometry --------------------------------------------------------------

test("mercator helpers round-trip", () => {
  for (const lng of [0, 24, -179.5, 179.5]) {
    assert.ok(
      Math.abs(core.xToLng(core.lngToX(lng)) - lng) < 1e-9,
      `lng ${lng}`,
    );
  }
  for (const lat of [0, 60.1699, -33.87, 84, -84]) {
    assert.ok(
      Math.abs(core.yToLat(core.latToY(lat)) - lat) < 1e-6,
      `lat ${lat}`,
    );
  }
  // Beyond the projection's range clamps instead of diverging.
  assert.equal(core.latToY(90), core.latToY(85.0511287798066));
});

test("metersPerPixel matches the 256 px-tile convention", () => {
  assert.ok(Math.abs(core.metersPerPixel(0, 0) - 156543.03392804097) < 1e-6);
  assert.ok(
    Math.abs(core.metersPerPixel(60, 0) - 156543.03392804097 * 0.5) < 1e-6,
  );
  assert.ok(
    Math.abs(core.metersPerPixel(0, 10) - 156543.03392804097 / 1024) < 1e-6,
  );
});

test("buildFrameRequest: extent covers the viewport, resolution per image pixel", () => {
  const view = {
    centerLng: 24,
    centerLat: 60,
    zoom: 10,
    width: 800,
    height: 600,
  };
  const req = core.buildFrameRequest(view, {
    overlayId: "depth",
    requestId: "r1",
    pixelRatio: 2,
    liveInterval: 200,
  });
  const mpp = core.metersPerPixel(60, 10);
  assert.equal(req.overlayId, "depth");
  assert.equal(req.requestId, "r1");
  // Half the viewport in metres on either side of the centre.
  assert.ok(Math.abs(req.extent[2] - core.lngToX(24) - 400 * mpp) < 1e-6);
  assert.equal(req.width, 1600);
  assert.equal(req.height, 1200);
  assert.equal(req.pixelRatio, 2);
  // Metres per IMAGE pixel (not per CSS pixel).
  assert.ok(Math.abs(req.resolution - mpp / 2) < 1e-9);
  assert.equal(req.zoom, 10);
  assert.equal(req.rotation, 0);
  assert.equal(req.liveInterval, 200);
  // The bounds are the same box as lon/lat.
  assert.ok(Math.abs(req.bounds[0] - core.xToLng(req.extent[0])) < 1e-6);
  assert.ok(Math.abs(req.bounds[3] - core.yToLat(req.extent[3])) < 1e-6);
});

test("buildFrameRequest: antimeridian crossing takes the API's form", () => {
  // A viewport centred near +180 with a ~90° span: west normalizes
  // past 180, so the bounds must come out west > east. (A span of
  // 360° or more is the whole world — that legitimately comes out
  // [-180, 180], not the crossing form.)
  const view = {
    centerLng: 179.9,
    centerLat: 0,
    zoom: 5,
    width: 2000,
    height: 1000,
  };
  const req = core.buildFrameRequest(view, {
    overlayId: "depth",
    requestId: "r2",
    pixelRatio: 1,
  });
  assert.ok(
    req.bounds[0] > req.bounds[2],
    `west ${req.bounds[0]} > east ${req.bounds[2]}`,
  );
  // A world-spanning box comes out as -180..180.
  const wide = core.buildFrameRequest(
    { centerLng: 0, centerLat: 0, zoom: 1, width: 4000, height: 1000 },
    { overlayId: "depth", requestId: "r3", pixelRatio: 1 },
  );
  assert.deepEqual(wide.bounds[0], -180);
  assert.deepEqual(wide.bounds[2], 180);
});

test("framePlacement: a frame built from the current view fills the viewport", () => {
  const view = {
    centerLng: 24.5,
    centerLat: 60.2,
    zoom: 12.5,
    width: 1024,
    height: 768,
  };
  const req = core.buildFrameRequest(view, {
    overlayId: "depth",
    requestId: "r3",
    pixelRatio: 1,
  });
  const p = core.framePlacement({ extent: req.extent }, view);
  assert.ok(Math.abs(p.x) < 1e-9);
  assert.ok(Math.abs(p.y) < 1e-9);
  assert.ok(Math.abs(p.width - view.width) < 1e-6);
  assert.ok(Math.abs(p.height - view.height) < 1e-6);
  // A panned-on view places the stale frame where its extent now sits.
  const moved = { ...view, centerLng: view.centerLng + 0.001 };
  const p2 = core.framePlacement({ extent: req.extent }, moved);
  assert.ok(p2.x < 0, "moved east → the frame slides left");
});

// ---- frame gate -------------------------------------------------------------

test("acceptFrame: request answered in order, superseded after a newer one", () => {
  const gate = { lastRequestId: "r1", lastLiveAt: 0, liveInterval: 200 };
  assert.deepEqual(core.acceptFrame(gate, { requestId: "r1" }, 1000), {
    accepted: true,
  });
  gate.lastRequestId = "r2";
  assert.deepEqual(core.acceptFrame(gate, { requestId: "r1" }, 1100), {
    accepted: false,
    reason: "overlays.superseded",
  });
});

test("acceptFrame: live frames are paced by liveInterval", () => {
  const gate = { lastRequestId: null, lastLiveAt: 0, liveInterval: 200 };
  assert.deepEqual(core.acceptFrame(gate, {}, 300), { accepted: true });
  assert.deepEqual(core.acceptFrame(gate, {}, 400), {
    accepted: false,
    reason: "overlays.throttled",
  });
  assert.deepEqual(core.acceptFrame(gate, {}, 601), { accepted: true });
  // A requested frame counts as fresh content for pacing purposes.
  gate.lastRequestId = "r9";
  assert.deepEqual(core.acceptFrame(gate, { requestId: "r9" }, 610), {
    accepted: true,
  });
  assert.deepEqual(core.acceptFrame(gate, {}, 700), {
    accepted: false,
    reason: "overlays.throttled",
  });
});

// ---- host-side overlay API ---------------------------------------------------

test("makeMethods: units.get answers the host's preferred units", async () => {
  const { host } = makeOverlayHost({ units: { depth: "foot" } });
  const api = host.makeMethods({
    kind: "background",
    extId: "ext",
    conn: {
      publish() {
        return true;
      },
      close() {},
    },
  });
  assert.deepEqual(await api["units.get"](), { units: { depth: "foot" } });
  const plain = makeOverlayHost();
  const api2 = plain.host.makeMethods({
    kind: "widget",
    extId: "ext",
    conn: {
      publish() {
        return true;
      },
      close() {},
    },
  });
  assert.deepEqual(await api2["units.get"](), { units: { depth: "m" } });
});

test("makeMethods: map.getView needs a chart, answers the viewport otherwise", async () => {
  const { host } = makeOverlayHost();
  const ctx = {
    kind: "background",
    extId: "ext",
    conn: {
      publish() {
        return true;
      },
      close() {},
    },
  };
  const api = host.makeMethods(ctx);
  await assert.rejects(api["map.getView"]());
  // A fake Leaflet map.
  host.getMap = () => ({
    getSize: () => ({ x: 800, y: 600 }),
    getCenter: () => ({ lng: 24, lat: 60 }),
    getZoom: () => 10,
    getBounds: () => ({
      getWest: () => 23.9,
      getSouth: () => 59.9,
      getEast: () => 24.1,
      getNorth: () => 60.1,
    }),
  });
  const view = await api["map.getView"]();
  assert.deepEqual(view.center, [24, 60]);
  assert.equal(view.zoom, 10);
  assert.ok(Math.abs(view.bounds[0] - 23.9) < 1e-9, `west ${view.bounds[0]}`);
  assert.ok(Math.abs(view.bounds[2] - 24.1) < 1e-9, `east ${view.bounds[2]}`);
  assert.equal(view.bounds[1], 59.9);
  assert.equal(view.bounds[3], 60.1);
});

test("makeMethods: map.center / map.fitBounds validate params", async () => {
  const { host } = makeOverlayHost();
  const api = host.makeMethods({
    kind: "widget",
    extId: "ext",
    conn: {
      publish() {
        return true;
      },
      close() {},
    },
  });
  await assert.rejects(api["map.center"]({ position: [24] }));
  await assert.rejects(api["map.center"]({}));
  await assert.rejects(api["map.fitBounds"]({ bounds: [1, 2, 3] }));
  await assert.rejects(api["map.center"]({ position: [24, 60] })); // no chart
});

test("makeMethods: map.center / map.fitBounds refused while follow engaged", async () => {
  // Center-on-vessel owns the view while engaged: freeform view moves
  // (an extension's included) only happen once follow is released.
  const { host } = makeOverlayHost();
  const api = host.makeMethods({
    kind: "widget",
    extId: "ext",
    conn: {
      publish() {
        return true;
      },
      close() {},
    },
  });
  host.getMap = () => ({ setView() {}, fitBounds() {} });
  host.getFollow = () => true;
  await assert.rejects(
    api["map.center"]({ position: [24, 60] }),
    /locked on the vessel/,
  );
  await assert.rejects(
    api["map.fitBounds"]({ bounds: [23, 59, 25, 61] }),
    /locked on the vessel/,
  );
  // Released follow lets the moves through again.
  host.getMap = () => ({
    setView() {},
    fitBounds() {},
  });
  host.getFollow = () => false;
  await api["map.center"]({ position: [24, 60] });
  await api["map.fitBounds"]({ bounds: [23, 59, 25, 61] });
});

test("syncOverlays: specs, runtime contexts, and state broadcast", () => {
  const { host, created } = makeOverlayHost();
  const ext = core
    .compatibleExtensions(
      { livedepth: overlayManifest() },
      core.HOST_CAPABILITIES,
    )
    .get("livedepth");
  host.syncOverlays("livedepth", ext);
  assert.deepEqual(created, ["livedepth/renderer"]);
  const spec = host.overlaySpecs.get("livedepth").get("depth");
  assert.equal(spec.runtime, "renderer");
  assert.equal(spec.minZoom, 4);
  // Second pass is idempotent — no duplicate runtime, no reset specs.
  host.syncOverlays("livedepth", ext);
  assert.deepEqual(created, ["livedepth/renderer"]);
});

test("syncOverlays: runtime whose URL changed is recreated", () => {
  const { host, created } = makeOverlayHost();
  const ext = core
    .compatibleExtensions(
      { livedepth: overlayManifest() },
      core.HOST_CAPABILITIES,
    )
    .get("livedepth");
  host.syncOverlays("livedepth", ext);
  const bumped = overlayManifest({
    background: [
      {
        id: "renderer",
        type: "iframe",
        url: "/plotterext/signalk-livedepth-plugin/renderer2.html",
      },
    ],
  });
  host.syncOverlays(
    "livedepth",
    core
      .compatibleExtensions({ livedepth: bumped }, core.HOST_CAPABILITIES)
      .get("livedepth"),
  );
  assert.deepEqual(created, ["livedepth/renderer", "livedepth/renderer"]);
  assert.equal(host.bgCtxs.size, 1);
});

test("overlay.list answers the extension's overlays with state", async () => {
  const { host } = makeOverlayHost();
  const ctx = {
    kind: "background",
    extId: "livedepth",
    conn: {
      publish() {
        return true;
      },
      close() {},
    },
  };
  const api = host.makeMethods(ctx);
  assert.deepEqual(await api["overlay.list"](), { overlays: [] }); // nothing synced yet
  const ext = core
    .compatibleExtensions(
      { livedepth: overlayManifest() },
      core.HOST_CAPABILITIES,
    )
    .get("livedepth");
  host.syncOverlays("livedepth", ext);
  const listed = await api["overlay.list"]();
  assert.equal(listed.overlays.length, 1);
  assert.equal(listed.overlays[0].id, "depth");
  assert.equal(listed.overlays[0].visible, true);
  assert.equal(listed.overlays[0].suspended, false);
});

test("overlay.setVisibility: persists, broadcasts, and drives requests", async () => {
  const { host } = makeOverlayHost();
  const ext = core
    .compatibleExtensions(
      { livedepth: overlayManifest() },
      core.HOST_CAPABILITIES,
    )
    .get("livedepth");
  host.syncOverlays("livedepth", ext);
  const events = [];
  host.publishOverlayState = (extId, id, state) =>
    events.push({ extId, id, state });
  // A fake viewport so the wake path reaches the request machinery.
  host.currentView = () => ({
    centerLng: 24,
    centerLat: 60,
    zoom: 10,
    width: 800,
    height: 600,
  });
  let requests = 0;
  host.requestOverlay = () => {
    requests++;
  };
  const ctx = {
    kind: "background",
    extId: "livedepth",
    conn: {
      publish() {
        return true;
      },
      close() {},
    },
  };
  const api = host.makeMethods(ctx);
  await api["overlay.setVisibility"]({ ids: ["depth"], visible: false });
  assert.deepEqual(events.at(-1).state, {
    visible: false,
    opacity: 0.85,
    suspended: false,
  });
  assert.equal(
    host.overlayStore.effective(
      host.overlaySpecs.get("livedepth").get("depth"),
      "livedepth",
    ).visible,
    false,
  );
  // Showing again re-requests a frame for the woken layer.
  const before = requests;
  await api["overlay.setVisibility"]({ ids: ["depth"], visible: true });
  assert.ok(requests > before, "waking a layer re-requests frames");
  // Validation: ids required, boolean required, opacity in range.
  await assert.rejects(api["overlay.setVisibility"]({ visible: true }));
  await assert.rejects(
    api["overlay.setVisibility"]({ ids: ["depth"], visible: "yes" }),
  );
  await assert.rejects(
    api["overlay.setOpacity"]({ ids: ["depth"], opacity: 5 }),
  );
});

test("acceptOverlayFrame: ownership, gating, and refusal closes the bitmap", () => {
  const { host } = makeOverlayHost();
  const ext = core
    .compatibleExtensions(
      { livedepth: overlayManifest() },
      core.HOST_CAPABILITIES,
    )
    .get("livedepth");
  host.syncOverlays("livedepth", ext);
  const ctx = {
    kind: "background",
    extId: "livedepth",
    conn: {
      publish() {
        return true;
      },
      close() {},
    },
  };
  let closed = 0;
  const image = { width: 1600, height: 1200, close: () => closed++ };
  // Unknown overlay → refuses.
  assert.throws(
    () =>
      host.acceptOverlayFrame(ctx, {
        overlayId: "nope",
        extent: [0, 0, 1, 1],
        image,
      }),
    /unknown overlay/,
  );
  assert.equal(closed, 1);
  // A request the host sent: accepted, and the host owns the bitmap.
  const view = {
    centerLng: 24,
    centerLat: 60,
    zoom: 10,
    width: 800,
    height: 600,
  };
  host.requestOverlay(
    "livedepth",
    host.overlaySpecs.get("livedepth").get("depth"),
    view,
  );
  const gate = host.gateFor("livedepth/depth");
  assert.ok(gate.lastRequestId, "the request was registered");
  const verdict = host.acceptOverlayFrame(ctx, {
    overlayId: "depth",
    requestId: gate.lastRequestId,
    extent: [0, 0, 1, 1],
    image,
  });
  assert.deepEqual(verdict, { accepted: true });
  assert.equal(closed, 1, "accepted bitmaps are not closed");
  assert.equal(host.overlayFrames.get("livedepth/depth").image, image);
  // A stale frame (older request id) is refused and closed.
  const stale = { width: 10, height: 10, close: () => closed++ };
  const staleVerdict = host.acceptOverlayFrame(ctx, {
    overlayId: "depth",
    requestId: "r-old",
    extent: [0, 0, 1, 1],
    image: stale,
  });
  assert.deepEqual(staleVerdict, {
    accepted: false,
    reason: "overlays.superseded",
  });
  assert.equal(closed, 2, "refused bitmaps are closed by the host");
  // A live frame right after the requested one is throttled.
  const live = { width: 10, height: 10, close: () => closed++ };
  const liveVerdict = host.acceptOverlayFrame(ctx, {
    overlayId: "depth",
    extent: [0, 0, 1, 1],
    image: live,
  });
  assert.deepEqual(liveVerdict, {
    accepted: false,
    reason: "overlays.throttled",
  });
  assert.equal(closed, 3);
});

test("teardownOverlays: runtimes, gates, frames and state all go", () => {
  const { host, storage } = makeOverlayHost();
  const ext = core
    .compatibleExtensions(
      { livedepth: overlayManifest() },
      core.HOST_CAPABILITIES,
    )
    .get("livedepth");
  host.syncOverlays("livedepth", ext);
  host.overlayStore.set("livedepth", "depth", { visible: false });
  host.teardownOverlays("livedepth");
  assert.equal(host.bgCtxs.size, 0);
  assert.equal(host.overlaySpecs.size, 0);
  assert.equal(host.overlayGates.size, 0);
  assert.equal(host.overlayFrames.size, 0);
  // Persisted overrides for the vanished extension are dropped.
  assert.equal(
    storage.getItem(core.overlayStateKey()).includes("livedepth"),
    false,
  );
});
