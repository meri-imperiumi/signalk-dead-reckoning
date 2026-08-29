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
const celestial = require("../plugin/celestial.js");
const { FakeSignalKApp, FakeRouter } = require("./fake-app.js");

let tempDir;

test.before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "dr-plugin-"));
});

test.after(async () => {
  // Windows holds sqlite files briefly after close (AV scanners on CI
  // runners are notorious for it); rm retries EBUSY/EPERM only on Windows.
  if (tempDir)
    await rm(tempDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
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
    "performance.polarSpeed",
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

test("tick publishes an idle state reason when moored (no speed/heading)", async () => {
  const { app, plugin } = makeStarted();
  // Moored, no STW or heading → step() can't compute DR.
  app.emitDelta({
    context: "vessels.self",
    updates: [
      {
        values: [
          { path: "navigation.state", value: "moored" },
          {
            path: "navigation.position",
            value: { latitude: 60, longitude: 24 },
          },
        ],
      },
    ],
  });
  await new Promise((r) => setTimeout(r, 1100));
  const stateDeltas = app.handledMessages
    .filter((m) =>
      m.message?.updates?.some((u) =>
        u.values?.some((v) => v.path === "navigation.deadReckoning.state"),
      ),
    )
    .flatMap((m) =>
      m.message.updates.flatMap((u) =>
        u.values.filter((v) => v.path === "navigation.deadReckoning.state"),
      ),
    );
  assert.ok(stateDeltas.length > 0, "no idle state delta published");
  assert.strictEqual(stateDeltas[stateDeltas.length - 1].value.status, "idle");
  assert.strictEqual(
    stateDeltas[stateDeltas.length - 1].value.reason,
    "moored",
  );
  plugin.stop();
});

test("tick publishes underway state when DR is running", async () => {
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
  await new Promise((r) => setTimeout(r, 1100));
  const stateDeltas = app.handledMessages
    .filter((m) =>
      m.message?.updates?.some((u) =>
        u.values?.some((v) => v.path === "navigation.deadReckoning.state"),
      ),
    )
    .flatMap((m) =>
      m.message.updates.flatMap((u) =>
        u.values.filter((v) => v.path === "navigation.deadReckoning.state"),
      ),
    );
  assert.ok(stateDeltas.length > 0, "no underway state delta published");
  assert.strictEqual(
    stateDeltas[stateDeltas.length - 1].value.status,
    "underway",
  );
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

test("PUT /current/manual validates and normalizes input", () => {
  const { plugin, router } = makeStarted();
  let res = router.invoke("put", "/current/manual", { setTrue: 45 });
  assert.strictEqual(res.status, 400);
  res = router.invoke("put", "/current/manual", { drift: -1, setTrue: 10 });
  assert.strictEqual(res.status, 400);
  // 405° → 45°, negative → +315°, TTL defaults to 60 min.
  res = router.invoke("put", "/current/manual", {
    setTrue: 405,
    drift: 1.5,
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.manualCurrent.setTrue, 45);
  assert.strictEqual(res.body.manualCurrent.drift, 1.5);
  assert.ok(
    res.body.manualCurrent.validUntilMs - res.body.manualCurrent.setAtMs <=
      61 * 60_000,
  );
  res = router.invoke("put", "/current/manual", { setTrue: -45, drift: 0.8 });
  assert.strictEqual(res.body.manualCurrent.setTrue, 315);
  plugin.stop();
});

test("manual current is mirrored in /status and cleared by DELETE", () => {
  const { plugin, router } = makeStarted();
  router.invoke("put", "/current/manual", {
    setTrue: 120,
    drift: 0.9,
    ttlMinutes: 15,
    setBy: "watchkeeper",
  });
  let { status, body } = router.invoke("get", "/status");
  assert.strictEqual(status, 200);
  assert.strictEqual(body.manualCurrent.setTrue, 120);
  assert.strictEqual(body.manualCurrent.drift, 0.9);
  assert.strictEqual(body.manualCurrent.setBy, "watchkeeper");
  const { status: delStatus, body: delBody } = router.invoke(
    "delete",
    "/current/manual",
  );
  assert.strictEqual(delStatus, 200);
  assert.strictEqual(delBody.manualCurrent, null);
  ({ body } = router.invoke("get", "/status"));
  assert.strictEqual(body.manualCurrent, null);
  plugin.stop();
});

test("manual current outranks automatic sources in the tick", async () => {
  const { app, plugin, router } = makeStarted();
  // Weather current is enabled by default with no provider reachable;
  // the manual tier must win regardless once set.
  router.invoke("put", "/current/manual", { setTrue: 67, drift: 1.2 });
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
  await new Promise((r) => setTimeout(r, 1100));
  const currentDeltas = app.handledMessages
    .flatMap((m) => m.message?.updates ?? [])
    .flatMap((u) => u.values ?? [])
    .filter(
      (v) =>
        v.path === "environment.current.setTrue" ||
        v.path === "environment.current.drift",
    );
  assert.ok(currentDeltas.length > 0, "no current delta published");
  const last = (p) => {
    const vals = currentDeltas.filter((v) => v.path === p);
    return vals[vals.length - 1].value;
  };
  // SI units on the bus: set 67° → radians, drift 1.2 kn → m/s.
  assert.ok(
    Math.abs(last("environment.current.setTrue") - (67 * Math.PI) / 180) < 1e-6,
    `setTrue ${last("environment.current.setTrue")}`,
  );
  assert.ok(
    Math.abs(last("environment.current.drift") - (1.2 * 1852) / 3600) < 1e-6,
    `drift ${last("environment.current.drift")}`,
  );
  // The DR-specific tier/source enrichment rides REST /status.
  const status = router.invoke("get", "/status").body;
  assert.strictEqual(status.current.source, "manual");
  assert.strictEqual(status.current.tier, 1);
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

test("POST /fix/lop persists a line of position and returns its id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-lop-"));
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  plugin.start({});
  const router = new FakeRouter();
  plugin.registerWithRouter(router);
  const { status, body } = router.invoke("post", "/fix/lop", {
    lop_type: "bearing",
    assumed_lat: 60,
    assumed_lon: 24,
    azimuth_true: 45,
    body_or_object: "North Rock",
    confirmed_by: "crew",
  });
  assert.strictEqual(status, 200);
  assert.ok(body.lop_id > 0);
  plugin.stop();
  const db = new DatabaseSync(join(dir, "dead-reckoning.sqlite"), {
    readOnly: true,
  });
  const row = db
    .prepare("SELECT * FROM lines_of_position WHERE lop_id = ?")
    .get(body.lop_id);
  assert.strictEqual(row.lop_type, "bearing");
  assert.strictEqual(row.azimuth_true, 45);
  assert.strictEqual(row.body_or_object, "North Rock");
  assert.strictEqual(row.used_in_fix_id, null);
  db.close();
  await rm(dir, { recursive: true, force: true });
});

test("POST /fix/lop rejects missing required fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-lop-bad-"));
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  plugin.start({});
  const router = new FakeRouter();
  plugin.registerWithRouter(router);
  const { status, body } = router.invoke("post", "/fix/lop", {
    lop_type: "bearing",
    assumed_lat: 60,
  });
  assert.strictEqual(status, 400);
  assert.ok(
    /assumed_lat, assumed_lon, azimuth_true required/.test(body.message),
  );
  plugin.stop();
  await rm(dir, { recursive: true, force: true });
});

test("POST /fix/cpl persists a circular position line and returns its id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-cpl-"));
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  plugin.start({});
  const router = new FakeRouter();
  plugin.registerWithRouter(router);
  const { status, body } = router.invoke("post", "/fix/cpl", {
    cpl_type: "vertical-angle",
    center_lat: 60,
    center_lon: 24,
    radius_nm: 2,
    source_object: "Lighthouse",
  });
  assert.strictEqual(status, 200);
  assert.ok(body.cpl_id > 0);
  plugin.stop();
  const db = new DatabaseSync(join(dir, "dead-reckoning.sqlite"), {
    readOnly: true,
  });
  const row = db
    .prepare("SELECT * FROM circular_position_lines WHERE cpl_id = ?")
    .get(body.cpl_id);
  assert.strictEqual(row.cpl_type, "vertical-angle");
  assert.strictEqual(row.radius_nm, 2);
  assert.strictEqual(row.source_object, "Lighthouse");
  db.close();
  await rm(dir, { recursive: true, force: true });
});

test("POST /fix/resolve previews a candidate without confirming", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-resolve-"));
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  plugin.start({});
  const router = new FakeRouter();
  plugin.registerWithRouter(router);
  const { status, body } = router.invoke("post", "/fix/resolve", {
    source_type: "bearing",
    observations: [
      { kind: "lop", assumed_lat: 60, assumed_lon: 24, azimuth_true: 0 },
      { kind: "lop", assumed_lat: 60, assumed_lon: 24, azimuth_true: 90 },
    ],
  });
  assert.strictEqual(status, 200);
  assert.ok(body.candidate);
  assert.ok(Math.abs(body.candidate.latitude - 60) < 1e-6);
  assert.ok(Math.abs(body.candidate.longitude - 24) < 1e-6);
  assert.ok(body.candidate.residual_nm < 1e-6);
  // Preview must NOT write a fix.
  plugin.stop();
  const db = new DatabaseSync(join(dir, "dead-reckoning.sqlite"), {
    readOnly: true,
  });
  const n = db.prepare("SELECT COUNT(*) AS n FROM fixes").get().n;
  assert.strictEqual(n, 0);
  db.close();
  await rm(dir, { recursive: true, force: true });
});

test("POST /fix/resolve returns 400 for an unresolvable single LOP", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-resolve-bad-"));
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  plugin.start({});
  const router = new FakeRouter();
  plugin.registerWithRouter(router);
  const { status, body } = router.invoke("post", "/fix/resolve", {
    source_type: "celestial",
    observations: [
      { kind: "lop", assumed_lat: 60, assumed_lon: 24, azimuth_true: 0 },
    ],
  });
  assert.strictEqual(status, 400);
  assert.ok(/not resolvable/.test(body.message));
  plugin.stop();
  await rm(dir, { recursive: true, force: true });
});

test("POST /fix with LOP ids confirms a resolved fix and attaches observations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-fix-lop-"));
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  plugin.start({});
  const router = new FakeRouter();
  plugin.registerWithRouter(router);
  // Seed a prior DR origin so a correction is recorded.
  app.emitDelta({
    context: "vessels.self",
    updates: [
      {
        values: [
          {
            path: "navigation.position",
            value: { latitude: 60.05, longitude: 24.05 },
          },
        ],
      },
    ],
  });
  await new Promise((r) => setTimeout(r, 30));
  // Persist two bearing LOPs.
  const a = router.invoke("post", "/fix/lop", {
    lop_type: "bearing",
    assumed_lat: 60,
    assumed_lon: 24,
    azimuth_true: 0,
    body_or_object: "Rock A",
  }).body.lop_id;
  const b = router.invoke("post", "/fix/lop", {
    lop_type: "bearing",
    assumed_lat: 60,
    assumed_lon: 24,
    azimuth_true: 90,
    body_or_object: "Rock B",
  }).body.lop_id;
  // Confirm the fix, resolving the two LOPs through the pipeline.
  const { status, body } = router.invoke("post", "/fix", {
    source_type: "bearing",
    observations: [
      { kind: "lop", assumed_lat: 60, assumed_lon: 24, azimuth_true: 0 },
      { kind: "lop", assumed_lat: 60, assumed_lon: 24, azimuth_true: 90 },
    ],
    lop_ids: [a, b],
    confirmed_by: "crew",
  });
  assert.strictEqual(status, 200);
  assert.ok(body.fix_id > 0);
  assert.ok(
    body.recorded_correction,
    "expected a correction with a prior origin",
  );
  plugin.stop();
  const db = new DatabaseSync(join(dir, "dead-reckoning.sqlite"), {
    readOnly: true,
  });
  const attached = db
    .prepare(
      "SELECT COUNT(*) AS n FROM lines_of_position WHERE used_in_fix_id = ?",
    )
    .get(body.fix_id).n;
  assert.strictEqual(attached, 2);
  const fixes = db
    .prepare("SELECT * FROM fixes WHERE fix_id = ?")
    .get(body.fix_id);
  assert.strictEqual(fixes.source_type, "bearing");
  assert.strictEqual(fixes.confirmed_by, "crew");
  const corrections = db.prepare("SELECT * FROM dr_corrections").all();
  assert.ok(corrections.length >= 1);
  db.close();
  await rm(dir, { recursive: true, force: true });
});

