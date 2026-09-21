/**
 * Tests for wind layline geometry (work doc #30): beat/gybe selection
 * by point of sail, tack colors, ray geometry, honest gating when the
 * polar/wind inputs are absent.
 * @file dr-laylines.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const vmPromise = import("../public/dr-viewmodel.js");

async function loadVm() {
  return vmPromise;
}

const closeTo = (actual, expected, tol, msg) =>
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${msg}: ${actual} vs ${expected} (±${tol})`,
  );

test("laylineSpec: wind ahead of the beam uses the beat angles", async () => {
  const vm = await loadVm();
  // Wind from the north (TWD 0°), boat heading north — dead upwind.
  // Beat angle 45°: layline courses 315° and 045°.
  const spec = vm.laylineSpec([60, 24], {
    twdDeg: 0,
    beatAngleDeg: 45,
    gybeAngleDeg: 150,
    headingDeg: 0,
    lengthNm: 1,
  });
  assert.ok(spec, "spec");
  assert.equal(spec.mode, "beat");
  closeTo(spec.angleDeg, 45, 0.001, "angle");
  assert.equal(spec.rays.length, 2);
  closeTo(spec.rays[0].courseDeg, 315, 0.001, "TWD − beat");
  closeTo(spec.rays[1].courseDeg, 45, 0.001, "TWD + beat");
});

test("laylineSpec: wind aft of the beam uses the gybe angles", async () => {
  const vm = await loadVm();
  // Boat heading north, wind from the south (TWD 180°) — running.
  const spec = vm.laylineSpec([60, 24], {
    twdDeg: 180,
    beatAngleDeg: 45,
    gybeAngleDeg: 150,
    headingDeg: 0,
    lengthNm: 1,
  });
  assert.equal(spec.mode, "gybe");
  closeTo(spec.rays[0].courseDeg, 30, 0.001, "TWD − gybe");
  closeTo(spec.rays[1].courseDeg, 330, 0.001, "TWD + gybe (normalized)");
});

test("laylineSpec: port tack is red and on the TWD+angle course", async () => {
  const vm = await loadVm();
  // TWD 0, beat 45: the 045° course has the wind on the PORT side.
  const spec = vm.laylineSpec([60, 24], {
    twdDeg: 0,
    beatAngleDeg: 45,
    gybeAngleDeg: 150,
    headingDeg: 0,
    lengthNm: 1,
  });
  const port = spec.rays.find((r) => r.tack === "port");
  const stbd = spec.rays.find((r) => r.tack === "starboard");
  assert.equal(port.color, vm.STYLE.laylinePort, "port red");
  assert.equal(stbd.color, vm.STYLE.laylineStbd, "starboard green");
  closeTo(port.courseDeg, 45, 0.001);
  closeTo(stbd.courseDeg, 315, 0.001);
});

test("laylineSpec: rays run lengthNm along their course from the DR position", async () => {
  const vm = await loadVm();
  const spec = vm.laylineSpec([60, 24], {
    twdDeg: 0,
    beatAngleDeg: 90,
    gybeAngleDeg: 150,
    headingDeg: 0,
    lengthNm: 2,
  });
  const stbd = spec.rays[0]; // course 270
  closeTo(vm.distanceNm([60, 24], stbd.to), 2, 0.001, "ray length");
  closeTo(
    stbd.to[1],
    24 - 2 / (60 * Math.cos((60 * Math.PI) / 180)),
    0.001,
    "due west",
  );
});

test("laylineSpec: missing inputs gate the layer to null", async () => {
  const vm = await loadVm();
  const base = {
    twdDeg: 0,
    beatAngleDeg: 45,
    gybeAngleDeg: 150,
    headingDeg: 0,
    lengthNm: 1,
  };
  assert.equal(
    vm.laylineSpec([60, 24], { ...base, twdDeg: null }),
    null,
    "no true wind → no laylines",
  );
  assert.equal(
    vm.laylineSpec([60, 24], { ...base, beatAngleDeg: null }),
    null,
    "beating but no beat angle → nothing",
  );
  // Wind aft, gybe angle missing → nothing (beat angle irrelevant).
  assert.equal(
    vm.laylineSpec([60, 24], { ...base, twdDeg: 180, gybeAngleDeg: null }),
    null,
    "running but no gybe angle → nothing",
  );
  assert.equal(vm.laylineSpec(null, base), null, "no DR position");
  // Nonsense angles rejected.
  assert.equal(vm.laylineSpec([60, 24], { ...base, beatAngleDeg: 0 }), null);
  assert.equal(vm.laylineSpec([60, 24], { ...base, beatAngleDeg: 200 }), null);
});

test("laylineSpec: missing heading falls back to beat angles", async () => {
  const vm = await loadVm();
  const spec = vm.laylineSpec([60, 24], {
    twdDeg: 180,
    beatAngleDeg: 45,
    gybeAngleDeg: 150,
    headingDeg: null,
    lengthNm: 1,
  });
  assert.equal(spec.mode, "beat", "racing default when heading unknown");
});
