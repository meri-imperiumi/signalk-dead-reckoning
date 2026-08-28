/**
 * Polar-derived STW fallback (SPEC §3.1 `inertial-polar`, work doc #18):
 * running average over `performance.polarSpeed` deltas with a staleness
 * verdict. Pure module tests for plugin/polar.js.
 *
 * @file polar.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createPolarSpeedState,
  polarSpeedSample,
  polarSpeedAverage,
} = require("../plugin/polar.js");

const WINDOW = { windowMs: 60_000 };

test("empty state has no average and is stale", () => {
  const s = createPolarSpeedState();
  assert.deepStrictEqual(
    polarSpeedAverage(s, {
      nowMs: 0,
      windowMs: 60_000,
      staleMs: 30_000,
    }),
    {
      averageKn: null,
      sampleCount: 0,
      stale: true,
    },
  );
});

test("average is the mean of the window samples", () => {
  const s = createPolarSpeedState();
  polarSpeedSample(s, { tsMs: 1000, speedKn: 4 }, WINDOW);
  polarSpeedSample(s, { tsMs: 2000, speedKn: 6 }, WINDOW);
  const r = polarSpeedAverage(s, { nowMs: 2500, ...WINDOW, staleMs: 30_000 });
  assert.strictEqual(r.averageKn, 5);
  assert.strictEqual(r.sampleCount, 2);
  assert.strictEqual(r.stale, false);
});

test("null (out-of-table) deltas sample nothing — the average ages out", () => {
  const s = createPolarSpeedState();
  polarSpeedSample(s, { tsMs: 1000, speedKn: 5 }, WINDOW);
  polarSpeedSample(s, { tsMs: 2000, speedKn: null }, WINDOW);
  polarSpeedSample(s, { tsMs: 3000, speedKn: Number.NaN }, WINDOW);
  const r = polarSpeedAverage(s, { nowMs: 3000, ...WINDOW, staleMs: 30_000 });
  assert.strictEqual(r.sampleCount, 1);
  assert.strictEqual(r.averageKn, 5);
});

test("samples older than the window are evicted on read and on push", () => {
  const s = createPolarSpeedState();
  polarSpeedSample(s, { tsMs: 0, speedKn: 1 }, WINDOW);
  polarSpeedSample(s, { tsMs: 10_000, speedKn: 2 }, WINDOW);
  polarSpeedSample(s, { tsMs: 70_000, speedKn: 6 }, WINDOW); // evicts t=0
  // Window is [10_000, 70_000]: both remaining samples count.
  const r = polarSpeedAverage(s, { nowMs: 70_000, ...WINDOW, staleMs: 30_000 });
  assert.strictEqual(r.sampleCount, 2);
  assert.strictEqual(r.averageKn, 4);
  // A read 60 s later evicts everything but the newest bucket edge.
  const r2 = polarSpeedAverage(s, {
    nowMs: 130_000,
    ...WINDOW,
    staleMs: 30_000,
  });
  assert.strictEqual(r2.sampleCount, 1);
  assert.strictEqual(r2.averageKn, 6);
});

test("staleness is judged against the newest sample's age", () => {
  const s = createPolarSpeedState();
  polarSpeedSample(s, { tsMs: 0, speedKn: 5 }, WINDOW);
  // Older than the (short) staleness cutoff but still inside the
  // averaging window: stale, with the average retained for the caller
  // to decide. This is the config that makes staleS < windowS tighten
  // the drop-off (the plugin default).
  const r = polarSpeedAverage(s, { nowMs: 10_000, ...WINDOW, staleMs: 5_000 });
  assert.strictEqual(r.stale, true);
  assert.strictEqual(r.averageKn, 5);
  // Fresh enough: not stale.
  const r2 = polarSpeedAverage(s, { nowMs: 4_000, ...WINDOW, staleMs: 5_000 });
  assert.strictEqual(r2.stale, false);
  // Once the feed is quiet past the whole window, eviction leaves
  // nothing to average at all — staleMs above windowMs can only
  // loosen, never extend, the effective cutoff.
  const r3 = polarSpeedAverage(s, {
    nowMs: 100_000,
    ...WINDOW,
    staleMs: 120_000,
  });
  assert.strictEqual(r3.stale, true);
  assert.strictEqual(r3.averageKn, null);
});

test("window boundary: a sample exactly windowMs old is kept", () => {
  const s = createPolarSpeedState();
  polarSpeedSample(s, { tsMs: 10_000, speedKn: 3 }, WINDOW);
  // Cutoff = 70_000 - 60_000 = 10_000; ts < cutoff evicts, == stays.
  const r = polarSpeedAverage(s, { nowMs: 70_000, ...WINDOW, staleMs: 30_000 });
  assert.strictEqual(r.sampleCount, 1);
  assert.strictEqual(r.averageKn, 3);
});
