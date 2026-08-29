/**
 * Tests for the AIS target layer's pure helpers (work doc #23):
 * delta→store reducer, REST snapshot seed, staleness tri-state
 * (active → expiring → dropped/aged-out), SOG/COG position prediction,
 * marker specs, and the render-set builder.
 * Loads the browser ESM module directly, like dr-viewmodel.test.js.
 * @file dr-ais.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const vmPromise = import("../public/dr-viewmodel.js");

async function loadVm() {
  return vmPromise;
}

const closeTo = (actual, expected, tol, msg) =>
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${msg}: ${actual} vs ${expected} (±${tol})`,
  );

/** Fixed "now" for deterministic age arithmetic. */
const T0 = 1_700_000_000_000;
const ISO_T0 = new Date(T0).toISOString();
/** An AIS delta at a given age (ms before T0). */
const delta = (ctx, values, ageMs = 0) => ({
  context: ctx,
  updates: [
    {
      timestamp: new Date(T0 - ageMs).toISOString(),
      values,
    },
  ],
});
const POSITION = (lat, lon) => ({
  path: "navigation.position",
  value: { latitude: lat, longitude: lon },
});

test("distanceNm: 1° of latitude ≈ 60 nm", async () => {
  const vm = await loadVm();
  closeTo(vm.distanceNm([60, 24], [61, 24]), 60.04, 0.1, "1° lat");
  closeTo(vm.distanceNm([60, 24], [60, 24]), 0, 1e-9, "same point");
});

test("applyAisDelta: position report with timestamp, SI velocity kept", async () => {
  const vm = await loadVm();
  const store = new Map();
  vm.applyAisDelta(
    store,
    delta("vessels.urn:mrn:imo:mmsi:230123456", [
      POSITION(60.1, 24.2),
      { path: "navigation.courseOverGroundTrue", value: Math.PI / 2 },
      { path: "navigation.speedOverGround", value: 5.144 }, // ≈ 10 kn
    ]),
    T0,
  );
  assert.equal(store.size, 1, "one target");
  const t = store.get("vessels.urn:mrn:imo:mmsi:230123456");
  assert.equal(t.lat, 60.1);
  assert.equal(t.lon, 24.2);
  assert.equal(t.tMs, T0, "report timestamp drives tMs");
  closeTo(t.cogRad, Math.PI / 2, 1e-9, "cog");
  closeTo(t.sogMs, 5.144, 1e-9, "sog");
  assert.equal(t.receivedMs, T0);
});

test("applyAisDelta: name/mmsi paths and root value with buddy flag", async () => {
  const vm = await loadVm();
  const store = new Map();
  vm.applyAisDelta(
    store,
    delta("vessels.urn:mrn:imo:mmsi:111", [
      { path: "name", value: "MS ERIK" },
      { path: "mmsi", value: 230111111 },
    ]),
    T0,
  );
  vm.applyAisDelta(
    store,
    delta("vessels.urn:mrn:imo:mmsi:222", [
      {
        path: "",
        value: { name: "S/Y KAPRI", mmsi: "230222222", buddy: true },
      },
    ]),
    T0,
  );
  const a = store.get("vessels.urn:mrn:imo:mmsi:111");
  assert.equal(a.name, "MS ERIK");
  assert.equal(a.mmsi, "230111111");
  const b = store.get("vessels.urn:mrn:imo:mmsi:222");
  assert.equal(b.name, "S/Y KAPRI");
  assert.equal(b.mmsi, "230222222");
  assert.equal(b.buddy, true);
});

test("applyAisDelta: ignores deltas without context or updates", async () => {
  const vm = await loadVm();
  const store = new Map();
  vm.applyAisDelta(store, { updates: [{ values: [POSITION(1, 2)] }] }, T0);
  vm.applyAisDelta(store, { context: "vessels.urn:x" }, T0);
  assert.equal(store.size, 0);
});

test("aisMmsiFromContext: mmsi-shaped contexts yield an MMSI, others null", async () => {
  const vm = await loadVm();
  assert.equal(
    vm.aisMmsiFromContext("vessels.urn:mrn:imo:mmsi:230123456"),
    "230123456",
  );
  assert.equal(vm.aisMmsiFromContext("vessels.230123456"), "230123456");
  assert.equal(vm.aisMmsiFromContext("vessels.urn:mrn:signalk:uuid:abc"), null);
  assert.equal(vm.aisMmsiFromContext(null), null);
});

