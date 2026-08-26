/**
 * Tests for the pure UI view-model (SPEC §14.1).
 * Loads the browser ESM module directly.
 * @file dr-viewmodel.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const vmPromise = import("../public/dr-viewmodel.js");

/** Resolves the view-model module (loaded once, shared by all tests). */
async function loadVm() {
  return vmPromise;
}

const closeTo = (actual, expected, tol, msg) =>
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${msg}: ${actual} vs ${expected} (±${tol})`,
  );

test("destinationPoint: 60 nm north adds ~1° latitude", async () => {
  const vm = await loadVm();
  const [lat, lon] = vm.destinationPoint([60, 24], 0, 60);
  closeTo(lat, 61, 0.01, "lat");
  closeTo(lon, 24, 0.01, "lon");
});

test("destinationPoint: east bearing moves longitude, ~cos(lat) scaling", async () => {
  const vm = await loadVm();
  const [lat, lon] = vm.destinationPoint([60, 24], 90, 60);
  // Great circle due-east starts at its vertex and dips slightly south
  // (~0.015° over 1° of arc) — this is correct GC behavior, not a bug.
  closeTo(lat, 59.985, 0.01, "lat");
  // 60 nm east at 60N ≈ 1° of longitude (cos(60°) scaling).
  closeTo(lon, 25.999, 0.02, "lon");
});

test("destinationPoint: crosses the antimeridian cleanly", async () => {
  const vm = await loadVm();
  const [, lon] = vm.destinationPoint([10, 179.9], 90, 60);
  assert.ok(lon < 179.9 && lon > -180, `wrapped east: ${lon}`);
});

test("lopLineSpec: intercept shifts the anchor toward the body; zero intercept keeps assumed", async () => {
  const vm = await loadVm();
  const base = {
    assumed_lat: 60,
    assumed_lon: 24,
    azimuth_true: 0,
    intercept_nm: 0,
  };
  const zero = vm.lopLineSpec(base);
  closeTo(zero.anchor[0], 60, 1e-6, "anchor lat");
  closeTo(zero.anchor[1], 24, 1e-6, "anchor lon");

  // 10 nm toward azimuth 0 (north) moves the anchor ~10' north.
  const shifted = vm.lopLineSpec({ ...base, intercept_nm: 10 });
  closeTo(shifted.anchor[0], 60 + 10 / 60, 0.001, "shifted lat");
  closeTo(shifted.anchor[1], 24, 1e-6, "shifted lon");
});

test("extendLineSpec: endpoints sit on the perpendicular ±lengthNm", async () => {
  const vm = await loadVm();
  const spec = { anchor: [60, 24], azimuthDeg: 0 }; // LOP runs E-W
  const [a, b] = vm.extendLineSpec(spec, 30);
  // Both endpoints share the anchor's latitude (E-W line); due-east GC
  // dips slightly south (59.996). At 60N, 30 nm = 1.0° of longitude.
  closeTo(a[0], 59.996, 0.005, "a lat");
  closeTo(b[0], 59.996, 0.005, "b lat");
  closeTo(a[1], 24.999, 0.01, "a lon (+30 nm east)");
  closeTo(b[1], 23.001, 0.01, "b lon (−30 nm west)");
});

test("lopLineSpec / cplCircleSpec carry the used flag for styling", async () => {
  const vm = await loadVm();
  const lop = vm.lopLineSpec({
    assumed_lat: 60,
    assumed_lon: 24,
    azimuth_true: 45,
    intercept_nm: 1,
    used_in_fix_id: 7,
  });
  assert.strictEqual(lop.used, true);
  const cpl = vm.cplCircleSpec({
    center_lat: 60,
    center_lon: 24,
    radius_nm: 2.5,
    used_in_fix_id: null,
  });
  assert.strictEqual(cpl.used, false);
  assert.strictEqual(cpl.radiusNm, 2.5);
  assert.deepStrictEqual(cpl.center, [60, 24]);
});

test("fixPointSpec: styled per source_type, unknown falls back to manual", async () => {
  const vm = await loadVm();
  const mk = (st) =>
    vm.fixPointSpec({ latitude: 60, longitude: 24, source_type: st });
  assert.strictEqual(mk("gps").color, vm.STYLE.fix.gps);
  assert.strictEqual(mk("celestial").color, vm.STYLE.fix.celestial);
  assert.strictEqual(mk("bearing").color, vm.STYLE.fix.bearing);
  assert.strictEqual(mk("whatever").color, vm.STYLE.fix.manual);
  const labeled = vm.fixPointSpec({
    latitude: 60,
    longitude: 24,
    source_type: "celestial",
    confirmed_by: "Bob",
  });
  assert.match(labeled.label, /Celestial fix|celestial fix/);
  assert.match(labeled.label, /Bob/);
});

test("correctionSegmentSpec: from pre-snap DR to fix, carries deviation", async () => {
  const vm = await loadVm();
  const s = vm.correctionSegmentSpec({
    dr_lat: 60.01,
    dr_lon: 24.01,
    fix_lat: 60,
    fix_lon: 24,
    deviation_nm: 0.8,
    deviation_bearing: 210,
  });
  assert.deepStrictEqual(s.from, [60.01, 24.01]);
  assert.deepStrictEqual(s.to, [60, 24]);
  assert.strictEqual(s.deviationNm, 0.8);
  assert.strictEqual(s.bearingDeg, 210);
});

test("TrackLog: dedupes identical points within 1s, evicts at capacity", async () => {
  const vm = await loadVm();
  const t = new vm.TrackLog(3);
  t.push(60, 24, 1000);
  t.push(60, 24, 1500); // dup within 1s → dropped
  t.push(61, 24, 2000);
  t.push(62, 24, 3000);
  t.push(63, 24, 4000); // capacity 3 → first evicted
  assert.strictEqual(t.length, 3);
  assert.deepStrictEqual(t.points(), [
    [61, 24],
    [62, 24],
    [63, 24],
  ]);
});

test("Sparkline: stats with min/max/current and normalized points", async () => {
  const vm = await loadVm();
  const s = new vm.Sparkline(4);
  assert.strictEqual(s.stats().current, null);
  s.push(1);
  s.push(2);
  s.push(3);
  s.push(4); // capacity 4, nothing evicted yet
  const st = s.stats();
  assert.strictEqual(st.current, 4);
  assert.strictEqual(st.min, 1);
  assert.strictEqual(st.max, 4);
  assert.deepStrictEqual(st.points, [0, 1 / 3, 2 / 3, 1]);
  s.push(5); // evicts 1
  const st2 = s.stats();
  assert.strictEqual(st2.min, 2);
  assert.strictEqual(st2.current, 5);
});

test("Sparkline: flat series normalizes to 0.5 line, non-finite ignored", async () => {
  const vm = await loadVm();
  const s = new vm.Sparkline();
  s.push(3);
  s.push(3);
  s.push(3);
  s.push(Number.NaN);
  const st = s.stats();
  assert.deepStrictEqual(st.points, [0.5, 0.5, 0.5]);
});

test("divergenceText: formats distance and zero-padded bearing", async () => {
  const vm = await loadVm();
  assert.strictEqual(
    vm.divergenceText({ distance_nm: 0.423, bearing_true: 3 }),
    "0.42 nm / 003°",
  );
  assert.strictEqual(vm.divergenceText(null), "— nm");
});

test("uncertaintySpec: passes radius/method with DR center", async () => {
  const vm = await loadVm();
  const u = vm.uncertaintySpec([60, 24], {
    radius_nm: 1.5,
    method: "empirical",
  });
  assert.deepStrictEqual(u.center, [60, 24]);
  assert.strictEqual(u.radiusNm, 1.5);
  assert.strictEqual(u.method, "empirical");
  assert.strictEqual(vm.uncertaintySpec([60, 24], null).radiusNm, 0);
});

test("bearingBetween: north and east cardinal cases", async () => {
  const vm = await loadVm();
  closeTo(vm.bearingBetween([60, 24], [61, 24]), 0, 0.1, "north");
  closeTo(vm.bearingBetween([60, 24], [60, 25]), 90, 0.5, "east");
});

test("parseChartLayers: drops non-tilemap charts, sorts by name, defaults zooms", async () => {
  const vm = await loadVm();
  const layers = vm.parseChartLayers({
    mbtiles: {
      identifier: "mytiles",
      name: "Offline MBTiles",
      tilemapUrl: "http://localhost:3000/charts/mytiles/{z}/{x}/{y}.png",
      minzoom: 2,
      maxzoom: 17,
    },
    wms: { identifier: "enc", name: "ENC (WMS)" }, // no tilemapUrl → dropped
    proxy: { tilemapUrl: "http://lan/tiles/{s}/{z}/{x}/{y}.png" }, // no names → keyed
  });
  assert.strictEqual(layers.length, 2);
  assert.strictEqual(layers[0].name, "Offline MBTiles");
  assert.deepStrictEqual(layers[1], {
    identifier: "proxy",
    name: "proxy",
    url: "http://lan/tiles/{s}/{z}/{x}/{y}.png",
    minZoom: 0,
    maxZoom: 19,
  });
});

test("parseChartLayers: null/empty/non-object → empty array (tile-less)", async () => {
  const vm = await loadVm();
  assert.deepStrictEqual(vm.parseChartLayers(null), []);
  assert.deepStrictEqual(vm.parseChartLayers(undefined), []);
  assert.deepStrictEqual(vm.parseChartLayers({}), []);
});

test("chartLayersWithFallback: returns configured layers when present", async () => {
  const vm = await loadVm();
  const layers = vm.chartLayersWithFallback({
    a: { tilemapUrl: "http://x/{z}/{x}/{y}.png", name: "MBTiles" },
  });
  assert.strictEqual(layers.length, 1);
  assert.strictEqual(layers[0].name, "MBTiles");
});

test("chartLayersWithFallback: OSM fallback when nothing configured (404/empty)", async () => {
  const vm = await loadVm();
  assert.strictEqual(vm.DEFAULT_OSM_LAYER.identifier, "osm");
  assert.match(vm.DEFAULT_OSM_LAYER.name, /online/i);
  for (const resource of [null, undefined, {}]) {
    const layers = vm.chartLayersWithFallback(resource);
    assert.strictEqual(layers.length, 1);
    assert.strictEqual(layers[0].identifier, "osm");
    assert.ok(layers[0].url.includes("{z}/{x}/{y}"));
  }
});

test("historyToTrack: converts SK history [lon,lat] to [lat,lon], dedupes", async () => {
  const vm = await loadVm();
  const track = vm.historyToTrack({
    data: [
      ["2026-01-01T00:00:00Z", [-159.8, -18.86]],
      ["2026-01-01T00:01:00Z", [-159.81, -18.87]],
      ["2026-01-01T00:02:00Z", null],
      ["2026-01-01T00:03:00Z", [-159.82, -18.88]],
      ["2026-01-01T00:04:00Z", [-159.82, -18.88]], // dup → dropped
    ],
  });
  assert.deepStrictEqual(track, [
    [-18.86, -159.8],
    [-18.87, -159.81],
    [-18.88, -159.82],
  ]);
});

test("historyToTrack: empty/null/non-data → empty array", async () => {
  const vm = await loadVm();
  assert.deepStrictEqual(vm.historyToTrack(null), []);
  assert.deepStrictEqual(vm.historyToTrack({}), []);
  assert.deepStrictEqual(vm.historyToTrack({ data: [] }), []);
});

test("historyUrl: builds the SK history path with from/to/resolution", async () => {
  const vm = await loadVm();
  const url = vm.historyUrl(6, 60);
  assert.ok(url.startsWith("/signalk/v1/history/values?"));
  assert.ok(url.includes("paths=navigation.position"));
  assert.ok(url.includes("resolution=60"));
  assert.ok(url.includes("from="));
  assert.ok(url.includes("to="));
});

test("bearingToTrue: east variation adds, west subtracts, wraps 360", async () => {
  const vm = await loadVm();
  closeTo(vm.bearingToTrue(350, 15), 5, 0.001, "east var wraps");
  closeTo(vm.bearingToTrue(10, -20), 350, 0.001, "west var subtracts");
  closeTo(vm.bearingToTrue(180, 0), 180, 0.001, "zero var");
});

test("verticalAngleDistanceNm: height/tan(angle) converted to nm", async () => {
  const vm = await loadVm();
  // 10m height, 1° angle → 10/tan(1°)/1852 = 0.3094 nm
  closeTo(vm.verticalAngleDistanceNm(10, 1), 0.3094, 0.001, "1° angle");
  // 30m height, 2° angle
  closeTo(vm.verticalAngleDistanceNm(30, 2), 0.4639, 0.001, "2° angle");
  // Zero/negative angle → infinity (object below eye)
  assert.strictEqual(vm.verticalAngleDistanceNm(10, 0), Infinity);
});

test("sightTimeToIso/epochMs: UTC parsing with seconds", async () => {
  const vm = await loadVm();
  // 2025-01-01T00:00:30Z
  const iso = vm.sightTimeToIso("2025-01-01T00:00:30", "utc");
  assert.strictEqual(iso, "2025-01-01T00:00:30.000Z");
  const ms = vm.sightTimeToEpochMs("2025-01-01T00:00:30", "utc");
  assert.strictEqual(ms, 1735689630000);
  // Empty/invalid → null
  assert.strictEqual(vm.sightTimeToIso("", "utc"), null);
  assert.strictEqual(vm.sightTimeToEpochMs("not-a-date", "utc"), null);
});

test("sightTimeToIso: local tz uses the browser zone", async () => {
  const vm = await loadVm();
  // A naive string parsed as local must differ from the UTC-parsed one
  // by the local offset (whatever it is). Just assert they differ in
  // zones other than UTC, and match in UTC. Use a known fixed input.
  const local = vm.sightTimeToIso("2025-06-21T12:00:00", "local");
  const utc = vm.sightTimeToIso("2025-06-21T12:00:00", "utc");
  // In the UTC zone they'd be equal; everywhere else they differ.
  const offsetMin = new Date("2025-06-21T12:00:00").getTimezoneOffset();
  if (offsetMin !== 0) assert.notStrictEqual(local, utc);
  else assert.strictEqual(local, utc);
});

test("isoToSightTimeInput: round-trips with seconds in UTC", async () => {
  const vm = await loadVm();
  const s = vm.isoToSightTimeInput("2025-01-01T00:00:30.000Z", "utc");
  assert.strictEqual(s, "2025-01-01T00:00:30");
});

test("bearingLopBody: object position as assumed, azimuth +90 for along-bearing line", async () => {
  const vm = await loadVm();
  const body = vm.bearingLopBody({
    object: "lighthouse",
    bearing_true: 45,
    object_lat: 60,
    object_lon: 24,
    confirmed_by: "Alice",
  });
  assert.strictEqual(body.lop_type, "bearing");
  // +90° so the engine's perpendicular-line convention yields a line
  // running along the bearing.
  assert.strictEqual(body.azimuth_true, 135);
  assert.strictEqual(body.intercept_nm, 0);
  // Object position is the assumed (line passes through the object).
  assert.strictEqual(body.assumed_lat, 60);
  assert.strictEqual(body.assumed_lon, 24);
  assert.strictEqual(body.body_or_object, "lighthouse");
  // Sight time flows through as a timestamp (UTC ISO).
  const tsBody = vm.bearingLopBody({
    object: "lighthouse",
    bearing_true: 45,
    object_lat: 60,
    object_lon: 24,
    sight_time: "2025-01-01T00:00:00",
    sight_tz: "utc",
  });
  assert.strictEqual(tsBody.timestamp, "2025-01-01T00:00:00.000Z");
  // No sight_time → no timestamp field (server defaults to now).
  assert.ok(!("timestamp" in body));
});

test("verticalAngleCplBody: center + radius from height/angle", async () => {
  const vm = await loadVm();
  const body = vm.verticalAngleCplBody({
    object: "lighthouse",
    height_m: 30,
    angle_deg: 2,
    center_lat: 60.01,
    center_lon: 24.01,
  });
  assert.strictEqual(body.cpl_type, "vertical-angle");
  assert.strictEqual(body.center_lat, 60.01);
  closeTo(body.radius_nm, 0.4639, 0.001, "radius");
  assert.strictEqual(body.source_object, "lighthouse");
  // Vertical CPL also carries the sight timestamp.
  const tsBody = vm.verticalAngleCplBody({
    object: "lighthouse",
    height_m: 30,
    angle_deg: 2,
    center_lat: 60.01,
    center_lon: 24.01,
    sight_time: "2025-01-01T00:00:00",
    sight_tz: "utc",
  });
  assert.strictEqual(tsBody.timestamp, "2025-01-01T00:00:00.000Z");
});

test("celestialSightBody: required + optional fields, assumed position shape", async () => {
  const vm = await loadVm();
  const body = vm.celestialSightBody({
    body: "Sun",
    hs_deg: 45.5,
    index_correction_deg: -1.2,
    eye_height_m: 3,
    limb: "lower",
    // 2025-01-01T00:00:00Z → epoch 1735689600000
    sight_time: "2025-01-01T00:00:00",
    sight_tz: "utc",
    assumed_lat: 60,
    assumed_lon: 24,
    confirmed_by: "Bob",
  });
  assert.strictEqual(body.body, "Sun");
  assert.strictEqual(body.hs_deg, 45.5);
  assert.strictEqual(body.index_correction_deg, -1.2);
  assert.strictEqual(body.eye_height_m, 3);
  assert.strictEqual(body.limb, "lower");
  assert.strictEqual(body.epoch_ms, 1735689600000);
  assert.deepStrictEqual(body.assumed_position, {
    latitude: 60,
    longitude: 24,
  });
  assert.strictEqual(body.confirmed_by, "Bob");
  // Minimal form (no optionals) — fields omitted, not null.
  const minimal = vm.celestialSightBody({
    body: "Vega",
    hs_deg: 30,
    sight_time: "2025-01-01T00:00:00",
    sight_tz: "utc",
  });
  assert.strictEqual(minimal.body, "Vega");
  assert.strictEqual(minimal.epoch_ms, 1735689600000);
  assert.ok(!("index_correction_deg" in minimal));
  assert.ok(!("limb" in minimal));
  assert.ok(!("assumed_position" in minimal));
  assert.ok(!("noon" in minimal));
  // noon flag forwards to the body.
  const noonBody = vm.celestialSightBody({
    body: "Sun",
    hs_deg: 73,
    sight_time: "2025-06-21T17:00:00",
    sight_tz: "utc",
    noon: true,
  });
  assert.strictEqual(noonBody.noon, true);
});

test("extendLineSpec: bearing LOP draws a ray toward the navigator (reciprocal), not symmetric through the object", async () => {
  const vm = await loadVm();
  // Bearing LOP: bearing 0° (object due north of navigator). azimuth_true
  // = bearing+90 = 90. The navigator is south of the object (reciprocal).
  // lopLineSpec passes lopType through.
  const spec = vm.lopLineSpec({
    assumed_lat: 60,
    assumed_lon: 24,
    azimuth_true: 90,
    intercept_nm: 0,
    lop_type: "bearing",
  });
  assert.strictEqual(spec.lopType, "bearing");
  const [stub, far] = vm.extendLineSpec(spec, 30);
  // Far endpoint is south of the object (toward navigator).
  assert.ok(far[0] < 60, `far lat ${far[0]} should be south of 60`);
  // Stub is just north of the object (the short past-object tail).
  assert.ok(stub[0] > 60, `stub lat ${stub[0]} should be north of 60`);
});

test("extendLineSpec: celestial LOP stays symmetric (no lopType)", async () => {
  const vm = await loadVm();
  const spec = { anchor: [60, 24], azimuthDeg: 90 };
  const [a, b] = vm.extendLineSpec(spec, 30);
  // Symmetric: one endpoint north of 60, one south.
  const lats = [a[0], b[0]].sort((x, y) => x - y);
  assert.ok(lats[0] < 60 && lats[1] > 60);
});

test("elapsedText: formats fix age at watchkeeper granularity", async () => {
  const vm = await loadVm();
  assert.strictEqual(vm.elapsedText(null), "—");
  assert.strictEqual(vm.elapsedText(undefined), "—");
  assert.strictEqual(vm.elapsedText(Number.NaN), "—");
  assert.strictEqual(vm.elapsedText(-5), "—");
  assert.strictEqual(vm.elapsedText(45), "45s");
  assert.strictEqual(vm.elapsedText(60), "1m");
  assert.strictEqual(vm.elapsedText(4 * 60), "4m");
  assert.strictEqual(vm.elapsedText(134 * 60), "2h 14m");
});
