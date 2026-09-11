/**
 * Tests for the current-vector subsystem (SPEC §6.2): the pure forecast
 * parser, the tiered resolver, and the Weather API poller/cache.
 * @file current.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseWeatherCurrent,
  resolveCurrent,
  WeatherCurrentClient,
  MS_TO_KN,
} = require("../plugin/current.js");

const NOW = Date.UTC(2026, 6, 15, 12, 0, 0);

/** forecast entry helper: set rad toward, drift m/s */
function entry(offsetMin, setRad, driftMs) {
  return {
    date: new Date(NOW + offsetMin * 60000).toISOString(),
    current: { set: setRad, drift: driftMs },
  };
}

// ---------------------------------------------------------------- parser

test("parseWeatherCurrent: converts set rad→deg and drift m/s→kn", () => {
  // set 1.74 rad ≈ 99.70°, drift 3.4 m/s ≈ 6.609 kn
  const r = parseWeatherCurrent([entry(0, 1.74, 3.4)], NOW);
  assert.ok(r);
  assert.ok(Math.abs(r.setTrue - (1.74 * 180) / Math.PI) < 1e-9);
  assert.ok(Math.abs(r.drift - 3.4 * MS_TO_KN) < 1e-9);
});

test("parseWeatherCurrent: interpolates u/v between bracketing entries", () => {
  // East 1 m/s at −60 min, east 2 m/s at +60 min → east 1.5 m/s at now.
  const r = parseWeatherCurrent(
    [entry(-60, Math.PI / 2, 1), entry(60, Math.PI / 2, 2)],
    NOW,
  );
  assert.ok(r);
  assert.ok(Math.abs(r.setTrue - 90) < 1e-6);
  assert.ok(Math.abs(r.drift - 1.5 * MS_TO_KN) < 1e-9);
});

test("parseWeatherCurrent: vector interpolation rotates set between entries", () => {
  // North 1 m/s at −60 min, east 1 m/s at +60 min → at the midpoint the
  // vector is NE √2/2 m/s each component → set 45°.
  const r = parseWeatherCurrent(
    [entry(-60, 0, 1), entry(60, Math.PI / 2, 1)],
    NOW,
  );
  assert.ok(r);
  assert.ok(Math.abs(r.setTrue - 45) < 1e-6);
  assert.ok(Math.abs(r.drift - Math.SQRT1_2 * MS_TO_KN) < 1e-9);
});

test("parseWeatherCurrent: clamps outside the series to the nearest endpoint", () => {
  const pts = [entry(-60, 0, 1), entry(0, Math.PI / 2, 2)];
  const before = parseWeatherCurrent(pts, NOW - 120 * 60000);
  assert.ok(before);
  assert.strictEqual(before.setTrue, 0); // first entry (north)
  const after = parseWeatherCurrent(pts, NOW + 120 * 60000);
  assert.ok(after);
  assert.strictEqual(after.setTrue, 90); // last entry (east)
});

test("parseWeatherCurrent: null when no entry carries current data", () => {
  assert.strictEqual(parseWeatherCurrent([], NOW), null);
  assert.strictEqual(
    parseWeatherCurrent([{ date: new Date(NOW).toISOString() }], NOW),
    null,
  );
  assert.strictEqual(parseWeatherCurrent(null, NOW), null);
});

// --------------------------------------------------------------- resolver

test("resolveCurrent: tier 5 zero vector when nothing better exists", () => {
  const c = resolveCurrent({ nowMs: NOW });
  assert.deepStrictEqual(c, { setTrue: 0, drift: 0, tier: 5, source: "none" });
});

test("resolveCurrent: valid weather cache wins as tier 3", () => {
  const c = resolveCurrent({
    weather: { setTrue: 90, drift: 1.2, validUntilMs: NOW + 1000 },
    nowMs: NOW,
  });
  assert.strictEqual(c.tier, 3);
  assert.strictEqual(c.source, "weather-api");
  assert.strictEqual(c.setTrue, 90);
  assert.strictEqual(c.drift, 1.2);
});

