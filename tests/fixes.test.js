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
  leastSquaresFit,
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

test("resolveFix: three LOPs forming a cocked hat → exact least-squares point and residual", () => {
  // Three bearings 120° apart through the same assumed position, all
  // with the same intercept: the cocked hat is an equilateral triangle
  // centered on the assumed position, so the least-squares point is the
  // assumed position itself and the residual equals the intercept.
  // Regression: the previous fixed-step solver could only travel a few
  // hundred metres from its start, returning (nearly) the DR position
  // with a residual that grew in lockstep with the intercept — the same
  // fix for every intercept, which read as a plausible cocked hat.
  for (const icptNm of [1, 10, 30]) {
    const obs = [0, 120, 240].map((az) => ({
      kind: "lop",
      assumed_lat: 60,
      assumed_lon: 24,
      azimuth_true: az,
      intercept_nm: icptNm,
    }));
    const r = resolveFix(obs, CENTER, DR);
    assert.ok(r);
    assert.ok(
      distanceNm(CENTER, { latitude: r.latitude, longitude: r.longitude }) <
        0.01,
      `intercept ${icptNm}nm: fit should sit on the assumed position, got (${r.latitude}, ${r.longitude})`,
    );
    assert.ok(
      Math.abs(r.residual_nm - icptNm) < 0.05,
      `intercept ${icptNm}nm: residual should be ${icptNm}, got ${r.residual_nm}`,
    );
  }
});

test("leastSquaresFit: over-determined lines, hand-computable answer", () => {
  // Minimize x² + y² + (x − D)² over lines x=0, y=0, x=D → (D/2, 0),
  // residual D/2. D = 10 nm puts the answer ~9 km from the start — well
  // beyond what the old fixed-step descent could ever reach.
  const nm = 1852;
  const D = 10 * nm;
  const lops = [
    { n: { x: 1, y: 0 }, c: 0 },
    { n: { x: 0, y: 1 }, c: 0 },
    { n: { x: 1, y: 0 }, c: D },
  ];
  const { point, residual } = leastSquaresFit(
    lops,
    { centers: [], radii: [] },
    {
      x: 0,
      y: 0,
    },
  );
  assert.ok(Math.abs(point.x - D / 2) < 1, `x ${point.x}`);
  assert.ok(Math.abs(point.y) < 1, `y ${point.y}`);
  assert.ok(Math.abs(residual.maxNm - 5) < 0.01, `maxNm ${residual.maxNm}`);
});

test("leastSquaresFit: mixed line + circles converges to the unique minimum", () => {
  // Line x=5000 and two 3000 m circles at (0,0) and (10000,0): by
  // symmetry the minimum is at (5000, 0) with max residual 2000 m.
  const lops = [{ n: { x: 1, y: 0 }, c: 5000 }];
  const circles = {
    centers: [
      { x: 0, y: 0 },
      { x: 10000, y: 0 },
    ],
    radii: [3000, 3000],
  };
  const { point, residual } = leastSquaresFit(lops, circles, { x: 0, y: 0 });
  assert.ok(Math.abs(point.x - 5000) < 1, `x ${point.x}`);
  assert.ok(Math.abs(point.y) < 1, `y ${point.y}`);
  assert.ok(
    Math.abs(residual.maxNm - 2000 / 1852) < 0.01,
    `maxNm ${residual.maxNm}`,
  );
});

