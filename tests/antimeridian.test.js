/**
 * Antimeridian (longitude ±180°) regression tests.
 *
 * A boat sailing Fiji→Samoa or through the Bering Strait steps over the
 * ±180° boundary every passage; every longitude difference in the code
 * must measure the short way around (0.2°, not 359.8°) and every
 * position output must stay normalized to [-180, 180).
 *
 * Covers the whole longitude-touching chain: geo primitives, DR track
 * interpolation, the fix pipeline's local-plane projection, the derived
 * current sampler's ground-velocity decomposition, and the DR engine's
 * tick integration.
 *
 * @file antimeridian.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  distanceNm,
  bearingDeg,
  destinationPoint,
  advanceByVector,
} = require("../plugin/geo.js");
const { GroundTrack } = require("../plugin/ground-track.js");
const { projectToLocal, unprojectFromLocal } = require("../plugin/fixes.js");
const {
  createDerivedCurrentState,
  updateDerivedCurrent,
  derivedCurrentSnapshot,
} = require("../plugin/derived-current.js");
const { DeadReckoningEngine } = require("../plugin/engine.js");

/** 1° of longitude at the equator, in nm. */
const DEG_AT_EQUATOR_NM = 60;

test("distanceNm across the antimeridian measures the short way", () => {
  // 0.2° apart across the line, on the equator → 12 nm, not ~21600 nm.
  const west = { latitude: 0, longitude: 179.9 };
  const east = { latitude: 0, longitude: -179.9 };
  const d = distanceNm(west, east);
  assert.ok(
    Math.abs(d - 0.2 * DEG_AT_EQUATOR_NM) < 0.01,
    `expected ~12 nm across the line, got ${d}`,
  );
});

test("distanceNm symmetry across the antimeridian", () => {
  const west = { latitude: -17.8, longitude: 179.95 };
  const east = { latitude: -17.7, longitude: -179.95 };
  assert.ok(Math.abs(distanceNm(west, east) - distanceNm(east, west)) < 1e-9);
});

test("bearingDeg across the antimeridian reads due east as 90", () => {
  const west = { latitude: 0, longitude: 179.9 };
  const east = { latitude: 0, longitude: -179.9 };
  assert.ok(Math.abs(bearingDeg(west, east) - 90) < 1e-3);
  assert.ok(Math.abs(bearingDeg(east, west) - 270) < 1e-3);
});

test("destinationPoint crossing the antimeridian wraps to [-180, 180)", () => {
  // 60 nm east along the equator from 179° lands at 180° exactly;
  // anything further wraps negative.
  const start = { latitude: 0, longitude: 179 };
  const over = destinationPoint(start, 90, 120);
  assert.ok(
    over.longitude > -180 && over.longitude < 180,
    `longitude ${over.longitude} outside [-180, 180)`,
  );
  assert.ok(
    over.longitude < 0,
    `expected wrapped negative, got ${over.longitude}`,
  );
  assert.ok(Math.abs(distanceNm(start, over) - 120) < 1e-2);
});

test("repeated advanceByVector steps cross the line continuously", () => {
  // 1 nm east per step from 179.99°: the first step crosses, then the
  // boat keeps sailing east at growing negative longitudes.
  let pos = { latitude: 0, longitude: 179.99 };
  const steps = 120;
  for (let i = 0; i < steps; i++) {
    pos = advanceByVector(pos, { bearingTrue: 90, distanceNm: 1 });
    assert.ok(
      pos.longitude >= -180 && pos.longitude < 180,
      `step ${i}: longitude ${pos.longitude} outside [-180, 180)`,
    );
  }
  // 120 nm = 2° of longitude at the equator: 179.99° + 2° wraps to
  // -178.01°.
  assert.ok(Math.abs(pos.longitude - -178.01) < 1e-2);
  assert.ok(
    Math.abs(distanceNm({ latitude: 0, longitude: 179.99 }, pos) - steps) < 0.1,
  );
});

test("GroundTrack interpolates across the antimeridian", () => {
  const track = new GroundTrack();
  const t0 = Date.UTC(2026, 8, 1, 0, 0, 0);
  track.append({ timestamp: t0, latitude: 0, longitude: 179.9 });
  track.append({ timestamp: t0 + 60000, latitude: 0, longitude: -179.9 });
  const mid = track.positionAt(t0 + 30000);
  assert.ok(mid, "midpoint should interpolate");
  // Halfway over the line: longitude magnitude ~180° (either sign),
  // not 0° (the long way through Greenwich).
  assert.ok(
    Math.abs(Math.abs(mid.longitude) - 180) < 1e-6,
    `expected ±180 at the midpoint, got ${mid.longitude}`,
  );
  assert.ok(Math.abs(mid.latitude) < 1e-9);
  // The other side interpolates the short way too.
  const quarter = track.positionAt(t0 + 15000);
  assert.ok(Math.abs(quarter.longitude - 179.95) < 1e-6);
});

test("GroundTrack displacement across the antimeridian is the short run", () => {
  const track = new GroundTrack();
  const t0 = Date.UTC(2026, 8, 1, 0, 0, 0);
  track.append({ timestamp: t0, latitude: 0, longitude: 179.9 });
  track.append({ timestamp: t0 + 3600000, latitude: 0, longitude: -179.9 });
  const run = track.displacementBetween(t0, t0 + 3600000);
  assert.ok(run, "displacement should resolve");
  assert.ok(
    Math.abs(run.distanceNm - 0.2 * DEG_AT_EQUATOR_NM) < 0.01,
    `expected ~12 nm, got ${run.distanceNm}`,
  );
  assert.ok(Math.abs(run.bearingTrue - 90) < 1e-3);
});