test("resolveCurrent: derived residual wins over weather as tier 2", () => {
  const c = resolveCurrent({
    derived: { setTrue: 270, drift: 0.7, validUntilMs: NOW + 1000 },
    weather: { setTrue: 90, drift: 1.2, validUntilMs: NOW + 1000 },
    nowMs: NOW,
  });
  assert.strictEqual(c.tier, 2);
  assert.strictEqual(c.source, "derived");
  assert.strictEqual(c.setTrue, 270);
  assert.strictEqual(c.drift, 0.7);
});

test("resolveCurrent: manual override still outranks derived", () => {
  const c = resolveCurrent({
    manual: { setTrue: 180, drift: 0.5, validUntilMs: NOW + 1000 },
    derived: { setTrue: 270, drift: 0.7, validUntilMs: NOW + 1000 },
    nowMs: NOW,
  });
  assert.strictEqual(c.tier, 1);
  assert.strictEqual(c.source, "manual");
});

test("resolveCurrent: expired derived residual falls through to weather", () => {
  const c = resolveCurrent({
    derived: { setTrue: 270, drift: 0.7, validUntilMs: NOW - 1 },
    weather: { setTrue: 90, drift: 1.2, validUntilMs: NOW + 1000 },
    nowMs: NOW,
  });
  assert.strictEqual(c.tier, 3);
  assert.strictEqual(c.source, "weather-api");
  // GPS gone for a day: derived TTL lapsed, the model tier takes over.
  const none = resolveCurrent({
    derived: { setTrue: 270, drift: 0.7, validUntilMs: NOW - 1 },
    nowMs: NOW,
  });
  assert.strictEqual(none.tier, 5);
});

test("resolveCurrent: expired weather cache falls through to zero", () => {
  const c = resolveCurrent({
    weather: { setTrue: 90, drift: 1.2, validUntilMs: NOW - 1 },
    nowMs: NOW,
  });
  assert.strictEqual(c.tier, 5);
});

test("resolveCurrent: manual override outranks weather (tier 1 > 3)", () => {
  const c = resolveCurrent({
    manual: { setTrue: 45, drift: 0.8, validUntilMs: NOW + 1000 },
    weather: { setTrue: 90, drift: 1.2, validUntilMs: NOW + 1000 },
    nowMs: NOW,
  });
  assert.strictEqual(c.tier, 1);
  assert.strictEqual(c.source, "manual");
  assert.strictEqual(c.setTrue, 45);
});

test("resolveCurrent: pilot chart used only when higher tiers absent", () => {
  const pilot = () => ({ setTrue: 270, drift: 0.3 });
  const withWeather = resolveCurrent({
    weather: { setTrue: 90, drift: 1.2, validUntilMs: NOW + 1000 },
    pilotLookup: pilot,
    nowMs: NOW,
  });
  assert.strictEqual(withWeather.tier, 3);
  const withoutWeather = resolveCurrent({
    pilotLookup: pilot,
    nowMs: NOW,
  });
  assert.strictEqual(withoutWeather.tier, 4);
  assert.strictEqual(withoutWeather.source, "pilot-chart");
  assert.strictEqual(withoutWeather.setTrue, 270);
});

test("resolveCurrent: genuine zero-drift weather data is valid tier 3", () => {
  const c = resolveCurrent({
    weather: { setTrue: 0, drift: 0, validUntilMs: NOW + 1000 },
    nowMs: NOW,
  });
  assert.strictEqual(c.tier, 3);
  assert.strictEqual(c.drift, 0);
});

// ------------------------------------------------------- poller + cache

/**
 * Builds a fake in-process `app.weatherApi` (the same shape
 * signalk-energy-predictor calls): `getForecasts(position, "point",
 * {maxCount})` → WeatherDataModel array.
 *
 * @param {object[]} points - forecast entries
 * @param {object} [opts] - { fail: Error } to make the call throw
 * @returns {{getForecasts: Function}}
 */
function fakeWeatherApi(points, opts = {}) {
  let call = 0;
  return {
    async getForecasts(position, kind, query) {
      fakeWeatherApi.lastCall = { position, kind, query, call: call++ };
      if (opts.fail) throw opts.fail;
      return points;
    },
  };
}

