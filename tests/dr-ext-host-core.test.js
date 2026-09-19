/**
 * Unit tests for the pure plotter-extension host core (work doc #27):
 * manifest filtering, layout model, state keys, path ref-counting and
 * delta routing. DOM/bus glue is covered by dr-ext-host.test.js.
 *
 * @file dr-ext-host-core.test.js
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as core from "../public/dr-ext-host-core.js";

const CAPS = ["widgets", "panels.iframe", "signalk.stream", "signalk.put"];

/** A minimal valid manifest. */
function manifest(overrides = {}) {
  return {
    name: "Test",
    description: "",
    version: "1.0.0",
    apiVersion: "1",
    requires: ["widgets", "signalk.stream"],
    widgets: [
      {
        id: "gauge",
        title: "Gauge",
        type: "iframe",
        url: "/plotterext/test/gauge.html",
        size: "1x1",
      },
    ],
    ...overrides,
  };
}

test("parseSize: accepts 1x1..2x2, rejects everything else", () => {
  assert.deepEqual(core.parseSize("1x1"), { cols: 1, rows: 1 });
  assert.deepEqual(core.parseSize("2x1"), { cols: 2, rows: 1 });
  assert.deepEqual(core.parseSize("1x2"), { cols: 1, rows: 2 });
  assert.deepEqual(core.parseSize("2x2"), { cols: 2, rows: 2 });
  assert.equal(core.parseSize("3x1"), null);
  assert.equal(core.parseSize("1"), null);
  assert.equal(core.parseSize(""), null);
  assert.equal(core.parseSize(null), null);
  assert.equal(core.parseSize(2), null);
});

test("compatibleExtensions: offers only satisfiable manifests", () => {
  const collection = {
    ok: manifest(),
    needsMap: manifest({ requires: ["widgets", "map"] }),
    newerApi: manifest({ apiVersion: "2" }),
    unknownRequires: manifest({ requires: ["x-future.thing"] }),
  };
  const compat = core.compatibleExtensions(collection, CAPS);
  assert.deepEqual([...compat.keys()], ["ok"]);
});

test("compatibleExtensions: unknown sections ignored, no-contribution dropped", () => {
  const collection = {
    unknownSection: manifest({ widgets: undefined, buttons: [{ id: "b" }] }),
    empty: manifest({ widgets: [] }),
  };
  const compat = core.compatibleExtensions(collection, CAPS);
  assert.equal(compat.size, 0);
});

test("compatibleExtensions: contribution-level apiVersion omits entries", () => {
  const collection = {
    ext: manifest({
      widgets: [
        { id: "old", url: "/a.html", size: "1x1", apiVersion: "1" },
        { id: "new", url: "/b.html", size: "1x1", apiVersion: "2" },
        { id: "badsize", url: "/c.html", size: "3x3" },
      ],
    }),
  };
  const compat = core.compatibleExtensions(collection, CAPS);
  assert.deepEqual(
    compat.get("ext").widgets.map((w) => w.id),
    ["old"],
  );
});

test("firstFreeSlot: packs row-major, skips overlaps", () => {
  const placed = [{ size: "2x1", row: 0, col: 0 }];
  // Row 0 is full (2 cols) — next free for 1x1 is row 1.
  assert.deepEqual(core.firstFreeSlot(placed, "1x1"), { row: 1, col: 0 });
  // A 1x1 fits after the placed widget; a 2x2 no longer fits
  // anywhere (only one full row is free).
  assert.deepEqual(core.firstFreeSlot(placed, "1x1"), { row: 1, col: 0 });
  assert.deepEqual(core.firstFreeSlot(placed, "2x1"), { row: 1, col: 0 });
  assert.equal(core.firstFreeSlot(placed, "2x2"), null);
  // Empty grid: everything fits at origin.
  assert.deepEqual(core.firstFreeSlot([], "2x2"), { row: 0, col: 0 });
  // Full grid: nothing fits.
  const full = [
    { size: "2x1", row: 0, col: 0 },
    { size: "2x1", row: 1, col: 0 },
  ];
  assert.equal(core.firstFreeSlot(full, "1x1"), null);
});

test("layoutFromJSON: validates shape, ignores unknown anchors", () => {
  const good = core.layoutFromJSON({
    version: 1,
    areas: {
      "top-left": [
        {
          extensionId: "e",
          widgetId: "w",
          instanceId: "i1",
          size: "1x1",
          row: 0,
          col: 0,
        },
      ],
      "bottom-center": [{ extensionId: "x" }],
    },
  });
  assert.equal(good.areas["top-left"].length, 1);
  assert.equal(good.areas["top-right"].length, 0);
  assert.equal(good.areas["bottom-center"], undefined);
  assert.equal(core.layoutFromJSON(null), null);
  assert.equal(core.layoutFromJSON("junk"), null);
  // Invalid entries are dropped, not fatal.
  const partial = core.layoutFromJSON({
    areas: { "top-left": [{ extensionId: "e" }, null, 42] },
  });
  assert.equal(partial.areas["top-left"].length, 0);
});