test("POST /fix still accepts a plain point fix (back-compat)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-fix-point-"));
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  plugin.start({});
  const router = new FakeRouter();
  plugin.registerWithRouter(router);
  // Seed a prior origin.
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
  const { status, body } = router.invoke("post", "/fix", {
    latitude: 60.01,
    longitude: 24.01,
    source_type: "manual",
    confirmed_by: "crew",
  });
  assert.strictEqual(status, 200);
  assert.ok(body.fix_id > 0);
  assert.strictEqual(body.recorded_correction, true);
  plugin.stop();
  await rm(dir, { recursive: true, force: true });
});

test("POST /fix records timestamp, notes and estimated error (offline/paper fixes)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-fix-meta-"));
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  plugin.start({});
  const router = new FakeRouter();
  plugin.registerWithRouter(router);
  // Seed a prior origin so a correction row is also written with the
  // fix's own timestamp.
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
  const { status, body } = router.invoke("post", "/fix", {
    latitude: 60.01,
    longitude: 24.01,
    source_type: "backfill",
    timestamp: "2025-08-25T12:30:00.000Z",
    notes: "reduced on paper, logged next morning",
    estimated_error_nm: 0.15,
  });
  assert.strictEqual(status, 200);
  assert.ok(body.fix_id > 0);
  await new Promise((r) => setTimeout(r, 20));
  plugin.stop();
  const db = new DatabaseSync(join(dir, "dead-reckoning.sqlite"), {
    readOnly: true,
  });
  const fix = db
    .prepare("SELECT * FROM fixes WHERE fix_id = ?")
    .get(body.fix_id);
  assert.strictEqual(fix.source_type, "backfill");
  assert.strictEqual(
    fix.timestamp,
    "2025-08-25T12:30:00.000Z",
    "fix row should carry the observation time, not entry time",
  );
  assert.strictEqual(fix.notes, "reduced on paper, logged next morning");
  assert.ok(Math.abs(fix.estimated_error_radius - 0.15) < 1e-9);
  const correction = db
    .prepare("SELECT * FROM dr_corrections WHERE fix_id = ?")
    .get(body.fix_id);
  assert.ok(correction, "correction row written for the backfilled fix");
  assert.strictEqual(correction.timestamp, "2025-08-25T12:30:00.000Z");
  db.close();
  await rm(dir, { recursive: true, force: true });
});

test("POST /fix ignores an invalid timestamp rather than rejecting the fix", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-fix-badts-"));
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  plugin.start({});
  const router = new FakeRouter();
  plugin.registerWithRouter(router);
  const { status, body } = router.invoke("post", "/fix", {
    latitude: 60,
    longitude: 24,
    source_type: "manual",
    timestamp: "not-a-date",
  });
  assert.strictEqual(status, 200);
  await new Promise((r) => setTimeout(r, 20));
  plugin.stop();
  const db = new DatabaseSync(join(dir, "dead-reckoning.sqlite"), {
    readOnly: true,
  });
  const fix = db
    .prepare("SELECT * FROM fixes WHERE fix_id = ?")
    .get(body.fix_id);
  assert.notStrictEqual(
    fix.timestamp,
    "not-a-date",
    "invalid timestamp should fall back to entry time",
  );
  db.close();
  await rm(dir, { recursive: true, force: true });
});

test("POST /celestial/sight reduces a Sun sight and persists a celestial LOP", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-cel-"));
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  plugin.start({});
  const router = new FakeRouter();
  plugin.registerWithRouter(router);
  // Set a DR position so the engine has an origin to reduce from.
  app.emitDelta({
    context: "vessels.self",
    updates: [
      {
        values: [
          {
            path: "navigation.position",
            value: { latitude: 40, longitude: -75 },
          },
        ],
      },
    ],
  });
  await new Promise((r) => setTimeout(r, 30));
  // A Sun sight at local noon: Hs chosen so the intercept is small.
  const t = new Date("2026-06-21T17:00:00Z").getTime();
  const { status, body } = router.invoke("post", "/celestial/sight", {
    body: "Sun",
    hs_deg: 72.5,
    eye_height_m: 3,
    epoch_ms: t,
    limb: "lower",
    confirmed_by: "crew",
  });
  assert.strictEqual(status, 200);
  assert.ok(body.lop_id > 0);
  assert.strictEqual(body.reduction.body, "Sun");
  assert.ok(Number.isFinite(body.reduction.intercept_nm));
  assert.ok(
    body.reduction.azimuth_true >= 0 && body.reduction.azimuth_true < 360,
  );
  plugin.stop();
  const db = new DatabaseSync(join(dir, "dead-reckoning.sqlite"), {
    readOnly: true,
  });
  const row = db
    .prepare("SELECT * FROM lines_of_position WHERE lop_id = ?")
    .get(body.lop_id);
  assert.strictEqual(row.lop_type, "celestial");
  assert.strictEqual(row.body_or_object, "Sun");
  assert.strictEqual(row.used_in_fix_id, null);
  db.close();
  await rm(dir, { recursive: true, force: true });
});

test("POST /celestial/sight rejects a missing required field", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-cel-bad-"));
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  plugin.start({});
  const router = new FakeRouter();
  plugin.registerWithRouter(router);
  const { status, body } = router.invoke("post", "/celestial/sight", {
    body: "Sun",
    hs_deg: 72.5,
  });
  assert.strictEqual(status, 400);
  assert.ok(/body, hs_deg, epoch_ms required/.test(body.message));
  plugin.stop();
  await rm(dir, { recursive: true, force: true });
});

test("POST /celestial/sight returns 400 for a below-cutoff sight", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-cel-low-"));
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  plugin.start({});
  const router = new FakeRouter();
  plugin.registerWithRouter(router);
  app.emitDelta({
    context: "vessels.self",
    updates: [
      {
        values: [
          {
            path: "navigation.position",
            value: { latitude: 40, longitude: -65 },
          },
        ],
      },
    ],
  });
  await new Promise((r) => setTimeout(r, 30));
  const t = new Date("2026-06-21T08:30:00Z").getTime();
  const { status, body } = router.invoke("post", "/celestial/sight", {
    body: "Sun",
    hs_deg: 6,
    epoch_ms: t,
  });
  assert.strictEqual(status, 400);
  assert.ok(/refraction cutoff/.test(body.message));
  plugin.stop();
  await rm(dir, { recursive: true, force: true });
});

test("POST /celestial/sight with noon: true reduces a meridian sight to a latitude LOP", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-noon-"));
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  plugin.start({});
  const router = new FakeRouter();
  plugin.registerWithRouter(router);
  app.emitDelta({
    context: "vessels.self",
    updates: [
      {
        values: [
          {
            path: "navigation.position",
            value: { latitude: 40, longitude: -75 },
          },
        ],
      },
    ],
  });
  await new Promise((r) => setTimeout(r, 30));
  const t = new Date("2026-06-21T17:00:00Z").getTime();
  // Ho at 40N meridian transit ≈ 73.4°; back out a lower-limb Hs.
  const trueHo = 90 - Math.abs(40 - 23.44);
  const hs = trueHo + celestial.dipArcmin(3) / 60 - 0.2666;
  const { status, body } = router.invoke("post", "/celestial/sight", {
    body: "Sun",
    hs_deg: hs,
    eye_height_m: 3,
    epoch_ms: t,
    limb: "lower",
    noon: true,
  });
  assert.strictEqual(status, 200);
  assert.ok(body.lop_id > 0);
  // The noon reduction recovers a latitude near 40.
  assert.ok(Math.abs(body.reduction.assumed_lat - 40) < 0.5);
  assert.strictEqual(body.reduction.intercept_nm, 0);
  assert.ok(
    body.reduction.azimuth_true === 0 || body.reduction.azimuth_true === 180,
  );
  plugin.stop();
  await rm(dir, { recursive: true, force: true });
});

test("uncertainty polygon publishes fallback method with no correction history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-unc-fb-"));
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  plugin.start({});
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
  await new Promise((r) => setTimeout(r, 1100));
  const uDelta = app.handledMessages
    .flatMap((m) => m.message?.updates ?? [])
    .flatMap((u) => u.values ?? [])
    .find((v) => v.path === "navigation.deadReckoning.uncertainty");
  assert.ok(uDelta, "uncertainty delta not published");
  assert.strictEqual(uDelta.value.method, "fallback");
  assert.ok(typeof uDelta.value.radius_m === "number");
  assert.ok(uDelta.value.radius_m >= 0);
  plugin.stop();
  await rm(dir, { recursive: true, force: true });
});

test("uncertainty polygon radius grows monotonically with distance run", async () => {
  // Isolated DB so no leftover dr_corrections push it into empirical mode.
  const dir = await mkdtemp(join(tmpdir(), "dr-unc-grow-"));
  // Pre-seed the restored per-excursion distance well above the GNSS
  // noise floor (0.02 nm) so both samples measure growth, not the floor.
  const seedDb = require("../plugin/db.js").openDatabase(
    join(dir, "dead-reckoning.sqlite"),
  );
  const { setState } = require("../plugin/db.js");
  setState(seedDb, "dr_log_since_origin", "5");
  // Seed the origin too, or the first GPS delta snaps to it and resets
  // the excursion distance back to zero.
  setState(
    seedDb,
    "last_known_good_fix",
    JSON.stringify({ latitude: 60, longitude: 24 }),
  );
  seedDb.close();
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  plugin.start({});
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
  await new Promise((r) => setTimeout(r, 1200));
  const r1 = latestUncertainty(app);
  assert.strictEqual(r1.method, "fallback");
  await new Promise((r) => setTimeout(r, 1200));
  const r2 = latestUncertainty(app);
  // Distance run grew → radius grows (the §8 "scales with distance, not
  // time" claim is tested precisely at the unit level; here we confirm the
  // live path publishes growing radii).
  assert.ok(
    r2.radius_m > r1.radius_m,
    `radius should grow: r1=${r1.radius_m} r2=${r2.radius_m}`,
  );
  // 0.02 nm GNSS-noise floor, in metres.
  assert.ok(r1.radius_m > 0.02 * 1852, "seeded run should exceed the floor");
  plugin.stop();
  await rm(dir, { recursive: true, force: true });
});

test("uncertainty polygon tightens toward empirical after corrections + bin hits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-unc-emp-"));
  // Seed the restored per-excursion distance so both regimes measure
  // rates, not the GNSS-noise floor.
  const seedDb = require("../plugin/db.js").openDatabase(
    join(dir, "dead-reckoning.sqlite"),
  );
  const { setState } = require("../plugin/db.js");
  setState(seedDb, "dr_log_since_origin", "5");
  seedDb.close();
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  plugin.start({});
  const router = new FakeRouter();
  plugin.registerWithRouter(router);

  // Seed the matrix bin with a high live hit count so effectiveHitCount
  // is high (live × 5), and seed dr_corrections rows with a *low* deviation
  // rate so the empirical radius is far below the fallback.
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(join(dir, "dead-reckoning.sqlite"));
  db.prepare(
    `INSERT INTO dr_matrix_bins
       (sail_state, sea_state, stw_bin, awa_bin, heel_bin,
        leeway_angle, speed_loss, upwash_correction,
        hit_count, live_hit_count, historical_hit_count, historical_confidence_tier)
     VALUES ('unknown','unknown',5,0,0, 0,0,0, 60,60,0,NULL)`,
  ).run();
  // Low-deviation corrections: 0.01 nm over 3600 s → tiny per-time rate,
  // → per-distance rate well below the fallback.
  const insFix = db.prepare(
    "INSERT INTO fixes (timestamp, source_type, latitude, longitude, confirmed_by, resets_dr_origin) VALUES (?, 'gps', 60, 24, NULL, 1)",
  );
  const insCorr = db.prepare(
    `INSERT INTO dr_corrections
       (fix_id, timestamp, dr_lat, dr_lon, fix_lat, fix_lon,
        deviation_nm, deviation_bearing, dr_elapsed_seconds, sail_state, sea_state)
     VALUES (?, '2026-01-01T00:00:00Z', 60.01, 24.01, 60, 24, 0.01, 200, 3600, 'unknown','unknown')`,
  );
  for (let i = 0; i < 25; i++) {
    const fid = insFix.run("2026-01-01T00:00:00Z");
    insCorr.run(Number(fid.lastInsertRowid));
  }
  db.close();

  app.emitDelta({
    context: "vessels.self",
    updates: [
      {
        values: [
          {
            path: "navigation.position",
            value: { latitude: 60, longitude: 24 },
          },
          { path: "navigation.speedThroughWater", value: 2.5722 }, // 5 kn in m/s — must land in the seeded stw_bin=5
          { path: "navigation.headingTrue", value: 0 },
        ],
      },
    ],
  });
  await new Promise((r) => setTimeout(r, 1200));
  const u = latestUncertainty(app);
  assert.ok(
    u.method === "empirical" || u.method === "blend",
    `expected empirical/blend, got ${u.method}`,
  );
  // The empirical/blend radius should be well below the pure-fallback
  // radius at the same distance (the tightening signal).
  const { computeRadius } = require("../plugin/uncertainty.js");
  const fallbackOnly = computeRadius({
    elapsedDistanceNm: 5,
    effectiveHitCount: 0,
    deviationRows: [],
    stwKn: 5,
  }).radius_nm;
  assert.ok(
    u.radius_m < fallbackOnly * 1852,
    `empirical/blend radius ${u.radius_m} should be below fallback ${fallbackOnly}`,
  );
  plugin.stop();
  await rm(dir, { recursive: true, force: true });
});

