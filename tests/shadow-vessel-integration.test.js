/**
 * Shadow vessel plugin integration tests (work doc #21): opt-in gating,
 * the delta emitted on the synthetic context, and the heading/COG
 * mapping through the live tick loop.
 *
 * @file shadow-vessel-integration.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

const makePlugin = require("../plugin/index.js");
const { FakeSignalKApp, FakeRouter } = require("./fake-app.js");

let tempDir;

test.before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "dr-shadow-"));
});

test.after(async () => {
  if (tempDir)
    await rm(tempDir, { recursive: true, force: true, maxRetries: 10 });
});

/** A started plugin with the shadow vessel enabled. */
function makeStartedWithShadow(overrides = {}) {
  const app = new FakeSignalKApp();
  app.dataPath = tempDir;
  const plugin = makePlugin(app);
  plugin.start({ shadowVessel: { enabled: true, ...overrides } });
  return { app, plugin };
}

/** Shadow-context deltas (synthetic vessels.<uuid> targets). */
function shadowDeltas(app) {
  return app.handledMessages.filter(
    (m) =>
      typeof m.message?.context === "string" &&
      m.message.context.startsWith("vessels.urn:mrn:signalk:uuid:"),
  );
}

/** Feeds a sensor delta into the fake app. */
function feed(app, values, context = "vessels.self") {
  app.emitDelta({
    context,
    updates: [{ values }],
  });
}

test("shadow is opt-in: disabled by default emits no synthetic target", async () => {
  const app = new FakeSignalKApp();
  app.dataPath = tempDir;
  const plugin = makePlugin(app);
  plugin.start({}); // defaults — shadow off
  feed(app, [
    { path: "navigation.position", value: { latitude: 60, longitude: 24 } },
    { path: "navigation.speedThroughWater", value: 5 },
    { path: "navigation.headingTrue", value: 0 },
  ]);
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(shadowDeltas(app).length, 0, "no shadow delta when disabled");
  plugin.stop();
});

test("shadow publishes nothing before the engine has an origin", async () => {
  // Fresh data dir so no persisted last_known_good_fix seeds the origin.
  const dir = await mkdtemp(join(tmpdir(), "dr-shadow-nofix-"));
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  plugin.start({ shadowVessel: { enabled: true } });
  // No GPS / fix fed — engine.origin stays null.
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(shadowDeltas(app).length, 0);
  plugin.stop();
  await rm(dir, { recursive: true, force: true, maxRetries: 10 });
});

test("shadow publishes position, name, buddy, heading, COG and SOG", async () => {
  const { app, plugin } = makeStartedWithShadow({ name: "Test Shadow" });
  feed(app, [
    { path: "navigation.position", value: { latitude: 60, longitude: 24 } },
    { path: "navigation.speedThroughWater", value: 5 }, // m/s ≈ 9.7 kn
    { path: "navigation.headingTrue", value: 0 }, // rad → due north
  ]);
  await new Promise((r) => setTimeout(r, 1100));

  const deltas = shadowDeltas(app);
  assert.ok(deltas.length > 0, "shadow delta published");
  const values = deltas[0].message.updates[0].values;
  const byPath = Object.fromEntries(values.map((v) => [v.path, v.value]));

  // Distinctness lever: green ais_buddy glyph.
  assert.deepEqual(byPath[""], { name: "Test Shadow", buddy: true });
  // Position — the DR position after a tick, slightly advanced north
  // from the seeded {60, 24} (heading 0, ~9.7 kn for ~1 s).
  const pos = byPath["navigation.position"];
  assert.ok(Math.abs(pos.latitude - 60) < 0.001, `lat ${pos.latitude}`);
  assert.ok(Math.abs(pos.longitude - 24) < 0.001, `lon ${pos.longitude}`);
  // Heading (rad) — glyph orientation.
  assert.equal(byPath["navigation.headingTrue"], 0);
  // COG (rad) + SOG (m/s) — projected line. Due north, no current →
  // COG == heading == 0.
  assert.ok(byPath["navigation.courseOverGroundTrue"] != null);
  assert.ok(byPath["navigation.speedOverGround"] > 0);
  plugin.stop();
});

