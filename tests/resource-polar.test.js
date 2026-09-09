/**
 * Unit tests for the `polars` resource contract module (SPEC §3.1
 * inertial-polar resource path): pointer/factor parsing, table
 * validation, interpolation semantics, and the in-process resource
 * load with its degrade-to-null failure modes.
 *
 * @file resource-polar.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  POLAR_RESOURCE_TYPE,
  parseActivePolarId,
  parsePerformanceFactor,
  isInterpolatableTable,
  interpolatePolarSpeed,
  createPolarSpeedModel,
  loadActivePolarModel,
} = require("../plugin/resource-polar.js");

/**
 * Canonical test table (m/s, rad): TWS [4, 12] × TWA [30°, 180°].
 * Midpoint (8 m/s, 105°) interpolates to the 4-corner mean: 3 m/s.
 */
const TABLE = {
  kind: "polarTable",
  axes: { tws: [4, 12], twa: [Math.PI / 6, Math.PI] },
  values: {
    boatSpeedMatrix: [
      [2.0, 1.0],
      [6.0, 3.0],
    ],
  },
  symmetry: { portStarboardSymmetric: true },
};

const MID_TWA = (Math.PI / 6 + Math.PI) / 2;

/** `TABLE` normalized to the interpolation grid shape (see toGrid). */
const GRID = {
  tws: [4, 12],
  twa: [Math.PI / 6, Math.PI],
  matrix: [
    [2.0, 1.0],
    [6.0, 3.0],
  ],
  symmetric: true,
};

// --- parseActivePolarId --------------------------------------------------

test("parseActivePolarId: accepts the delta, getSelfPath, and API URL forms", () => {
  assert.strictEqual(
    parseActivePolarId({ href: "/resources/polars/my-polar" }),
    "my-polar",
  );
  assert.strictEqual(
    parseActivePolarId({ value: { href: "/resources/polars/my-polar" } }),
    "my-polar",
  );
  assert.strictEqual(
    parseActivePolarId({
      href: "/signalk/v1/api/resources/polars/caf%C3%A9",
    }),
    "café",
  );
});

test("parseActivePolarId: null for unset, malformed, or foreign values", () => {
  assert.strictEqual(parseActivePolarId(null), null);
  assert.strictEqual(parseActivePolarId(undefined), null);
  assert.strictEqual(parseActivePolarId("polars/x"), null);
  assert.strictEqual(parseActivePolarId({}), null);
  assert.strictEqual(parseActivePolarId({ href: "/resources/charts/x" }), null);
});

// --- parsePerformanceFactor ---------------------------------------------

test("parsePerformanceFactor: reads number and wrapped forms, clamps [0,1]", () => {
  assert.strictEqual(parsePerformanceFactor(0.5), 0.5);
  assert.strictEqual(parsePerformanceFactor({ value: 0.75 }), 0.75);
  assert.strictEqual(parsePerformanceFactor(2), 1);
  assert.strictEqual(parsePerformanceFactor(-1), 0);
  // Unset/invalid → 1 (polar-management publishes 1 as its default).
  assert.strictEqual(parsePerformanceFactor(null), 1);
  assert.strictEqual(parsePerformanceFactor("high"), 1);
});

// --- isInterpolatableTable ----------------------------------------------

test("isInterpolatableTable: accepts the canonical shape", () => {
  assert.strictEqual(isInterpolatableTable(TABLE), true);
});

test("isInterpolatableTable: rejects malformed tables", () => {
  assert.strictEqual(isInterpolatableTable(null), false);
  assert.strictEqual(isInterpolatableTable({}), false);
  // Matrix not matching the axes' dimensions.
  assert.strictEqual(
    isInterpolatableTable({
      axes: TABLE.axes,
      values: { boatSpeedMatrix: [[1, 2, 3]] },
    }),
    false,
  );
  // Non-ascending axis.
  assert.strictEqual(
    isInterpolatableTable({
      axes: { tws: [12, 4], twa: TABLE.axes.twa },
      values: TABLE.values,
    }),
    false,
  );
  // Non-numeric cell.
  assert.strictEqual(
    isInterpolatableTable({
      axes: TABLE.axes,
      values: { boatSpeedMatrix: [[2, "fast"]] },
    }),
    false,
  );
});

// --- interpolatePolarSpeed ----------------------------------------------

test("interpolatePolarSpeed: bilinear inside the grid", () => {
  assert.ok(Math.abs(interpolatePolarSpeed(GRID, 8, MID_TWA) - 3.0) < 1e-9);
  // Exact grid nodes.
  assert.ok(Math.abs(interpolatePolarSpeed(GRID, 4, Math.PI / 6) - 2.0) < 1e-9);
  assert.ok(Math.abs(interpolatePolarSpeed(GRID, 12, Math.PI) - 3.0) < 1e-9);
});

test("interpolatePolarSpeed: port tack mirrors starboard on symmetric tables", () => {
  assert.ok(
    Math.abs(
      interpolatePolarSpeed(GRID, 8, -MID_TWA) -
        interpolatePolarSpeed(GRID, 8, MID_TWA),
    ) < 1e-9,
  );
});