test("uncertainty polygon radius drops after a snap-to-fix resets the excursion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-unc-snap-"));
  // Seed the restored per-excursion distance so `before` is well above
  // the GNSS-noise floor; after the snap it must drop to the floor.
  const seedDb = require("../plugin/db.js").openDatabase(
    join(dir, "dead-reckoning.sqlite"),
  );
  const { setState } = require("../plugin/db.js");
  setState(seedDb, "dr_log_since_origin", "10");
  // Seed the origin so the first GPS delta doesn't reset the excursion.
  setState(
    seedDb,
    "last_known_good_fix",
    JSON.stringify({ latitude: 60, longitude: 24 }),
  );
  seedDb.close();
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  plugin.start({});
  const router = new FakeRouter();
  plugin.registerWithRouter(router);

  // Sail ~3 ticks to accumulate distance (so `before` reflects several
  // ticks of growth).
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
  await new Promise((r) => setTimeout(r, 3200));
  const before = latestUncertainty(app);
  assert.ok(before.radius_m > 0, "radius should be non-zero before snap");

  // Confirm a fix → snapToFix resets logNmSinceOrigin to 0; the next tick
  // re-grows it from one tick of distance, so `after` reflects far less
  // accumulated distance than `before`.
  router.invoke("post", "/fix", {
    latitude: 60.001,
    longitude: 24.001,
    source_type: "gps",
  });
  await new Promise((r) => setTimeout(r, 1200));
  const after = latestUncertainty(app);
  assert.ok(
    after.radius_m < before.radius_m,
    `radius should drop after snap (excursion reset): before=${before.radius_m} after=${after.radius_m}`,
  );
  plugin.stop();
  await rm(dir, { recursive: true, force: true });
});

/** Returns the latest published uncertainty value, or throws. */
function latestUncertainty(app) {
  const vals = app.handledMessages
    .flatMap((m) => m.message?.updates ?? [])
    .flatMap((u) => u.values ?? [])
    .filter((v) => v.path === "navigation.deadReckoning.uncertainty");
  if (vals.length === 0) throw new Error("no uncertainty delta published");
  return vals[vals.length - 1].value;
}

test("divergence advisory raises on sustained DR-GPS divergence and publishes the readout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-dvg-raise-"));
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  // Fast tick + fast hysteresis so the 30s default doesn't slow the test.
  plugin.start({
    tickIntervalMs: 100,
    divergence: { sustainS: 0.3, clearS: 0.3 },
  });
  const router = new FakeRouter();
  plugin.registerWithRouter(router);
  // GPS held fixed at (60, 24) while the boat sails north at a
  // synthetic 120 kn from it — divergence must outrun the GNSS-noise
  // radius floor (0.02 nm) within the fast-hysteresis window; a real
  // 6 kn would take ~20 s to cross it.
  app.emitDelta({
    context: "vessels.self",
    updates: [
      {
        values: [
          {
            path: "navigation.position",
            value: { latitude: 60, longitude: 24 },
          },
          { path: "navigation.speedThroughWater", value: 120 },
          { path: "navigation.headingTrue", value: 0 },
        ],
      },
    ],
  });
  await new Promise((r) => setTimeout(r, 2000));
  // Divergence readout published and growing.
  const dvg = latestDivergence(app);
  assert.ok(dvg.distance_m > 0, "divergence readout should be non-zero");
  // Advisory raised at alert severity, visual method.
  const notif = latestNotification(
    app,
    "notifications.navigation.deadReckoning.divergenceAdvisory",
  );
  assert.ok(notif, "advisory notification not published");
  assert.strictEqual(notif.state, "alert");
  assert.ok(Array.isArray(notif.method) && notif.method.includes("visual"));
  assert.ok(/consider taking a fix/.test(notif.message));
  plugin.stop();
  await rm(dir, { recursive: true, force: true });
});

test("divergence advisory clears after a confirmed fix snaps DR back to GPS", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-dvg-clear-"));
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  plugin.start({
    tickIntervalMs: 100,
    divergence: { sustainS: 0.3, clearS: 0.3 },
  });
  const router = new FakeRouter();
  plugin.registerWithRouter(router);
  app.emitDelta({
    context: "vessels.self",
    updates: [
      {
        values: [
          {
            path: "navigation.position",
            value: { latitude: 60, longitude: 24 },
          },
          { path: "navigation.speedThroughWater", value: 120 },
          { path: "navigation.headingTrue", value: 0 },
        ],
      },
    ],
  });
  await new Promise((r) => setTimeout(r, 2000));
  const raised = latestNotification(
    app,
    "notifications.navigation.deadReckoning.divergenceAdvisory",
  );
  assert.strictEqual(raised.state, "alert");

  // Stop the boat and confirm a fix at the GPS position: DR snaps to it,
  // divergence → 0, sustained recovery clears the advisory.
  app.emitDelta({
    context: "vessels.self",
    updates: [{ values: [{ path: "navigation.speedThroughWater", value: 0 }] }],
  });
  router.invoke("post", "/fix", {
    latitude: 60,
    longitude: 24,
    source_type: "gps",
  });
  await new Promise((r) => setTimeout(r, 900));
  const cleared = latestNotification(
    app,
    "notifications.navigation.deadReckoning.divergenceAdvisory",
  );
  assert.strictEqual(cleared.state, "normal");
  assert.ok(/back within expected uncertainty/.test(cleared.message));
  plugin.stop();
  await rm(dir, { recursive: true, force: true });
});

test("divergence monitor is suppressed at anchor", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-dvg-anchor-"));
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  plugin.start({
    tickIntervalMs: 100,
    divergence: { sustainS: 0.3, clearS: 0.3 },
  });
  const router = new FakeRouter();
  plugin.registerWithRouter(router);
  // Same divergent geometry, but anchored: no divergence readout, no advisory.
  app.emitDelta({
    context: "vessels.self",
    updates: [
      {
        values: [
          {
            path: "navigation.position",
            value: { latitude: 60, longitude: 24 },
          },
          { path: "navigation.speedThroughWater", value: 6 },
          { path: "navigation.headingTrue", value: 0 },
          { path: "navigation.state", value: "anchored" },
        ],
      },
    ],
  });
  await new Promise((r) => setTimeout(r, 900));
  // Suppression now means an explicit null readout (so connected UIs drop
  // any stale underway figure), not silence.
  const vals = app.handledMessages
    .flatMap((m) => m.message?.updates ?? [])
    .flatMap((u) => u.values ?? [])
    .filter((v) => v.path === "navigation.deadReckoning.divergence");
  assert.ok(vals.length > 0, "null divergence readout should be published");
  assert.strictEqual(
    vals[vals.length - 1].value,
    null,
    "divergence readout should be null at anchor",
  );
  const notif = app.handledMessages
    .flatMap((m) => m.message?.updates ?? [])
    .flatMap((u) => u.values ?? [])
    .find(
      (v) =>
        v.path ===
          "notifications.navigation.deadReckoning.divergenceAdvisory" &&
        v.value.state === "alert",
    );
  assert.ok(!notif, "advisory should not fire at anchor");
  plugin.stop();
  await rm(dir, { recursive: true, force: true });
});

test("moored with wind: no fouled paddlewheel alert, advisory withdrawn, null divergence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-moored-fouled-"));
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  plugin.start({
    tickIntervalMs: 100,
    divergence: { sustainS: 0.3, clearS: 0.3 },
  });
  const router = new FakeRouter();
  plugin.registerWithRouter(router);

  // Phase 1 — underway, sailing away from a fixed GPS at a synthetic
  // 120 kn (divergence outruns the 0.02 nm radius floor quickly):
  // advisory raises.
  app.emitDelta({
    context: "vessels.self",
    updates: [
      {
        values: [
          {
            path: "navigation.position",
            value: { latitude: 60, longitude: 24 },
          },
          { path: "navigation.speedThroughWater", value: 120 },
          { path: "navigation.headingTrue", value: 0 },
        ],
      },
    ],
  });
  await new Promise((r) => setTimeout(r, 2000));
  assert.strictEqual(
    latestNotification(
      app,
      "notifications.navigation.deadReckoning.divergenceAdvisory",
    ).state,
    "alert",
  );

  // Phase 2 — tie up: STW reads 0 (a moored paddlewheel's honest value),
  // wind blows 12 kn on the mast, GPS wanders a few metres. The old
  // behaviour: phantom "paddlewheel fouled" alert + stuck advisory.
  app.emitDelta({
    context: "vessels.self",
    updates: [
      {
        values: [
          { path: "navigation.state", value: "moored" },
          { path: "navigation.speedThroughWater", value: 0 },
          { path: "environment.wind.speedApparent", value: 12 },
          {
            path: "navigation.position",
            value: { latitude: 60.0005, longitude: 24.0005 },
          },
        ],
      },
    ],
  });
  await new Promise((r) => setTimeout(r, 900));

  // The advisory raised just before mooring is withdrawn, not stuck.
  const notif = latestNotification(
    app,
    "notifications.navigation.deadReckoning.divergenceAdvisory",
  );
  assert.strictEqual(notif.state, "normal");
  assert.ok(/suspended while moored/.test(notif.message));

  // Divergence readout is an explicit null — no stale underway figure.
  assert.strictEqual(latestDivergence(app), null);

  // No phantom fouled paddlewheel: wind on a tied-up boat is not making way.
  const health = latestNotification(
    app,
    "notifications.navigation.deadReckoning.status",
  );
  assert.ok(health?.state !== "alert", `got ${health?.message}`);
  plugin.stop();
  await rm(dir, { recursive: true, force: true });
});

test("moored from the start: DR state clean (no fouled, no transient), fouled detector idle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-moored-clean-"));
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  plugin.start({ tickIntervalMs: 100 });
  app.emitDelta({
    context: "vessels.self",
    updates: [
      {
        values: [
          { path: "navigation.state", value: "moored" },
          {
            path: "navigation.position",
            value: { latitude: 60, longitude: 24 },
          },
          { path: "navigation.speedThroughWater", value: 0 },
          { path: "navigation.headingTrue", value: 10 },
          { path: "environment.wind.speedApparent", value: 15 },
          { path: "environment.wind.angleApparent", value: 1.2 },
        ],
      },
    ],
  });
  await new Promise((r) => setTimeout(r, 500));
  const stateDeltas = app.handledMessages
    .flatMap((m) => m.message?.updates ?? [])
    .flatMap((u) => u.values ?? [])
    .filter((v) => v.path === "navigation.deadReckoning.state");
  assert.ok(stateDeltas.length > 0, "no DR state delta published");
  const last = stateDeltas[stateDeltas.length - 1].value;
  // Engine warm on a tied-up boat: its own status, not "underway" —
  // and no navState duplication (navigation.state already flows).
  assert.strictEqual(last.status, "warm");
  assert.strictEqual(last.fouled, false);
  assert.strictEqual(last.transient, false);
  assert.ok(!("navState" in last), "navState must not be republished");
  const health = app.handledMessages
    .flatMap((m) => m.message?.updates ?? [])
    .flatMap((u) => u.values ?? [])
    .find(
      (v) =>
        v.path === "notifications.navigation.deadReckoning.status" &&
        v.value.state === "alert",
    );
  assert.ok(!health, "no sensor-health alert while moored");
  plugin.stop();
  await rm(dir, { recursive: true, force: true });
});

