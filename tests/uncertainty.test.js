/**
 * Tests for the uncertainty polygon growth model (SPEC §8) — revised
 * after the 2026-08-30…09-05 Aitutaki→Niue sea trial (work doc #24):
 * current-knowledge-aware cone, median empirical rate, honest fallback.
 * @file uncertainty.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const u = require("../plugin/uncertainty.js");

const RAD = Math.PI / 180;

test("fallbackRateNmPerNm: tan(4°) ≈ 0.0699 nm/nm (sea-trial calibration)", () => {
  const r = u.fallbackRateNmPerNm();
  assert.ok(Math.abs(r - Math.tan(4 * RAD)) < 1e-9);
  // Sea trial measured 0.12–0.22 nm/nm open-loop; 4° (0.07 nm/nm) is the
  // flat-water fallback the empirical rate tightens from.
  assert.ok(r > 0.069 && r < 0.071);
});

test("rowRatePerSecond: deviation/elapsed, capped at 2 kn, 0 when no time", () => {
  assert.strictEqual(
    u.rowRatePerSecond({ deviation_nm: 0.5, dr_elapsed_seconds: 1800 }),
    0.5 / 1800,
  );
  // Garbage row (the 2026-08-31 Antarctica snap): 3058 NM over 75971 s
  // ≈ 145 kn — capped at MAX_ROW_RATE_KN.
  assert.strictEqual(
    u.rowRatePerSecond({ deviation_nm: 3058, dr_elapsed_seconds: 75971 }),
    u.MAX_ROW_RATE_KN / 3600,
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

test("deviationRateMedian: null when no usable rows", () => {
  assert.strictEqual(u.deviationRateMedian([]), null);
  assert.strictEqual(
    u.deviationRateMedian([{ deviation_nm: 1, dr_elapsed_seconds: 0 }]),
    null,
  );
});

test("deviationRateMedian: median of the capped per-row rates", () => {
  // Even count → mean of the middle two. Rates 0.36–1.44 kn — realistic
  // deviation rates, below the 2 kn garbage cap.
  const rows = [1, 2, 3, 4].map((n) => ({
    deviation_nm: 0.0001 * n * 3600,
    dr_elapsed_seconds: 3600,
  }));
  assert.ok(Math.abs(u.deviationRateMedian(rows) - 0.00025) < 1e-12);
  // Odd count → the middle value.
  const odd = [1, 2, 3].map((n) => ({
    deviation_nm: 0.0001 * n * 3600,
    dr_elapsed_seconds: 3600,
  }));
  assert.ok(Math.abs(u.deviationRateMedian(odd) - 0.0002) < 1e-12);
});

test("deviationRateMedian: a garbage row cannot shift the median (work doc #2)", () => {
  const sane = Array.from({ length: 5 }, (_, i) => ({
    deviation_nm: (0.001 + i * 0.0001) * 1800,
    dr_elapsed_seconds: 1800,
  }));
  const withGarbage = [
    { deviation_nm: 3058, dr_elapsed_seconds: 75971 }, // 145 kn, capped
    ...sane,
  ];
  assert.ok(
    Math.abs(u.deviationRateMedian(withGarbage) - u.deviationRateMedian(sane)) <
      1e-12,
    "garbage row must not shift the median",
  );
});

test("deviationRateMedian: only the newest MEDIAN_N rows count", () => {
  // Newest-first ordering. 12 newest at 1e-4/s, 11 mid at 2e-5/s, then 5
  // oldest at 5e-5/s. With slicing (MEDIAN_N=20) the 5 oldest drop and
  // the median is 1e-4; without slicing (n=28) it would be 5e-5.
  const newest = Array.from({ length: 12 }, () => ({
    deviation_nm: 0.0001 * 3600,
    dr_elapsed_seconds: 3600,
  }));
  const mid = Array.from({ length: 11 }, () => ({
    deviation_nm: 0.00002 * 3600,
    dr_elapsed_seconds: 3600,
  }));
  const oldest = Array.from({ length: 5 }, () => ({
    deviation_nm: 0.00005 * 3600,
    dr_elapsed_seconds: 3600,
  }));
  const m = u.deviationRateMedian([...newest, ...mid, ...oldest]);
  assert.ok(
    Math.abs(m - 0.0001) < 1e-12,
    `median ${m} should ignore rows beyond MEDIAN_N`,
  );
});

test("blendWeight: 0 at hit_count=0, rises toward 1, 0.5 at MIN_HITS", () => {
  assert.strictEqual(u.blendWeight(0), 0);
  assert.ok(Math.abs(u.blendWeight(u.MIN_HITS_FOR_EMPIRICAL) - 0.5) < 1e-9);
  assert.ok(u.blendWeight(u.MIN_HITS_FOR_EMPIRICAL * 10) > 0.9);
  assert.ok(u.blendWeight(u.MIN_HITS_FOR_EMPIRICAL * 10) < 1);
});

test("computeRadius: fallback regime with zero hit count (run term only)", () => {
  const out = u.computeRadius({
    elapsedDistanceNm: 10,
    effectiveHitCount: 0,
    deviationRows: [],
    stwKn: 5,
  });
  assert.strictEqual(out.method, "fallback");
  assert.ok(out.weight <= 0);
  assert.ok(Math.abs(out.radius_nm - u.fallbackRateNmPerNm() * 10) < 1e-9);
  assert.strictEqual(out.current_term_nm, 0);
});

test("computeRadius: empirical median regime dominates at high hit count", () => {
  // deviation 0.01 nm over 3600 s at 5 kn → 0.002 nm/nm, far below the
  // 0.07 nm/nm fallback.
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
  // blended rate ≈ 0.91*0.002 + 0.09*0.07 ≈ 0.0081 → radius ≈ 0.081…
  // still far below the pure fallback 0.7.
  assert.ok(
    out.radius_nm < 0.15,
    `empirical radius ${out.radius_nm} should be tight`,
  );
  assert.ok(out.radius_nm < u.fallbackRateNmPerNm() * 10);
});

test("computeRadius: radius scales with elapsed distance, not time", () => {
  const args = { effectiveHitCount: 0, deviationRows: [], stwKn: 5 };
  const a = u.computeRadius({ ...args, elapsedDistanceNm: 10 });
  const b = u.computeRadius({ ...args, elapsedDistanceNm: 20 });
  assert.ok(Math.abs(b.radius_nm - 2 * a.radius_nm) < 1e-9);
});

test("computeRadius: current term grows with time at the tier residual rate", () => {
  // Tier 5 (zero vector, no current knowledge): 1.0 kn residual.
  const oneHour = u.computeRadius({
    elapsedDistanceNm: 0,
    elapsedS: 3600,
    currentTier: 5,
    effectiveHitCount: 0,
    deviationRows: [],
    stwKn: 5,
  });
  assert.ok(Math.abs(oneHour.radius_nm - 1.0) < 1e-9);
  const tenHours = u.computeRadius({
    elapsedDistanceNm: 0,
    elapsedS: 36000,
    currentTier: 5,
    effectiveHitCount: 0,
    deviationRows: [],
    stwKn: 5,
  });
  assert.ok(Math.abs(tenHours.radius_nm - 10.0) < 1e-9);
  // Sea trial: 44.8 h zero-current → 47.2 NM actual — inside the 44.8 NM
  // tier-5 cone.
  assert.strictEqual(tenHours.current_residual_kn, u.CURRENT_RESIDUAL_KN[5]);
});

test("computeRadius: manual-current tier residual is 0.25 kn", () => {
  const out = u.computeRadius({
    elapsedDistanceNm: 0,
    elapsedS: 3600,
    currentTier: 1,
    effectiveHitCount: 0,
    deviationRows: [],
    stwKn: 5,
  });
  assert.ok(Math.abs(out.radius_nm - 0.25) < 1e-9);
});

test("computeRadius: derived-current tier residual is 0.2 kn", () => {
  // Tier 2 (boat's own EWMA): tighter than the model tiers — the
  // sea trial held DR to ~11 nm over 110 h ≈ 0.1 kn effective.
  const out = u.computeRadius({
    elapsedDistanceNm: 0,
    elapsedS: 3600,
    currentTier: 2,
    effectiveHitCount: 0,
    deviationRows: [],
    stwKn: 5,
  });
  assert.ok(Math.abs(out.radius_nm - 0.2) < 1e-9);
});

test("computeRadius: run and current terms combine root-sum-square", () => {
  // 10 nm run at fallback (≈0.0699) → 0.699; tier 5 over 10 h → 10 NM;
  // hypot(0.699, 10) ≈ 10.024.
  const out = u.computeRadius({
    elapsedDistanceNm: 10,
    elapsedS: 36000,
    currentTier: 5,
    effectiveHitCount: 0,
    deviationRows: [],
    stwKn: 5,
  });
  const expected = Math.hypot(u.fallbackRateNmPerNm() * 10, 10);
  assert.ok(Math.abs(out.radius_nm - expected) < 1e-9);
});

test("computeRadius: origin error floors the cone at the fix's own accuracy", () => {
  // A celestial fix is realistically ~5 nm (sea-trial discussion
  // 2026-09-06): right after snapping, the cone must not claim better.
  const out = u.computeRadius({
    elapsedDistanceNm: 0,
    effectiveHitCount: 100,
    deviationRows: [{ deviation_nm: 0.01, dr_elapsed_seconds: 3600 }],
    stwKn: 5,
    originErrorNm: 5,
  });
  assert.strictEqual(out.radius_nm, 5);
});

test("computeRadius: radius floors at MIN_RADIUS_NM at excursion start", () => {
  // Zero distance run must not report a point-exact DR position.
  const out = u.computeRadius({
    elapsedDistanceNm: 0,
    effectiveHitCount: 100,
    deviationRows: [{ deviation_nm: 1, dr_elapsed_seconds: 1000 }],
    stwKn: 5,
  });
  assert.strictEqual(out.radius_nm, u.MIN_RADIUS_NM);
  assert.ok(
    u.MIN_RADIUS_NM >= 0.05,
    "floor below the 2026-08-30 trial's post-fix advisory noise band",
  );
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
  assert.strictEqual(near.radius_nm, u.MIN_RADIUS_NM);
});

test("computeRadius: unknown current tier is treated as no current knowledge", () => {
  const out = u.computeRadius({
    elapsedDistanceNm: 0,
    elapsedS: 3600,
    currentTier: 99,
    effectiveHitCount: 0,
    deviationRows: [],
    stwKn: 5,
  });
  assert.ok(Math.abs(out.radius_nm - 1.0) < 1e-9);
});