test("applyAisDelta: mmsi pre-seeds from the context before static data arrives", async () => {
  const vm = await loadVm();
  const store = new Map();
  // Position-only delta on an mmsi-keyed context — no name, no mmsi value.
  vm.applyAisDelta(
    store,
    delta("vessels.urn:mrn:imo:mmsi:230987654", [POSITION(60, 24)]),
    T0,
  );
  const t = store.get("vessels.urn:mrn:imo:mmsi:230987654");
  assert.equal(t.mmsi, "230987654", "mmsi derived from the context key");
  // A later explicit mmsi value still wins.
  vm.applyAisDelta(
    store,
    delta("vessels.urn:mrn:imo:mmsi:230987654", [
      { path: "mmsi", value: "999999999" },
    ]),
    T0,
  );
  assert.equal(t.mmsi, "999999999");
});

test("applyAisDelta: position-only updates refresh tMs, not older fields", async () => {
  const vm = await loadVm();
  const store = new Map();
  vm.applyAisDelta(
    store,
    delta("vessels.urn:mrn:imo:mmsi:333", [
      POSITION(60, 24),
      { path: "name", value: "OLD NAME" },
    ]),
    T0,
  );
  vm.applyAisDelta(
    store,
    delta(
      "vessels.urn:mrn:imo:mmsi:333",
      [{ path: "name", value: "NEW NAME" }],
      60_000,
    ),
  );
  const t = store.get("vessels.urn:mrn:imo:mmsi:333");
  assert.equal(t.name, "NEW NAME");
  assert.equal(t.tMs, T0, "name delta must not touch the position timestamp");
});

test("seedAisFromSnapshot: REST leaves, self/shadow excluded, report ts carried", async () => {
  const vm = await loadVm();
  const store = new Map();
  const shadow = "vessels.urn:mrn:signalk:uuid:shadow-1";
  vm.seedAisFromSnapshot(
    store,
    {
      vessels: {
        self: {
          navigation: {
            position: {
              value: { latitude: 1, longitude: 1 },
              timestamp: ISO_T0,
            },
          },
        },
        "vessels.urn:mrn:signalk:uuid:own": {
          navigation: { position: { value: { latitude: 2, longitude: 2 } } },
        },
        [shadow]: {
          navigation: {
            position: {
              value: { latitude: 3, longitude: 3 },
              timestamp: ISO_T0,
            },
          },
        },
        "vessels.urn:mrn:imo:mmsi:444": {
          name: { value: "TANKER" },
          mmsi: { value: "230444444" },
          navigation: {
            position: {
              value: { latitude: 60, longitude: 25 },
              timestamp: ISO_T0,
            },
            courseOverGroundTrue: { value: 0 },
            speedOverGround: { value: 0 },
          },
        },
      },
    },
    { selfContext: "vessels.urn:mrn:signalk:uuid:own", shadowContext: shadow },
  );
  assert.equal(store.size, 1, "only the real target");
  const t = store.get("vessels.urn:mrn:imo:mmsi:444");
  assert.ok(t, "target seeded");
  assert.equal(t.name, "TANKER");
  assert.equal(t.lat, 60);
  assert.equal(t.tMs, T0, "REST report timestamp drives staleness");
});

test("aisStaleness: active → expiring (3 min) → dropped (20 min)", async () => {
  const vm = await loadVm();
  const mk = (ageMs) => ({
    context: "vessels.x",
    lat: 60,
    lon: 24,
    tMs: T0 - ageMs,
    receivedMs: T0,
  });
  assert.equal(vm.aisStaleness(mk(10_000), T0), "active");
  assert.equal(vm.aisStaleness(mk(2 * 60_000), T0), "active");
  assert.equal(vm.aisStaleness(mk(3 * 60_000), T0), "expiring");
  assert.equal(vm.aisStaleness(mk(19 * 60_000), T0), "expiring");
  assert.equal(vm.aisStaleness(mk(20 * 60_000), T0), "dropped");
  assert.equal(vm.aisStaleness({ context: "vessels.x" }, T0), "dropped");
});