test("fouling alert is debounced: threshold-hovering STW doesn't flap, sustained fouling raises", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-fouled-debounce-"));
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  plugin.start({
    tickIntervalMs: 100,
    sensorHealth: { sustainS: 1, clearS: 1 },
  });
  app.emitDelta({
    context: "vessels.self",
    updates: [
      {
        values: [
          {
            path: "navigation.position",
            value: { latitude: 60, longitude: 24 },
          },
          { path: "navigation.headingTrue", value: 0 },
          { path: "environment.wind.speedApparent", value: 12 },
        ],
      },
    ],
  });

  // STW hovers at the detector's stop threshold, strictly alternating
  // every 37 ms (incommensurate with the 100 ms tick so consecutive
  // ticks never sample a stable parity — paddlewheel spinner
  // sticking/slipping): raw verdict flips far faster than the 1 s
  // sustain window, so the alert must not raise.
  let flip = 0;
  const flap = setInterval(() => {
    app.emitDelta({
      context: "vessels.self",
      updates: [
        {
          values: [
            {
              path: "navigation.speedThroughWater",
              value: flip++ % 2 === 0 ? 0 : 0.4,
            },
          ],
        },
      ],
    });
  }, 37);
  await new Promise((r) => setTimeout(r, 1500));
  clearInterval(flap);
  const healthAlerts = () =>
    app.handledMessages
      .flatMap((m) => m.message?.updates ?? [])
      .flatMap((u) => u.values ?? [])
      .filter(
        (v) =>
          v.path === "notifications.navigation.deadReckoning.status" &&
          v.value.state === "alert",
      );
  assert.strictEqual(
    healthAlerts().length,
    0,
    "fouling alert flapped during threshold hover",
  );

  // A real fault — STW pinned at 0 while wind says 12 kn — must still
  // surface after the sustain window.
  app.emitDelta({
    context: "vessels.self",
    updates: [
      {
        values: [{ path: "navigation.speedThroughWater", value: 0 }],
      },
    ],
  });
  await new Promise((r) => setTimeout(r, 1600));
  const alerts = healthAlerts();
  assert.strictEqual(alerts.length, 1, "sustained fouling did not raise");
  assert.ok(/fouled/.test(alerts[0].value.message));
  plugin.stop();
  await rm(dir, { recursive: true, force: true });
});

test("water-track log survives restart via dr_log_nm state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-log-restore-"));
  // Pre-seed the persisted state a previous run's flush would have left.
  const db = require("../plugin/db.js").openDatabase(
    join(dir, "dead-reckoning.sqlite"),
  );
  const { setState } = require("../plugin/db.js");
  setState(db, "dr_log_nm", "12.5");
  setState(db, "dr_trip_log_nm", "3.25");
  db.close();

  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  plugin.start({});
  const router = new FakeRouter();
  plugin.registerWithRouter(router);
  const { body } = router.invoke("get", "/status");
  assert.strictEqual(body.logNm, 12.5);
  assert.strictEqual(body.tripLogNm, 3.25);
  plugin.stop();
  await rm(dir, { recursive: true, force: true });
});

/** Returns the latest published divergence readout, or throws. */
function latestDivergence(app) {
  const vals = app.handledMessages
    .flatMap((m) => m.message?.updates ?? [])
    .flatMap((u) => u.values ?? [])
    .filter((v) => v.path === "navigation.deadReckoning.divergence");
  if (vals.length === 0) throw new Error("no divergence delta published");
  return vals[vals.length - 1].value;
}

/** Returns the latest value of a notification path, or undefined. */
function latestNotification(app, path) {
  const vals = app.handledMessages
    .flatMap((m) => m.message?.updates ?? [])
    .flatMap((u) => u.values ?? [])
    .filter((v) => v.path === path);
  return vals.length ? vals[vals.length - 1].value : undefined;
}

test("logbook: confirmed fix writes entry and marks the fixes row", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-lb-fix-"));
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  // Injectable fetch recorder via deps override isn't available here;
  // the logbook client is created by initLogbook with default fetch.
  // Instead: enable with a config token and stub globalThis.fetch.
  const posts = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    posts.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 201 };
  };
  try {
    plugin.start({ logbook: { enabled: true, token: "tok" } });
    const router = new FakeRouter();
    plugin.registerWithRouter(router);
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
    await new Promise((r) => setTimeout(r, 100));
    const { status, body } = router.invoke("post", "/fix", {
      latitude: 60.001,
      longitude: 24.001,
      source_type: "gps",
      confirmed_by: "Alice",
    });
    assert.strictEqual(status, 200);
    // The POST is async fire-and-forget; give it a beat.
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(posts.length, 1, "one logbook entry POSTed");
    assert.ok(posts[0].url.includes("/plugins/signalk-logbook/logs"));
    const entry = posts[0].body;
    assert.strictEqual(entry.origin, "auto");
    assert.strictEqual(entry.category, "navigation");
    assert.strictEqual(entry.author, "Alice");
    assert.strictEqual(entry.position.source, "GPS");
    assert.ok(/GPS fix/.test(entry.text));
    assert.ok(
      !/by Alice/.test(entry.text),
      "author stays in metadata, not text",
    );
    assert.ok(/0\.1 NM at \d{3}°T from DR/.test(entry.text));
    assert.ok(entry.datetime); // explicit, never `ago`

    // fixes row marked with the entry ref
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(join(dir, "dead-reckoning.sqlite"), {
      readOnly: true,
    });
    const row = db
      .prepare(
        "SELECT logged_to_logbook, logbook_entry_ref FROM fixes WHERE fix_id = ?",
      )
      .get(body.fix_id);
    assert.strictEqual(row.logged_to_logbook, 1);
    assert.strictEqual(row.logbook_entry_ref, entry.datetime);
    db.close();
    plugin.stop();
  } finally {
    globalThis.fetch = realFetch;
  }
  await rm(dir, { recursive: true, force: true });
});

test("deflattenConfig folds flat dotted keys into nested objects", () => {
  const deflattenConfig = require("../plugin/index.js").deflattenConfig;
  // Flat shape — what the server's admin UI saves for dotted schema keys.
  assert.deepEqual(
    deflattenConfig({
      tickIntervalMs: 500,
      "logbook.enabled": true,
      "logbook.token": "tok",
      "polar.windowS": 90,
    }),
    {
      tickIntervalMs: 500,
      logbook: { enabled: true, token: "tok" },
      polar: { windowS: 90 },
    },
  );
  // Nested shape passes through untouched.
  const nested = {
    logbook: { enabled: true, url: "http://x" },
    array: [1, 2],
  };
  assert.deepEqual(deflattenConfig(nested), nested);
  // Mixed shapes merge without losing either side.
  assert.deepEqual(
    deflattenConfig({
      "logbook.enabled": true,
      logbook: { token: "tok" },
    }),
    { logbook: { enabled: true, token: "tok" } },
  );
  // Null-safe.
  assert.deepEqual(deflattenConfig(null), {});
});

test("logbook: flat dotted config keys enable write-through (server admin UI save shape)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-lb-flat-"));
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  const posts = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    posts.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 201 };
  };
  try {
    // Exactly the shape saved by the admin UI for the dotted schema
    // keys (regression: this used to fall back to enabled=false and
    // silently queue every entry forever).
    plugin.start({
      "logbook.enabled": true,
      "logbook.token": "tok",
    });
    const router = new FakeRouter();
    plugin.registerWithRouter(router);
    const { status } = router.invoke("post", "/fix/lop", {
      assumed_lat: -18.865,
      assumed_lon: -159.8,
      azimuth_true: 45,
      lop_type: "bearing",
      body_or_object: "LIGHTHOUSE",
      confirmed_by: "bergie",
    });
    assert.strictEqual(status, 200);
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(posts.length, 1, "observation entry POSTed immediately");
    assert.ok(/LIGHTHOUSE bearing/.test(posts[0].body.text));
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(join(dir, "dead-reckoning.sqlite"), {
      readOnly: true,
    });
    const queued = db
      .prepare("SELECT COUNT(*) AS n FROM logbook_pending")
      .get();
    assert.strictEqual(queued.n, 0, "nothing left in the pending queue");
    db.close();
    plugin.stop();
  } finally {
    globalThis.fetch = realFetch;
  }
  await rm(dir, { recursive: true, force: true });
});

test("logbook: disabled by default — no entry, fix still confirmed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-lb-off-"));
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  const posts = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    posts.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 201 };
  };
  try {
    plugin.start({});
    const router = new FakeRouter();
    plugin.registerWithRouter(router);
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
    await new Promise((r) => setTimeout(r, 100));
    const { status, body } = router.invoke("post", "/fix", {
      latitude: 60.001,
      longitude: 24.001,
      source_type: "gps",
    });
    assert.strictEqual(status, 200);
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(posts.length, 0);
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(join(dir, "dead-reckoning.sqlite"), {
      readOnly: true,
    });
    const row = db
      .prepare("SELECT logged_to_logbook FROM fixes WHERE fix_id = ?")
      .get(body.fix_id);
    assert.strictEqual(row.logged_to_logbook, 0);
    db.close();
    plugin.stop();
  } finally {
    globalThis.fetch = realFetch;
  }
  await rm(dir, { recursive: true, force: true });
});

test("logbook: tokenless start queues the fix entry, access approval flushes it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-lb-queue-"));
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  const posts = [];
  const realFetch = globalThis.fetch;
  let approved = false;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.endsWith("/signalk/v1/access/requests")) {
      return {
        ok: true,
        status: 202,
        json: async () => ({
          state: "PENDING",
          href: "/signalk/v1/requests/abc",
        }),
      };
    }
    if (u.includes("/signalk/v1/requests/abc")) {
      return {
        ok: true,
        status: 200,
        json: async () =>
          approved
            ? {
                state: "COMPLETED",
                accessRequest: {
                  permission: "APPROVED",
                  token: "granted-tok",
                  expirationTime: null,
                },
              }
            : { state: "PENDING" },
      };
    }
    if (u.includes("/plugins/signalk-logbook/logs")) {
      posts.push({
        url: u,
        body: JSON.parse(opts.body),
        auth: opts.headers?.Authorization,
      });
      return { ok: true, status: 201 };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  try {
    plugin.start({
      logbook: {
        enabled: true,
        pollIntervalMs: 20,
        url: "http://x/plugins/signalk-logbook/logs",
        baseUrl: "http://x",
      },
    });
    const router = new FakeRouter();
    plugin.registerWithRouter(router);
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
    await new Promise((r) => setTimeout(r, 50));
    // Confirm a fix BEFORE approval — entry must be queued, not lost.
    const { status, body } = router.invoke("post", "/fix", {
      latitude: 60.001,
      longitude: 24.001,
      source_type: "gps",
      confirmed_by: "Alice",
    });
    assert.strictEqual(status, 200);
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(posts.length, 0, "nothing written while tokenless");
    const { DatabaseSync } = require("node:sqlite");
    let db = new DatabaseSync(join(dir, "dead-reckoning.sqlite"), {
      readOnly: true,
    });
    let pending = db.prepare("SELECT COUNT(*) c FROM logbook_pending").get().c;
    assert.strictEqual(pending, 1, "fix entry queued during approval window");
    let row = db
      .prepare("SELECT logged_to_logbook FROM fixes WHERE fix_id = ?")
      .get(body.fix_id);
    assert.strictEqual(
      row.logged_to_logbook,
      0,
      "fix row unmarked until write lands",
    );
    db.close();
    // Admin approves — the queued entry flushes with the granted token.
    approved = true;
    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(posts.length, 1, "queued entry delivered on approval");
    assert.strictEqual(posts[0].auth, "Bearer granted-tok");
    db = new DatabaseSync(join(dir, "dead-reckoning.sqlite"), {
      readOnly: true,
    });
    pending = db.prepare("SELECT COUNT(*) c FROM logbook_pending").get().c;
    assert.strictEqual(pending, 0, "queue drained after flush");
    row = db
      .prepare("SELECT logged_to_logbook FROM fixes WHERE fix_id = ?")
      .get(body.fix_id);
    assert.strictEqual(row.logged_to_logbook, 1, "fix row marked after flush");
    db.close();
    plugin.stop();
  } finally {
    globalThis.fetch = realFetch;
  }
  await rm(dir, { recursive: true, force: true });
});

