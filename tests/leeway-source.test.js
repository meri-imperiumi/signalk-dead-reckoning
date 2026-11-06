/**
 * Tests for companion leeway consumption (leeway-source.js, SPEC §3.2).
 *
 * The speedandcurrent companion plugin publishes a learned
 * `navigation.leewayAngle` (rad, starboard-positive — the same sign
 * convention as our matrix). The resolver must prefer that value while
 * fresh and plausible, and fall back to the matrix lookup the moment
 * it goes stale, implausible, or absent.
 * @file leeway-source.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveLeewayDeg,
  DEFAULT_MAX_AGE_MS,
  DEFAULT_MAX_ABS_DEG,
} = require("../plugin/leeway-source.js");

const NOW = 1_800_000_000_000;
// 5° starboard slip in rad — a healthy close-hauled value.
const FIVE_DEG_RAD = (5 * Math.PI) / 180;
// 20° — beyond the plausibility bound.
const TWENTY_DEG_RAD = (20 * Math.PI) / 180;

test("fresh plausible companion value wins over the matrix", () => {
  const r = resolveLeewayDeg({
    companionRad: FIVE_DEG_RAD,
    companionAtMs: NOW - 1000,
    nowMs: NOW,
    matrixLeewayDeg: 3,
  });
  assert.strictEqual(r.source, "companion");
  // rad → deg conversion, small float tolerance.
  assert.ok(Math.abs(r.leewayDeg - 5) < 1e-9);
});

test("sign convention passes through (port-tack negative value)", () => {
  const r = resolveLeewayDeg({
    companionRad: -FIVE_DEG_RAD,
    companionAtMs: NOW - 1000,
    nowMs: NOW,
    matrixLeewayDeg: 3,
  });
  assert.strictEqual(r.source, "companion");
  assert.ok(Math.abs(r.leewayDeg + 5) < 1e-9);
});

test("stale companion value falls back to the matrix", () => {
  const r = resolveLeewayDeg({
    companionRad: FIVE_DEG_RAD,
    companionAtMs: NOW - DEFAULT_MAX_AGE_MS - 1,
    nowMs: NOW,
    matrixLeewayDeg: 3,
  });
  assert.deepStrictEqual(r, { leewayDeg: 3, source: "matrix" });
});

test("value at exactly the freshness boundary is still usable", () => {
  const r = resolveLeewayDeg({
    companionRad: FIVE_DEG_RAD,
    companionAtMs: NOW - DEFAULT_MAX_AGE_MS,
    nowMs: NOW,
    matrixLeewayDeg: 3,
  });
  assert.strictEqual(r.source, "companion");
});

test("implausible companion value (> bound) falls back to the matrix", () => {
  const r = resolveLeewayDeg({
    companionRad: TWENTY_DEG_RAD,
    companionAtMs: NOW - 1000,
    nowMs: NOW,
    matrixLeewayDeg: 3,
  });
  assert.deepStrictEqual(r, { leewayDeg: 3, source: "matrix" });
});

test("implausible on the negative side falls back too", () => {
  const r = resolveLeewayDeg({
    companionRad: -TWENTY_DEG_RAD,
    companionAtMs: NOW - 1000,
    nowMs: NOW,
    matrixLeewayDeg: -2,
  });
  assert.deepStrictEqual(r, { leewayDeg: -2, source: "matrix" });
});

test("value exactly at the plausibility bound is usable", () => {
  const r = resolveLeewayDeg({
    companionRad: (DEFAULT_MAX_ABS_DEG * Math.PI) / 180,
    companionAtMs: NOW - 1000,
    nowMs: NOW,
    matrixLeewayDeg: 3,
  });
  assert.strictEqual(r.source, "companion");
});

test("absent companion (nulls) resolves to the matrix", () => {
  const r = resolveLeewayDeg({
    companionRad: null,
    companionAtMs: null,
    nowMs: NOW,
    matrixLeewayDeg: 4,
  });
  assert.deepStrictEqual(r, { leewayDeg: 4, source: "matrix" });
});

test("absent companion and empty bin resolves to null, not 0", () => {
  // The engine maps a missing angle to an upright water track; the
  // resolver must not fabricate a 0 that would mask "no data".
  const r = resolveLeewayDeg({
    companionRad: null,
    companionAtMs: null,
    nowMs: NOW,
    matrixLeewayDeg: null,
  });
  assert.deepStrictEqual(r, { leewayDeg: null, source: "matrix" });
});

test("non-finite companion value falls back", () => {
  const r = resolveLeewayDeg({
    companionRad: Number.NaN,
    companionAtMs: NOW - 1000,
    nowMs: NOW,
    matrixLeewayDeg: 1,
  });
  assert.deepStrictEqual(r, { leewayDeg: 1, source: "matrix" });
});

test("future receipt time (local clock anomaly) stays fresh", () => {
  const r = resolveLeewayDeg({
    companionRad: FIVE_DEG_RAD,
    companionAtMs: NOW + 5000,
    nowMs: NOW,
    matrixLeewayDeg: 3,
  });
  assert.strictEqual(r.source, "companion");
});

test("matrix fallback wins over stale+implausible combination only", () => {
  // Both disqualifiers at once — sanity check the conjunction path.
  const r = resolveLeewayDeg({
    companionRad: TWENTY_DEG_RAD,
    companionAtMs: NOW - DEFAULT_MAX_AGE_MS - 1,
    nowMs: NOW,
    matrixLeewayDeg: null,
  });
  assert.deepStrictEqual(r, { leewayDeg: null, source: "matrix" });
});