test("pruneAisStore: aged-out targets evicted, fresh kept, re-seedable", async () => {
  const vm = await loadVm();
  const store = new Map();
  vm.applyAisDelta(
    store,
    delta("vessels.urn:old", [POSITION(60, 24)], 25 * 60_000),
    T0,
  );
  vm.applyAisDelta(
    store,
    delta("vessels.urn:new", [POSITION(61, 24)], 30_000),
    T0,
  );
  assert.equal(store.size, 2);
  vm.pruneAisStore(store, T0);
  assert.equal(store.size, 1, "only the fresh target survives");
  assert.ok(store.has("vessels.urn:new"));
  // The store is a cache, not a log: a returning target re-seeds.
  vm.applyAisDelta(
    store,
    delta("vessels.urn:old", [POSITION(60.5, 24)], 1000),
    T0,
  );
  assert.ok(store.has("vessels.urn:old"));
});

test("predictAisPosition: dead-reckons along COG/SOG, horizon-capped", async () => {
  const vm = await loadVm();
  // 30 kn due east, reported 2 min ago → 1 nm east of the report.
  const t = {
    context: "vessels.urn:x",
    lat: 60,
    lon: 24,
    tMs: T0 - 2 * 60_000,
    receivedMs: T0 - 2 * 60_000,
    cogRad: Math.PI / 2,
    sogMs: 30 * (1852 / 3600), // 30 kn in m/s
  };
  const [lat, lon] = vm.predictAisPosition(t, T0);
  closeTo(lat, 60, 0.01, "lat stays ~60");
  // 1 nm east at 60N ≈ 0.0333° lon (cos(60°) scaling).
  closeTo(lon, 24.0333, 0.002, "lon +1 nm east");

  // 30 min old: prediction caps at the 3-minute horizon (1.5 nm).
  const far = { ...t, tMs: T0 - 30 * 60_000, receivedMs: T0 - 30 * 60_000 };
  const [, lon2] = vm.predictAisPosition(far, T0);
  closeTo(lon2, 24.05, 0.002, "capped at 1.5 nm");

  // No velocity → the report position, unchanged.
  const still = {
    context: "vessels.urn:x",
    lat: 60,
    lon: 24,
    tMs: T0,
    receivedMs: T0,
  };
  assert.deepEqual(vm.predictAisPosition(still, T0), [60, 24]);

  // Never reported a position → null.
  assert.equal(
    vm.predictAisPosition({ context: "vessels.urn:x", receivedMs: T0 }, T0),
    null,
  );
});

test("aisMarkerSpec: label fallbacks, rotation, range, leader, expiring", async () => {
  const vm = await loadVm();
  const fresh = {
    context: "vessels.urn:mrn:imo:mmsi:555",
    name: null,
    mmsi: "230555555",
    buddy: false,
    lat: 60,
    lon: 24,
    tMs: T0,
    receivedMs: T0,
    cogRad: 0,
    sogMs: 10 * (1852 / 3600),
    headingRad: Math.PI, // 180° — heading must win over COG
  };
  const spec = vm.aisMarkerSpec(fresh, T0, [60.5, 24]);
  assert.equal(spec.label, "MMSI 230555555", "mmsi label when unnamed");
  closeTo(spec.rotationDeg, 180, 0.001, "glyph rotated to heading");
  closeTo(spec.rangeNm, 30, 0.2, "range from own position");
  assert.equal(spec.color, vm.STYLE.ais);
  assert.ok(spec.leader, "active target gets a velocity leader");
  closeTo(spec.sogKn, 10, 0.001, "sog converted to knots");
  assert.ok(spec.tooltip.includes("MMSI 230555555"));

  // Named + buddy → green, name label.
  const buddy = { ...fresh, name: "S/Y KAPRI", buddy: true };
  assert.equal(vm.aisMarkerSpec(buddy, T0, null).color, vm.STYLE.aisBuddy);
  assert.equal(vm.aisMarkerSpec(buddy, T0, null).label, "S/Y KAPRI");

  // No own position → no range figure, still renders.
  const noOwn = vm.aisMarkerSpec(fresh, T0, null);
  assert.equal(noOwn.rangeNm, null);
  assert.ok(!noOwn.tooltip.includes("nm ·"), "no range part in tooltip");

  // Expiring (10 min old report): grey, no leader, tooltip says so.
  const expiring = {
    ...fresh,
    tMs: T0 - 10 * 60_000,
    receivedMs: T0 - 10 * 60_000,
  };
  const e = vm.aisMarkerSpec(expiring, T0, [60, 24]);
  assert.equal(e.expiring, true);
  assert.equal(e.color, vm.STYLE.aisExpiring);
  assert.equal(e.leader, null);
  assert.ok(e.tooltip.includes("expiring · last report 10m ago"));

  // Zero speed: no leader even while active.
  const moored = { ...fresh, sogMs: 0 };
  assert.equal(vm.aisMarkerSpec(moored, T0, null).leader, null);

  // No static data at all on an mmsi-keyed context → MMSI label
  // (derived from the context), never the unwieldy urn string.
  const bare = {
    context: "vessels.urn:mrn:imo:mmsi:230123456",
    name: null,
    mmsi: null,
    buddy: false,
    lat: 60,
    lon: 24,
    tMs: T0,
    receivedMs: T0,
    cogRad: null,
    sogMs: null,
    headingRad: null,
  };
  assert.equal(
    vm.aisMarkerSpec(
      { ...bare, mmsi: vm.aisMmsiFromContext(bare.context) },
      T0,
      null,
    ).label,
    "MMSI 230123456",
  );
  // uuid context without static data: context tail as the last resort.
  assert.equal(
    vm.aisMarkerSpec(
      { ...bare, context: "vessels.urn:mrn:signalk:uuid:some-boat" },
      T0,
      null,
    ).label,
    "urn:mrn:signalk:uuid:some-boat",
  );
});