test("projectToLocal across the antimeridian stays in the local plane", () => {
  const center = { latitude: 0, longitude: 179.95 };
  const east = { latitude: 0, longitude: -179.95 };
  const q = projectToLocal(center, east);
  // 0.1° east of the center ≈ 6 nm ≈ 11112 m (mean-radius projection
  // gives 11120 m — same ballpark, not half the planet).
  assert.ok(
    Math.abs(q.x - 0.1 * DEG_AT_EQUATOR_NM * 1852) < 20,
    `expected ~+11112 m east, got ${q.x}`,
  );
  assert.ok(Math.abs(q.y) < 1e-6);
});

test("projectToLocal / unprojectFromLocal round-trip across the line", () => {
  const center = { latitude: -17.8, longitude: 179.99 };
  const p = { latitude: -17.75, longitude: -179.98 };
  const back = unprojectFromLocal(center, projectToLocal(center, p));
  assert.ok(Math.abs(back.latitude - p.latitude) < 1e-9);
  assert.ok(Math.abs(back.longitude - p.longitude) < 1e-9);
});

test("derived current sampler keeps sampling across the antimeridian", () => {
  const st = createDerivedCurrentState();
  let tMs = Date.UTC(2026, 8, 1, 0, 0, 0);
  // Boat making 5 kn due east from just west of the line: the fix
  // stream steps across ±180° almost immediately. Before the wrap fix
  // the raw delta read as a ~360° west jump → SOG gate rejected the
  // sample as "gps-glitch".
  let lon = 179.99;
  const stwKn = 5;
  const dtS = 30;
  let sampled = 0;
  for (let i = 0; i < 20; i++) {
    lon += (stwKn * (dtS / 3600)) / 60;
    tMs += dtS * 1000;
    const r = updateDerivedCurrent(st, {
      tMs,
      gps: { latitude: 0, longitude: ((lon + 180) % 360) - 180 },
      stwKn,
      headingTrueDeg: 90,
    });
    if (i > 0) {
      assert.equal(r.sampled, true, `fix ${i}: ${r.reason}`);
      sampled++;
    }
  }
  assert.equal(sampled, 19);
  const snap = derivedCurrentSnapshot(st, tMs);
  assert.ok(snap, "snapshot should exist after crossing");
  // No current: the residual must read ~0, not a 3+ kn artifact.
  assert.ok(snap.drift < 0.01, `expected ~0 kn drift, got ${snap.drift}`);
});

test("derived current across the line with a real current still converges", () => {
  const st = createDerivedCurrentState();
  let tMs = Date.UTC(2026, 8, 1, 0, 0, 0);
  // 5 kn north water track + 1 kn east current, crossing the line.
  const stwKn = 5;
  const setKn = 1;
  const sogKn = Math.hypot(setKn, stwKn);
  const cogDeg = (Math.atan2(setKn, stwKn) * 180) / Math.PI;
  const rad = Math.PI / 180;
  let lat = 0;
  let lon = 179.995;
  const dtS = 30;
  for (let i = 0; i < 60; i++) {
    const eastKn = sogKn * Math.sin(cogDeg * rad);
    const northKn = sogKn * Math.cos(cogDeg * rad);
    lat += (northKn * (dtS / 3600)) / 60;
    lon += (eastKn * (dtS / 3600)) / 60;
    tMs += dtS * 1000;
    const r = updateDerivedCurrent(st, {
      tMs,
      gps: { latitude: lat, longitude: ((lon + 180) % 360) - 180 },
      stwKn,
      headingTrueDeg: 0,
    });
    if (i > 0) assert.equal(r.sampled, true, `fix ${i}: ${r.reason}`);
  }
  const snap = derivedCurrentSnapshot(st, tMs);
  assert.ok(snap, "snapshot should exist");
  assert.ok(Math.abs(snap.setTrue - 90) < 5, `set ~90°, got ${snap.setTrue}`);
  assert.ok(
    Math.abs(snap.drift - setKn) < 0.1,
    `drift ~${setKn} kn, got ${snap.drift}`,
  );
});

test("DR engine ticks across the antimeridian stay normalized", () => {
  const engine = new DeadReckoningEngine({
    origin: { latitude: 0, longitude: 179.99 },
  });
  // 5 kn due east, 1 s ticks: crosses the line after ~36 ticks.
  const ticks = 720;
  let pos = engine.origin;
  for (let i = 0; i < ticks; i++) {
    pos = engine.tick({ stwKn: 5, headingTrueDeg: 90 });
    assert.ok(
      pos.longitude >= -180 && pos.longitude < 180,
      `tick ${i}: longitude ${pos.longitude} outside [-180, 180)`,
    );
  }
  // 720 s at 5 kn = 1 nm east of 179.99° ≈ -60.99°… no: 179.99 + 1/60
  // of a degree = 180.0067° → wraps to -179.9933°.
  assert.ok(
    Math.abs(pos.longitude - -179.9933) < 1e-3,
    `expected ~-179.9933, got ${pos.longitude}`,
  );
  // The straight-line distance from the origin matches the log run.
  assert.ok(
    Math.abs(distanceNm({ latitude: 0, longitude: 179.99 }, pos) - 1) < 1e-3,
  );
});