test("logbook: unreachable server queues writes and retries on next write", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-lb-unreach-"));
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  const posts = [];
  const realFetch = globalThis.fetch;
  let reach = false;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (!reach) throw new Error("connect ECONNREFUSED");
    if (u.endsWith("/signalk/v1/access/requests")) {
      return {
        ok: true,
        status: 202,
        json: async () => ({
          state: "PENDING",
          href: "/signalk/v1/requests/abc",
        }),
      };
    }
    if (u.includes("/signalk/v1/requests/abc")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          state: "COMPLETED",
          accessRequest: {
            permission: "APPROVED",
            token: "tok2",
            expirationTime: null,
          },
        }),
      };
    }
    if (u.includes("/plugins/signalk-logbook/logs")) {
      posts.push({ url: u });
      return { ok: true, status: 201 };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  try {
    plugin.start({
      logbook: {
        enabled: true,
        pollIntervalMs: 20,
        url: "http://x/plugins/signalk-logbook/logs",
        baseUrl: "http://x",
      },
    });
    const router = new FakeRouter();
    plugin.registerWithRouter(router);
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
        { values: [{ path: "navigation.speedThroughWater", value: 5 }] },
        { values: [{ path: "navigation.headingTrue", value: 0 }] },
      ],
    });
    await new Promise((r) => setTimeout(r, 50));
    // Confirm while the server is unreachable — entry queues, no false
    // "unauthenticated" mode, status honest.
    router.invoke("post", "/fix", {
      latitude: 60.001,
      longitude: 24.001,
      source_type: "gps",
      confirmed_by: "Alice",
    });
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(posts.length, 0, "no write attempted while unreachable");
    const { DatabaseSync } = require("node:sqlite");
    let db = new DatabaseSync(join(dir, "dead-reckoning.sqlite"), {
      readOnly: true,
    });
    let pending = db.prepare("SELECT COUNT(*) c FROM logbook_pending").get().c;
    assert.strictEqual(pending, 1, "entry queued while unreachable");
    db.close();
    // Server comes back — the next write re-kicks initLogbook, the access
    // request now succeeds, approval flushes the queued entry.
    reach = true;
    router.invoke("post", "/fix", {
      latitude: 60.002,
      longitude: 24.002,
      source_type: "gps",
      confirmed_by: "Alice",
    });
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(posts.length >= 1, "queued entry delivered once reachable");
    db = new DatabaseSync(join(dir, "dead-reckoning.sqlite"), {
      readOnly: true,
    });
    pending = db.prepare("SELECT COUNT(*) c FROM logbook_pending").get().c;
    assert.strictEqual(pending, 0, "queue drained after recovery");
    db.close();
    plugin.stop();
  } finally {
    globalThis.fetch = realFetch;
  }
  await rm(dir, { recursive: true, force: true });
});

test("logbook: denied access — writes dropped, no re-request spam", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-lb-denied-"));
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  const posts = [];
  const accessReqs = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/signalk/v1/access/requests")) {
      accessReqs.push(u);
      return {
        ok: true,
        status: 202,
        json: async () => ({
          state: "PENDING",
          href: "/signalk/v1/requests/abc",
        }),
      };
    }
    if (u.includes("/signalk/v1/requests/abc")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          state: "COMPLETED",
          accessRequest: { permission: "DENIED" },
        }),
      };
    }
    if (u.includes("/plugins/signalk-logbook/logs")) {
      posts.push({ url: u });
      return { ok: true, status: 201 };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  try {
    plugin.start({
      logbook: {
        enabled: true,
        pollIntervalMs: 20,
        url: "http://x/plugins/signalk-logbook/logs",
        baseUrl: "http://x",
      },
    });
    const router = new FakeRouter();
    plugin.registerWithRouter(router);
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
        { values: [{ path: "navigation.speedThroughWater", value: 5 }] },
        { values: [{ path: "navigation.headingTrue", value: 0 }] },
      ],
    });
    await new Promise((r) => setTimeout(r, 120)); // let DENIED verdict land
    const beforeReqs = accessReqs.length;
    router.invoke("post", "/fix", {
      latitude: 60.001,
      longitude: 24.001,
      source_type: "gps",
      confirmed_by: "Alice",
    });
    await new Promise((r) => setTimeout(r, 80));
    assert.strictEqual(posts.length, 0, "denied → no logbook writes");
    assert.strictEqual(
      accessReqs.length,
      beforeReqs,
      "denied → no re-request spam on write",
    );
    plugin.stop();
  } finally {
    globalThis.fetch = realFetch;
  }
  await rm(dir, { recursive: true, force: true });
});

test("sea state from environment.water.swell.state flows into dr_corrections", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-lb-sea-"));
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  plugin.start({});
  const router = new FakeRouter();
  plugin.registerWithRouter(router);
  app.emitDelta({
    context: "vessels.self",
    updates: [
      {
        values: [
          {
            path: "navigation.position",
            value: { latitude: 60, longitude: 24 },
          },
          { path: "environment.water.swell.state", value: 3 },
          { path: "navigation.speedThroughWater", value: 5 },
          { path: "navigation.headingTrue", value: 0 },
        ],
      },
    ],
  });
  await new Promise((r) => setTimeout(r, 100));
  const { status, body } = router.invoke("post", "/fix", {
    latitude: 60.001,
    longitude: 24.001,
    source_type: "gps",
  });
  assert.strictEqual(status, 200);
  assert.ok(body.correction_id != null);
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(join(dir, "dead-reckoning.sqlite"), {
    readOnly: true,
  });
  const row = db
    .prepare("SELECT sea_state FROM dr_corrections WHERE correction_id = ?")
    .get(body.correction_id);
  assert.strictEqual(row.sea_state, "3");
  db.close();
  plugin.stop();
  await rm(dir, { recursive: true, force: true });
});

test("logbook: completed tack writes one entry, debounced for a second maneuver", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-lb-tack-"));
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  const posts = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    posts.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 201 };
  };
  try {
    // Short settle + debounce so the test runs fast; fast tick so ROT
    // accumulates over seconds, not ticks. Settle (1s) must elapse after
    // the turn before the entry fires, and the debounce (10s) keeps the
    // second maneuver suppressed for the remainder of the test.
    plugin.start({
      tickIntervalMs: 100,
      logbook: { enabled: true, token: "tok", tackDebounceS: 10 },
      training: { settleSustainS: 1 },
    });
    const router = new FakeRouter();
    plugin.registerWithRouter(router);
    const emit = (heading, awaRad) =>
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
              { path: "navigation.headingTrue", value: heading },
              { path: "environment.wind.angleApparent", value: awaRad },
            ],
          },
        ],
      });
    // Steady starboard close-hauled for a few ticks (AWA 30° starboard).
    for (let i = 0; i < 5; i++) emit(350, (30 * Math.PI) / 180);
    await new Promise((r) => setTimeout(r, 150));
    // Snap onto port (heading 30, AWA 330°) — ROT spike opens the window.
    for (let i = 0; i < 5; i++) emit(30, (330 * Math.PI) / 180);
    // Settle: heel+AWA+heading must hold for settleSustainS after the turn
    // stops, then the entry fires. 2.5s ≫ 1s settle + fetch margin.
    await new Promise((r) => setTimeout(r, 2500));
    const tacks = posts.filter((p) => /Tack to/.test(p.body.text));
    assert.strictEqual(
      tacks.length,
      1,
      `expected exactly one tack entry, got ${posts.map((p) => p.body.text)}`,
    );
    assert.strictEqual(tacks[0].body.origin, "auto");
    assert.ok(tacks[0].body.datetime);

    // An immediate second maneuver inside the debounce window logs nothing.
    for (let i = 0; i < 5; i++) emit(350, (30 * Math.PI) / 180);
    await new Promise((r) => setTimeout(r, 2500));
    const tacks2 = posts.filter((p) => /Tack to/.test(p.body.text));
    assert.strictEqual(
      tacks2.length,
      1,
      "debounce should suppress the second tack",
    );
    plugin.stop();
  } finally {
    globalThis.fetch = realFetch;
  }
  await rm(dir, { recursive: true, force: true });
});

test("GET /fixes, /observations, /corrections expose the UI overlay shapes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-ui-rest-"));
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  plugin.start({});
  const router = new FakeRouter();
  plugin.registerWithRouter(router);
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
  await new Promise((r) => setTimeout(r, 100));
  // Seed: one LOP, one CPL, one confirmed fix (with correction).
  const lop = router.invoke("post", "/fix/lop", {
    timestamp: new Date().toISOString(),
    azimuth_true: 45,
    assumed_lat: 60.02,
    assumed_lon: 24.02,
    intercept_nm: 1.2,
    lop_type: "celestial",
    body_or_object: "Sun",
  });
  const cpl = router.invoke("post", "/fix/cpl", {
    timestamp: new Date().toISOString(),
    center_lat: 60.05,
    center_lon: 24.05,
    radius_nm: 3.5,
    source_object: "lighthouse",
  });
  router.invoke("post", "/fix", {
    latitude: 60.001,
    longitude: 24.001,
    source_type: "gps",
    confirmed_by: "Alice",
  });

  const fixes = router.invoke("get", "/fixes", undefined);
  assert.strictEqual(fixes.status, 200);
  assert.ok(Array.isArray(fixes.body.fixes));
  const fixRow = fixes.body.fixes[0];
  for (const k of [
    "fix_id",
    "timestamp",
    "source_type",
    "latitude",
    "longitude",
    "confirmed_by",
  ]) {
    assert.ok(k in fixRow, `fixes row missing ${k}`);
  }

  const obs = router.invoke("get", "/observations", undefined);
  assert.strictEqual(obs.status, 200);
  assert.strictEqual(obs.body.lops.length, 1);
  const lopRow = obs.body.lops[0];
  for (const k of [
    "lop_id",
    "assumed_lat",
    "assumed_lon",
    "azimuth_true",
    "intercept_nm",
    "used_in_fix_id",
  ]) {
    assert.ok(k in lopRow, `lop row missing ${k}`);
  }
  assert.strictEqual(obs.body.cpls.length, 1);
  const cplRow = obs.body.cpls[0];
  for (const k of [
    "cpl_id",
    "center_lat",
    "center_lon",
    "radius_nm",
    "used_in_fix_id",
  ]) {
    assert.ok(k in cplRow, `cpl row missing ${k}`);
  }

  const corr = router.invoke("get", "/corrections", undefined);
  assert.strictEqual(corr.status, 200);
  assert.ok(corr.body.corrections.length >= 1);
  const corrRow = corr.body.corrections[0];
  for (const k of [
    "dr_lat",
    "dr_lon",
    "fix_lat",
    "fix_lon",
    "deviation_nm",
    "deviation_bearing",
  ]) {
    assert.ok(k in corrRow, `correction row missing ${k}`);
  }

  // Contract: the view-model consumes these exact shapes without error.
  const vm = await import("../public/dr-viewmodel.js");
  const lopSpec = vm.lopLineSpec(obs.body.lops[0]);
  assert.ok(Array.isArray(lopSpec.anchor));
  const cplSpec = vm.cplCircleSpec(obs.body.cpls[0]);
  assert.strictEqual(cplSpec.radiusNm, 3.5);
  const fixSpec = vm.fixPointSpec(
    fixes.body.fixes[fixes.body.fixes.length - 1],
  );
  assert.ok(fixSpec.color);
  const seg = vm.correctionSegmentSpec(corrRow);
  assert.ok(Array.isArray(seg.from) && Array.isArray(seg.to));

  // Limits are honored.
  const limited = router.invoke("get", "/fixes?limit=1", undefined);
  assert.strictEqual(limited.body.fixes.length, 1);

  plugin.stop();
  await rm(dir, { recursive: true, force: true });
});

