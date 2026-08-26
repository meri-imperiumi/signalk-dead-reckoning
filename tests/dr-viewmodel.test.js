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