test("pruneLayout: drops placements whose extension/widget vanished", () => {
  const compat = core.compatibleExtensions({ e: manifest() }, CAPS);
  const layout = {
    version: 1,
    areas: {
      "top-left": [
        {
          extensionId: "e",
          widgetId: "gauge",
          instanceId: "keep",
          size: "1x1",
          row: 0,
          col: 0,
        },
        {
          extensionId: "gone",
          widgetId: "w",
          instanceId: "drop",
          size: "1x1",
          row: 1,
          col: 0,
        },
        {
          extensionId: "e",
          widgetId: "no-such-widget",
          instanceId: "drop2",
          size: "1x1",
          row: 1,
          col: 1,
        },
      ],
      "top-right": [],
    },
  };
  const out = core.pruneLayout(layout, compat);
  assert.equal(out.changed, true);
  const kept = out.layout.areas["top-left"];
  assert.equal(kept.length, 1);
  assert.equal(kept[0].instanceId, "keep");
  // A second prune of the clean layout is a no-op.
  const out2 = core.pruneLayout(out.layout, compat);
  assert.equal(out2.changed, false);
});

test("pruneLayout: overlapping stale entries are dropped, not trusted", () => {
  const compat = core.compatibleExtensions(
    { e: manifest({ widgets: [w("big", "2x2")] }) },
    CAPS,
  );
  const layout = {
    version: 1,
    areas: {
      "top-left": [
        pl("e", "big", "a", "2x2", 0, 0),
        pl("e", "big", "b", "2x2", 0, 0), // hand-edited overlap
      ],
      "top-right": [],
    },
  };
  const out = core.pruneLayout(layout, compat);
  assert.equal(out.layout.areas["top-left"].length, 1);
  assert.equal(out.layout.areas["top-left"][0].instanceId, "a");
});

function w(id, size) {
  return { id, title: id, type: "iframe", url: `/x/${id}.html`, size };
}

function pl(extensionId, widgetId, instanceId, size, row, col) {
  return { extensionId, widgetId, instanceId, size, row, col };
}

test("StateStore: extension and instance scopes are separate keys", () => {
  /** @type {Map<string, string>} */
  const backing = new Map();
  const storage = {
    getItem: (k) => backing.get(k) ?? null,
    setItem: (k, v) => backing.set(k, v),
  };
  const store = new core.StateStore(storage);
  assert.deepEqual(store.get("e", null), {});
  store.write("e", null, { theme: "dark" });
  store.write("e", "inst-1", { path: "navigation.speedOverGround" });
  assert.deepEqual(store.get("e", null), { theme: "dark" });
  assert.deepEqual(store.get("e", "inst-1"), {
    path: "navigation.speedOverGround",
  });
  assert.deepEqual(store.get("e", "inst-1", ["nope"]), {});
  // Corrupt JSON degrades to empty, not a throw.
  backing.set(core.stateKey("e", "bad"), "{not json");
  assert.deepEqual(store.get("e", "bad"), {});
});

test("PathRefRegistry: refs, drops and routing", () => {
  const reg = new core.PathRefRegistry();
  const ctxA = { name: "a" };
  const ctxB = { name: "b" };
  const s1 = reg.subscribe(ctxA, ["p.one", "p.two"]);
  reg.subscribe(ctxB, ["p.two"]);
  const s3 = reg.subscribe(ctxA, ["p.two"]); // second sub, same path+ctx
  assert.deepEqual(reg.activePaths().sort(), ["p.one", "p.two"]);
  assert.deepEqual(reg.contextsForPath("p.two"), new Set([ctxA, ctxB]));
  assert.deepEqual(reg.contextsForPath("p.one"), new Set([ctxA]));

  // Dropping one of A's subs keeps the path held by its other sub.
  reg.unsubscribe(s3);
  assert.deepEqual(reg.contextsForPath("p.two"), new Set([ctxA, ctxB]));

  reg.unsubscribe(s1);
  assert.deepEqual(reg.contextsForPath("p.one"), new Set());
  assert.deepEqual(reg.contextsForPath("p.two"), new Set([ctxB]));

  // Unknown subscription id → null.
  assert.equal(reg.unsubscribe("nope"), null);

  // dropContext releases everything the context held.
  const held = reg.dropContext(ctxB);
  assert.deepEqual(held, ["p.two"]);
  assert.deepEqual(reg.activePaths(), []);
});

test("selfDeltaValues: own-vessel values only, meta skipped", () => {
  const self = "vessels.urn:mrn:signalk:uuid:abc";
  const delta = {
    context: self,
    updates: [
      {
        timestamp: "2026-09-19T10:00:00Z",
        $source: "sources.dr",
        values: [
          {
            path: "navigation.deadReckoning.state",
            value: { status: "underway" },
          },
        ],
        meta: [
          { path: "navigation.deadReckoning.state", value: { units: "" } },
        ],
      },
    ],
  };
  assert.deepEqual(core.selfDeltaValues(delta, self), [
    {
      path: "navigation.deadReckoning.state",
      value: { status: "underway" },
      timestamp: "2026-09-19T10:00:00Z",
      $source: "sources.dr",
    },
  ]);
  // Other vessels (AIS) are not part of the v1 relay.
  assert.deepEqual(
    core.selfDeltaValues({ context: "vessels.urn:other", updates: [] }, self),
    [],
  );
  // literals `vessels.self` also count.
  assert.equal(
    core.selfDeltaValues({ context: "vessels.self", updates: [] }, self).length,
    0,
  );
  // $source falls back to the source label.
  assert.equal(
    core.selfDeltaValues(
      {
        context: "vessels.self",
        updates: [
          { source: { label: "gps" }, values: [{ path: "x", value: 1 }] },
        ],
      },
      self,
    )[0].$source,
    "gps",
  );
});

test("newInstanceId: v4-shaped, unique", () => {
  const a = core.newInstanceId();
  const b = core.newInstanceId();
  assert.match(
    a,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.notEqual(a, b);
});
