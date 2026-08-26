/**
 * Tests for the divergence advisory monitor (SPEC §7.3, band 2).
 * @file divergence.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createDivergenceState,
  divergenceTick,
  DEFAULT_FACTOR,
  DEFAULT_SUSTAIN_S,
  DEFAULT_CLEAR_S,
} = require("../plugin/divergence.js");

/** Feeds `n` ticks at dt=1s of the given condition. */
function run(state, n, { div = 5, rad = 1, opts } = {}) {
  let last;
  for (let i = 0; i < n; i++) {
    last = divergenceTick(
      state,
      { divergenceNm: div, radiusNm: rad, dtS: 1 },
      opts,
    );
  }
  return last;
}

test("defaults: factor 1.5, 30s raise / 30s clear", () => {
  assert.strictEqual(DEFAULT_FACTOR, 1.5);
  assert.strictEqual(DEFAULT_SUSTAIN_S, 30);
  assert.strictEqual(DEFAULT_CLEAR_S, 30);
});

test("fresh state is inactive with zero timers", () => {
  const s = createDivergenceState();
  assert.strictEqual(s.active, false);
  assert.strictEqual(s.exceedS, 0);
  assert.strictEqual(s.insideS, 0);
});

test("raises only after sustained exceedance, exactly once", () => {
  const s = createDivergenceState();
  const r29 = run(s, 29, { div: 5, rad: 1 }); // 5 > 1.5
  assert.strictEqual(r29.active, false);
  assert.strictEqual(r29.transition, null);
  const r30 = divergenceTick(s, { divergenceNm: 5, radiusNm: 1, dtS: 1 });
  assert.strictEqual(r30.active, true);
  assert.strictEqual(r30.transition, "raise");
  // No repeated transition while still exceeding.
  const r31 = divergenceTick(s, { divergenceNm: 5, radiusNm: 1, dtS: 1 });
  assert.strictEqual(r31.transition, null);
  assert.strictEqual(r31.active, true);
});

test("sustain accumulates in seconds, not ticks (dt scaling)", () => {
  const s = createDivergenceState();
  // 6 ticks × 5s = 30s sustained → raise on the 6th.
  let r;
  for (let i = 0; i < 6; i++) {
    r = divergenceTick(s, { divergenceNm: 5, radiusNm: 1, dtS: 5 });
  }
  assert.strictEqual(r.transition, "raise");
});

test("brief spike does not raise", () => {
  const s = createDivergenceState();
  const r = run(s, 10, { div: 5, rad: 1 }); // 10s < 30s
  assert.strictEqual(r.active, false);
  const back = divergenceTick(s, { divergenceNm: 0.5, radiusNm: 1, dtS: 1 });
  assert.strictEqual(back.transition, null);
  assert.strictEqual(back.active, false);
});

test("clears only after sustained recovery", () => {
  const s = createDivergenceState();
  run(s, 30, { div: 5, rad: 1 });
  // back inside, 29s → not yet
  const r29 = run(s, 29, { div: 1, rad: 1 }); // 1 < 1.5
  assert.strictEqual(r29.active, true);
  assert.strictEqual(r29.transition, null);
  const r30 = divergenceTick(s, { divergenceNm: 1, radiusNm: 1, dtS: 1 });
  assert.strictEqual(r30.active, false);
  assert.strictEqual(r30.transition, "clear");
});

test("flapping below the sustain window never raises", () => {
  const s = createDivergenceState();
  // Alternate 20s exceed / 20s inside — each side resets the other's timer.
  for (let cycle = 0; cycle < 5; cycle++) {
    run(s, 20, { div: 5, rad: 1 });
    run(s, 20, { div: 0.5, rad: 1 });
  }
  assert.strictEqual(s.active, false);
});

test("missing input holds timers and state", () => {
  const s = createDivergenceState();
  run(s, 10, { div: 5, rad: 1 }); // exceedS = 10
  const held = divergenceTick(s, { divergenceNm: null, radiusNm: 1, dtS: 1 });
  assert.strictEqual(held.transition, null);
  assert.strictEqual(held.active, false);
  assert.strictEqual(held.expectedNm, null);
  assert.strictEqual(s.exceedS, 10); // unchanged
  // Resuming completes the accumulation.
  run(s, 19, { div: 5, rad: 1 });
  const r = divergenceTick(s, { divergenceNm: 5, radiusNm: 1, dtS: 1 });
  assert.strictEqual(r.transition, "raise");
});

test("zero radius with any divergence exceeds; zero/zero does not", () => {
  const s = createDivergenceState();
  const r = divergenceTick(s, { divergenceNm: 0.001, radiusNm: 0, dtS: 30 });
  assert.strictEqual(r.transition, "raise");
  const s2 = createDivergenceState();
  const r2 = divergenceTick(s2, { divergenceNm: 0, radiusNm: 0, dtS: 30 });
  assert.strictEqual(r2.transition, null); // 0 > 0 is false → inside
});

test("opts.factor is respected", () => {
  const s = createDivergenceState();
  const opts = { factor: 3, sustainS: 1 };
  // div 4, rad 1: 4 > 3×1 → exceeds with factor 3.
  const r = divergenceTick(s, { divergenceNm: 4, radiusNm: 1, dtS: 1 }, opts);
  assert.strictEqual(r.transition, "raise");
  const s2 = createDivergenceState();
  // div 2, rad 1: 2 < 3 → does not exceed.
  const r2 = divergenceTick(s2, { divergenceNm: 2, radiusNm: 1, dtS: 5 }, opts);
  assert.strictEqual(r2.transition, null);
});

test("report carries divergence and expected values", () => {
  const s = createDivergenceState();
  const r = divergenceTick(s, { divergenceNm: 2.5, radiusNm: 1, dtS: 1 });
  assert.strictEqual(r.divergenceNm, 2.5);
  assert.strictEqual(r.expectedNm, 1.5);
});

test("floating-point epsilon divergence against zero radius does not exceed", () => {
  // Regression: post-snap, divergence can be ~1e-9 nm (destinationPoint
  // rounding) while the radius is exactly 0 (STW 0). That must count as
  // inside, or the advisory can never clear.
  const s = createDivergenceState();
  run(s, 30, { div: 5, rad: 1 }); // raise first
  let r;
  for (let i = 0; i < 3; i++) {
    r = divergenceTick(
      s,
      { divergenceNm: 1e-9, radiusNm: 0, dtS: 0.1 },
      { clearS: 0.3 },
    );
  }
  assert.strictEqual(r.transition, "clear");
  assert.strictEqual(r.active, false);
});