test("leastSquaresFit: parallel lines fall back to the midline nearest the start", () => {
  // Two parallel E-W lines 2 nm apart (the lower one weighted ×2 by a
  // duplicate) : the loss is flat along east-west, so the answer is
  // pinned to the start's east-west coordinate at the weighted mean
  // offset y = (0+0+2nm)/3, with the far line's distance as residual.
  // The Tikhonov term makes the singular normal equations return that
  // instead of blowing up.
  const nm = 1852;
  const lops = [
    { n: { x: 0, y: 1 }, c: 0 },
    { n: { x: 0, y: 1 }, c: 2 * nm },
    { n: { x: 0, y: 1 }, c: 0 },
  ];
  const { point, residual } = leastSquaresFit(
    lops,
    { centers: [], radii: [] },
    {
      x: 4000,
      y: -3000,
    },
  );
  assert.ok(Math.abs(point.x - 4000) < 1, `x ${point.x}`);
  assert.ok(Math.abs(point.y - (2 * nm) / 3) < 1, `y ${point.y}`);
  assert.ok(Math.abs(residual.maxNm - 4 / 3) < 0.01, `maxNm ${residual.maxNm}`);
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

test("advanceObservation: point moves by the displacement", () => {
  const obs = { kind: "point", latitude: 60, longitude: 24 };
  const moved = advanceObservation(obs, { bearingTrue: 90, distanceNm: 1 });
  assert.strictEqual(moved.kind, "point");
  const expected = destinationPoint({ latitude: 60, longitude: 24 }, 90, 1);
  assert.ok(Math.abs(moved.latitude - expected.latitude) < 1e-9);
  assert.ok(Math.abs(moved.longitude - expected.longitude) < 1e-9);
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

test("resolveFix: point alone returns the point with zero residual", () => {
  const r = resolveFix(
    [{ kind: "point", latitude: 60.01, longitude: 24.02 }],
    CENTER,
    DR,
  );
  assert.ok(r);
  assert.ok(Math.abs(r.latitude - 60.01) < 1e-9);
  assert.ok(Math.abs(r.longitude - 24.02) < 1e-9);
  assert.strictEqual(r.residual_nm, 0);
  assert.strictEqual(r.alternate, null);
});

test("resolveFix: point + LOP projects onto the line (running fix vs previous fix)", () => {
  // Line: bearing 0 → east-west line 2nm north of CENTER (intercept 2).
  // The previous fix sits 1nm north of CENTER. Its perpendicular foot
  // on the line is 2nm north; the residual is the 1nm correction.
  const lop = {
    kind: "lop",
    assumed_lat: 60,
    assumed_lon: 24,
    azimuth_true: 0,
    intercept_nm: 2,
  };
  const fixPoint = { kind: "point", latitude: 60 + 1 / 60, longitude: 24 };
  const r = resolveFix([fixPoint, lop], CENTER, DR);
  assert.ok(r);
  const dNorth = distanceNm(CENTER, { latitude: r.latitude, longitude: 24 });
  assert.ok(Math.abs(dNorth - 2) < 0.01, `foot ~2nm north, got ${dNorth}`);
  assert.ok(Math.abs(r.longitude - 24) < 0.01);
  assert.ok(Math.abs(r.residual_nm - 1) < 0.01, `residual ${r.residual_nm}`);
  assert.strictEqual(r.alternate, null);
});

test("resolveFix: point + CPL projects radially onto the circle", () => {
  // Circle of 3nm around CENTER; the previous fix is 5nm north →
  // projected to the 3nm-north point on the circle, 2nm correction.
  const cpl = { kind: "cpl", center_lat: 60, center_lon: 24, radius_nm: 3 };
  const fixPoint = { kind: "point", latitude: 60 + 5 / 60, longitude: 24 };
  const r = resolveFix([fixPoint, cpl], CENTER, DR);
  assert.ok(r);
  const dNorth = distanceNm(CENTER, { latitude: r.latitude, longitude: 24 });
  assert.ok(Math.abs(dNorth - 3) < 0.01, `foot ~3nm north, got ${dNorth}`);
  assert.ok(Math.abs(r.longitude - 24) < 0.01);
  assert.ok(Math.abs(r.residual_nm - 2) < 0.01, `residual ${r.residual_nm}`);
});

test("resolveFix: point at the CPL center is undefined → null", () => {
  const cpl = { kind: "cpl", center_lat: 60, center_lon: 24, radius_nm: 3 };
  const r = resolveFix(
    [{ kind: "point", latitude: 60, longitude: 24 }, cpl],
    CENTER,
    DR,
  );
  assert.strictEqual(r, null);
});

test("resolveFix: point with ≥2 lines/circles is not a defined combination → null", () => {
  const fixPoint = { kind: "point", latitude: 60, longitude: 24 };
  const a = {
    kind: "lop",
    assumed_lat: 60,
    assumed_lon: 24,
    azimuth_true: 0,
  };
  const b = {
    kind: "lop",
    assumed_lat: 60,
    assumed_lon: 24,
    azimuth_true: 90,
  };
  assert.strictEqual(resolveFix([fixPoint, a, b], CENTER, DR), null);
  const cpl = { kind: "cpl", center_lat: 60, center_lon: 24, radius_nm: 3 };
  assert.strictEqual(resolveFix([fixPoint, a, cpl], CENTER, DR), null);
  assert.strictEqual(
    resolveFix([fixPoint, { ...fixPoint, latitude: 61 }], CENTER, DR),
    null,
  );
});
