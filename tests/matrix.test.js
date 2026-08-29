/**
 * Tests for the EMA matrix store (SPEC §4.1, §6.1).
 * @file matrix.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

const { openDatabase } = require("../plugin/db.js");
const {
  MatrixStore,
  learningRate,
  effectiveHitCount,
  UNKNOWN_STATE,
} = require("../plugin/matrix.js");

let tempDir;
let db;

test.before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "dr-matrix-"));
  db = openDatabase(join(tempDir, "matrix.sqlite"));
});

test.after(async () => {
  db?.close();
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

const ctx = {
  sail_state: "sailing",
  sea_state: "unknown",
  stwKn: 5.2,
  awaDeg: 42,
  heelDeg: 10,
};

test("lookup on an empty bin returns neutral defaults", () => {
  const store = new MatrixStore(db);
  const c = store.lookup(ctx);
  assert.strictEqual(c.leeway_angle, 0);
  assert.strictEqual(c.speed_loss, 0);
  assert.strictEqual(c.upwash_correction, 0);
  assert.strictEqual(c.hit_count, 0);
});

test("update writes the observed correction on a fresh bin (alpha=1)", () => {
  const store = new MatrixStore(db);
  store.update(ctx, {
    leeway_angle: 4,
    speed_loss: 0.1,
    upwash_correction: 0.2,
  });
  const c = store.lookup(ctx);
  assert.strictEqual(c.leeway_angle, 4);
  assert.strictEqual(c.speed_loss, 0.1);
  assert.strictEqual(c.upwash_correction, 0.2);
  assert.strictEqual(c.hit_count, 5); // 1 live hit * 5x multiplier
});

test("subsequent updates blend toward the new observation (EMA)", () => {
  const store = new MatrixStore(db);
  // Second sample: alpha = 1/(1+5) ≈ 0.167
  store.update(ctx, {
    leeway_angle: 10,
    speed_loss: 0.2,
    upwash_correction: 0.4,
  });
  const c = store.lookup(ctx);
  // leeway = 0.167*10 + 0.833*4 ≈ 5.0
  assert.ok(Math.abs(c.leeway_angle - 5.0) < 0.01);
  assert.ok(c.hit_count > 5);
});

test("quantization means nearby conditions land in the same bin", () => {
  const store = new MatrixStore(db);
  // stw 5.4, awa 44, heel 11 all quantize to the same bins as ctx (5, 45, 10).
  const nearby = { ...ctx, stwKn: 5.4, awaDeg: 44, heelDeg: 11 };
  store.update(nearby, {
    leeway_angle: 6,
    speed_loss: 0.05,
    upwash_correction: 0.1,
  });
  const c = store.lookup(ctx);
  // hit_count grew, confirming same bin.
  assert.ok(c.hit_count >= 6);
});

test("light-air opposite tacks do not blend into one bin (regression)", () => {
  // Both tacks at sub-bin heel share heel_bin 0; with AWA folded to
  // |AWA| they also shared awa_bin, and their opposite-sign leeway
  // EMA-averaged toward zero. Signed AWA bins keep them apart.
  const store = new MatrixStore(db);
  const stw = 2.5; // distinct from other tests' bins
  store.update(
    {
      sail_state: "sailing",
      sea_state: "unknown",
      stwKn: stw,
      awaDeg: 30,
      heelDeg: 0.4,
    },
    { leeway_angle: 2, speed_loss: 0.1, upwash_correction: 0 },
  );
  store.update(
    {
      sail_state: "sailing",
      sea_state: "unknown",
      stwKn: stw,
      awaDeg: -30,
      heelDeg: -0.4,
    },
    { leeway_angle: -2, speed_loss: 0.1, upwash_correction: 0 },
  );
  const stbd = store.lookup({
    sail_state: "sailing",
    sea_state: "unknown",
    stwKn: stw,
    awaDeg: 30,
    heelDeg: 0.4,
  });
  const port = store.lookup({
    sail_state: "sailing",
    sea_state: "unknown",
    stwKn: stw,
    awaDeg: -30,
    heelDeg: -0.4,
  });
  assert.strictEqual(stbd.leeway_angle, 2);
  assert.strictEqual(port.leeway_angle, -2);
  assert.strictEqual(stbd.hit_count, 5); // fresh bin — no cross-talk
});

test("live samples outweigh historical samples in effective hit count", () => {
  // 1 live hit * 5 = 5 effective; 1 historical climatology hit * 0.5 = 0.5.
  const live = { live_hit_count: 1, historical_hit_count: 0 };
  const hist = {
    live_hit_count: 0,
    historical_hit_count: 1,
    historical_confidence_tier: "climatology",
  };
  assert.strictEqual(effectiveHitCount(live), 5);
  assert.strictEqual(effectiveHitCount(hist), 0.5);
});

test("reanalysis historical tier weighs more than climatology", () => {
  const reanalysis = {
    live_hit_count: 0,
    historical_hit_count: 1,
    historical_confidence_tier: "reanalysis",
  };
  assert.strictEqual(effectiveHitCount(reanalysis), 1.0);
});

test("learningRate is 1 for a fresh bin and decreases with hits", () => {
  assert.strictEqual(learningRate(0), 1);
  assert.ok(learningRate(1) < 1);
  assert.ok(learningRate(100) > 0 && learningRate(100) < learningRate(1));
  // Never goes rigid — floor enforced.
  assert.ok(learningRate(1e9) >= 0.01);
});

test("missing sail/sea state falls back to 'unknown'", () => {
  const store = new MatrixStore(db);
  const sparse = { stwKn: 5, awaDeg: 45, heelDeg: 10 };
  store.update(sparse, {
    leeway_angle: 2,
    speed_loss: 0,
    upwash_correction: 0,
  });
  const c = store.lookup({
    sail_state: UNKNOWN_STATE,
    sea_state: UNKNOWN_STATE,
    stwKn: 5,
    awaDeg: 45,
    heelDeg: 10,
  });
  assert.strictEqual(c.leeway_angle, 2);
});

test("historical updates advance the historical counter, not live", () => {
  const store = new MatrixStore(db);
  const hctx = { ...ctx, stwKn: 6.5, awaDeg: 90, heelDeg: 4 };
  store.update(
    hctx,
    {
      leeway_angle: 3,
      speed_loss: 0.1,
      upwash_correction: 0,
    },
    { source: "historical", confidenceTier: "reanalysis" },
  );
  const row = db
    .prepare(
      "SELECT live_hit_count, historical_hit_count, historical_confidence_tier FROM dr_matrix_bins WHERE stw_bin=?",
    )
    .get(6.5);
  assert.strictEqual(row.live_hit_count, 0);
  assert.strictEqual(row.historical_hit_count, 1);
  assert.strictEqual(row.historical_confidence_tier, "reanalysis");
});

test("count reports populated bins", () => {
  const store = new MatrixStore(db);
  const before = store.count();
  store.update(
    { ...ctx, stwKn: 7.5, awaDeg: 120, heelDeg: 20 },
    { leeway_angle: 5, speed_loss: 0.1, upwash_correction: 0 },
  );
  assert.strictEqual(store.count(), before + 1);
});
