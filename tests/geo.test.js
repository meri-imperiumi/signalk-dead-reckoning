/**
 * Tests for geodetic helpers.
 * @file geo.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  degToRad,
  radToDeg,
  normalizeDeg180,
  normalizeDeg360,
  distanceNm,
  bearingDeg,
  destinationPoint,
  knotsToMs,
  msToKnots,
} = require("../plugin/geo.js");

test("degToRad / radToDeg are inverses", () => {
  for (const deg of [0, 45, 90, -123.456, 359.9]) {
    assert.ok(Math.abs(radToDeg(degToRad(deg)) - deg) < 1e-9);
  }
});

test("normalizeDeg360 wraps negatives", () => {
  assert.strictEqual(normalizeDeg360(-10), 350);
  assert.strictEqual(normalizeDeg360(370), 10);
  assert.strictEqual(normalizeDeg360(0), 0);
});

test("normalizeDeg180 wraps to [-180, 180)", () => {
  assert.strictEqual(normalizeDeg180(190), -170);
  assert.strictEqual(normalizeDeg180(-190), 170);
  assert.strictEqual(normalizeDeg180(180), -180);
});

test("distanceNm is ~0 for identical points", () => {
  const p = { latitude: 60.1, longitude: 24.9 };
  assert.ok(distanceNm(p, p) < 1e-6);
});

test("distanceNm matches a known ~1nm step", () => {
  // 1 nm = 1 minute of latitude along a meridian.
  const a = { latitude: 60, longitude: 24 };
  const b = { latitude: 60 + 1 / 60, longitude: 24 };
  assert.ok(Math.abs(distanceNm(a, b) - 1) < 1e-3);
});

test("bearingDeg due north is 0", () => {
  const a = { latitude: 60, longitude: 24 };
  const b = { latitude: 61, longitude: 24 };
  assert.ok(Math.abs(bearingDeg(a, b) - 0) < 1e-3);
});

test("bearingDeg due east is 90", () => {
  const a = { latitude: 60, longitude: 24 };
  // 1 degree longitude at 60N ≈ 30nm (cos60 * 60nm)
  const b = { latitude: 60, longitude: 25 };
  assert.ok(Math.abs(bearingDeg(a, b) - 90) < 0.5);
});

test("destinationPoint round-trips distance", () => {
  const start = { latitude: 60, longitude: 24 };
  const dest = destinationPoint(start, 45, 10);
  assert.ok(Math.abs(distanceNm(start, dest) - 10) < 1e-2);
});

test("destinationPoint bearing is honored", () => {
  const start = { latitude: 0, longitude: 0 };
  const dest = destinationPoint(start, 90, 60);
  // Due east along the equator → longitude increases by ~1 degree per 60nm
  assert.ok(Math.abs(dest.longitude - 1) < 1e-3);
  assert.ok(Math.abs(dest.latitude) < 1e-9);
});

test("knotsToMs / msToKnots are inverses", () => {
  assert.ok(Math.abs(msToKnots(knotsToMs(5)) - 5) < 1e-9);
});