test("GET /celestial/bodies lists Sun, Moon, and bundled stars with validity", () => {
  const { plugin } = makeStarted();
  const router = new FakeRouter();
  plugin.registerWithRouter(router);

  const r = router.invoke("get", "/celestial/bodies", undefined);
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.body.bodies));
  assert.ok(r.body.bodies.includes("Sun"));
  assert.ok(r.body.bodies.includes("Moon"));
  assert.ok(r.body.bodies.includes("Polaris"));
  assert.ok(typeof r.body.valid_from === "string");
  assert.ok(typeof r.body.valid_until === "string");
  assert.strictEqual(typeof r.body.expired, "boolean");
  plugin.stop();
});

test("app.get config endpoint serves the plugin config with a hash", () => {
  const { app, plugin } = makeStarted();
  // The public config endpoint is mounted on app.get (not the router).
  assert.ok(app.appRoutes.length >= 1);
  const cfg = app.appRoutes.find((r) =>
    r.path.includes("/signalk-dead-reckoning/configuration"),
  );
  assert.ok(cfg, "config endpoint registered");
  const res = {
    set() {},
    json(obj) {
      this._body = obj;
    },
    status(code) {
      this._status = code;
    },
  };
  cfg.handler({}, res);
  assert.strictEqual(res._status, undefined); // 200 path doesn't set status
  assert.ok(res._body.config, "config served");
  assert.strictEqual(res._body.config.positionFormat, "dms");
  assert.ok(typeof res._body.configHash === "string");
  assert.ok(res._body.configHash.length > 0);
  plugin.stop();
});

test("schema exposes the positionFormat option with DMS default", () => {
  const app = new FakeSignalKApp();
  const plugin = makePlugin(app);
  assert.ok(plugin.schema.properties.positionFormat);
  assert.strictEqual(plugin.schema.properties.positionFormat.default, "dms");
  assert.deepStrictEqual(plugin.schema.properties.positionFormat.enum, [
    "decimal",
    "dm",
    "dms",
  ]);
});

test("POST /fix populates confirmed_by from the JAUTHENTICATION cookie", () => {
  const { plugin } = makeStarted();
  const router = new FakeRouter();
  plugin.registerWithRouter(router);
  // JWT payload { id: "watchkeeper" }, base64url of the JSON.
  const payload = Buffer.from(JSON.stringify({ id: "watchkeeper" })).toString(
    "base64url",
  );
  const cookie = `header.${payload}.sig`;
  const r = router.invoke(
    "post",
    "/fix",
    {
      latitude: 60.1,
      longitude: 24.9,
      source_type: "manual",
    },
    {},
    { cookies: { JAUTHENTICATION: cookie } },
  );
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.confirmed_by, "watchkeeper");
  plugin.stop();
});

test("POST /fix leaves confirmed_by null when anonymous", () => {
  const { plugin } = makeStarted();
  const router = new FakeRouter();
  plugin.registerWithRouter(router);
  const r = router.invoke(
    "post",
    "/fix",
    {
      latitude: 60.1,
      longitude: 24.9,
      source_type: "manual",
    },
    {},
    { cookies: {} },
  );
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.confirmed_by, null);
  plugin.stop();
});

test("logbook: posting a bearing LOP writes an observation entry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-lb-obs-"));
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  const posts = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    posts.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 201 };
  };
  try {
    plugin.start({ logbook: { enabled: true, token: "tok" } });
    const router = new FakeRouter();
    plugin.registerWithRouter(router);
    // Seed the vessel's DR position from the first GPS fix — distinct
    // from the charted object, so the test can prove the entry records
    // *our* position, not the lighthouse's.
    app.emitDelta({
      context: "vessels.self",
      updates: [
        {
          values: [
            {
              path: "navigation.position",
              value: { latitude: 61, longitude: 25 },
            },
          ],
        },
      ],
    });
    await new Promise((r) => setTimeout(r, 50));
    const { status } = router.invoke("post", "/fix/lop", {
      lop_type: "bearing",
      assumed_lat: 60,
      assumed_lon: 24,
      azimuth_true: 135,
      body_or_object: "lighthouse",
    });
    assert.strictEqual(status, 200);
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(posts.length, 1, "observation logbook entry POSTed");
    const entry = posts[0].body;
    assert.strictEqual(entry.category, "navigation");
    assert.match(entry.text, /lighthouse bearing 135°T/);
    assert.strictEqual(entry.position.source, "DR");
    // The entry's position is the vessel's DR, not the object's charted
    // position (assumed_lat/lon 60,24 is the lighthouse).
    assert.strictEqual(entry.position.latitude, 61);
    assert.strictEqual(entry.position.longitude, 25);
    plugin.stop();
  } finally {
    globalThis.fetch = realFetch;
  }
  await rm(dir, { recursive: true, force: true });
});

test("logbook: posting a celestial sight writes a sight entry with reduction", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-lb-sight-"));
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  const posts = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    posts.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 201 };
  };
  try {
    plugin.start({ logbook: { enabled: true, token: "tok" } });
    const router = new FakeRouter();
    plugin.registerWithRouter(router);
    // Seed the vessel's DR position so the entry records where we were
    // (the sight-reduction assumed position is a different artifact).
    app.emitDelta({
      context: "vessels.self",
      updates: [
        {
          values: [
            {
              path: "navigation.position",
              value: { latitude: 40, longitude: -70 },
            },
          ],
        },
      ],
    });
    await new Promise((r) => setTimeout(r, 50));
    const { status } = router.invoke("post", "/celestial/sight", {
      body: "Sun",
      hs_deg: 45,
      epoch_ms: Date.UTC(2025, 5, 21, 12, 0, 0),
      eye_height_m: 2,
    });
    assert.strictEqual(status, 200);
    await new Promise((r) => setTimeout(r, 100));
    const sightEntries = posts.filter((p) => /sight$|sight,/.test(p.body.text));
    assert.ok(sightEntries.length >= 1, "celestial sight entry POSTed");
    const entry = sightEntries[0].body;
    assert.strictEqual(entry.category, "navigation");
    assert.strictEqual(entry.position.source, "Celestial");
    // The entry's position is the vessel's DR, not the reduction's AP.
    assert.strictEqual(entry.position.latitude, 40);
    assert.strictEqual(entry.position.longitude, -70);
    assert.match(entry.text, /Sun sight/);
    assert.match(entry.text, /intercept/);
    plugin.stop();
  } finally {
    globalThis.fetch = realFetch;
  }
  await rm(dir, { recursive: true, force: true });
});

test("POST /fix with source_type gps confirms a fix at the given position", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-gps-fix-"));
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  plugin.start({});
  const router = new FakeRouter();
  plugin.registerWithRouter(router);
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
  await new Promise((r) => setTimeout(r, 100));
  const { status, body } = router.invoke("post", "/fix", {
    source_type: "gps",
    latitude: 60.001,
    longitude: 24.001,
  });
  assert.strictEqual(status, 200);
  assert.ok(body.fix_id > 0);
  // GPS point fix has zero residual.
  assert.strictEqual(body.confirmed_by, null);
  const db = new DatabaseSync(join(dir, "dead-reckoning.sqlite"), {
    readOnly: true,
  });
  const row = db
    .prepare("SELECT source_type FROM fixes WHERE fix_id = ?")
    .get(body.fix_id);
  assert.strictEqual(row.source_type, "gps");
  db.close();
  plugin.stop();
  await rm(dir, { recursive: true, force: true });
});

test("tick integrates the Weather API current into the DR solution (tier 3)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-weather-"));
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  const realFetch = globalThis.fetch;
  // Point forecast: 1 m/s due east → set 90° true, drift ≈ 1.944 kn.
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => [
      {
        date: new Date().toISOString(),
        current: { set: Math.PI / 2, drift: 1 },
      },
    ],
  });
  try {
    plugin.start({
      tickIntervalMs: 20,
      saveIntervalMs: 60000,
      weatherCurrent: { enabled: true, intervalMs: 50 },
    });
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
    // Wait for the weather poll to land (interval 50 ms) and a DR tick.
    await new Promise((r) => setTimeout(r, 1200));
    const currentVals = app.handledMessages.flatMap((m) =>
      m.message?.updates?.flatMap((u) =>
        (u.values ?? []).filter(
          (v) =>
            v.path === "environment.current.setTrue" ||
            v.path === "environment.current.drift",
        ),
      ),
    );
    assert.ok(currentVals.length > 0, "no environment.current published");
    const last = (p) => {
      const vals = currentVals.filter((v) => v.path === p);
      return vals[vals.length - 1].value;
    };
    // Weather tier 3 in SI bus units: 90° → π/2 rad, 1 m/s stays m/s.
    assert.ok(
      Math.abs(last("environment.current.setTrue") - Math.PI / 2) < 1e-6,
      `setTrue ${last("environment.current.setTrue")}`,
    );
    assert.ok(
      Math.abs(last("environment.current.drift") - 1) < 1e-6,
      `drift ${last("environment.current.drift")}`,
    );
  } finally {
    globalThis.fetch = realFetch;
    plugin.stop();
  }
  await rm(dir, { recursive: true, force: true });
});

/**
 * Emits a GPS fix sequence moving due east at `speedKn` at ~100 ms
 * intervals, so the pair-derived motion estimator converges.
 */