test("aisTargetsForRender: drop, range filter, sort; without own renders all", async () => {
  const vm = await loadVm();
  const store = new Map();
  const mk = (ctx, lat, ageMs) =>
    vm.applyAisDelta(store, delta(ctx, [POSITION(lat, 24)], ageMs), T0);
  mk("vessels.urn:near", 60.1, 10_000); // ~6 nm
  mk("vessels.urn:far", 60.7, 10_000); // ~42 nm — beyond default 24
  mk("vessels.urn:gone", 60.2, 25 * 60_000); // aged out
  const own = [60, 24];
  const specs = vm.aisTargetsForRender(store, T0, own);
  assert.deepEqual(
    specs.map((s) => s.context),
    ["vessels.urn:near"],
  );
  // Without own there is no basis to range-filter — everything renders.
  assert.equal(vm.aisTargetsForRender(store, T0, null).length, 2);
  // Custom range keeps the far one, sorted nearest first.
  const wide = vm.aisTargetsForRender(store, T0, own, { rangeNm: 50 });
  assert.deepEqual(
    wide.map((s) => s.context),
    ["vessels.urn:near", "vessels.urn:far"],
  );
});

test("smoke: delta → store → render → age out (the full layer lifecycle)", async () => {
  const vm = await loadVm();
  const store = new Map();
  const own = [60, 24];
  // A crossing target 8 nm north, 12 kn southbound, report 1 min old.
  vm.applyAisDelta(
    store,
    delta(
      "vessels.urn:mrn:imo:mmsi:666",
      [
        POSITION(60.13, 24),
        { path: "name", value: "MS ERIK" },
        { path: "navigation.courseOverGroundTrue", value: Math.PI },
        { path: "navigation.speedOverGround", value: 12 * (1852 / 3600) },
      ],
      60_000,
    ),
    T0,
  );
  let specs = vm.aisTargetsForRender(store, T0, own);
  assert.equal(specs.length, 1);
  const spec = specs[0];
  assert.equal(spec.label, "MS ERIK");
  // Predicted 1 min along 180° at 12 kn = 0.2 nm south of the report.
  closeTo(spec.position[0], 60.13 - 0.2 / 60, 0.001, "predicted south");
  assert.ok(spec.leader, "leader drawn while active");
  // Pick instant is the prediction instant (tMs threading contract).
  const pickT = T0;
  assert.ok(pickT >= store.get("vessels.urn:mrn:imo:mmsi:666").tMs);

  // 10 minutes later: expiring.
  specs = vm.aisTargetsForRender(store, T0 + 10 * 60_000, own);
  assert.equal(specs.length, 1);
  assert.equal(specs[0].expiring, true);

  // 20+ minutes later: aged out of the render set, then the store.
  const late = T0 + 25 * 60_000;
  assert.equal(vm.aisTargetsForRender(store, late, own).length, 0);
  vm.pruneAisStore(store, late);
  assert.equal(store.size, 0);
});