test("shadow COG differs from heading when current sets sideways", async () => {
  const { app, plugin } = makeStartedWithShadow();
  feed(app, [
    { path: "navigation.position", value: { latitude: 60, longitude: 24 } },
    { path: "navigation.speedThroughWater", value: 2 }, // ~3.9 kn north
    { path: "navigation.headingTrue", value: 0 }, // due north
  ]);
  // Manual current: 2 kn due east (setTrue 90°). The shadow's COG should
  // be pushed east of the heading.
  const router = new FakeRouter();
  plugin.registerWithRouter(router);
  router.invoke("put", "/current/manual", { setTrue: 90, drift: 2 });
  await new Promise((r) => setTimeout(r, 1200));

  const deltas = shadowDeltas(app);
  assert.ok(deltas.length > 0);
  const latest = deltas[deltas.length - 1].message.updates[0].values;
  const byPath = Object.fromEntries(latest.map((v) => [v.path, v.value]));

  // Heading is 0 (north); COG must be > 0 (pushed east by the current).
  assert.ok(
    byPath["navigation.courseOverGroundTrue"] > 0.01,
    `COG ${byPath["navigation.courseOverGroundTrue"]} should be east of heading 0`,
  );
  assert.ok(byPath["navigation.speedOverGround"] > 0);
  plugin.stop();
});

test("shadow stays on chart (position only, sog 0) when DR goes idle", async () => {
  const { app, plugin } = makeStartedWithShadow();
  // Underway first so the shadow appears with a position + COG.
  feed(app, [
    { path: "navigation.position", value: { latitude: 60, longitude: 24 } },
    { path: "navigation.speedThroughWater", value: 3 },
    { path: "navigation.headingTrue", value: 0 },
  ]);
  await new Promise((r) => setTimeout(r, 1100));
  assert.ok(shadowDeltas(app).length > 0);

  // Go idle: moored, no STW/heading. The shadow should keep publishing
  // position (so it doesn't go stale) with sog 0 (clearing the COG line).
  feed(app, [
    { path: "navigation.state", value: "moored" },
    { path: "navigation.speedThroughWater", value: null },
    { path: "navigation.headingTrue", value: null },
  ]);
  await new Promise((r) => setTimeout(r, 1100));

  const deltas = shadowDeltas(app);
  assert.ok(deltas.length > 1, "shadow kept publishing while idle");
  const latest = deltas[deltas.length - 1].message.updates[0].values;
  const byPath = Object.fromEntries(latest.map((v) => [v.path, v.value]));
  assert.ok(byPath["navigation.position"], "position still published");
  assert.equal(byPath["navigation.speedOverGround"], 0, "SOG cleared");
  plugin.stop();
});

test("shadow context UUID persists across restarts", async () => {
  // First start: generates and persists the UUID.
  const app1 = new FakeSignalKApp();
  app1.dataPath = tempDir;
  const plugin1 = makePlugin(app1);
  plugin1.start({ shadowVessel: { enabled: true } });
  feed(app1, [
    { path: "navigation.position", value: { latitude: 1, longitude: 1 } },
    { path: "navigation.speedThroughWater", value: 1 },
    { path: "navigation.headingTrue", value: 0 },
  ]);
  await new Promise((r) => setTimeout(r, 1100));
  const ctx1 = shadowDeltas(app1)[0].message.context;
  plugin1.stop();

  // Second start over the same data dir: same UUID.
  const app2 = new FakeSignalKApp();
  app2.dataPath = tempDir;
  const plugin2 = makePlugin(app2);
  plugin2.start({ shadowVessel: { enabled: true } });
  feed(app2, [
    { path: "navigation.position", value: { latitude: 1, longitude: 1 } },
    { path: "navigation.speedThroughWater", value: 1 },
    { path: "navigation.headingTrue", value: 0 },
  ]);
  await new Promise((r) => setTimeout(r, 1100));
  const ctx2 = shadowDeltas(app2)[0].message.context;
  plugin2.stop();

  assert.equal(ctx1, ctx2, "shadow context UUID reused across restart");
});
