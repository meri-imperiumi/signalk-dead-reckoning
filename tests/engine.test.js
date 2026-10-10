/**
 * Tests for the DR integration engine (SPEC §5, §3.1).
 * @file engine.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { DeadReckoningEngine } = require("../plugin/engine.js");

test("tick returns null without an origin", () => {
  const e = new DeadReckoningEngine();
  assert.strictEqual(e.tick({ stwKn: 5, headingTrueDeg: 0 }), null);
});

test("snapToFix seeds the origin and resets elapsed time", () => {
  const e = new DeadReckoningEngine();
  e.snapToFix({ latitude: 60, longitude: 24 });
  assert.deepStrictEqual(e.origin, { latitude: 60, longitude: 24 });
  assert.strictEqual(e.elapsedSinceOriginS, 0);
  assert.strictEqual(e.underwaySinceOriginS, 0);
});

test("under-way clock only advances while under way", () => {
  const e = new DeadReckoningEngine();
  e.snapToFix({ latitude: 60, longitude: 24 });
  // Under way for an hour: both clocks advance.
  e.tick({ stwKn: 5, headingTrueDeg: 0, underway: true }, 3600);
  assert.strictEqual(e.elapsedSinceOriginS, 3600);
  assert.strictEqual(e.underwaySinceOriginS, 3600);
  // Anchored for a day: wall-clock keeps counting ("since last fix"),
  // the under-way clock — the uncertainty cone's growth axis — freezes.
  e.tick({ stwKn: 0, headingTrueDeg: 0, underway: false }, 24 * 3600);
  assert.strictEqual(e.elapsedSinceOriginS, 25 * 3600);
  assert.strictEqual(e.underwaySinceOriginS, 3600);
  // A fix resets both.
  e.snapToFix({ latitude: 61, longitude: 24 });
  assert.strictEqual(e.elapsedSinceOriginS, 0);
  assert.strictEqual(e.underwaySinceOriginS, 0);
});

test("anchored tick holds the shadow boat on the anchor", () => {
  const e = new DeadReckoningEngine();
  e.snapToFix({ latitude: -18.65, longitude: 174.0 });
  // A month on the hook: sensors on a stopped hull still read — the
  // paddlewheel sees the current streaming past, the resolver hands back
  // a GRIB current — but the anchor holds the ground position, so none
  // of it may move the shadow boat or grow the logs.
  const before = { ...e };
  for (let day = 0; day < 30; day++) {
    const pos = e.tick(
      {
        stwKn: 0.8,
        headingTrueDeg: 90,
        leewayDeg: 5,
        current: { setTrue: 90, drift: 0.4 },
        underway: false,
      },
      24 * 3600,
    );
    assert.deepStrictEqual(pos, before.origin);
  }
  assert.deepStrictEqual(e.origin, before.origin);
  assert.strictEqual(e.logNm, before.logNm);
  assert.strictEqual(e.tripLogNm, before.tripLogNm);
  assert.strictEqual(e.logNmSinceOrigin, before.logNmSinceOrigin);
  // The under-way clock — the cone's growth axis — stays frozen, while
  // the wall-clock "since fix" keeps counting the real stay.
  assert.strictEqual(e.underwaySinceOriginS, 0);
  assert.strictEqual(e.elapsedSinceOriginS, 30 * 24 * 3600);
  // The engine stays warm: sailing off the hook resumes integration
  // from the held position with no snap needed.
  const pos = e.tick({ stwKn: 5, headingTrueDeg: 0, underway: true }, 3600);
  assert.ok(Math.abs(pos.latitude - (before.origin.latitude + 5 / 60)) < 1e-4);
});

test("tick advances north along a meridian at the given STW", () => {
  const e = new DeadReckoningEngine();
  e.snapToFix({ latitude: 60, longitude: 24 });
  // 1 knot for 1 hour = 1 nm north.
  e.tick({ stwKn: 1, headingTrueDeg: 0, leewayDeg: 0, speedLoss: 0 }, 3600);
  assert.ok(Math.abs(e.origin.latitude - (60 + 1 / 60)) < 1e-4);
  assert.ok(Math.abs(e.origin.longitude - 24) < 1e-6);
  assert.ok(Math.abs(e.logNm - 1) < 1e-6);
  assert.ok(Math.abs(e.tripLogNm - 1) < 1e-6);
  assert.strictEqual(e.elapsedSinceOriginS, 3600);
});

test("speedLoss reduces effective distance traveled", () => {
  const e1 = new DeadReckoningEngine();
  e1.snapToFix({ latitude: 0, longitude: 0 });
  e1.tick({ stwKn: 6, headingTrueDeg: 90, speedLoss: 0 }, 3600);

  const e2 = new DeadReckoningEngine();
  e2.snapToFix({ latitude: 0, longitude: 0 });
  e2.tick({ stwKn: 6, headingTrueDeg: 90, speedLoss: 0.5 }, 3600);

  assert.ok(e2.logNm < e1.logNm);
  assert.ok(Math.abs(e2.logNm - 3) < 1e-3);
});

test("leeway rotates the course off the heading", () => {
  const e = new DeadReckoningEngine();
  e.snapToFix({ latitude: 0, longitude: 0 });
  e.tick({ stwKn: 6, headingTrueDeg: 0, leewayDeg: 45, speedLoss: 0 }, 3600);
  // Course 045 over 6nm → NE corner; latitude and longitude both increase.
  assert.ok(e.origin.latitude > 0);
  assert.ok(e.origin.longitude > 0);
});

test("current adds drift on top of the water-track vector", () => {
  const base = new DeadReckoningEngine();
  base.snapToFix({ latitude: 0, longitude: 0 });
  base.tick(
    { stwKn: 0, headingTrueDeg: 0, current: { setTrue: 90, drift: 6 } },
    3600,
  );
  // No boat speed; pure 6kn current due east for 1h → 6nm east.
  assert.ok(Math.abs(base.origin.longitude - 0.1) < 1e-3);
  assert.ok(Math.abs(base.origin.latitude) < 1e-6);
  // Current doesn't add to the water-track log.
  assert.strictEqual(base.logNm, 0);
});

test("resetTrip zeroes only the trip log", () => {
  const e = new DeadReckoningEngine();
  e.snapToFix({ latitude: 0, longitude: 0 });
  e.tick({ stwKn: 5, headingTrueDeg: 0 }, 3600);
  e.resetTrip();
  assert.strictEqual(e.tripLogNm, 0);
  assert.ok(e.logNm > 0);
});

test("method defaults to inertial-paddlewheel and active is false", () => {
  const e = new DeadReckoningEngine();
  assert.strictEqual(e.method, "inertial-paddlewheel");
  assert.strictEqual(e.active, false);
});

test("missing stw or heading holds position without advancing the log", () => {
  const e = new DeadReckoningEngine();
  e.snapToFix({ latitude: 60, longitude: 24 });
  const pos = e.tick({ stwKn: null, headingTrueDeg: 0 }, 3600);
  assert.deepStrictEqual(pos, { latitude: 60, longitude: 24 });
  assert.strictEqual(e.logNm, 0);
});
