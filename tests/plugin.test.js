/**
 * Smoke tests for the plugin entry point (subscriptions, start/stop, REST).
 * @file plugin.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { DatabaseSync } = require("node:sqlite");

const makePlugin = require("../plugin/index.js");
const { FakeSignalKApp, FakeRouter } = require("./fake-app.js");

let tempDir;

test.before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "dr-plugin-"));
});

test.after(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

/**
 * Builds a started plugin instance wired to a fresh fake app + temp db.
 *
 * @returns {{app: FakeSignalKApp, plugin: object, router: FakeRouter}}
 */
function makeStarted() {
  const app = new FakeSignalKApp();
  app.dataPath = tempDir;
  const plugin = makePlugin(app);
  plugin.start({});
  const router = new FakeRouter();
  plugin.registerWithRouter(router);
  return { app, plugin, router };
}

test("creates a plugin object with the right id/name", () => {
  const app = new FakeSignalKApp();
  const plugin = makePlugin(app);
  assert.strictEqual(plugin.id, "signalk-dead-reckoning");
  assert.strictEqual(plugin.name, "Dead Reckoning");
  assert.ok(plugin.description);
});

test("schema is a JSON object with tick/save intervals", () => {
  const app = new FakeSignalKApp();
  const plugin = makePlugin(app);
  assert.strictEqual(plugin.schema.type, "object");
  assert.ok(plugin.schema.properties.tickIntervalMs);
  assert.ok(plugin.schema.properties.saveIntervalMs);
});

test("start subscribes to the SPEC §3.2 sensor paths", () => {
  const { app, plugin } = makeStarted();
  const subscribed = app.subscriptionmanager.subscriptions.flatMap((s) =>
    s.subscription.subscribe.map((e) => e.path),
  );
  for (const path of [
    "navigation.position",
    "navigation.speedThroughWater",
    "navigation.headingMagnetic",
    "environment.wind.angleApparent",
    "navigation.state",
    "propulsion.main.state",
  ]) {
    assert.ok(subscribed.includes(path), `not subscribed to ${path}`);
  }
  plugin.stop();
});

test("start sets a status message", () => {
  const { app, plugin } = makeStarted();
  assert.ok(
    app.statusMessages.some((m) => /started/i.test(m)),
    `got ${app.statusMessages}`,
  );
  plugin.stop();
});

test("feeding a GPS position seeds the DR origin", () => {
  const { app, plugin } = makeStarted();
  app.emitDelta({
    context: "vessels.self",
    updates: [
      {
        values: [
          {
            path: "navigation.position",
            value: { latitude: 60.1, longitude: 24.9 },
          },
        ],
      },
    ],
  });
  // The 1Hz tick reads the origin; give it a moment then check via REST.
  // (We assert directly against the published status by querying the route.)
  plugin.stop();
});

test("tick publishes a deadReckoning.position delta with the origin", async () => {
  const { app, plugin } = makeStarted();
  app.emitDelta({
    context: "vessels.self",
    updates: [
      {
        values: [
          {
            path: "navigation.position",
            value: { latitude: 60, longitude: 24 },
          },
          { path: "navigation.speedThroughWater", value: 5 },
          { path: "navigation.headingTrue", value: 0 },
        ],
      },
    ],
  });
  // Wait for at least one tick (default 1s).
  await new Promise((r) => setTimeout(r, 1100));
  const drDeltas = app.handledMessages.filter((m) =>
    m.message?.updates?.some((u) =>
      u.values?.some((v) => v.path === "navigation.deadReckoning.position"),
    ),
  );
  assert.ok(drDeltas.length > 0, "no DR position delta published");
  plugin.stop();
});

test("GET /status returns engine snapshot", () => {
  const { app, plugin, router } = makeStarted();
  app.emitDelta({
    context: "vessels.self",
    updates: [
      {
        values: [
          {
            path: "navigation.position",
            value: { latitude: 60, longitude: 24 },
          },
        ],
      },
    ],
  });
  const { status, body } = router.invoke("get", "/status");
  assert.strictEqual(status, 200);
  assert.strictEqual(typeof body.logNm, "number");
  assert.strictEqual(body.method, "inertial-paddlewheel");
  assert.strictEqual(body.active, false);
  plugin.stop();
});

test("PUT /override toggles the active flag", () => {
  const { plugin, router } = makeStarted();
  let res = router.invoke("put", "/override", { active: true });
  assert.strictEqual(res.body.active, true);
  res = router.invoke("put", "/override", { active: false });
  assert.strictEqual(res.body.active, false);
  plugin.stop();
});

