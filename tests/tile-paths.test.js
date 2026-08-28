/**
 * Smoketests for the SI bus contract: values the plugin publishes follow
 * the Signal K unit conventions (m, m/s, rad, s) with display-unit meta
 * carrying the nautical-mile conversions, and scalar sibling paths exist
 * for consumers (signalk-status-tiles threshold checks) that cannot read
 * subfields of object-valued paths.
 *
 * @file tile-paths.test.js */

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

const makePlugin = require("../plugin/index.js");
const { FakeSignalKApp, FakeRouter } = require("./fake-app.js");

const METRES_PER_NM = 1852;

const SCALAR_RADIUS = "navigation.deadReckoning.uncertainty.radius";
const SCALAR_DISTANCE = "navigation.deadReckoning.divergence.distance";
const OBJECT_UNCERTAINTY = "navigation.deadReckoning.uncertainty";
const OBJECT_DIVERGENCE = "navigation.deadReckoning.divergence";
const LOG = "navigation.deadReckoning.log";

/**
 * Starts the plugin on a fresh fake app fed one delta batch, waits for
 * a tick, and returns the handles.
 *
 * @param {string} dir - temp data dir
 * @param {Array<{path: string, value: unknown}>} values - delta values
 * @returns {Promise<{app: FakeSignalKApp, plugin: object, router: FakeRouter}>}
 */
async function startedWithDelta(dir, values) {
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  plugin.start({});
  const router = new FakeRouter();
  plugin.registerWithRouter(router);
  app.emitDelta({
    context: "vessels.self",
    updates: [{ values }],
  });
  await new Promise((r) => setTimeout(r, 1100));
  return { app, plugin, router };
}

/** Last value published on a path, across all handled messages. */
function lastValue(app, path) {
  let found;
  for (const { message } of app.handledMessages) {
    for (const update of message?.updates ?? []) {
      for (const v of update.values ?? []) {
        if (v.path === path) found = v.value;
      }
    }
  }
  return found;
}

/** All meta entries published, across all handled messages. */
function allMeta(app) {
  return app.handledMessages
    .flatMap(({ message }) => message?.updates ?? [])
    .flatMap((u) => u.meta ?? []);
}

test("scalar uncertainty/divergence siblings publish in metres alongside the objects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-tile-paths-"));
  const { app, plugin } = await startedWithDelta(dir, [
    { path: "navigation.position", value: { latitude: 60, longitude: 24 } },
    { path: "navigation.speedThroughWater", value: 2.57 },
    { path: "navigation.headingTrue", value: 0 },
  ]);

  const uObj = lastValue(app, OBJECT_UNCERTAINTY);
  assert.ok(uObj, "uncertainty object not published");
  assert.ok(typeof uObj.radius_m === "number");

  const radiusScalar = lastValue(app, SCALAR_RADIUS);
  assert.ok(
    typeof radiusScalar === "number",
    "uncertainty radius scalar not published",
  );
  assert.ok(Math.abs(radiusScalar - uObj.radius_m) < 1e-6);

  const dObj = lastValue(app, OBJECT_DIVERGENCE);
  assert.ok(dObj, "divergence object not published");
  assert.ok(typeof dObj.distance_m === "number");
  assert.ok(typeof dObj.bearing_true === "number"); // radians now

  const distanceScalar = lastValue(app, SCALAR_DISTANCE);
  assert.ok(
    typeof distanceScalar === "number",
    "divergence distance scalar not published",
  );
  assert.ok(Math.abs(distanceScalar - dObj.distance_m) < 1e-6);

  plugin.stop();
  await rm(dir, { recursive: true, force: true });
});

test("log publishes in metres, matching the REST nm figure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-tile-log-"));
  const { app, plugin, router } = await startedWithDelta(dir, [
    { path: "navigation.position", value: { latitude: 60, longitude: 24 } },
    { path: "navigation.speedThroughWater", value: 2.57 },
    { path: "navigation.headingTrue", value: 0 },
  ]);

  const logM = lastValue(app, LOG);
  assert.ok(typeof logM === "number", "log delta not published");
  const status = router.invoke("get", "/status").body;
  assert.ok(
    Math.abs(logM - status.logNm * METRES_PER_NM) < 1,
    `delta ${logM} m vs REST ${status.logNm} nm`,
  );

  plugin.stop();
  await rm(dir, { recursive: true, force: true });
});