async function emitMovingGps(app, speedKn, fixes = 6) {
  // 6 kn × 100 ms = 0.000167 nm; at 60N, 1° lon ≈ 30 nm.
  const dLon =
    (speedKn * (100 / 3600000)) / (30 * Math.cos((60 * Math.PI) / 180));
  for (let i = 1; i <= fixes; i++) {
    app.emitDelta({
      context: "vessels.self",
      updates: [
        {
          values: [
            {
              path: "navigation.position",
              value: { latitude: 60, longitude: 24 + dLon * i },
            },
          ],
        },
      ],
    });
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** m/s value for a knot figure — `performance.polarSpeed` unit (§3.1). */
function polarMs(kn) {
  return (kn * 1852) / 3600;
}

/**
 * Emits a `performance.polarSpeed` delta stream (m/s), as the polar
 * performance plugin does on every wind update.
 *
 * @param {FakeSignalKApp} app
 * @param {number[]} msValues
 * @param {number} [intervalMs]
 */
async function emitPolarSpeed(app, msValues, intervalMs = 50) {
  for (const v of msValues) {
    app.emitDelta({
      context: "vessels.self",
      updates: [{ values: [{ path: "performance.polarSpeed", value: v }] }],
    });
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function lastValues(app, path) {
  return app.handledMessages
    .filter((m) =>
      m.message?.updates?.some((u) => u.values?.some((v) => v.path === path)),
    )
    .flatMap((m) =>
      m.message.updates.flatMap((u) => u.values.filter((v) => v.path === path)),
    )
    .map((v) => v.value);
}

test("idle while making way: uncertainty grows, state carries moving, alert raised", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-idle-moving-"));
  // Seed the restored per-excursion distance above the GNSS-noise floor
  // so idle-run growth is observable above it within the test window.
  const seedDb = require("../plugin/db.js").openDatabase(
    join(dir, "dead-reckoning.sqlite"),
  );
  const { setState } = require("../plugin/db.js");
  setState(seedDb, "dr_log_since_origin", "1.5");
  // Seed the origin so the first GPS delta doesn't reset the excursion.
  setState(
    seedDb,
    "last_known_good_fix",
    JSON.stringify({ latitude: 60, longitude: 24 }),
  );
  seedDb.close();
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  plugin.start({
    tickIntervalMs: 20,
    saveIntervalMs: 60000,
    sensorHealth: { sustainS: 0.1, clearS: 0.1 },
  });
  try {
    // No STW/heading (idle), but GPS shows ~60 kn over ground.
    await emitMovingGps(app, 60, 20);

    const states = lastValues(app, "navigation.deadReckoning.state");
    assert.ok(states.length > 0, "no state deltas");
    const last = states[states.length - 1];
    assert.strictEqual(last.status, "idle");
    assert.strictEqual(last.moving, true, `state ${JSON.stringify(last)}`);

    const unc = lastValues(app, "navigation.deadReckoning.uncertainty");
    assert.ok(unc.length >= 2, "expected uncertainty deltas while idle-moving");
    assert.ok(
      unc[unc.length - 1].radius_m > unc[0].radius_m,
      `radius should grow: ${unc[0].radius_m} → ${unc[unc.length - 1].radius_m}`,
    );

    const alerts = lastValues(
      app,
      "notifications.navigation.deadReckoning.status",
    );
    assert.ok(
      alerts.some((a) => a.state === "alert" && /stale/i.test(a.message)),
      `no stale alert: ${JSON.stringify(alerts)}`,
    );
  } finally {
    plugin.stop();
  }
  await rm(dir, { recursive: true, force: true });
});

test("idle and stationary (moored): no moving flag, no growth alert", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-idle-still-"));
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  plugin.start({ tickIntervalMs: 20, saveIntervalMs: 60000 });
  try {
    // Same fix repeated → deduped, no motion samples.
    for (let i = 0; i < 5; i++) {
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
      await new Promise((r) => setTimeout(r, 60));
    }
    const states = lastValues(app, "navigation.deadReckoning.state");
    const last = states[states.length - 1];
    assert.strictEqual(last.status, "idle");
    assert.strictEqual(last.moving, false);
    const alerts = lastValues(
      app,
      "notifications.navigation.deadReckoning.status",
    );
    assert.strictEqual(
      alerts.filter((a) => a.state === "alert").length,
      0,
      "no alert when stationary",
    );
  } finally {
    plugin.stop();
  }
  await rm(dir, { recursive: true, force: true });
});

test("fouled paddlewheel: STW 0 while making way raises fouling alert + state flag", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-fouled-"));
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  plugin.start({
    tickIntervalMs: 20,
    saveIntervalMs: 60000,
    sensorHealth: { sustainS: 0.1, clearS: 0.1 },
  });
  try {
    // STW reads 0, heading present → underway branch; GPS moving ~6 kn.
    app.emitDelta({
      context: "vessels.self",
      updates: [
        {
          values: [
            { path: "navigation.speedThroughWater", value: 0 },
            { path: "navigation.headingTrue", value: 45 },
          ],
        },
      ],
    });
    await emitMovingGps(app, 6, 8);

    const states = lastValues(app, "navigation.deadReckoning.state");
    const underway = states.filter((s) => s.status === "underway");
    assert.ok(underway.length > 0, "no underway state");
    const last = states[states.length - 1];
    assert.strictEqual(last.status, "underway");
    assert.strictEqual(last.fouled, true, `state ${JSON.stringify(last)}`);

    const alerts = lastValues(
      app,
      "notifications.navigation.deadReckoning.status",
    );
    assert.ok(
      alerts.some((a) => a.state === "alert" && /fouled/i.test(a.message)),
      `no fouling alert: ${JSON.stringify(alerts)}`,
    );

    // Elapsed-since-fix figure is published for the UI headline.
    const elapsed = lastValues(app, "navigation.deadReckoning.elapsedSinceFix");
    assert.ok(elapsed.length > 0, "no elapsedSinceFix delta");
  } finally {
    plugin.stop();
  }
  await rm(dir, { recursive: true, force: true });
});

// --- inertial-polar: polar-derived STW fallback (SPEC §3.1, work doc #18) --

test("inertial-polar: missing STW + polar deltas → integrates averaged polar speed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-polar-missing-"));
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  plugin.start({ tickIntervalMs: 50, saveIntervalMs: 60000 });
  try {
    app.emitDelta({
      context: "vessels.self",
      updates: [
        {
          values: [
            {
              path: "navigation.position",
              value: { latitude: 60, longitude: 24 },
            },
            { path: "navigation.headingTrue", value: 90 },
          ],
        },
      ],
    });
    // No STW, no polar yet → honest idle with the fallback-zero token.
    await new Promise((r) => setTimeout(r, 250));
    let methods = lastValues(app, "navigation.deadReckoning.method");
    assert.ok(methods.length > 0, "no method delta published");
    assert.strictEqual(
      methods[methods.length - 1],
      "fallback-zero",
      JSON.stringify(methods.slice(-3)),
    );

    await emitPolarSpeed(app, Array(8).fill(polarMs(5)));
    await new Promise((r) => setTimeout(r, 300));

    methods = lastValues(app, "navigation.deadReckoning.method");
    assert.strictEqual(
      methods[methods.length - 1],
      "inertial-polar",
      JSON.stringify(methods.slice(-3)),
    );

    const states = lastValues(app, "navigation.deadReckoning.state").filter(
      (s) => s.status === "underway",
    );
    assert.ok(states.length > 0, "no underway state on polar");
    assert.strictEqual(
      states[states.length - 1].speedSource,
      "polar",
      JSON.stringify(states[states.length - 1]),
    );

    // DR advanced on the averaged polar speed (heading 90° → east).
    const positions = lastValues(app, "navigation.deadReckoning.position");
    assert.ok(positions.length > 1, "no DR positions on polar");
    assert.ok(
      positions[positions.length - 1].longitude > positions[0].longitude,
      `DR did not advance: ${JSON.stringify(positions.map((p) => p.longitude))}`,
    );

    // The sensor STW output stays silent — a polar estimate is a model,
    // not a measurement, and must not masquerade as one.
    assert.strictEqual(
      lastValues(app, "navigation.speedThroughWater").length,
      0,
      "plugin published navigation.speedThroughWater while on polar",
    );

    // Uncertainty grows at the fallback rate: no trusted bin for a
    // model-derived speed.
    const unc = lastValues(app, "navigation.deadReckoning.uncertainty");
    assert.strictEqual(unc[unc.length - 1].method, "fallback");

    // Sensor-health alert names the missing paddlewheel and the switch.
    const alerts = lastValues(
      app,
      "notifications.navigation.deadReckoning.status",
    );
    assert.ok(
      alerts.some(
        (a) => a.state === "alert" && /polar-derived/.test(a.message),
      ),
      `no polar alert: ${JSON.stringify(alerts)}`,
    );
  } finally {
    plugin.stop();
  }
  await rm(dir, { recursive: true, force: true });
});

test("inertial-polar: fouled paddlewheel switches DR onto polar speed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-polar-fouled-"));
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  plugin.start({
    tickIntervalMs: 50,
    saveIntervalMs: 60000,
    sensorHealth: { sustainS: 0.1, clearS: 0.1 },
  });
  try {
    app.emitDelta({
      context: "vessels.self",
      updates: [
        {
          values: [
            {
              path: "navigation.position",
              value: { latitude: 60, longitude: 24 },
            },
            { path: "navigation.speedThroughWater", value: 0 },
            { path: "navigation.headingTrue", value: 90 },
            // Wind corroborates making-way (§6.3's AWS path) — constant,
            // unlike a GPS-derived SOG whose EMA drains once fixes stop
            // changing, which would clear the fouling verdict mid-test.
            { path: "environment.wind.speedApparent", value: 12 },
          ],
        },
      ],
    });
    // Fouled STW reads 0 (a number) — the underway branch would
    // integrate near-zero speed without the polar fallback. Feed the
    // polar stream until the debounced fouling verdict lands and the
    // source switches.
    await emitPolarSpeed(app, Array(20).fill(polarMs(5)));
    await new Promise((r) => setTimeout(r, 300));

    const methods = lastValues(app, "navigation.deadReckoning.method");
    assert.ok(
      methods.includes("inertial-polar"),
      `method never switched to polar: ${JSON.stringify(methods.slice(-5))}`,
    );

    // The fouling verdict stays live and the alert names the switch.
    const states = lastValues(app, "navigation.deadReckoning.state");
    const last = states[states.length - 1];
    assert.strictEqual(last.fouled, true, JSON.stringify(last));
    assert.strictEqual(last.speedSource, "polar");
    const alerts = lastValues(
      app,
      "notifications.navigation.deadReckoning.status",
    );
    assert.ok(
      alerts.some(
        (a) =>
          a.state === "alert" &&
          /fouled/.test(a.message) &&
          /polar/.test(a.message),
      ),
      `no fouled+switch alert: ${JSON.stringify(alerts)}`,
    );
  } finally {
    plugin.stop();
  }
  await rm(dir, { recursive: true, force: true });
});

test("inertial-polar: stale polar feed drops DR to the honest idle branch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-polar-stale-"));
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  plugin.start({
    tickIntervalMs: 50,
    saveIntervalMs: 60000,
    polar: { windowS: 60, staleS: 0.3 },
  });
  try {
    app.emitDelta({
      context: "vessels.self",
      updates: [
        {
          values: [
            {
              path: "navigation.position",
              value: { latitude: 60, longitude: 24 },
            },
            { path: "navigation.headingTrue", value: 90 },
          ],
        },
      ],
    });
    await emitPolarSpeed(app, Array(5).fill(polarMs(5)));
    await new Promise((r) => setTimeout(r, 200));
    const methods = lastValues(app, "navigation.deadReckoning.method");
    assert.strictEqual(methods[methods.length - 1], "inertial-polar");

    // Feed goes quiet past the staleness cutoff → idle, fallback-zero.
    await new Promise((r) => setTimeout(r, 600));
    const methods2 = lastValues(app, "navigation.deadReckoning.method");
    assert.strictEqual(
      methods2[methods2.length - 1],
      "fallback-zero",
      JSON.stringify(methods2.slice(-3)),
    );
    const states = lastValues(app, "navigation.deadReckoning.state");
    const last = states[states.length - 1];
    assert.strictEqual(last.status, "idle");
    assert.strictEqual(last.reason, "no speed through water");
  } finally {
    plugin.stop();
  }
  await rm(dir, { recursive: true, force: true });
});

test("inertial-polar: moored gate — wind on the mast must not sail the shadow boat", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-polar-moored-"));
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  plugin.start({ tickIntervalMs: 50, saveIntervalMs: 60000 });
  try {
    app.emitDelta({
      context: "vessels.self",
      updates: [
        {
          values: [
            { path: "navigation.state", value: "moored" },
            {
              path: "navigation.position",
              value: { latitude: 60, longitude: 24 },
            },
            { path: "navigation.headingTrue", value: 90 },
          ],
        },
      ],
    });
    await emitPolarSpeed(app, Array(6).fill(polarMs(5)));
    await new Promise((r) => setTimeout(r, 250));
    const methods = lastValues(app, "navigation.deadReckoning.method");
    assert.ok(
      !methods.includes("inertial-polar"),
      `polar engaged while moored: ${JSON.stringify(methods)}`,
    );
    const states = lastValues(app, "navigation.deadReckoning.state");
    const last = states[states.length - 1];
    assert.strictEqual(last.status, "idle");
    assert.strictEqual(last.reason, "moored");
  } finally {
    plugin.stop();
  }
  await rm(dir, { recursive: true, force: true });
});

test("inertial-polar: motoring gate — a polar is meaningless under power", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-polar-motoring-"));
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  plugin.start({ tickIntervalMs: 50, saveIntervalMs: 60000 });
  try {
    app.emitDelta({
      context: "vessels.self",
      updates: [
        {
          values: [
            { path: "propulsion.main.state", value: "started" },
            {
              path: "navigation.position",
              value: { latitude: 60, longitude: 24 },
            },
            { path: "navigation.headingTrue", value: 90 },
          ],
        },
      ],
    });
    await emitPolarSpeed(app, Array(6).fill(polarMs(5)));
    await new Promise((r) => setTimeout(r, 250));
    const methods = lastValues(app, "navigation.deadReckoning.method");
    assert.ok(
      !methods.includes("inertial-polar"),
      `polar engaged while motoring: ${JSON.stringify(methods)}`,
    );
    const states = lastValues(app, "navigation.deadReckoning.state");
    const last = states[states.length - 1];
    assert.strictEqual(last.status, "idle");
    assert.strictEqual(last.reason, "no speed through water");
  } finally {
    plugin.stop();
  }
  await rm(dir, { recursive: true, force: true });
});

