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

test("GroundTrack: positionAt interpolates across the antimeridian the short way", () => {
  // Boat at the equator sailing east across the dateline: 179.9°E →
  // 179.9°W is a 0.2° hop over ±180°, not 359.8° through Greenwich.
  const gt = new GroundTrack();
  gt.append({ timestamp: 0, latitude: 0, longitude: 179.9 });
  gt.append({ timestamp: 1000, latitude: 0, longitude: -179.9 });
  const q = gt.positionAt(250);
  assert.ok(Math.abs(q.latitude) < 1e-9);
  assert.ok(Math.abs(q.longitude - 179.95) < 1e-6, `lon ${q.longitude}`);
  // Midpoint is the antimeridian itself (reported as -180). Both
  // endpoints stay exact.
  const mid = gt.positionAt(500);
  assert.ok(Math.abs(Math.abs(mid.longitude) - 180) < 1e-6);
  const end = gt.positionAt(1000);
  assert.ok(Math.abs(end.longitude - -179.9) < 1e-9);
});

test("GroundTrack: displacementBetween across the antimeridian measures the short hop", () => {
  // Interior interpolation crossing the dateline: half of the 0.2°
  // eastbound run at the equator is ~6 nm at ~090°T. The unwrapped
  // path would report ~half the globe.
  const gt = new GroundTrack();
  gt.append({ timestamp: 0, latitude: 0, longitude: 179.9 });
  gt.append({ timestamp: 1000, latitude: 0, longitude: -179.9 });
  const d = gt.displacementBetween(0, 500);
  assert.ok(d, "displacement resolves");
  assert.ok(d.distanceNm > 5.5 && d.distanceNm < 6.5, `dist ${d.distanceNm}`);
  assert.ok(Math.abs(d.bearingTrue - 90) < 1, `brg ${d.bearingTrue}`);
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

test("GroundTrack: default capacity covers a 36h 1Hz run (one sight per day)", () => {
  const gt = new GroundTrack();
  assert.strictEqual(gt.capacity, 36 * 3600);
});

test("GroundTrack: 24h+ sight spacing advances when capacity is sized for it", () => {
  // Capacity as the plugin sizes it for 36 h at 1 Hz.
  const gt = new GroundTrack({
    capacity: Math.round((36 * 3600 * 1000) / 1000),
  });
  // One DR sample per minute over 24.5 h (sight-to-sight drift), boat
  // sailing due east at 60N: 0.001° lon per sample.
  const stepMs = 60 * 1000;
  const n = Math.round((24.5 * 3600 * 1000) / stepMs) + 1;
  for (let i = 0; i < n; i++) {
    gt.append({
      timestamp: i * stepMs,
      latitude: 60,
      longitude: 24 + i * 0.001,
    });
  }
  // Yesterday's sight → today's sight, 24.5 h apart.
  const d = gt.displacementBetween(0, 24.5 * 3600 * 1000);
  assert.ok(d, "day-long interval advanced");
  assert.ok(Math.abs(d.bearingTrue - 90) < 1, "east run");
  assert.ok(d.distanceNm > 0);
});

test("GroundTrack: day-long interval ages out beyond the capacity window", () => {
  // Old default: 21 600 samples at the 1 Hz tick cadence = a 6 h window.
  const gt = new GroundTrack({ capacity: 21600 });
  for (let i = 0; i < 22000; i++) {
    gt.append({ timestamp: i * 1000, latitude: 60, longitude: 24 + i * 0.001 });
  }
  // Samples older than 6 h evicted: a 7 h span cannot advance — the
  // honest null — while the retained 6 h window still resolves.
  assert.strictEqual(gt.displacementBetween(0, 7 * 3600 * 1000), null);
  const kept = gt.displacementBetween(500 * 1000, 6 * 3600 * 1000);
  assert.ok(kept && kept.distanceNm > 0, "retained window still advances");
});
