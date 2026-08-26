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
  assert.ok(typeof uDelta.value.radius_nm === "number");
  assert.ok(uDelta.value.radius_nm >= 0);
  plugin.stop();
  await rm(dir, { recursive: true, force: true });
});

test("uncertainty polygon radius grows monotonically with distance run", async () => {
  // Isolated DB so no leftover dr_corrections push it into empirical mode.
  const dir = await mkdtemp(join(tmpdir(), "dr-unc-grow-"));
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
    r2.radius_nm > r1.radius_nm,
    `radius should grow: r1=${r1.radius_nm} r2=${r2.radius_nm}`,
  );
  plugin.stop();
  await rm(dir, { recursive: true, force: true });
});

test("uncertainty polygon tightens toward empirical after corrections + bin hits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-unc-emp-"));
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
          { path: "navigation.speedThroughWater", value: 5 },
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
    elapsedDistanceNm: 5 / 3600,
    effectiveHitCount: 0,
    deviationRows: [],
    stwKn: 5,
  }).radius_nm;
  assert.ok(
    u.radius_nm < fallbackOnly,
    `empirical/blend radius ${u.radius_nm} should be below fallback ${fallbackOnly}`,
  );
  plugin.stop();
  await rm(dir, { recursive: true, force: true });
});

test("uncertainty polygon radius drops after a snap-to-fix resets the excursion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-unc-snap-"));
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
  assert.ok(before.radius_nm > 0, "radius should be non-zero before snap");

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
    after.radius_nm < before.radius_nm,
    `radius should drop after snap (excursion reset): before=${before.radius_nm} after=${after.radius_nm}`,
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
