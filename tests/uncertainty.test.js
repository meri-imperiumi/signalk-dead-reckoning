/**
 * Tests for the uncertainty polygon growth model (SPEC §8).
 * @file uncertainty.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const u = require("../plugin/uncertainty.js");

const RAD = Math.PI / 180;

test("fallbackRateNmPerNm: tan(1°) ≈ 0.01745 nm/nm", () => {
  const r = u.fallbackRateNmPerNm();
  assert.ok(Math.abs(r - Math.tan(1 * RAD)) < 1e-9);
  assert.ok(r > 0.017 && r < 0.018);
});

test("rowRatePerSecond: deviation_nm / dr_elapsed_seconds, 0 when no time", () => {
  assert.strictEqual(
    u.rowRatePerSecond({ deviation_nm: 0.5, dr_elapsed_seconds: 1800 }),
    0.5 / 1800,
  );
  assert.strictEqual(
    u.rowRatePerSecond({ deviation_nm: 1, dr_elapsed_seconds: 0 }),
    0,
  );
  assert.strictEqual(
    u.rowRatePerSecond({ deviation_nm: 1, dr_elapsed_seconds: -5 }),
    0,
  );
});

test("deviationRateEwma: seeds from fallback rate (via stw) when no rows", () => {
  const stwKn = 5;
  const expected = u.fallbackRateNmPerNm() * (stwKn / 3600);
  const r = u.deviationRateEwma([], { stwKn });
  assert.ok(Math.abs(r - expected) < 1e-12);
});

test("deviationRateEwma: seeds from the oldest row when rows exist", () => {
  // Single row → EWMA equals that row's rate (seeded from it, no updates).
  const r = u.deviationRateEwma(
    [{ deviation_nm: 0.3, dr_elapsed_seconds: 600 }],
    { stwKn: 5 },
  );
  assert.ok(Math.abs(r - 0.3 / 600) < 1e-12);
});

test("deviationRateEwma: applies rows oldest→newest (recent weighted more)", () => {
  // 5 old rows at rate 0.001/s, then 5 recent rows at rate 0.01/s.
  // With EWMA weighting recent rows more, the result should land well
  // above the simple mean (0.0055) toward the recent rate.
  const old = Array.from({ length: 5 }, () => ({
    deviation_nm: 0.001 * 1800,
    dr_elapsed_seconds: 1800,
  }));
  const recent = Array.from({ length: 5 }, () => ({
    deviation_nm: 0.01 * 1800,
    dr_elapsed_seconds: 1800,
  }));
  // db returns newest-first; put recent last (newest).
  const rows = [...old, ...recent];
  const r = u.deviationRateEwma(rows, { stwKn: 5 });
  const mean = 0.0055;
  assert.ok(
    r > mean,
    `EWMA ${r} should exceed the simple mean ${mean} (recent weighted more)`,
  );
  assert.ok(r < 0.01, `EWMA ${r} should stay below the recent rate 0.01`);
});

test("blendWeight: 0 at hit_count=0, rises toward 1, 0.5 at MIN_HITS", () => {
  assert.strictEqual(u.blendWeight(0), 0);
  assert.ok(Math.abs(u.blendWeight(u.MIN_HITS_FOR_EMPIRICAL) - 0.5) < 1e-9);
  assert.ok(u.blendWeight(u.MIN_HITS_FOR_EMPIRICAL * 10) > 0.9);
  assert.ok(u.blendWeight(u.MIN_HITS_FOR_EMPIRICAL * 10) < 1);
});

test("computeRadius: fallback regime with zero hit count", () => {
  const out = u.computeRadius({
    elapsedDistanceNm: 10,
    effectiveHitCount: 0,
    deviationRows: [],
    stwKn: 5,
  });
  assert.strictEqual(out.method, "fallback");
  assert.ok(out.weight <= 0);
  // radius = fallback_rate * distance
  assert.ok(Math.abs(out.radius_nm - u.fallbackRateNmPerNm() * 10) < 1e-9);
});

test("computeRadius: empirical regime dominates at high hit count", () => {
  // Build rows whose per-time rate, at stwKn=5, yields a per-distance rate
  // well below the fallback, so a tight radius confirms empirical wins.
  // deviation 0.1 nm over 3600 s = 2.78e-5 nm/s; at 5 kn = 5/3600 nm/s run
  // → per-distance = 2.78e-5 / (5/3600) = 0.02 nm/nm (vs fallback 0.01745).
  // Use a clearly-different rate: deviation 0.01 nm over 3600 s at 5 kn
  // → 0.002 nm/nm, far below fallback 0.01745.
  const rows = Array.from({ length: 30 }, () => ({
    deviation_nm: 0.01,
    dr_elapsed_seconds: 3600,
  }));
  const out = u.computeRadius({
    elapsedDistanceNm: 10,
    effectiveHitCount: 100, // high → w ≈ 0.91
    deviationRows: rows,
    stwKn: 5,
  });
  assert.ok(out.method === "empirical" || out.method === "blend");
  assert.ok(out.weight > 0.9);
  // empirical rate ≈ 0.002; blended rate ≈ 0.91*0.002 + 0.09*0.01745 ≈ 0.0034
  // radius ≈ 0.034 nm — far below the pure-fallback 0.1745.
  assert.ok(
    out.radius_nm < 0.05,
    `empirical radius ${out.radius_nm} should be tight`,
  );
  assert.ok(out.radius_nm < u.fallbackRateNmPerNm() * 10);
});

test("computeRadius: radius scales with elapsed distance, not time", () => {
  // Same bin/confidence/rows: doubling distance doubles radius.
  const args = {
    effectiveHitCount: 0,
    deviationRows: [],
    stwKn: 5,
  };
  const a = u.computeRadius({ ...args, elapsedDistanceNm: 10 });
  const b = u.computeRadius({ ...args, elapsedDistanceNm: 20 });
  assert.ok(Math.abs(b.radius_nm - 2 * a.radius_nm) < 1e-9);
});

test("computeRadius: radius floors at GNSS noise at excursion start (no distance run)", () => {
  // Zero distance run must not report a point-exact DR position: the
  // radius can never honestly be smaller than the GPS noise the origin
  // was seeded from, or any dockside GPS wander "exceeds expected
  // uncertainty" and trips the divergence advisory on a moored boat.
  const out = u.computeRadius({
    elapsedDistanceNm: 0,
    effectiveHitCount: 100,
    deviationRows: [{ deviation_nm: 1, dr_elapsed_seconds: 1000 }],
    stwKn: 5,
  });
  assert.strictEqual(out.radius_nm, u.MIN_RADIUS_NM);
  assert.ok(u.MIN_RADIUS_NM >= 0.02, "floor below GNSS noise scale");
});

test("computeRadius: floor only applies below it — growth is unchanged above", () => {
  const far = u.computeRadius({
    elapsedDistanceNm: 10,
    effectiveHitCount: 0,
    deviationRows: [],
    stwKn: 5,
  });
  assert.ok(Math.abs(far.radius_nm - u.fallbackRateNmPerNm() * 10) < 1e-9);
  const near = u.computeRadius({
    elapsedDistanceNm: 0.01,
    effectiveHitCount: 0,
    deviationRows: [],
    stwKn: 5,
  });
  // 0.01 nm run × 0.01745 ≈ 0.00017 nm — below floor → floored.
  assert.strictEqual(near.radius_nm, u.MIN_RADIUS_NM);
});

test("computeRadius: blend regime between fallback and empirical", () => {
  // At MIN_HITS_FOR_EMPIRICAL, weight=0.5 → rate is the average of the two.
  const rows = Array.from({ length: 30 }, () => ({
    deviation_nm: 0.01,
    dr_elapsed_seconds: 3600,
  }));
  const out = u.computeRadius({
    elapsedDistanceNm: 10,
    effectiveHitCount: u.MIN_HITS_FOR_EMPIRICAL,
    deviationRows: rows,
    stwKn: 5,
  });
  assert.strictEqual(out.method, "blend");
  assert.ok(Math.abs(out.weight - 0.5) < 1e-9);
  // blended rate = 0.5*empirical + 0.5*fallback
  assert.ok(
    out.radius_nm > u.fallbackRateNmPerNm() * 10 * 0.4 &&
      out.radius_nm < u.fallbackRateNmPerNm() * 10 * 0.6,
  );
});

test("computeRadius: stwKn=0 falls back to fallback rate (no division by zero)", () => {
  const out = u.computeRadius({
    elapsedDistanceNm: 10,
    effectiveHitCount: 50,
    deviationRows: [{ deviation_nm: 1, dr_elapsed_seconds: 100 }],
    stwKn: 0,
  });
  assert.ok(Number.isFinite(out.radius_nm));
  assert.ok(out.radius_nm > 0);
});
