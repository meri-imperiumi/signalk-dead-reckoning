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
    vm.divergenceText({
      distance_m: 0.423 * 1852,
      bearing_true: (3 * Math.PI) / 180,
    }),
    "0.42 nm / 003°",
  );
  assert.strictEqual(vm.divergenceText(null), "— nm");
});

test("divergenceText: no bearing below display resolution — it is the direction of noise", async () => {
  const vm = await loadVm();
  // A few metres of DR-GPS offset: bearing is meaningless, distance is
  // honest at "0.00 nm".
  assert.strictEqual(
    vm.divergenceText({ distance_m: 0.004 * 1852, bearing_true: 248 }),
    "0.00 nm",
  );
  assert.strictEqual(
    vm.divergenceText({
      distance_m: 0.006 * 1852,
      bearing_true: (97 * Math.PI) / 180,
    }),
    "0.01 nm / 097°",
  );
});

test("methodLabel: short watchkeeper-sized labels for the spec tokens", async () => {
  const vm = await loadVm();
  assert.strictEqual(vm.methodLabel("inertial-paddlewheel"), "STW");
  assert.strictEqual(vm.methodLabel("inertial-polar"), "Polar");
  assert.strictEqual(vm.methodLabel("fallback-zero"), "Zero");
  assert.strictEqual(vm.methodLabel("something-new"), "—");
  assert.strictEqual(vm.methodLabel(null), "—");
  assert.strictEqual(vm.methodLabel(undefined), "—");
});

test("drStatusText: engine-warm on a tied-up boat is its own status, not 'underway'", async () => {
  const vm = await loadVm();
  assert.strictEqual(
    vm.drStatusText({ status: "warm", navState: "moored" }),
    "DR warm (moored)",
  );
  assert.strictEqual(
    vm.drStatusText({ status: "warm", navState: "anchored" }),
    "DR warm (anchored)",
  );
  // Fouling outranks the warm wording.
  assert.match(
    vm.drStatusText({ status: "warm", navState: "moored", fouled: true }),
    /fouled/,
  );
  assert.strictEqual(vm.drStatusText({ status: "underway" }), "DR active");
  assert.strictEqual(
    vm.drStatusText({ status: "underway", transient: true }),
    "DR active — tack/gybe, divergence may spike.",
  );
  assert.match(vm.drStatusText({ status: "idle", reason: "moored" }), /idle/);
  assert.match(
    vm.drStatusText({ status: "idle", moving: true, reason: "no heading" }),
    /DR stale/,
  );
  assert.strictEqual(vm.drStatusText(null), "No dead-reckoning data");
  assert.strictEqual(vm.drStatusText({ status: "???" }), null);
});