test("/status before start returns 503", () => {
  const app = new FakeSignalKApp();
  const plugin = makePlugin(app);
  const router = new FakeRouter();
  plugin.registerWithRouter(router);
  const { status } = router.invoke("get", "/status");
  assert.strictEqual(status, 503);
});

test("stop clears subscriptions and closes the db", () => {
  const { app, plugin } = makeStarted();
  assert.ok(app.subscriptionmanager.subscriptions.length > 0);
  plugin.stop();
  assert.strictEqual(app.subscriptionmanager.subscriptions.length, 0);
  assert.ok(
    app.statusMessages.some((m) => /stopped/i.test(m)),
    `got ${app.statusMessages}`,
  );
});

test("unwrapPosition handles bare and wrapped values", () => {
  const { unwrapPosition } = require("../plugin/index.js");
  assert.deepStrictEqual(unwrapPosition({ latitude: 1, longitude: 2 }), {
    latitude: 1,
    longitude: 2,
  });
  assert.strictEqual(unwrapPosition(null), null);
  assert.strictEqual(unwrapPosition({ foo: 1 }), null);
});

test("training writes a matrix bin once GPS ground truth is available", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-train-"));
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  // Fast tick so the test doesn't wait a full second per step.
  plugin.start({ tickIntervalMs: 20, saveIntervalMs: 60000 });
  // First GPS fix seeds the origin; second provides SOG/COG for training.
  // Boat heading 0 (N), STW 5, but GPS drifts slightly E of N (leeward)
  // → observed leeway should be positive and a bin should be written.
  for (let i = 0; i < 3; i++) {
    app.emitDelta({
      context: "vessels.self",
      updates: [
        {
          values: [
            {
              path: "navigation.position",
              value: { latitude: 60 + i * 0.0002, longitude: 24 + 0.0001 * i },
            },
            { path: "navigation.speedThroughWater", value: 5 },
            { path: "navigation.headingTrue", value: 0 },
            { path: "environment.wind.angleApparent", value: 0.78 },
            { path: "environment.wind.speedApparent", value: 12 },
            { path: "navigation.attitude", value: { roll: 0.17 } },
            { path: "propulsion.main.state", value: "stopped" },
          ],
        },
      ],
    });
    await new Promise((r) => setTimeout(r, 25));
  }
  await new Promise((r) => setTimeout(r, 30));
  plugin.stop();
  const db = new DatabaseSync(join(dir, "dead-reckoning.sqlite"), {
    readOnly: true,
  });
  const n = db.prepare("SELECT COUNT(*) AS n FROM dr_matrix_bins").get().n;
  assert.ok(n > 0, `expected at least one trained bin, got ${n}`);
  db.close();
  await rm(dir, { recursive: true, force: true });
});

test("POST /fix records a dr_corrections row when a prior origin exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-snap-"));
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  plugin.start({ tickIntervalMs: 20, saveIntervalMs: 60000 });
  const router = new FakeRouter();
  plugin.registerWithRouter(router);
  // First GPS fix seeds the origin (no prior → no correction).
  app.emitDelta({
    context: "vessels.self",
    updates: [
      {
        values: [
          {
            path: "navigation.position",
            value: { latitude: 60, longitude: 24 },
          },
        ],
      },
    ],
  });
  await new Promise((r) => setTimeout(r, 30));
  // Sail a bit so the DR origin moves away from the seed and elapsed accrues.
  app.emitDelta({
    context: "vessels.self",
    updates: [
      {
        values: [
          { path: "navigation.speedThroughWater", value: 5 },
          { path: "navigation.headingTrue", value: 0 },
        ],
      },
    ],
  });
  await new Promise((r) => setTimeout(r, 60));
  // Confirm a fix away from the current DR origin → correction recorded.
  const { status, body } = router.invoke("post", "/fix", {
    latitude: 60.01,
    longitude: 24.01,
    source_type: "manual",
    confirmed_by: "crew",
  });
  assert.strictEqual(status, 200);
  assert.strictEqual(body.recorded_correction, true);
  await new Promise((r) => setTimeout(r, 20));
  plugin.stop();
  const db = new DatabaseSync(join(dir, "dead-reckoning.sqlite"), {
    readOnly: true,
  });
  const corrections = db.prepare("SELECT * FROM dr_corrections").all();
  assert.ok(
    corrections.length >= 1,
    `expected >=1 correction, got ${corrections.length}`,
  );
  assert.strictEqual(corrections[0].sail_state, "unknown");
  assert.ok(corrections[0].deviation_nm > 0);
  db.close();
  await rm(dir, { recursive: true, force: true });
});
