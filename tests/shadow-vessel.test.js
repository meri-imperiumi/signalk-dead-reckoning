/**
 * Shadow vessel publisher unit tests (work doc #21): the pure velocity
 * resolver and the delta-shape emitted by the publisher.
 *
 * @file shadow-vessel.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createShadowVesselPublisher,
  resolveVelocity,
  SOURCE_LABEL,
} = require("../plugin/shadow-vessel.js");
const { FakeSignalKApp } = require("./fake-app.js");

// --- resolveVelocity (pure vector math, mirrors the engine motion model) ---

test("resolveVelocity returns null without heading or speed", () => {
  assert.equal(resolveVelocity({ stwKn: null, headingTrueDeg: 0 }), null);
  assert.equal(resolveVelocity({ stwKn: 5, headingTrueDeg: null }), null);
  assert.equal(resolveVelocity({}), null);
});

test("resolveVelocity with no current: COG = heading + leeway, SOG = effective STW", () => {
  // Due north, no leeway, no current → COG 0, SOG = STW.
  const v = resolveVelocity({ stwKn: 6, headingTrueDeg: 0 });
  assert.deepEqual(v, { cogDeg: 0, sogKn: 6 });

  // Due east (90), leeway 10 to leeward → course 100.
  const v2 = resolveVelocity({
    stwKn: 5,
    headingTrueDeg: 90,
    leewayDeg: 10,
  });
  assert.ok(Math.abs(v2.cogDeg - 100) < 1e-9);
  assert.ok(Math.abs(v2.sogKn - 5) < 1e-9);
});

test("resolveVelocity applies speed-loss to STW", () => {
  const v = resolveVelocity({
    stwKn: 10,
    headingTrueDeg: 0,
    speedLoss: 0.2, // 20% loss → effective 8 kn
  });
  assert.ok(Math.abs(v.sogKn - 8) < 1e-9);
});

test("resolveVelocity composes water-track + current vector", () => {
  // Heading due north at 4 kn, 1 kn current setting due east (90° true):
  //   water vector: north 4
  //   current vector: east 1
  //   SOG = sqrt(4^2 + 1^2) = sqrt(17) ≈ 4.123
  //   COG = atan2(1, 4) ≈ 14.04°
  const v = resolveVelocity({
    stwKn: 4,
    headingTrueDeg: 0,
    current: { setTrue: 90, drift: 1 },
  });
  assert.ok(Math.abs(v.sogKn - Math.sqrt(17)) < 1e-9);
  assert.ok(Math.abs(v.cogDeg - (180 / Math.PI) * Math.atan2(1, 4)) < 1e-9);
});

test("resolveVelocity returns null when the vector sums to zero (stopped)", () => {
  // STW 0 → no water motion; no current → zero vector.
  assert.equal(resolveVelocity({ stwKn: 0, headingTrueDeg: 0 }), null);
});

test("resolveVelocity clamps speed-loss to [0,1]", () => {
  // Negative loss doesn't boost speed.
  const neg = resolveVelocity({ stwKn: 6, headingTrueDeg: 0, speedLoss: -0.5 });
  assert.ok(Math.abs(neg.sogKn - 6) < 1e-9);
  // Loss >1 clamps to 1 → effective 0 → zero vector → null (stopped).
  const over = resolveVelocity({ stwKn: 6, headingTrueDeg: 0, speedLoss: 2 });
  assert.equal(over, null);
});

// --- createShadowVesselPublisher (delta shape) ---

/** Collects handleMessage deltas into a flat list. */
function makeApp() {
  const app = new FakeSignalKApp();
  return app;
}

/** Deltas published by the shadow publisher on the synthetic context. */
function shadowDeltas(app) {
  return app.handledMessages.filter((m) =>
    m.message?.context?.startsWith("vessels.urn:mrn:signalk:uuid:"),
  );
}

