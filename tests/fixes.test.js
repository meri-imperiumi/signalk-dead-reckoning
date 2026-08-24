/**
 * Tests for the unified fix resolver (SPEC §4.4).
 *
 * The math is local-planar about an explicit projection center. Tests
 * check both the geometry and the residual/alternate-candidate contract.
 * @file fixes.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  projectToLocal,
  unprojectFromLocal,
  lopToLocal,
  signedDistanceToLop,
  intersectLopLop,
  intersectLopCircle,
  intersectCircleCircle,
  distanceToLop,
  distanceToCircle,
  residualSpreadNm,
  resolveFix,
  advanceObservation,
} = require("../plugin/fixes.js");
const { distanceNm, destinationPoint } = require("../plugin/geo.js");

// Projection center used across most tests: a mid-latitude point.
const CENTER = { latitude: 60, longitude: 24 };
const DR = { latitude: 60.02, longitude: 24.01 };

test("projectToLocal / unprojectFromLocal round-trip", () => {
  const p = { latitude: 60.05, longitude: 24.1 };
  const q = projectToLocal(CENTER, p);
  const back = unprojectFromLocal(CENTER, q);
  assert.ok(Math.abs(back.latitude - p.latitude) < 1e-9);
  assert.ok(Math.abs(back.longitude - p.longitude) < 1e-9);
});

test("projectToLocal: 1 nm north → y ≈ 1852 m", () => {
  const p = { latitude: 60 + 1 / 60, longitude: 24 };
  const q = projectToLocal(CENTER, p);
  // Equirectangular uses the spherical mean radius; 1' of latitude is
  // ~1853.25m there vs 1852m by the nautical-mile definition. The ~1.25m
  // (0.07%) mismatch is consistent across the codebase and well below
  // sight-reduction accuracy, so the tolerance accepts it.
  assert.ok(Math.abs(q.y - 1852) < 2);
  assert.ok(Math.abs(q.x) < 1e-6);
});

test("lopToLocal: bearing due east (90) → normal points east", () => {
  const lop = lopToLocal(CENTER, {
    assumed_lat: 60,
    assumed_lon: 24,
    azimuth_true: 90,
    intercept_nm: 0,
  });
  assert.ok(Math.abs(lop.n.x - 1) < 1e-9); // east
  assert.ok(Math.abs(lop.n.y) < 1e-9);
  assert.ok(Math.abs(lop.c) < 1e-6); // line passes through assumed position
});

test("signedDistanceToLop: intercept shifts the line by the intercept", () => {
  // Azimuth 0 (north): normal points north. A +1nm intercept moves the
  // line 1nm toward the body (north of the assumed position).
  const lop = lopToLocal(CENTER, {
    assumed_lat: 60,
    assumed_lon: 24,
    azimuth_true: 0,
    intercept_nm: 1,
  });
  // A point 1nm north of the assumed position should be ON the line.
  // (Tolerance accounts for the spherical-vs-nm projection mismatch.)
  const p1nm = projectToLocal(CENTER, {
    latitude: 60 + 1 / 60,
    longitude: 24,
  });
  assert.ok(Math.abs(signedDistanceToLop(lop, p1nm)) < 2);
});

test("intersectLopLop: two perpendicular bearings cross at the observer", () => {
  // Two bearings through the same point: lines cross there.
  const a = lopToLocal(CENTER, {
    assumed_lat: 60,
    assumed_lon: 24,
    azimuth_true: 0,
  });
  const b = lopToLocal(CENTER, {
    assumed_lat: 60,
    assumed_lon: 24,
    azimuth_true: 90,
  });
  const pt = intersectLopLop(a, b);
  assert.ok(pt);
  const ll = unprojectFromLocal(CENTER, pt);
  assert.ok(Math.abs(ll.latitude - 60) < 1e-7);
  assert.ok(Math.abs(ll.longitude - 24) < 1e-7);
});

test("intersectLopLop: parallel lines return null", () => {
  const a = lopToLocal(CENTER, {
    assumed_lat: 60,
    assumed_lon: 24,
    azimuth_true: 0,
    intercept_nm: 0,
  });
  const b = lopToLocal(CENTER, {
    assumed_lat: 60,
    assumed_lon: 24,
    azimuth_true: 0,
    intercept_nm: 2,
  });
  assert.strictEqual(intersectLopLop(a, b), null);
});

test("intersectLopCircle: line through circle center → two points 2r apart", () => {
  // Circle of 1nm radius at CENTER, line (azimuth 90, east-west line) through CENTER.
  const center = projectToLocal(CENTER, CENTER);
  const lop = lopToLocal(CENTER, {
    assumed_lat: 60,
    assumed_lon: 24,
    azimuth_true: 90,
  });
  const pts = intersectLopCircle(lop, center, 1852);
  assert.strictEqual(pts.length, 2);
  const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  assert.ok(Math.abs(d - 2 * 1852) < 1);
});

test("intersectLopCircle: line tangent to circle → one point", () => {
  const center = projectToLocal(CENTER, CENTER);
  // Line offset 1nm north of center (azimuth 0, intercept 1), circle r=1nm → tangent.
  const lop = lopToLocal(CENTER, {
    assumed_lat: 60,
    assumed_lon: 24,
    azimuth_true: 0,
    intercept_nm: 1,
  });
  const pts = intersectLopCircle(lop, center, 1852);
  assert.strictEqual(pts.length, 1);
});

test("intersectLopCircle: line misses circle → no points", () => {
  const center = projectToLocal(CENTER, CENTER);
  const lop = lopToLocal(CENTER, {
    assumed_lat: 60,
    assumed_lon: 24,
    azimuth_true: 0,
    intercept_nm: 5,
  });
  const pts = intersectLopCircle(lop, center, 1852);
  assert.strictEqual(pts.length, 0);
});

test("intersectCircleCircle: two equal circles 1nm apart → two points", () => {
  const c1 = projectToLocal(CENTER, { latitude: 60, longitude: 24 });
  const c2 = projectToLocal(CENTER, { latitude: 60 + 1 / 60, longitude: 24 });
  const pts = intersectCircleCircle(c1, 1852, c2, 1852);
  assert.strictEqual(pts.length, 2);
});

test("intersectCircleCircle: disjoint → no points", () => {
  const c1 = projectToLocal(CENTER, { latitude: 60, longitude: 24 });
  const c2 = projectToLocal(CENTER, { latitude: 60 + 5 / 60, longitude: 24 });
  assert.strictEqual(intersectCircleCircle(c1, 1852, c2, 1852).length, 0);
});

test("intersectCircleCircle: concentric → no points", () => {
  const c = projectToLocal(CENTER, CENTER);
  assert.strictEqual(intersectCircleCircle(c, 1852, { ...c }, 1852).length, 0);
});

test("distanceToLop / distanceToCircle are non-negative", () => {
  const lop = lopToLocal(CENTER, {
    assumed_lat: 60,
    assumed_lon: 24,
    azimuth_true: 45,
  });
  const p = projectToLocal(CENTER, { latitude: 60.05, longitude: 24.05 });
  assert.ok(distanceToLop(lop, p) >= 0);
  const center = projectToLocal(CENTER, CENTER);
  assert.ok(distanceToCircle(center, 1000, p) >= 0);
});

test("residualSpreadNm: zero for a point on all constraints", () => {
  const a = lopToLocal(CENTER, {
    assumed_lat: 60,
    assumed_lon: 24,
    azimuth_true: 0,
  });
  const b = lopToLocal(CENTER, {
    assumed_lat: 60,
    assumed_lon: 24,
    azimuth_true: 90,
  });
  const origin = projectToLocal(CENTER, CENTER);
  const spread = residualSpreadNm([a, b], { centers: [], radii: [] }, origin);
  assert.ok(spread.maxNm < 1e-6);
});

test("resolveFix: single observation → null", () => {
  const one = [
    { kind: "lop", assumed_lat: 60, assumed_lon: 24, azimuth_true: 0 },
  ];
  assert.strictEqual(resolveFix(one, CENTER, DR), null);
});

test("resolveFix: two crossing bearings → single point, small residual", () => {
  const obs = [
    { kind: "lop", assumed_lat: 60, assumed_lon: 24, azimuth_true: 0 },
    { kind: "lop", assumed_lat: 60, assumed_lon: 24, azimuth_true: 90 },
  ];
  const r = resolveFix(obs, CENTER, DR);
  assert.ok(r);
  assert.ok(Math.abs(r.latitude - 60) < 1e-6);
  assert.ok(Math.abs(r.longitude - 24) < 1e-6);
  assert.ok(r.residual_nm < 1e-6);
  assert.strictEqual(r.alternate, null);
});

test("resolveFix: parallel LOPs → closest approach with a residual gap", () => {
  const obs = [
    {
      kind: "lop",
      assumed_lat: 60,
      assumed_lon: 24,
      azimuth_true: 0,
      intercept_nm: 0,
    },
    {
      kind: "lop",
      assumed_lat: 60,
      assumed_lon: 24,
      azimuth_true: 0,
      intercept_nm: 1,
    },
  ];
  const r = resolveFix(obs, CENTER, DR);
  assert.ok(r);
  // The two lines are 1nm apart; the closest-approach midpoint sits halfway.
  assert.ok(r.residual_nm > 0.4 && r.residual_nm < 0.6);
});

test("resolveFix: LOP × Circle, two candidates → nearest DR primary, alternate surfaced", () => {
  // Circle of 2nm at CENTER; an east-west LOP through CENTER crosses it at
  // ±2nm east/west of CENTER. DR is east of CENTER → east point is primary.
  const obs = [
    { kind: "lop", assumed_lat: 60, assumed_lon: 24, azimuth_true: 90 },
    { kind: "cpl", center_lat: 60, center_lon: 24, radius_nm: 2 },
  ];
  const drEast = { latitude: 60.04, longitude: 24.1 }; // east of CENTER
  const r = resolveFix(obs, CENTER, drEast);
  assert.ok(r);
  assert.ok(r.alternate);
  // Primary should be closer to DR than alternate.
  const dPrimary = distanceNm(drEast, {
    latitude: r.latitude,
    longitude: r.longitude,
  });
  const dAlt = distanceNm(drEast, r.alternate);
  assert.ok(dPrimary < dAlt);
});

test("resolveFix: Circle × Circle → both candidates, nearest DR primary", () => {
  // Two 3nm circles whose centers are 2nm apart (N-S) → two intersections.
  const obs = [
    { kind: "cpl", center_lat: 60, center_lon: 24, radius_nm: 3 },
    { kind: "cpl", center_lat: 60 + 2 / 60, center_lon: 24, radius_nm: 3 },
  ];
  const r = resolveFix(obs, CENTER, DR);
  assert.ok(r);
  assert.ok(r.alternate);
  const dPrimary = distanceNm(DR, {
    latitude: r.latitude,
    longitude: r.longitude,
  });
  const dAlt = distanceNm(DR, r.alternate);
  assert.ok(dPrimary <= dAlt);
});

test("resolveFix: three LOPs forming a cocked hat → least-squares fit, residual > 0", () => {
  // Three bearings through three different points, none concurrent: a
  // classic cocked hat. The fit lands near the middle with a nonzero spread.
  const obs = [
    {
      kind: "lop",
      assumed_lat: 60,
      assumed_lon: 24,
      azimuth_true: 0,
      intercept_nm: 1,
    },
    {
      kind: "lop",
      assumed_lat: 60,
      assumed_lon: 24,
      azimuth_true: 120,
      intercept_nm: 1,
    },
    {
      kind: "lop",
      assumed_lat: 60,
      assumed_lon: 24,
      azimuth_true: 240,
      intercept_nm: 1,
    },
  ];
  const r = resolveFix(obs, CENTER, DR);
  assert.ok(r);
  assert.ok(r.residual_nm > 0.1); // not all concurrent → spread
});

test("advanceObservation: LOP reference point moves by the displacement", () => {
  const obs = {
    kind: "lop",
    assumed_lat: 60,
    assumed_lon: 24,
    azimuth_true: 45,
    intercept_nm: 0.5,
  };
  const moved = advanceObservation(obs, { bearingTrue: 90, distanceNm: 1 });
  assert.strictEqual(moved.kind, "lop");
  assert.strictEqual(moved.azimuth_true, 45);
  assert.strictEqual(moved.intercept_nm, 0.5);
  const expected = destinationPoint({ latitude: 60, longitude: 24 }, 90, 1);
  assert.ok(Math.abs(moved.assumed_lat - expected.latitude) < 1e-9);
  assert.ok(Math.abs(moved.assumed_lon - expected.longitude) < 1e-9);
});

test("advanceObservation: CPL center moves, radius preserved", () => {
  const obs = { kind: "cpl", center_lat: 60, center_lon: 24, radius_nm: 4 };
  const moved = advanceObservation(obs, { bearingTrue: 0, distanceNm: 2 });
  assert.strictEqual(moved.kind, "cpl");
  assert.strictEqual(moved.radius_nm, 4);
  const expected = destinationPoint({ latitude: 60, longitude: 24 }, 0, 2);
  assert.ok(Math.abs(moved.center_lat - expected.latitude) < 1e-9);
  assert.ok(Math.abs(moved.center_lon - expected.longitude) < 1e-9);
});

test("running fix: advance one LOP then combine with a later LOP", () => {
  // First LOP: bearing 0 (object due north) → east-west line through CENTER.
  // DR moves 1nm NORTH over the interval; the advanced LOP is now an
  // east-west line 1nm north of CENTER. A second LOP, bearing 90 (object
  // due east) → north-south line through CENTER, crosses it 1nm north.
  const first = {
    kind: "lop",
    assumed_lat: 60,
    assumed_lon: 24,
    azimuth_true: 0,
  };
  const advanced = advanceObservation(first, { bearingTrue: 0, distanceNm: 1 });
  const second = {
    kind: "lop",
    assumed_lat: 60,
    assumed_lon: 24,
    azimuth_true: 90,
  };
  const r = resolveFix([advanced, second], CENTER, DR);
  assert.ok(r);
  // Intersection should be ~1nm north of CENTER.
  const dNorth = distanceNm(CENTER, { latitude: r.latitude, longitude: 24 });
  assert.ok(Math.abs(dNorth - 1) < 0.01, `expected ~1nm north, got ${dNorth}`);
  assert.ok(Math.abs(r.longitude - 24) < 0.01);
});