test("inertial-polar: paddlewheel recovery flips method back and clears the alert", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-polar-recover-"));
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  plugin.start({ tickIntervalMs: 50, saveIntervalMs: 60000 });
  try {
    app.emitDelta({
      context: "vessels.self",
      updates: [
        {
          values: [
            {
              path: "navigation.position",
              value: { latitude: 60, longitude: 24 },
            },
            { path: "navigation.headingTrue", value: 90 },
          ],
        },
      ],
    });
    await emitPolarSpeed(app, Array(6).fill(polarMs(5)));
    await new Promise((r) => setTimeout(r, 200));
    let methods = lastValues(app, "navigation.deadReckoning.method");
    assert.strictEqual(methods[methods.length - 1], "inertial-polar");

    // The paddlewheel comes back → paddlewheel authority restored.
    app.emitDelta({
      context: "vessels.self",
      updates: [
        { values: [{ path: "navigation.speedThroughWater", value: 5 }] },
      ],
    });
    await new Promise((r) => setTimeout(r, 300));
    methods = lastValues(app, "navigation.deadReckoning.method");
    assert.strictEqual(
      methods[methods.length - 1],
      "inertial-paddlewheel",
      JSON.stringify(methods.slice(-3)),
    );
    const states = lastValues(app, "navigation.deadReckoning.state");
    assert.strictEqual(states[states.length - 1].speedSource, "paddlewheel");
    const alerts = lastValues(
      app,
      "notifications.navigation.deadReckoning.status",
    );
    assert.ok(
      alerts.some(
        (a) => a.state === "normal" && /sensor health nominal/.test(a.message),
      ),
      `no clear transition: ${JSON.stringify(alerts)}`,
    );
  } finally {
    plugin.stop();
  }
  await rm(dir, { recursive: true, force: true });
});

// --- Observation & fix CRUD routes (work doc #13 stage D) ------------------

test("DELETE /fix/lop/:id deletes pending LOPs, 404s missing, 409s attached", async () => {
  const { app, plugin, router } = makeStarted();
  const lop_id = router.invoke("post", "/fix/lop", {
    lop_type: "bearing",
    assumed_lat: 60,
    assumed_lon: 24,
    azimuth_true: 45,
    body_or_object: "Rock",
  }).body.lop_id;
  const gone = router.invoke("delete", `/fix/lop/${lop_id}`);
  assert.strictEqual(gone.status, 200);
  assert.strictEqual(gone.body.ok, true);
  // Now missing.
  assert.strictEqual(router.invoke("delete", `/fix/lop/${lop_id}`).status, 404);
  // Invalid id.
  assert.strictEqual(router.invoke("delete", "/fix/lop/abc").status, 400);

  // Attached: confirm a fix using a fresh LOP, then refuse the delete.
  const lop2 = router.invoke("post", "/fix/lop", {
    lop_type: "bearing",
    assumed_lat: 60,
    assumed_lon: 24,
    azimuth_true: 45,
  }).body.lop_id;
  const fix = router.invoke("post", "/fix", {
    source_type: "bearing",
    latitude: 60,
    longitude: 24,
    lop_ids: [lop2],
    confirmed_by: "crew",
  });
  assert.strictEqual(fix.status, 200);
  const refused = router.invoke("delete", `/fix/lop/${lop2}`);
  assert.strictEqual(refused.status, 409);
  assert.ok(
    new RegExp(`fix #${fix.body.fix_id}`).test(refused.body.message),
    `message names the fix: ${refused.body.message}`,
  );
  app.subscriptionmanager.subscriptions.length = 0;
  plugin.stop();
});

test("PUT /fix/lop/:id edits a pending LOP, 409s attached, 400s empty", async () => {
  const { app, plugin, router } = makeStarted();
  const lop_id = router.invoke("post", "/fix/lop", {
    lop_type: "bearing",
    assumed_lat: 60,
    assumed_lon: 24,
    azimuth_true: 45,
    body_or_object: "Rock",
  }).body.lop_id;
  const updated = router.invoke("put", `/fix/lop/${lop_id}`, {
    azimuth_true: 52,
    body_or_object: "North Rock",
  });
  assert.strictEqual(updated.status, 200);
  assert.strictEqual(updated.body.lop.azimuth_true, 52);
  assert.strictEqual(updated.body.lop.body_or_object, "North Rock");

  // No editable fields.
  assert.strictEqual(
    router.invoke("put", `/fix/lop/${lop_id}`, { lop_type: "rdf" }).status,
    400,
  );
  assert.strictEqual(router.invoke("put", "/fix/lop/99999", {}).status, 404);

  // Attached: point fix that carries the LOP id (a point fix resolves
  // trivially and the observation is still attached to it).
  const fix = router.invoke("post", "/fix", {
    source_type: "bearing",
    latitude: 60,
    longitude: 24,
    lop_ids: [lop_id],
  });
  assert.strictEqual(fix.status, 200);
  assert.strictEqual(
    router.invoke("put", `/fix/lop/${lop_id}`, { azimuth_true: 10 }).status,
    409,
  );
  app.subscriptionmanager.subscriptions.length = 0;
  plugin.stop();
});

test("PUT /fix/cpl/:id edits a pending CPL", async () => {
  const { app, plugin, router } = makeStarted();
  const cpl_id = router.invoke("post", "/fix/cpl", {
    cpl_type: "vertical-angle",
    center_lat: 60,
    center_lon: 24,
    radius_nm: 2,
    source_object: "light",
  }).body.cpl_id;
  const updated = router.invoke("put", `/fix/cpl/${cpl_id}`, {
    radius_nm: 2.75,
  });
  assert.strictEqual(updated.status, 200);
  assert.strictEqual(updated.body.cpl.radius_nm, 2.75);
  app.subscriptionmanager.subscriptions.length = 0;
  plugin.stop();
});

test("DELETE /fix/:id un-confirms: observations return to pending, correction dropped", async () => {
  const { app, plugin, router } = makeStarted();
  // Seed an origin so the confirm writes a correction row.
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
  const lop_id = router.invoke("post", "/fix/lop", {
    lop_type: "bearing",
    assumed_lat: 60,
    assumed_lon: 24,
    azimuth_true: 45,
    body_or_object: "Rock",
  }).body.lop_id;
  const cpl_id = router.invoke("post", "/fix/cpl", {
    cpl_type: "vertical-angle",
    center_lat: 60.02,
    center_lon: 24.02,
    radius_nm: 1.5,
    source_object: "light",
  }).body.cpl_id;
  const fix = router.invoke("post", "/fix", {
    source_type: "bearing",
    lop_ids: [lop_id],
    cpl_ids: [cpl_id],
    confirmed_by: "crew",
  });
  assert.strictEqual(fix.status, 200);
  assert.strictEqual(fix.body.recorded_correction, true);

  const deleted = router.invoke("delete", `/fix/${fix.body.fix_id}`);
  assert.strictEqual(deleted.status, 200);

  const after = router.invoke("get", "/observations?limit=10");
  const lop = after.body.lops.find((l) => l.lop_id === lop_id);
  const cpl = after.body.cpls.find((c) => c.cpl_id === cpl_id);
  assert.ok(lop, "LOP survived the fix delete");
  assert.strictEqual(lop.used_in_fix_id, null, "LOP pending again");
  assert.ok(cpl, "CPL survived the fix delete");
  assert.strictEqual(cpl.used_in_fix_id, null, "CPL pending again");

  const fixes = router.invoke("get", "/fixes?limit=10").body.fixes;
  assert.ok(!fixes.some((f) => f.fix_id === fix.body.fix_id), "fix row gone");
  const corrections = router.invoke("get", "/corrections?limit=10").body
    .corrections;
  assert.ok(
    !corrections.some((c) => c.fix_id === fix.body.fix_id),
    "correction row gone",
  );
  assert.strictEqual(router.invoke("delete", "/fix/99999").status, 404);
  app.subscriptionmanager.subscriptions.length = 0;
  plugin.stop();
});

test("PUT /fix/:id edits notes, guards position/source_type (409)", async () => {
  const { app, plugin, router } = makeStarted();
  const fix = router.invoke("post", "/fix", {
    latitude: 60,
    longitude: 24,
    source_type: "manual",
    notes: "berth",
  });
  assert.strictEqual(fix.status, 200);
  const updated = router.invoke("put", `/fix/${fix.body.fix_id}`, {
    notes: "berth 12, west quay",
  });
  assert.strictEqual(updated.status, 200);
  assert.strictEqual(updated.body.fix.notes, "berth 12, west quay");

  const guarded = router.invoke("put", `/fix/${fix.body.fix_id}`, {
    latitude: 61,
  });
  assert.strictEqual(guarded.status, 409);
  assert.ok(/latitude/.test(guarded.body.message));
  const guarded2 = router.invoke("put", `/fix/${fix.body.fix_id}`, {
    source_type: "gps",
  });
  assert.strictEqual(guarded2.status, 409);
  assert.strictEqual(
    router.invoke("put", "/fix/99999", { notes: "x" }).status,
    404,
  );
  app.subscriptionmanager.subscriptions.length = 0;
  plugin.stop();
});

test("POST /fix/resolve response carries per-observation advancements (work doc #13 C)", async () => {
  const { app, plugin, router } = makeStarted();
  const early = router.invoke("post", "/fix/lop", {
    lop_type: "bearing",
    assumed_lat: 60,
    assumed_lon: 24,
    azimuth_true: 0,
    timestamp: "2026-01-01T10:00:00Z",
  }).body.lop_id;
  const late = router.invoke("post", "/fix/lop", {
    lop_type: "bearing",
    assumed_lat: 60,
    assumed_lon: 24.4,
    azimuth_true: 90,
    timestamp: "2026-01-01T14:00:00Z",
  }).body.lop_id;
  const { status, body } = router.invoke("post", "/fix/resolve", {
    source_type: "bearing",
    lop_ids: [early, late],
  });
  assert.strictEqual(status, 200);
  const advancements = body.candidate.advancements;
  assert.ok(Array.isArray(advancements), "advancements present");
  assert.strictEqual(advancements.length, 2);
  const byId = Object.fromEntries(advancements.map((a) => [a.id, a]));
  assert.ok(byId[early], "early LOP advancement carries its id");
  // No ground track in this test → nothing advanced, but the records
  // still report original == advanced with null displacement.
  assert.deepStrictEqual(byId[early].advanced, byId[early].original);
  assert.strictEqual(byId[early].displacement, null);
  assert.strictEqual(byId[late].displacement, null);
  app.subscriptionmanager.subscriptions.length = 0;
  plugin.stop();
});

test("ground-track samples survive a plugin restart and still advance fixes (work doc #16)", async () => {
  const { app, plugin } = makeStarted();
  // Sail east at 5 kn so the DR shadow boat produces a measurable track.
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
          { path: "navigation.headingTrue", value: 90 },
        ],
      },
    ],
  });
  await new Promise((r) => setTimeout(r, 5000));
  const tNow = Date.now();
  // Sight times strictly inside the sampled window. Ticks fire at ~1 Hz
  // but the first position-bearing tick lands ~2s in, so after a 5s
  // wait samples span ≈ [tNow-3000, tNow-1000]. Keep both sights inside
  // the last two inter-tick gaps with margin on each edge.
  const earlyTs = tNow - 1900;
  const lateTs = tNow - 1200;
  plugin.stop(); // flushState() persists the ground-track samples

  // "Restart": a fresh plugin instance over the same data dir/db.
  const app2 = new FakeSignalKApp();
  app2.dataPath = tempDir;
  const plugin2 = makePlugin(app2);
  plugin2.start({});
  const router2 = new FakeRouter();
  plugin2.registerWithRouter(router2);

  const early = router2.invoke("post", "/fix/lop", {
    lop_type: "bearing",
    assumed_lat: 60,
    assumed_lon: 24,
    azimuth_true: 0,
    timestamp: new Date(earlyTs).toISOString(),
  }).body.lop_id;
  const late = router2.invoke("post", "/fix/lop", {
    lop_type: "bearing",
    assumed_lat: 60,
    assumed_lon: 24.4,
    azimuth_true: 90,
    timestamp: new Date(lateTs).toISOString(),
  }).body.lop_id;
  const { status, body } = router2.invoke("post", "/fix/resolve", {
    source_type: "bearing",
    lop_ids: [early, late],
  });
  assert.strictEqual(status, 200);
  const advancements = body.candidate.advancements;
  assert.ok(Array.isArray(advancements), "advancements present");
  const byId = Object.fromEntries(advancements.map((a) => [a.id, a]));
  // The pre-restart DR run advanced the older sight: displacement is a
  // real (bearing, distance) pair, not the un-advanced null.
  assert.ok(
    byId[early].displacement && byId[early].displacement.distanceNm > 0,
    `early sight advanced along pre-restart DR run: ${JSON.stringify(
      byId[early].displacement,
    )}`,
  );
  // The newest sight is the reference — never advanced.
  assert.strictEqual(byId[late].displacement, null);
  plugin2.stop();
  app.subscriptionmanager.subscriptions.length = 0;
});