test("publisher emits on the given context with the source label", () => {
  const app = makeApp();
  const pub = createShadowVesselPublisher({
    app,
    context: "vessels.urn:mrn:signalk:uuid:abc",
    name: "DR Shadow",
  });
  pub.publish({ position: { latitude: 60.1, longitude: 24.9 } });

  const [msg] = shadowDeltas(app);
  assert.equal(msg.source, SOURCE_LABEL);
  assert.equal(msg.message.context, "vessels.urn:mrn:signalk:uuid:abc");
});

test("publish is a no-op without a position (no DR origin yet)", () => {
  const app = makeApp();
  const pub = createShadowVesselPublisher({
    app,
    context: "vessels.urn:mrn:signalk:uuid:abc",
    name: "DR Shadow",
  });
  pub.publish({ position: null });
  assert.equal(shadowDeltas(app).length, 0);
});

test("root value carries name + buddy flag (the distinctness lever)", () => {
  const app = makeApp();
  const pub = createShadowVesselPublisher({
    app,
    context: "vessels.urn:mrn:signalk:uuid:abc",
    name: "My Shadow",
  });
  pub.publish({ position: { latitude: 1, longitude: 2 } });

  const values = shadowDeltas(app)[0].message.updates[0].values;
  const root = values.find((v) => v.path === "");
  assert.deepEqual(root.value, { name: "My Shadow", buddy: true });
});

test("position is published as {latitude, longitude}", () => {
  const app = makeApp();
  const pub = createShadowVesselPublisher({
    app,
    context: "vessels.urn:mrn:signalk:uuid:abc",
    name: "DR Shadow",
  });
  pub.publish({ position: { latitude: 60.1, longitude: 24.9 } });

  const values = shadowDeltas(app)[0].message.updates[0].values;
  const pos = values.find((v) => v.path === "navigation.position");
  assert.deepEqual(pos.value, { latitude: 60.1, longitude: 24.9 });
});

test("heading/COG are in radians and SOG in m/s (Signal K SI convention)", () => {
  const app = makeApp();
  const pub = createShadowVesselPublisher({
    app,
    context: "vessels.urn:mrn:signalk:uuid:abc",
    name: "DR Shadow",
  });
  pub.publish({
    position: { latitude: 0, longitude: 0 },
    headingTrueRad: 1.5, // ~85.9°
    cogRad: 1.4, // ~80.2°
    sogMs: 2.5, // ~4.86 kn
  });

  const values = shadowDeltas(app)[0].message.updates[0].values;
  assert.equal(
    values.find((v) => v.path === "navigation.headingTrue").value,
    1.5,
  );
  assert.equal(
    values.find((v) => v.path === "navigation.courseOverGroundTrue").value,
    1.4,
  );
  assert.equal(
    values.find((v) => v.path === "navigation.speedOverGround").value,
    2.5,
  );
});

test("null heading/COG/SOG are omitted (plotter retains last values)", () => {
  const app = makeApp();
  const pub = createShadowVesselPublisher({
    app,
    context: "vessels.urn:mrn:signalk:uuid:abc",
    name: "DR Shadow",
  });
  // Idle publish: position + sog 0 only.
  pub.publish({ position: { latitude: 0, longitude: 0 }, sogMs: 0 });

  const paths = shadowDeltas(app)[0].message.updates[0].values.map(
    (v) => v.path,
  );
  assert.deepEqual(paths.sort(), [
    "",
    "navigation.position",
    "navigation.speedOverGround",
  ]);
});

test("stop() makes publish a no-op", () => {
  const app = makeApp();
  const pub = createShadowVesselPublisher({
    app,
    context: "vessels.urn:mrn:signalk:uuid:abc",
    name: "DR Shadow",
  });
  pub.publish({ position: { latitude: 0, longitude: 0 } });
  assert.equal(shadowDeltas(app).length, 1);

  pub.stop();
  pub.publish({ position: { latitude: 1, longitude: 1 } });
  assert.equal(shadowDeltas(app).length, 1); // unchanged
});