test("interpolatePolarSpeed: out-of-range handling is conservative", () => {
  // TWS below the lightest column: scales linearly toward zero.
  assert.ok(Math.abs(interpolatePolarSpeed(GRID, 2, Math.PI / 6) - 1.0) < 1e-9);
  assert.strictEqual(interpolatePolarSpeed(GRID, 0, MID_TWA), 0);
  // Pinching below the closest-winded angle: scales toward zero.
  assert.ok(
    Math.abs(interpolatePolarSpeed(GRID, 4, Math.PI / 12) - 1.0) < 1e-9,
  );
  // Dead run beyond the last column: clamps to it.
  assert.ok(Math.abs(interpolatePolarSpeed(GRID, 8, 2 * Math.PI) - 2.0) < 1e-9);
  // TWS above the strongest row: clamps to it (hull speed).
  assert.ok(Math.abs(interpolatePolarSpeed(GRID, 25, MID_TWA) - 4.5) < 1e-9);
});

// --- createPolarSpeedModel ----------------------------------------------

test("createPolarSpeedModel: applies the performance factor", () => {
  const model = createPolarSpeedModel({ id: "x", table: TABLE });
  assert.strictEqual(model.available, true);
  assert.strictEqual(model.id, "x");
  assert.strictEqual(model.performanceFactor, 1);
  assert.ok(Math.abs(model.speedAt(8, MID_TWA) - 3.0) < 1e-9);

  const derated = createPolarSpeedModel({
    id: "x",
    table: TABLE,
    performanceFactor: 0.5,
  });
  assert.ok(Math.abs(derated.speedAt(8, MID_TWA) - 1.5) < 1e-9);
});

test("createPolarSpeedModel: null on a malformed table", () => {
  assert.strictEqual(createPolarSpeedModel({ id: "x", table: {} }), null);
});

// --- loadActivePolarModel -----------------------------------------------

/** Minimal fake app exposing a `polars` resource provider. */
function fakeApp({ table = TABLE, fail = false } = {}) {
  let fetches = 0;
  return {
    debugLogs: [],
    fetchCount() {
      return fetches;
    },
    debug(msg) {
      this.debugLogs.push(msg);
    },
    resourcesApi: {
      getResource: async (type, id) => {
        if (type !== POLAR_RESOURCE_TYPE) throw new Error("wrong type");
        fetches++;
        if (fail) throw new Error("boom");
        if (id === "missing") throw new Error("Polar not found");
        return table;
      },
    },
  };
}

const READ = {
  active: () => ({ href: "/resources/polars/test" }),
  none: () => null,
};

test("loadActivePolarModel: loads the active polar via the provider", async () => {
  const app = fakeApp();
  const { model, id, table } = await loadActivePolarModel({
    app,
    readValue: READ.active,
  });
  assert.strictEqual(id, "test");
  assert.strictEqual(table, TABLE);
  assert.strictEqual(model.id, "test");
  assert.ok(Math.abs(model.speedAt(8, MID_TWA) - 3.0) < 1e-9);
  assert.strictEqual(app.fetchCount(), 1);
});

test("loadActivePolarModel: no active pointer → null, no fetch", async () => {
  const app = fakeApp();
  const out = await loadActivePolarModel({ app, readValue: READ.none });
  assert.deepStrictEqual(out, { model: null, id: null, table: null });
  assert.strictEqual(app.fetchCount(), 0);
});

test("loadActivePolarModel: cached id skips the refetch, factor changes rebuild", async () => {
  const app = fakeApp();
  let factor = 1;
  const readValue = (p) =>
    p === "polars.performanceFactor" ? factor : READ.active();
  const first = await loadActivePolarModel({ app, readValue });
  assert.strictEqual(first.model.performanceFactor, 1);

  // Same id again → table served from cache.
  factor = 0.5;
  const second = await loadActivePolarModel({
    app,
    readValue,
    cachedId: first.id,
    cachedTable: first.table,
  });
  assert.strictEqual(app.fetchCount(), 1);
  assert.strictEqual(second.model.performanceFactor, 0.5);
  assert.ok(Math.abs(second.model.speedAt(8, MID_TWA) - 1.5) < 1e-9);
});

test("loadActivePolarModel: provider failure degrades to null without throwing", async () => {
  const app = fakeApp({ fail: true });
  const out = await loadActivePolarModel({ app, readValue: READ.active });
  assert.deepStrictEqual(out, { model: null, id: null, table: null });
  assert.ok(app.debugLogs.some((m) => /Polar load failed/.test(m)));
});

test("loadActivePolarModel: missing resource id degrades to null", async () => {
  const app = fakeApp();
  const out = await loadActivePolarModel({
    app,
    readValue: () => ({ href: "/resources/polars/missing" }),
  });
  assert.deepStrictEqual(out, { model: null, id: null, table: null });
});

test("loadActivePolarModel: no resourcesApi → unavailable, not an error", async () => {
  const out = await loadActivePolarModel({
    app: {},
    readValue: READ.active,
  });
  assert.deepStrictEqual(out, { model: null, id: null, table: null });
});

test("loadActivePolarModel: unusable table shape degrades to null", async () => {
  const app = fakeApp({ table: { kind: "polarTable" } });
  const out = await loadActivePolarModel({ app, readValue: READ.active });
  assert.deepStrictEqual(out, { model: null, id: null, table: null });
  assert.ok(app.debugLogs.some((m) => /unusable table/.test(m)));
});