// The constructor must survive servers without the Weather API.
const NO_WEATHER_API = { notAWeatherApi: true };

test("WeatherCurrentClient: fetch caches the interpolated vector with TTL", async () => {
  let t = NOW;
  const client = new WeatherCurrentClient({
    getPosition: () => ({ latitude: 60, longitude: 24 }),
    weatherApi: fakeWeatherApi([entry(-30, Math.PI / 2, 1)]),
    now: () => t,
    intervalMs: 1000,
    validityFactor: 4,
  });
  await client.poll();
  const c = client.currentAt();
  assert.ok(c, "cache should be valid immediately after a successful poll");
  assert.ok(Math.abs(c.setTrue - 90) < 1e-6);
  // TTL = interval × factor = 4000 ms.
  t = NOW + 4001;
  assert.strictEqual(client.currentAt(), null, "expired cache → null");
});

test("WeatherCurrentClient: failed fetch keeps the previous cache until TTL", async () => {
  let t = NOW;
  let fail = false;
  const api = {
    async getForecasts() {
      if (fail) throw new Error("weather API returned 503");
      return [entry(-30, 0, 1)];
    },
  };
  const client = new WeatherCurrentClient({
    getPosition: () => ({ latitude: 60, longitude: 24 }),
    weatherApi: api,
    now: () => t,
    intervalMs: 1000,
    validityFactor: 4,
    onStatus: () => {},
  });
  await client.poll();
  assert.ok(client.currentAt());
  fail = true;
  await client.poll(); // must not throw
  t = NOW + 2000;
  const c = client.currentAt();
  assert.ok(c, "old cache still valid after a failed refetch");
  t = NOW + 4001;
  assert.strictEqual(client.currentAt(), null);
});

test("WeatherCurrentClient: no position → no fetch, no error", async () => {
  const client = new WeatherCurrentClient({
    getPosition: () => null,
    weatherApi: {
      getForecasts: () => {
        throw new Error("should not be called");
      },
    },
    now: () => NOW,
  });
  await client.poll();
  assert.strictEqual(client.currentAt(), null);
});

test("WeatherCurrentClient: calls getForecasts in-process with position and count", async () => {
  const api = fakeWeatherApi([entry(-30, 0, 1)]);
  const client = new WeatherCurrentClient({
    getPosition: () => ({ latitude: 60.1, longitude: 24.9 }),
    weatherApi: api,
    now: () => NOW,
    count: 7,
  });
  await client.poll();
  const { position, kind, query } = fakeWeatherApi.lastCall;
  assert.deepStrictEqual(position, { latitude: 60.1, longitude: 24.9 });
  assert.strictEqual(kind, "point");
  assert.strictEqual(query.maxCount, 7);
});

test("WeatherCurrentClient: a server without the Weather API never resolves tier 3", async () => {
  const client = new WeatherCurrentClient({
    getPosition: () => ({ latitude: 60, longitude: 24 }),
    weatherApi: NO_WEATHER_API,
    now: () => NOW,
  });
  await client.poll();
  assert.strictEqual(client.currentAt(), null);
  // Also without any weatherApi at all.
  const bare = new WeatherCurrentClient({
    getPosition: () => ({ latitude: 60, longitude: 24 }),
    now: () => NOW,
  });
  await bare.poll();
  assert.strictEqual(bare.currentAt(), null);
});

test("WeatherCurrentClient: start schedules an immediate poll + interval", async () => {
  let t = NOW;
  const client = new WeatherCurrentClient({
    getPosition: () => ({ latitude: 0, longitude: 0 }),
    weatherApi: fakeWeatherApi([entry(-30, 0, 1)]),
    now: () => t,
    intervalMs: 5,
  });
  client.start();
  // The immediate poll is async; give it a tick to complete.
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(client.currentAt() != null, true, "immediate poll ran");
  t = NOW + 5;
  await new Promise((r) => setTimeout(r, 10));
  client.stop();
});