test("uncertaintySpec: passes radius/method with DR center", async () => {
  const vm = await loadVm();
  const u = vm.uncertaintySpec([60, 24], {
    radius_m: 1.5 * 1852,
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

test("chartLayersWithFallback: first layer is always a default-selectable provider (map never opens blank)", async () => {
  const vm = await loadVm();
  // Contract for dr-map-view's initMap: charts[0] is what gets
  // auto-added to the map. Whatever the server says (or fails to say),
  // the list is non-empty and its head is a usable tile layer.
  const cases = [
    null, // fetch 404 / not ok → null resource
    {}, // resources provider enabled but no charts saved
    {
      b: { tilemapUrl: "http://x/b/{z}/{x}/{y}.png", name: "B Tiles" },
      a: { tilemapUrl: "http://x/a/{z}/{x}/{y}.png", name: "A Tiles" },
    },
  ];
  for (const resource of cases) {
    const layers = vm.chartLayersWithFallback(resource);
    assert.ok(layers.length >= 1, `non-empty for ${JSON.stringify(resource)}`);
    const first = layers[0];
    assert.ok(first.identifier, "identifier present");
    assert.ok(first.name, "name present");
    assert.match(first.url, /\{z\}\/\{x\}\/\{y\}/, "tile URL template");
  }
  // Sorted configured list: first = "A Tiles"; fallback list: first = osm.
  assert.strictEqual(vm.chartLayersWithFallback(cases[2])[0].name, "A Tiles");
  assert.strictEqual(vm.chartLayersWithFallback(null)[0].identifier, "osm");
});

test("bearingToTrue: east variation adds, west subtracts, wraps 360", async () => {
  const vm = await loadVm();
  closeTo(vm.bearingToTrue(350, 15), 5, 0.001, "east var wraps");
  closeTo(vm.bearingToTrue(10, -20), 350, 0.001, "west var subtracts");
  closeTo(vm.bearingToTrue(180, 0), 180, 0.001, "zero var");
});

test("variationFromForm: hemisphere sign, blank/invalid → NaN", async () => {
  const vm = await loadVm();
  assert.strictEqual(
    vm.variationFromForm({ variation_deg: "4.5", variation_hem: "E" }),
    4.5,
  );
  assert.strictEqual(
    vm.variationFromForm({ variation_deg: "9", variation_hem: "W" }),
    -9,
  );
  // Missing hemisphere defaults to east.
  assert.strictEqual(vm.variationFromForm({ variation_deg: "3" }), 3);
  // Blank / absent / non-numeric magnitude → NaN (not silent 0 —
  // Number("") is 0, so an empty field must be rejected explicitly).
  assert.ok(Number.isNaN(vm.variationFromForm({ variation_deg: "" })));
  assert.ok(Number.isNaN(vm.variationFromForm({})));
  assert.ok(Number.isNaN(vm.variationFromForm({ variation_deg: "abc" })));
});

test("bearingFromFormTrue: magnetic converts via variation, true passes through", async () => {
  const vm = await loadVm();
  // Magnetic + east variation: 350°M + 15°E → 5°T (wraps).
  closeTo(
    vm.bearingFromFormTrue({
      bearing: "350",
      bearing_ref: "mag",
      variation_deg: "15",
      variation_hem: "E",
    }),
    5,
    0.001,
    "east var wraps",
  );
  // Magnetic + west variation: 10°M − 20°W → 350°T.
  closeTo(
    vm.bearingFromFormTrue({
      bearing: "10",
      bearing_ref: "mag",
      variation_deg: "20",
      variation_hem: "W",
    }),
    350,
    0.001,
    "west var subtracts",
  );
  // True reference (and absent ref) passes through unchanged.
  closeTo(
    vm.bearingFromFormTrue({ bearing: "137", bearing_ref: "true" }),
    137,
    0.001,
  );
  closeTo(vm.bearingFromFormTrue({ bearing: "137" }), 137, 0.001);
  // Magnetic without a usable variation → explicit error (never a
  // silently unconverted or 0-variation bearing).
  assert.throws(
    () => vm.bearingFromFormTrue({ bearing: "90", bearing_ref: "mag" }),
    /variation required/,
  );
  assert.throws(
    () =>
      vm.bearingFromFormTrue({
        bearing: "90",
        bearing_ref: "mag",
        variation_deg: "",
      }),
    /variation required/,
  );
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
    bearing: 45,
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
    bearing: 45,
    object_lat: 60,
    object_lon: 24,
    sight_time: "2025-01-01T00:00:00",
    sight_tz: "utc",
  });
  assert.strictEqual(tsBody.timestamp, "2025-01-01T00:00:00.000Z");
  // No sight_time → no timestamp field (server defaults to now).
  assert.ok(!("timestamp" in body));
  // Magnetic entry is converted to true before shaping: 45°M with
  // 10°E variation → 55°T → azimuth 145.
  const magBody = vm.bearingLopBody({
    object: "lighthouse",
    bearing: 45,
    bearing_ref: "mag",
    variation_deg: "10",
    variation_hem: "E",
    object_lat: 60,
    object_lon: 24,
  });
  assert.strictEqual(magBody.azimuth_true, 145);
  // …and magnetic without variation refuses rather than guessing.
  assert.throws(
    () =>
      vm.bearingLopBody({
        object: "lighthouse",
        bearing: 45,
        bearing_ref: "mag",
        object_lat: 60,
        object_lon: 24,
      }),
    /variation required/,
  );
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

test("extendLineSpec: bearing LOP draws a ray from the object toward the navigator (reciprocal)", async () => {
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
  const [start, far] = vm.extendLineSpec(spec, 30);
  // Far endpoint is south of the object (toward navigator).
  assert.ok(far[0] < 60, `far lat ${far[0]} should be south of 60`);
  // The ray starts AT the charted object — it must not run through
  // or past the mark it was taken from.
  assert.ok(
    Math.abs(start[0] - 60) < 1e-9 && Math.abs(start[1] - 24) < 1e-9,
    `start ${start} should be the object position`,
  );
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

test("pointFixBody: numbers pass through, defaults to manual source", async () => {
  const vm = await loadVm();
  const body = vm.pointFixBody({
    latitude: 60.155,
    longitude: 24.955,
    fix_time: "",
  });
  assert.strictEqual(body.source_type, "manual");
  assert.strictEqual(body.latitude, 60.155);
  assert.strictEqual(body.longitude, 24.955);
  assert.ok(!("timestamp" in body));
  assert.ok(!("notes" in body));
  assert.ok(!("estimated_error_nm" in body));
});

test("pointFixBody: coordinate strings parse in decimal, DM and DMS", async () => {
  const vm = await loadVm();
  for (const [latStr, expected] of [
    ["60.155", 60.155],
    ["60°09.300' N", 60.155],
    ["60°09'18.0\" N", 60.155],
    ["60°09'18\" S", -60.155],
  ]) {
    const body = vm.pointFixBody({ latitude: latStr, longitude: "025.000" });
    closeTo(body.latitude, expected, 0.0002, `parse ${latStr}`);
  }
});

test("pointFixBody: throws on unparseable coordinates", async () => {
  const vm = await loadVm();
  assert.throws(() => vm.pointFixBody({ latitude: "banana", longitude: 25 }));
  assert.throws(() => vm.pointFixBody({ latitude: "", longitude: 25 }));
});

test("pointFixBody: forwards timestamp (tz-aware), notes and error estimate", async () => {
  const vm = await loadVm();
  const body = vm.pointFixBody({
    latitude: 60,
    longitude: 24,
    source_type: "backfill",
    fix_time: "2025-06-21T17:00:00",
    fix_tz: "utc",
    notes: "berth 12, guest harbour",
    estimated_error_nm: "0.05",
  });
  assert.strictEqual(body.source_type, "backfill");
  assert.strictEqual(body.timestamp, "2025-06-21T17:00:00.000Z");
  assert.strictEqual(body.notes, "berth 12, guest harbour");
  assert.strictEqual(body.estimated_error_nm, 0.05);
  // Zero/empty error → omitted rather than recorded as a bogus 0.
  const zero = vm.pointFixBody({
    latitude: 60,
    longitude: 24,
    estimated_error_nm: "0",
  });
  assert.ok(!("estimated_error_nm" in zero));
});

test("hdopErrorNm: HDOP × UERE estimate, null without usable HDOP", async () => {
  const vm = await loadVm();
  assert.strictEqual(vm.hdopErrorNm(null), null);
  assert.strictEqual(vm.hdopErrorNm(0), null);
  assert.strictEqual(vm.hdopErrorNm(-1), null);
  closeTo(vm.hdopErrorNm(1), 3 / 1852, 1e-9, "HDOP 1");
  closeTo(vm.hdopErrorNm(2.5), 7.5 / 1852, 1e-9, "HDOP 2.5");
  closeTo(vm.hdopErrorNm(2, 5), 10 / 1852, 1e-9, "custom UERE");
});

test("gnssStats: rows only for known fields, none when empty", async () => {
  const vm = await loadVm();
  assert.deepStrictEqual(vm.gnssStats(null), []);
  assert.deepStrictEqual(vm.gnssStats({}), []);
  const full = vm.gnssStats({
    type: "GPS",
    method: "3D",
    satellites: 12,
    satellitesVisible: 15,
    hdop: 0.9,
  });
  assert.deepStrictEqual(full, [
    { label: "System", value: "GPS" },
    { label: "Fix method", value: "3D" },
    { label: "Satellites", value: "12 in use, 15 visible" },
    { label: "HDOP", value: "0.9 (≈ 3 m error)" },
  ]);
  // Satellites in use only (no visible count, or equal to it).
  const inUse = vm.gnssStats({ satellites: 12, satellitesVisible: 12 });
  assert.deepStrictEqual(inUse[0], { label: "Satellites", value: "12 in use" });
  // Only a visible count → labelled as such.
  const visible = vm.gnssStats({ satellitesVisible: 9 });
  assert.deepStrictEqual(visible[0], {
    label: "Satellites",
    value: "9 visible",
  });
  // Partial data renders partial rows.
  const partial = vm.gnssStats({ type: "GLONASS" });
  assert.deepStrictEqual(partial, [{ label: "System", value: "GLONASS" }]);
});

// --- Pending list & advancement layer (work doc #13 stages A/B) ------------

test("pendingLopRow/pendingCplRow: shape db rows into list rows", async () => {
  const vm = await loadVm();
  const lop = vm.pendingLopRow({
    lop_id: 3,
    timestamp: "2026-08-26T10:00:00Z",
    lop_type: "bearing",
    body_or_object: "North Rock",
    used_in_fix_id: null,
  });
  assert.deepStrictEqual(lop, {
    kind: "lop",
    id: 3,
    label: "North Rock bearing LOP",
    timestamp: "2026-08-26T10:00:00Z",
    used: false,
    fixId: null,
  });
  const cpl = vm.pendingCplRow({
    cpl_id: 5,
    timestamp: "2026-08-26T11:00:00Z",
    source_object: "lighthouse",
    radius_nm: 1.25,
    used_in_fix_id: 7,
  });
  assert.strictEqual(cpl.kind, "cpl");
  assert.strictEqual(cpl.label, "lighthouse r=1.3 nm");
  assert.strictEqual(cpl.used, true);
  assert.strictEqual(cpl.fixId, 7);
});

test("needsPartner: true only for exactly one observation", async () => {
  const vm = await loadVm();
  assert.strictEqual(vm.needsPartner([]), false);
  assert.strictEqual(vm.needsPartner([{ id: 1 }]), true);
  assert.strictEqual(vm.needsPartner([{ id: 1 }, { id: 2 }]), false);
});

test("isPendingStale: un-resolved observations age out after a day", async () => {
  const vm = await loadVm();
  const now = Date.parse("2026-08-27T10:00:00Z");
  assert.strictEqual(
    vm.isPendingStale({ timestamp: "2026-08-27T09:00:00Z" }, now),
    false,
  );
  assert.strictEqual(
    vm.isPendingStale({ timestamp: "2026-08-26T10:00:01Z" }, now),
    false,
  );
  // Exactly a day old is on the boundary — not yet stale.
  assert.strictEqual(
    vm.isPendingStale({ timestamp: "2026-08-26T10:00:00Z" }, now),
    false,
  );
  // 36 days old — the motivating case.
  assert.strictEqual(
    vm.isPendingStale({ timestamp: "2026-07-22T10:00:00Z" }, now),
    true,
  );
  // Custom horizon and no-timestamp rows never age out.
  assert.strictEqual(
    vm.isPendingStale({ timestamp: "2026-08-27T06:00:00Z" }, now, 60_000),
    true,
  );
  assert.strictEqual(vm.isPendingStale({ timestamp: "" }, now), false);
});

test("resolvePreviewBody: splits the selection into lop/cpl ids", async () => {
  const vm = await loadVm();
  const body = vm.resolvePreviewBody([
    { kind: "lop", id: 2 },
    { kind: "cpl", id: 5 },
    { kind: "lop", id: 9 },
  ]);
  assert.deepStrictEqual(body, {
    source_type: "manual",
    lop_ids: [2, 9],
    cpl_ids: [5],
  });
});

test("hasUnadvanced: flags older observations without displacement", async () => {
  const vm = await loadVm();
  // No advancements → false.
  assert.strictEqual(vm.hasUnadvanced(null), false);
  assert.strictEqual(vm.hasUnadvanced([]), false);
  // Latest un-advanced → fine (nothing needed advancing).
  assert.strictEqual(
    vm.hasUnadvanced([
      { timestamp_ms: 100, displacement: { bearingTrue: 0, distanceNm: 1 } },
      { timestamp_ms: 200, displacement: null },
    ]),
    false,
  );
  // Older observation left un-advanced → the honest-failure warning.
  assert.strictEqual(
    vm.hasUnadvanced([
      { timestamp_ms: 100, displacement: null },
      { timestamp_ms: 200, displacement: null },
    ]),
    true,
  );
  // Untimestamped observations don't count toward the warning.
  assert.strictEqual(
    vm.hasUnadvanced([
      { timestamp_ms: null, displacement: null },
      { timestamp_ms: 200, displacement: null },
    ]),
    false,
  );
});

test("advancementLayerSpecs: original/advanced/displacement + warning rows", async () => {
  const vm = await loadVm();
  const advancements = [
    {
      id: 2,
      kind: "lop",
      timestamp_ms: 100,
      original: { latitude: 60, longitude: 24 },
      advanced: { latitude: 60.02, longitude: 24.04 },
      displacement: { bearingTrue: 90, distanceNm: 2.5 },
    },
    {
      id: 5,
      kind: "cpl",
      timestamp_ms: 300,
      original: { latitude: 60.1, longitude: 24.1 },
      advanced: { latitude: 60.1, longitude: 24.1 },
      displacement: null,
    },
    {
      id: 8,
      kind: "lop",
      timestamp_ms: 200,
      original: { latitude: 60.05, longitude: 24.05 },
      advanced: { latitude: 60.05, longitude: 24.05 },
      displacement: null, // older than 300, no DR track → warning
    },
  ];
  const rowsById = {
    lop: new Map([
      [2, { azimuth_true: 45, lop_type: "bearing" }],
      [8, { azimuth_true: 90, lop_type: "celestial" }],
    ]),
    cpl: new Map([[5, { radius_nm: 1.5 }]]),
  };
  const specs = vm.advancementLayerSpecs(advancements, rowsById);
  assert.strictEqual(specs.length, 3);
  assert.deepStrictEqual(specs[0].original, [60, 24]);
  assert.deepStrictEqual(specs[0].advanced, [60.02, 24.04]);
  assert.strictEqual(specs[0].displacementNm, 2.5);
  assert.strictEqual(specs[0].azimuthDeg, 45);
  assert.strictEqual(specs[0].warning, false);
  // The latest observation: no warning, radius available.
  assert.strictEqual(specs[1].radiusNm, 1.5);
  assert.strictEqual(specs[1].warning, false);
  // Older + un-advanced → warning.
  assert.strictEqual(specs[2].warning, true);
  assert.strictEqual(specs[2].azimuthDeg, 90);
  // Ids unknown to the row maps degrade to null geometry.
  const orphan = vm.advancementLayerSpecs(
    [
      {
        id: 99,
        kind: "lop",
        timestamp_ms: null,
        original: { latitude: 1, longitude: 2 },
        advanced: { latitude: 1, longitude: 2 },
        displacement: null,
      },
    ],
    rowsById,
  );
  assert.strictEqual(orphan[0].azimuthDeg, null);
});

test("advancementLayerSpecs: running-fix point advancement (previous fix)", async () => {
  const vm = await loadVm();
  const specs = vm.advancementLayerSpecs(
    [
      {
        id: null,
        kind: "point",
        timestamp_ms: 1000,
        original: { latitude: 60, longitude: 24 },
        advanced: { latitude: 60.02, longitude: 24.04 },
        displacement: { bearingTrue: 60, distanceNm: 2.5 },
      },
      {
        id: 5,
        kind: "lop",
        timestamp_ms: 2000,
        original: { latitude: 60.02, longitude: 24.04 },
        advanced: { latitude: 60.02, longitude: 24.04 },
        displacement: null,
      },
    ],
    { lop: new Map(), cpl: new Map() },
  );
  const point = specs[0];
  assert.deepStrictEqual(point.original, [60, 24]);
  assert.deepStrictEqual(point.advanced, [60.02, 24.04]);
  assert.strictEqual(point.displacementNm, 2.5);
  // No observation row backs the fix point: no azimuth/radius, but the
  // original/advanced/vector render fine (and never a warning — the
  // pipeline nulls un-advanced running fixes).
  assert.strictEqual(point.azimuthDeg, null);
  assert.strictEqual(point.radiusNm, null);
  assert.strictEqual(point.warning, false);
});

test("relativeTimeText: watchkeeper-granularity ages", async () => {
  const vm = await loadVm();
  const now = Date.UTC(2026, 7, 26, 12, 0, 0);
  assert.strictEqual(vm.relativeTimeText("not-a-date", now), "");
  assert.strictEqual(
    vm.relativeTimeText("2026-08-26T11:59:30Z", now),
    "30s ago",
  );
  assert.strictEqual(
    vm.relativeTimeText("2026-08-26T11:45:00Z", now),
    "15m ago",
  );
  assert.strictEqual(
    vm.relativeTimeText("2026-08-26T09:20:00Z", now),
    "2h 40m ago",
  );
  assert.strictEqual(
    vm.relativeTimeText("2026-08-23T12:00:00Z", now),
    "3d ago",
  );
});

test("menuPlacement: opens down-right, flips up at the bottom edge", async () => {
  const vm = await loadVm();
  // Room below: menu opens at the anchor, down-right.
  assert.deepEqual(
    vm.menuPlacement(
      { x: 400, y: 300 },
      { w: 200, h: 150 },
      { width: 1000, height: 800 },
    ),
    { left: 400, top: 300 },
  );
  // The reported miss: pick near the bottom — the menu flips above the
  // anchor with the kept-clear margin instead of leaving the viewport.
  assert.deepEqual(
    vm.menuPlacement(
      { x: 400, y: 700 },
      { w: 200, h: 150 },
      { width: 1000, height: 800 },
    ),
    { left: 400, top: 542 },
  );
});

test("menuPlacement: flips left at the right edge, clamps top/left", async () => {
  const vm = await loadVm();
  // Near the right edge: opens to the left of the anchor.
  assert.deepEqual(
    vm.menuPlacement(
      { x: 900, y: 300 },
      { w: 200, h: 150 },
      { width: 1000, height: 800 },
    ),
    { left: 692, top: 300 },
  );
  // Bottom-right corner: flips both ways.
  assert.deepEqual(
    vm.menuPlacement(
      { x: 950, y: 750 },
      { w: 200, h: 150 },
      { width: 1000, height: 800 },
    ),
    { left: 742, top: 592 },
  );
  // Anchor near the top/left: clamped to the margin, never negative.
  assert.deepEqual(
    vm.menuPlacement(
      { x: 2, y: 3 },
      { w: 200, h: 150 },
      { width: 1000, height: 800 },
    ),
    { left: 8, top: 8 },
  );
  // A menu taller/wider than the container pins to the margin.
  assert.deepEqual(
    vm.menuPlacement(
      { x: 500, y: 400 },
      { w: 1200, h: 2000 },
      { width: 1000, height: 800 },
    ),
    { left: 8, top: 8 },
  );
});

test("bearingLopBody: radar instrument records radar-bearing provenance", async () => {
  const vm = await loadVm();
  const body = vm.bearingLopBody({
    object: "MATILDA",
    bearing: 115.5,
    bearing_instrument: "radar",
    object_lat: 60,
    object_lon: 24,
  });
  assert.strictEqual(body.lop_type, "radar-bearing");
  assert.strictEqual(body.azimuth_true, 205.5);
  // Same geometry as a hand-compass bearing — only provenance differs.
  const hand = vm.bearingLopBody({
    object: "MATILDA",
    bearing: 115.5,
    bearing_instrument: "hand",
    object_lat: 60,
    object_lon: 24,
  });
  assert.strictEqual(hand.lop_type, "bearing");
  // Absent instrument field (older callers) stays hand compass.
  const legacy = vm.bearingLopBody({
    object: "MATILDA",
    bearing: 115.5,
    object_lat: 60,
    object_lon: 24,
  });
  assert.strictEqual(legacy.lop_type, "bearing");
});

test("radarRangeCplBody: radar-range CPL on the object, radius = measured range", async () => {
  const vm = await loadVm();
  const body = vm.radarRangeCplBody({
    object: "Cape Rocks",
    range_nm: "4.2",
    center_lat: 60,
    center_lon: 24,
    confirmed_by: "Alice",
    sight_time: "2025-01-01T00:00:00",
    sight_tz: "utc",
  });
  assert.strictEqual(body.cpl_type, "radar-range");
  assert.strictEqual(body.center_lat, 60);
  assert.strictEqual(body.center_lon, 24);
  assert.strictEqual(body.radius_nm, 4.2);
  assert.strictEqual(body.source_object, "Cape Rocks");
  assert.strictEqual(body.confirmed_by, "Alice");
  assert.strictEqual(body.timestamp, "2025-01-01T00:00:00.000Z");
  // The uncertainty radius is the server's error model (range-proportional
  // default) — the client deliberately doesn't set it.
  assert.ok(!("radius_uncertainty_nm" in body));
});

test("pendingCplRow: radar range labeled with its instrument", async () => {
  const vm = await loadVm();
  const row = vm.pendingCplRow({
    cpl_id: 9,
    timestamp: "2026-08-26T11:00:00Z",
    cpl_type: "radar-range",
    source_object: "Cape Rocks",
    radius_nm: 4.2,
    used_in_fix_id: null,
  });
  assert.strictEqual(row.label, "Cape Rocks radar range 4.2 nm");
  // Non-radar CPL labels unchanged.
  const va = vm.pendingCplRow({
    cpl_id: 10,
    timestamp: "2026-08-26T11:00:00Z",
    cpl_type: "vertical-angle",
    source_object: "lighthouse",
    radius_nm: 1.25,
    used_in_fix_id: null,
  });
  assert.strictEqual(va.label, "lighthouse r=1.3 nm");
});

test("horizontalAngleCircle: circle of position through both objects and the navigator", async () => {
  const vm = await loadVm();
  const A = [60, 24];
  const B = [60, 24.1];
  const P = [60.02, 24.05]; // navigator north of the chord
  // Measure the actual angle ∠APB in a local equirectangular plane
  // around P — the honest way to construct a ground-truth sextant
  // angle without hand-deriving the circle.
  const R = 6371000;
  const proj = ([lat, lon]) => ({
    x: ((lon - P[1]) * Math.PI * R * Math.cos((60 * Math.PI) / 180)) / 180,
    y: ((lat - P[0]) * Math.PI * R) / 180,
  });
  const u = proj(A);
  const v = proj(B);
  const dot = u.x * v.x + u.y * v.y;
  const ang =
    (Math.acos(dot / (Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y))) * 180) /
    Math.PI;
  assert.ok(ang > 0.5 && ang < 179.5, `sanity: measured angle ${ang}`);

  const c = vm.horizontalAngleCircle(A, B, ang, P);
  // The circle passes through A, B and (within equirect-vs-haversine
  // slop) the navigator's position.
  const dA = vm.distanceNm([c.centerLat, c.centerLon], A);
  const dB = vm.distanceNm([c.centerLat, c.centerLon], B);
  const dP = vm.distanceNm([c.centerLat, c.centerLon], P);
  assert.ok(
    Math.abs(dA - c.radiusNm) < c.radiusNm * 0.01,
    `dA ${dA} vs r ${c.radiusNm}`,
  );
  assert.ok(
    Math.abs(dB - c.radiusNm) < c.radiusNm * 0.01,
    `dB ${dB} vs r ${c.radiusNm}`,
  );
  assert.ok(
    Math.abs(dP - c.radiusNm) < 0.05,
    `navigator on the circle: ${Math.abs(dP - c.radiusNm)} nm off`,
  );
  // Chord length sanity: r ≥ d/2 always.
  assert.ok(c.radiusNm >= vm.distanceNm(A, B) / 2);
});

test("horizontalAngleCircle: mirror side resolved against DR, degenerates rejected", async () => {
  const vm = await loadVm();
  const A = [60, 24];
  const B = [60, 24.1];
  const P = [59.98, 24.05]; // navigator SOUTH of the chord this time
  const R = 6371000;
  const proj = ([lat, lon]) => ({
    x: ((lon - P[1]) * Math.PI * R * Math.cos((60 * Math.PI) / 180)) / 180,
    y: ((lat - P[0]) * Math.PI * R) / 180,
  });
  const u = proj(A);
  const v = proj(B);
  const ang =
    (Math.acos(
      (u.x * v.x + u.y * v.y) / (Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y)),
    ) *
      180) /
    Math.PI;
  const c = vm.horizontalAngleCircle(A, B, ang, P);
  const dP = vm.distanceNm([c.centerLat, c.centerLon], P);
  assert.ok(
    Math.abs(dP - c.radiusNm) < 0.05,
    `navigator on the circle from the south side too: ${Math.abs(dP - c.radiusNm)} nm off`,
  );
  // Unmeasurable angles refuse rather than producing planet-sized circles.
  assert.throws(
    () => vm.horizontalAngleCircle(A, B, 0.2, P),
    /0\.5° and 179\.5°/,
  );
  assert.throws(
    () => vm.horizontalAngleCircle(A, B, 179.8, P),
    /0\.5° and 179\.5°/,
  );
  // Coincident objects refuse.
  assert.throws(
    () => vm.horizontalAngleCircle(A, [60, 24], 45, P),
    /distinct objects/,
  );
  // Missing DR refuses — the mirror side needs a reference.
  assert.throws(
    () => vm.horizontalAngleCircle(A, B, 45, undefined),
    /DR position required/,
  );
});

test("horizontalAngleCplBodies: one or two observations, raw angle recorded", async () => {
  const vm = await loadVm();
  const dr = { latitude: 60.02, longitude: 24.05 };
  // The sight's angles are measured AT the vessel — construct the
  // ground truth by measuring ∠ADB and ∠BDC from the DR position in a
  // local plane, so the DR honestly sits on both circles.
  const R = 6371000;
  const proj = (p) => ({
    x:
      ((p[1] - dr.longitude) *
        Math.PI *
        R *
        Math.cos((dr.latitude * Math.PI) / 180)) /
      180,
    y: ((p[0] - dr.latitude) * Math.PI * R) / 180,
  });
  const measured = (p1, p2) => {
    const u = proj(p1);
    const v = proj(p2);
    return (
      (Math.acos(
        (u.x * v.x + u.y * v.y) / (Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y)),
      ) *
        180) /
      Math.PI
    );
  };
  const A = [60, 24];
  const B = [60, 24.1];
  const C = [60.05, 24.05];
  const angle1 = measured(A, B);
  const angle2 = measured(B, C);
  const form = {
    object_a: "Lighthouse",
    object_b: "Tower",
    angle_1: angle1.toFixed(6),
    objA_lat: "60",
    objA_lon: "24",
    objB_lat: "60",
    objB_lon: "24.1",
    confirmed_by: "Alice",
    sight_time: "2025-01-01T00:00:00",
    sight_tz: "utc",
  };
  const [single] = vm.horizontalAngleCplBodies(form, dr);
  assert.strictEqual(single.cpl_type, "horizontal-angle");
  assert.strictEqual(single.source_object, "Lighthouse / Tower");
  // The form carries a string; Number() round-trips at entry precision.
  assert.ok(
    Math.abs(single.angle_deg - angle1) < 1e-5,
    `angle_deg ${single.angle_deg} vs measured ${angle1}`,
  );
  assert.strictEqual(single.confirmed_by, "Alice");
  assert.strictEqual(single.timestamp, "2025-01-01T00:00:00.000Z");
  assert.ok(Number.isFinite(single.radius_nm) && single.radius_nm > 0);
  // Circle geometry: both objects on the circle.
  const dA = vm.distanceNm([single.center_lat, single.center_lon], [60, 24]);
  assert.ok(Math.abs(dA - single.radius_nm) < single.radius_nm * 0.01);

  // With the second angle and object C: two bodies, B shared.
  const form2 = {
    ...form,
    object_c: "Spire",
    angle_2: angle2.toFixed(6),
    objC_lat: "60.05",
    objC_lon: "24.05",
  };
  const bodies = vm.horizontalAngleCplBodies(form2, dr);
  assert.strictEqual(bodies.length, 2);
  assert.strictEqual(bodies[1].source_object, "Tower / Spire");
  assert.ok(
    Math.abs(bodies[1].angle_deg - angle2) < 1e-5,
    `angle_deg ${bodies[1].angle_deg} vs measured ${angle2}`,
  );
  // The two circles intersect at the navigator (classic three-point
  // fix) — check via the distance of the DR position to each circle.
  const dB2 = Math.abs(
    vm.distanceNm([bodies[1].center_lat, bodies[1].center_lon], [60, 24.1]) -
      bodies[1].radius_nm,
  );
  assert.ok(dB2 < bodies[1].radius_nm * 0.01);
  const miss1 = Math.abs(
    vm.distanceNm(
      [bodies[0].center_lat, bodies[0].center_lon],
      [dr.latitude, dr.longitude],
    ) - bodies[0].radius_nm,
  );
  const miss2 = Math.abs(
    vm.distanceNm(
      [bodies[1].center_lat, bodies[1].center_lon],
      [dr.latitude, dr.longitude],
    ) - bodies[1].radius_nm,
  );
  assert.ok(miss1 < 0.05, `DR on circle 1: ${miss1} nm off`);
  assert.ok(miss2 < 0.05, `DR on circle 2: ${miss2} nm off`);

  // Second angle without object C refuses.
  assert.throws(
    () => vm.horizontalAngleCplBodies({ ...form, angle_2: 60 }, dr),
    /object C position required/,
  );
  // Missing DR refuses before any shaping.
  assert.throws(
    () => vm.horizontalAngleCplBodies(form, null),
    /DR position required/,
  );
});

test("followTarget: live DR wins, stale DR transfers to the fix, no oscillation", async () => {
  const vm = await loadVm();
  const now = 1_000_000;
  // Live DR position: the camera locks onto DR — a GPS fix ticking
  // more often than the DR engine must not drag the view between the
  // two marks.
  assert.deepEqual(
    vm.followTarget(
      {
        drPosition: [60.1, 24.9],
        drTimeMs: now - 500,
        gpsPosition: [60.2, 25.0],
      },
      now,
    ),
    [60.1, 24.9],
  );
  // DR engine idle (position stale): one clean transfer to the GNSS
  // fix — the only live boat position.
  assert.deepEqual(
    vm.followTarget(
      {
        drPosition: [60.1, 24.9],
        drTimeMs: now - vm.DR_LIVE_MS - 1,
        gpsPosition: [60.2, 25.0],
      },
      now,
    ),
    [60.2, 25.0],
  );
  // Before the first DR position arrives at all, the fix is the only
  // boat position there is.
  assert.deepEqual(
    vm.followTarget({ gpsPosition: [60.2, 25.0] }, now),
    [60.2, 25.0],
  );
  // DR stale and no fix at all (GNSS denied, engine dead): hold the
  // last DR mark — nothing better exists.
  assert.deepEqual(
    vm.followTarget(
      { drPosition: [60.1, 24.9], drTimeMs: now - vm.DR_LIVE_MS - 1 },
      now,
    ),
    [60.1, 24.9],
  );
  // Nothing yet: nothing to follow.
  assert.equal(vm.followTarget({}, now), null);
});
