/**
 * Tests for the DR ground-track buffer (SPEC §9.1: sun-run-sun).
 *
 * @file ground-track.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { GroundTrack } = require("../plugin/ground-track.js");

test("GroundTrack: append + positionAt interpolation", () => {
  const gt = new GroundTrack();
  gt.append({ timestamp: 0, latitude: 60, longitude: 24 });
  gt.append({ timestamp: 1000, latitude: 60.001, longitude: 24.002 });
  const p = gt.positionAt(500);
  assert.ok(p);
  assert.ok(Math.abs(p.latitude - 60.0005) < 1e-9);
  assert.ok(Math.abs(p.longitude - 24.001) < 1e-9);
});

test("GroundTrack: positionAt null outside the buffered range", () => {
  const gt = new GroundTrack();
  gt.append({ timestamp: 0, latitude: 60, longitude: 24 });
  gt.append({ timestamp: 1000, latitude: 60.001, longitude: 24.002 });
  assert.strictEqual(gt.positionAt(-1), null);
  assert.strictEqual(gt.positionAt(1001), null);
  assert.strictEqual(new GroundTrack().positionAt(0), null);
});

test("GroundTrack: displacementBetween returns bearing + distance", () => {
  const gt = new GroundTrack();
  // Boat sails due east ~0.001° lon at 60N ≈ 0.05 nm.
  gt.append({ timestamp: 0, latitude: 60, longitude: 24 });
  gt.append({ timestamp: 1000, latitude: 60, longitude: 24.001 });
  const d = gt.displacementBetween(0, 1000);
  assert.ok(d);
  assert.ok(Math.abs(d.bearingTrue - 90) < 1);
  assert.ok(d.distanceNm > 0);
});

test("GroundTrack: displacementBetween null when an endpoint is outside range", () => {
  const gt = new GroundTrack();
  gt.append({ timestamp: 1000, latitude: 60, longitude: 24 });
  gt.append({ timestamp: 2000, latitude: 60.001, longitude: 24 });
  assert.strictEqual(gt.displacementBetween(0, 2000), null);
  assert.strictEqual(gt.displacementBetween(1000, 3000), null);
});

test("GroundTrack: same-timestamp append replaces (dedup)", () => {
  const gt = new GroundTrack();
  gt.append({ timestamp: 0, latitude: 60, longitude: 24 });
  gt.append({ timestamp: 0, latitude: 61, longitude: 25 });
  assert.strictEqual(gt.samples.length, 1);
  assert.strictEqual(gt.samples[0].latitude, 61);
});

test("GroundTrack: capacity evicts oldest", () => {
  const gt = new GroundTrack({ capacity: 3 });
  gt.append({ timestamp: 0, latitude: 0, longitude: 0 });
  gt.append({ timestamp: 1, latitude: 1, longitude: 1 });
  gt.append({ timestamp: 2, latitude: 2, longitude: 2 });
  gt.append({ timestamp: 3, latitude: 3, longitude: 3 });
  assert.strictEqual(gt.samples.length, 3);
  assert.strictEqual(gt.earliest(), 1);
});