test("standard-path passthroughs stay SI (STW m/s, heading rad)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-tile-passthru-"));
  const { app, plugin } = await startedWithDelta(dir, [
    { path: "navigation.position", value: { latitude: 60, longitude: 24 } },
    { path: "navigation.speedThroughWater", value: 2.57 },
    { path: "navigation.headingTrue", value: 1.0 },
  ]);

  assert.strictEqual(lastValue(app, "navigation.headingTrue"), 1.0);
  assert.strictEqual(lastValue(app, "navigation.speedThroughWater"), 2.57);

  plugin.stop();
  await rm(dir, { recursive: true, force: true });
});

test("current publishes on the standard paths in SI units", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-tile-current-"));
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  plugin.start({});
  const router = new FakeRouter();
  plugin.registerWithRouter(router);
  // Manual tier (REST takes deg/kn — it is the plugin's own API).
  router.invoke("put", "/current/manual", { setTrue: 90, drift: 1.5 });
  app.emitDelta({
    context: "vessels.self",
    updates: [
      {
        values: [
          {
            path: "navigation.position",
            value: { latitude: 60, longitude: 24 },
          },
          { path: "navigation.speedThroughWater", value: 2.57 },
          { path: "navigation.headingTrue", value: 0 },
        ],
      },
    ],
  });
  await new Promise((r) => setTimeout(r, 1100));

  assert.ok(
    Math.abs(lastValue(app, "environment.current.setTrue") - Math.PI / 2) <
      1e-6,
    `setTrue ${lastValue(app, "environment.current.setTrue")}`,
  );
  assert.ok(
    Math.abs(
      lastValue(app, "environment.current.drift") - (1.5 * 1852) / 3600,
    ) < 1e-6,
    `drift ${lastValue(app, "environment.current.drift")}`,
  );

  plugin.stop();
  await rm(dir, { recursive: true, force: true });
});

test("divergence distance scalar is null while suppressed (anchored)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-tile-anchor-"));
  const { app, plugin } = await startedWithDelta(dir, [
    { path: "navigation.position", value: { latitude: 60, longitude: 24 } },
    { path: "navigation.speedThroughWater", value: 2.57 },
    { path: "navigation.headingTrue", value: 0 },
    { path: "navigation.state", value: "anchored" },
  ]);

  assert.strictEqual(lastValue(app, OBJECT_DIVERGENCE), null);
  assert.strictEqual(lastValue(app, SCALAR_DISTANCE), null);
  // The uncertainty side still publishes while warm at anchor.
  assert.ok(typeof lastValue(app, SCALAR_RADIUS) === "number");

  plugin.stop();
  await rm(dir, { recursive: true, force: true });
});

test("idle branch nulls both scalars so consumers drop stale figures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-tile-idle-"));
  // Position only: seeds the origin, but with no water-track sensors
  // the engine falls to the idle branch.
  const { app, plugin } = await startedWithDelta(dir, [
    { path: "navigation.position", value: { latitude: 60, longitude: 24 } },
  ]);

  assert.strictEqual(lastValue(app, SCALAR_RADIUS), null);
  assert.strictEqual(lastValue(app, SCALAR_DISTANCE), null);

  plugin.stop();
  await rm(dir, { recursive: true, force: true });
});

test("meta declares SI units, NM display conversion, and duration formatting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-tile-meta-"));
  const app = new FakeSignalKApp();
  app.dataPath = dir;
  const plugin = makePlugin(app);
  plugin.start({});

  const metaByPath = new Map(allMeta(app).map((m) => [m.path, m.value]));

  const radiusMeta = metaByPath.get(SCALAR_RADIUS);
  assert.ok(radiusMeta, "no meta for uncertainty radius scalar");
  assert.strictEqual(radiusMeta.units, "m");
  assert.strictEqual(radiusMeta.displayUnits?.formula, "value/1852");
  assert.strictEqual(radiusMeta.displayUnits?.symbol, "NM");

  const distanceMeta = metaByPath.get(SCALAR_DISTANCE);
  assert.ok(distanceMeta, "no meta for divergence distance scalar");
  assert.strictEqual(distanceMeta.units, "m");
  assert.strictEqual(distanceMeta.displayUnits?.formula, "value/1852");

  const logMeta = metaByPath.get(LOG);
  assert.ok(logMeta, "no meta for log");
  assert.strictEqual(logMeta.units, "m");
  assert.strictEqual(logMeta.displayUnits?.formula, "value/1852");

  const elapsedMeta = metaByPath.get(
    "navigation.deadReckoning.elapsedSinceFix",
  );
  assert.ok(elapsedMeta, "no meta for elapsedSinceFix");
  assert.strictEqual(elapsedMeta.units, "s");
  assert.strictEqual(
    elapsedMeta.displayUnits?.formula,
    "formatDurationCompact(value)",
  );

  plugin.stop();
  await rm(dir, { recursive: true, force: true });
});
