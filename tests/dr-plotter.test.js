/**
 * Tests for the chartplotter UX view-model functions (work doc #30):
 * scale-bar ladder, predictor vectors, range rings, and the 10-minute
 * AIS leader convention.
 * @file dr-plotter.test.js
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

test("metersPerPixel: zoom 0 equator ≈ 156.5 km/px, halves per zoom", async () => {
  const vm = await loadVm();
  closeTo(vm.metersPerPixel(0, 0), 156543.034, 1, "zoom 0");
  closeTo(vm.metersPerPixel(1, 0), 78271.517, 1, "zoom 1");
  // Latitude shrinks it by cos(lat).
  closeTo(vm.metersPerPixel(12, 60), (156543.034 * 0.5) / 4096, 1, "60N");
});

test("scaleBarSpec: mid zoom picks a nautical ladder value in the band", async () => {
  const vm = await loadVm();
  // Zoom 12 at 60N: ~38 m/px → 1 nm ≈ 49 px, 2 nm ≈ 97 px, 5 nm ≈ 243 px.
  const spec = vm.scaleBarSpec(vm.metersPerPixel(12, 60));
  assert.ok(spec, "spec");
  assert.equal(spec.nm, 2, "largest ladder value under 200 px");
  assert.equal(spec.metres, null, "nautical, not metric");
  assert.equal(spec.label, "2 nm");
  assert.ok(spec.px >= 80 && spec.px <= 200, `px in band: ${spec.px}`);
});

test("scaleBarSpec: zoomed out ladder climbs to big NM values", async () => {
  const vm = await loadVm();
  const spec = vm.scaleBarSpec(vm.metersPerPixel(4, 60));
  assert.equal(spec.nm, 500, "zoom 4 at 60N → 500 nm");
});

test("scaleBarSpec: deep zoom falls back to the metric ladder", async () => {
  const vm = await loadVm();
  // Zoom 20 at 60N: ~0.6 m/px → 0.1 nm = 185 m = ~300 px (too wide);
  // the metric ladder should carry the bar.
  const spec = vm.scaleBarSpec(vm.metersPerPixel(20, 60));
  assert.ok(spec, "spec");
  assert.equal(spec.nm, null, "no NM value fits");
  assert.ok(spec.metres > 0, "metric value picked");
  assert.equal(spec.label, `${spec.metres} m`);
  assert.ok(spec.px >= 80 && spec.px <= 200, `px in band: ${spec.px}`);
});

test("scaleBarSpec: rejects nonsense input", async () => {
  const vm = await loadVm();
  assert.equal(vm.scaleBarSpec(0), null);
  assert.equal(vm.scaleBarSpec(-5), null);
  assert.equal(vm.scaleBarSpec(NaN), null);
});

test("predictorVector: 10-minute run along the course with 2-min ticks", async () => {
  const vm = await loadVm();
  const from = [60, 24];
  // 6 kn for 10 minutes = 1 nm north.
  const v = vm.predictorVector(from, 0, 6);
  assert.ok(v, "vector");
  closeTo(vm.distanceNm(v.from, v.to), 1, 0.001, "length");
  closeTo(v.to[0], 60.01666, 0.001, "to lat");
  assert.equal(v.minutes, 10);
  assert.deepEqual(
    v.ticks.map((t) => t.minutes),
    [2, 4, 6, 8],
    "ticks at 2/4/6/8 — the endpoint is the 10-min mark",
  );
  closeTo(vm.distanceNm(v.from, v.ticks[0].at), 0.2, 0.001, "2-min tick");
  closeTo(vm.distanceNm(v.from, v.ticks[3].at), 0.8, 0.001, "8-min tick");
});

test("predictorVector: no vector without course or speed", async () => {
  const vm = await loadVm();
  const from = [60, 24];
  assert.equal(vm.predictorVector(from, null, 6), null, "no course");
  assert.equal(vm.predictorVector(from, 45, null), null, "no speed");
  assert.equal(vm.predictorVector(from, 45, 0), null, "zero speed");
  assert.equal(vm.predictorVector(null, 45, 6), null, "no position");
});

test("rangeRingSpacingNm: zoom-derived ladder spacing", async () => {
  const vm = await loadVm();
  // Zoom 12 at 60N (~19 m/px): 1 nm ≈ 97 px — the smallest ladder step
  // inside the 60–200 px band.
  assert.equal(vm.rangeRingSpacingNm(vm.metersPerPixel(12, 60)), 1);
  // Zoomed out the ladder climbs; past its top there are no rings.
  assert.equal(vm.rangeRingSpacingNm(vm.metersPerPixel(6, 60)), 50);
  assert.equal(vm.rangeRingSpacingNm(vm.metersPerPixel(4, 60)), null);
  assert.equal(vm.rangeRingSpacingNm(0), null);
});

test("AIS leader convention is 10 minutes (work doc #30)", async () => {
  const vm = await loadVm();
  assert.equal(vm.AIS_LEADER_MIN, 10);
  // End-to-end: an active 6 kn target projects 1 nm along COG.
  const T0 = Date.now();
  const target = {
    context: "vessels.230123456",
    lat: 60,
    lon: 24,
    cogRad: 0,
    sogMs: 6 / vm.msToKn(1),
    tMs: T0,
    receivedMs: T0,
  };
  const spec = vm.aisMarkerSpec(target, T0, null);
  assert.ok(spec.leader, "leader");
  closeTo(
    vm.distanceNm(spec.leader.from, spec.leader.to),
    1,
    0.001,
    "10-min run",
  );
});
