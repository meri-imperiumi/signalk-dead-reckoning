/**
 * Unified fix-resolution geometry (SPEC §4.4, §9.1).
 *
 * Observations come in three geometric primitives:
 *
 *   - **Point** (GPS, future Starlink positioning) — a fix on its own.
 *   - **Line of position (LOP)** — "you are somewhere along this line."
 *     A celestial sight (linearized near the assumed position), a
 *     compass bearing, or an RDF bearing. Modeled as an infinite line
 *     through a reference point at a given azimuth, offset by the
 *     signed intercept for the celestial case.
 *   - **Circular position line (CPL)** — "you are somewhere on this
 *     circle." A circle of equal altitude (vertical-angle-to-known-object)
 *     or a ranged ADS-B contact. Modeled as a circle of known center and
 *     radius.
 *
 * The resolver combines these into a candidate fix point, returning both
 * the resolved position and a residual spread (the "cocked hat" size) as
 * an implicit confidence indicator.
 *
 * ## Coordinate system
 *
 * Per the v1 design decision, all intersection math is **local-planar**:
 * each resolution projects inputs into an equirectangular plane tangent
 * to the sphere at a projection center (the DR position or an assumed
 * position), solves in metres, and projects the result back. This is
 * exact enough for typical sight ranges (sub-NM to a few tens of NM) and
 * far simpler and more legible than full spherical-circle intersection.
 * The projection center is always carried explicitly so the validity
 * envelope is documented, not hidden.
 *
 * @file fixes.js
 */

const {
  METRES_PER_NM,
  EARTH_RADIUS_M,
  degToRad,
  radToDeg,
  normalizeDeg180,
  destinationPoint,
} = require("./geo.js");

/**
 * Equirectangular projection of a lat/lon point into a local plane, in
 * metres, relative to the projection center. X is east, Y is north.
 *
 * @param {{latitude: number, longitude: number}} center
 * @param {{latitude: number, longitude: number}} p
 * @returns {{x: number, y: number}}
 */
function projectToLocal(center, p) {
  const lat0 = degToRad(center.latitude);
  const x =
    degToRad(p.longitude - center.longitude) * EARTH_RADIUS_M * Math.cos(lat0);
  const y = degToRad(p.latitude - center.latitude) * EARTH_RADIUS_M;
  return { x, y };
}

/**
 * Inverse of `projectToLocal`: a local-plane point back to lat/lon.
 *
 * @param {{latitude: number, longitude: number}} center
 * @param {{x: number, y: number}} q
 * @returns {{latitude: number, longitude: number}}
 */
function unprojectFromLocal(center, q) {
  const lat0 = degToRad(center.latitude);
  const lat = center.latitude + radToDeg(q.y / EARTH_RADIUS_M);
  const lon =
    center.longitude + radToDeg(q.x / (EARTH_RADIUS_M * Math.cos(lat0)));
  return {
    latitude: lat,
    longitude: normalizeDeg180(lon),
  };
}

/**
 * The local-plane representation of a line of position.
 *
 * A LOP is an infinite line through a point, perpendicular to the body's
 * azimuth (i.e. the line of equal altitude runs across-track). For a
 * celestial sight the line is offset from the assumed position by the
 * signed intercept (toward/away from the body). For a bearing/RDF line
 * the line passes through the observer and runs along the bearing — but
 * the *position constraint* ("you are on this line") is the same line,
 * so it is represented the same way: a point the line passes through plus
 * a direction along the line.
 *
 * Represented here in the canonical form `n·x = c` (unit normal n,
 * scalar offset c), which makes intersection and distance-to-line
 * calculations trivial. The normal points along the azimuth (so the
 * intercept sign is meaningful for celestial sights).
 *
 * @typedef {Object} LocalLop
 * @property {{x: number, y: number}} n - unit normal (along azimuth, in the local plane)
 * @property {number} c - line offset: n·p = c for points p on the line
 */

/**
 * Builds the local-plane LOP from an observation, projected about a given
 * projection center (the DR/assumed region). The assumed position of the
 * observation is itself projected into that same plane; the line passes
 * through that projected point, offset by the signed intercept along the
 * azimuth-normal (toward the body = positive, for celestial sights).
 *
 * @param {{latitude: number, longitude: number}} projectionCenter
 * @param {object} obs
 * @param {number} obs.assumed_lat
 * @param {number} obs.assumed_lon
 * @param {number} obs.azimuth_true - deg true, the body's bearing or measured bearing
 * @param {number} [obs.intercept_nm] - signed intercept (celestial); 0 for bearing/rdf
 * @returns {LocalLop}
 */
function lopToLocal(projectionCenter, obs) {
  // The line runs perpendicular to the azimuth; its normal is along the
  // azimuth. In the local plane, azimuth θ (deg true, 0=N, 90=E) maps to
  // a normal vector (sin θ, cos θ) since x=East, y=North.
  const az = degToRad(obs.azimuth_true);
  const n = { x: Math.sin(az), y: Math.cos(az) };
  // The assumed position, projected into the global local plane, is the
  // reference point the line passes through. The signed intercept shifts
  // the line along the normal (toward the body = positive).
  const ref = projectToLocal(projectionCenter, {
    latitude: obs.assumed_lat,
    longitude: obs.assumed_lon,
  });
  const interceptM = (obs.intercept_nm ?? 0) * METRES_PER_NM;
  const c = n.x * ref.x + n.y * ref.y + interceptM;
  return { n, c };
}

/**
 * Perpendicular distance from a local-plane point to a LOP, signed along
 * the normal. Used both for picking the plausible side of a Line×Circle
 * intersection and for residual computation.
 *
 * @param {LocalLop} lop
 * @param {{x: number, y: number}} p
 * @returns {number} signed distance in metres (positive = on the normal side)
 */
function signedDistanceToLop(lop, p) {
  return lop.n.x * p.x + lop.n.y * p.y - lop.c;
}

/**
 * Intersection of two LOPs in the local plane. Parallel lines return null
 * (the caller treats that as a non-intersection / residual case).
 *
 * @param {LocalLop} a
 * @param {LocalLop} b
 * @returns {{x: number, y: number}|null}
 */
function intersectLopLop(a, b) {
  // Solve n_a·p = c_a, n_b·p = c_b as a 2x2 linear system.
  const det = a.n.x * b.n.y - a.n.y * b.n.x;
  if (Math.abs(det) < 1e-12) return null; // parallel / coincident
  const x = (b.n.y * a.c - a.n.y * b.c) / det;
  const y = (a.n.x * b.c - b.n.x * a.c) / det;
  return { x, y };
}

/**
 * Intersection of a LOP and a CPL (circle) in the local plane. Returns up
 * to two candidate points; the caller (resolver) picks the plausible side
 * (nearest the DR position) and surfaces both if ambiguous.
 *
 * @param {LocalLop} lop
 * @param {{x: number, y: number}} center - circle center, local plane
 * @param {number} radiusM - circle radius, metres
 * @returns {{x: number, y: number}[]} 0, 1, or 2 intersection points
 */
function intersectLopCircle(lop, center, radiusM) {
  // Translate so the circle is at the origin: line becomes n·p = c', where
  // c' = c - n·center. The closest point on the line to the origin is
  // (c'/|n|^2) * n; |n|=1, so it's c' * n. Distance from origin to line is |c'|.
  const cPrime = lop.c - (lop.n.x * center.x + lop.n.y * center.y);
  const d = Math.abs(cPrime);
  if (d > radiusM + 1e-9) return []; // no intersection
  const foot = { x: cPrime * lop.n.x, y: cPrime * lop.n.y };
  if (Math.abs(d - radiusM) < 1e-9) return [foot]; // tangent
  const h = Math.sqrt(Math.max(0, radiusM * radiusM - d * d));
  // The chord direction is perpendicular to n.
  const along = { x: -lop.n.y, y: lop.n.x };
  return [
    { x: foot.x + h * along.x, y: foot.y + h * along.y },
    { x: foot.x - h * along.x, y: foot.y - h * along.y },
  ].map((p) => ({ x: p.x + center.x, y: p.y + center.y }));
}

/**
 * Intersection of two CPLs (circles) in the local plane. Returns 0, 1, or
 * 2 intersection points. The resolver returns **both** candidates (per the
 * design decision) and lets the caller/UI/human pick — the pipeline never
 * silently discards one (SPEC §4.4).
 *
 * @param {{x: number, y: number}} c1
 * @param {number} r1
 * @param {{x: number, y: number}} c2
 * @param {number} r2
 * @returns {{x: number, y: number}[]}
 */
function intersectCircleCircle(c1, r1, c2, r2) {
  const dx = c2.x - c1.x;
  const dy = c2.y - c1.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-9) {
    // Concentric. Same circle → infinitely many (return empty; caller
    // treats as non-resolvable). Different → no intersection.
    return [];
  }
  if (d > r1 + r2 + 1e-9) return []; // too far apart
  if (d < Math.abs(r1 - r2) - 1e-9) return []; // one inside the other
  // Distance from c1 to the chord midpoint along the center line.
  const a = (d * d - r2 * r2 + r1 * r1) / (2 * d);
  const hSq = r1 * r1 - a * a;
  const h = Math.sqrt(Math.max(0, hSq));
  const mx = c1.x + (a * dx) / d;
  const my = c1.y + (a * dy) / d;
  if (h < 1e-9) return [{ x: mx, y: my }]; // tangent
  const px = (-dy / d) * h;
  const py = (dx / d) * h;
  return [
    { x: mx + px, y: my + py },
    { x: mx - px, y: my - py },
  ];
}

/**
 * Perpendicular (unsigned) distance from a point to a LOP, in metres — the
 * residual contribution for least-squares.
 *
 * @param {LocalLop} lop
 * @param {{x: number, y: number}} p
 * @returns {number}
 */
function distanceToLop(lop, p) {
  return Math.abs(signedDistanceToLop(lop, p));
}

/**
 * Radial (unsigned) distance from a point to a CPL circle, in metres — the
 * residual contribution for least-squares. For a circle of radius r, the
 * residual is |dist(center, p) - r|.
 *
 * @param {{x: number, y: number}} center
 * @param {number} radiusM
 * @param {{x: number, y: number}} p
 * @returns {number}
 */
function distanceToCircle(center, radiusM, p) {
  return Math.abs(Math.hypot(p.x - center.x, p.y - center.y) - radiusM);
}

/**
 * A normalized observation in a form the resolver understands. Point
 * observations (GPS) are handled directly by the caller and don't enter
 * the geometric resolver. LOPs and CPLs are the inputs here.
 *
 * @typedef {Object} LopInput
 * @property {'lop'} kind
 * @property {number} assumed_lat
 * @property {number} assumed_lon
 * @property {number} azimuth_true
 * @property {number} [intercept_nm]
 *
 * @typedef {Object} CplInput
 * @property {'cpl'} kind
 * @property {number} center_lat
 * @property {number} center_lon
 * @property {number} radius_nm
 *
 * @typedef {LopInput|CplInput} Observation
 */

/**
 * Residual (cocked-hat) spread for a set of observations at a candidate
 * point, in nautical miles. The max constraint distance is a robust
 * summary of spread for the watchkeeper; the mean is also returned so the
 * UI can show both if desired.
 *
 * @param {LocalLop[]} lops
 * @param {{centers: {x:number,y:number}[], radii: number[]}} circles - local-plane circles
 * @param {{x: number, y: number}} p - candidate point, local plane
 * @returns {{maxNm: number, meanNm: number}}
 */
function residualSpreadNm(lops, circles, p) {
  const ds = [];
  for (const lop of lops) ds.push(distanceToLop(lop, p));
  for (let i = 0; i < circles.centers.length; i++) {
    ds.push(distanceToCircle(circles.centers[i], circles.radii[i], p));
  }
  if (ds.length === 0) return { maxNm: 0, meanNm: 0 };
  const max = Math.max(...ds);
  const mean = ds.reduce((s, v) => s + v, 0) / ds.length;
  return { maxNm: max / METRES_PER_NM, meanNm: mean / METRES_PER_NM };
}

/**
 * Least-squares best-fit point for ≥3 (or non-intersecting 2) inputs:
 * minimize the sum of squared constraint distances.
 *
 * Lines only, the problem is *linear* least squares: minimize
 * Σ (nᵢ·p − cᵢ)² has the closed-form normal equations
 * `(Σ nᵢnᵢᵀ) p = Σ cᵢnᵢ` — the same 2×2 solve `intersectLopLop`
 * does, generalized to N lines — so the answer is exact, in one shot,
 * however far the intercepts put it from the start point. (The previous
 * fixed-step gradient descent could only travel a few hundred metres
 * from its start regardless of the true answer — silently stalling on
 * realistic multi-nautical-mile intercepts.) A Tikhonov term λI with
 * λ ≪ the matrix scale makes the singular case (all lines parallel —
 * the loss is flat along the common direction) return the minimizing
 * line's point nearest `start` instead of dividing by ~0.
 *
 * With circles in the mix the residuals are nonlinear
 * (|p − center| − radius), so after the linear solve the point is
 * refined by Levenberg–Marquardt (damped Gauss–Newton). The constraint
 * set is tiny (≤ a handful) and only mildly nonlinear in the local
 * plane, so it converges in a handful of iterations; the damping keeps
 * it robust when the Jacobian is near-singular (e.g. near-concentric
 * circles).
 *
 * @param {LocalLop[]} lops
 * @param {{centers: {x:number,y:number}[], radii: number[]}} circles
 * @param {{x: number, y: number}} start - initial guess, local plane
 * @returns {{point: {x:number,y:number}, residual: {maxNm:number, meanNm:number}}}
 */
function leastSquaresFit(lops, circles, start) {
  let p = linearLopSolve(lops, start);
  if (circles.centers.length > 0) {
    // The linear solve minimizes only the line terms and can land in a
    // worse basin than `start` once the circles count; start from the
    // cheaper of the two. LM's accept-only-if-better step then
    // guarantees the result is never worse than either.
    if (fitLoss(lops, circles, start) < fitLoss(lops, circles, p)) {
      p = { x: start.x, y: start.y };
    }
    p = gaussNewtonRefine(lops, circles, p);
  }
  return { point: p, residual: residualSpreadNm(lops, circles, p) };
}

/**
 * Closed-form solution of the lines-only least squares: the normal
 * equations `(Σ nᵢnᵢᵀ) p = Σ cᵢnᵢ`, damped toward `start` for the
 * singular (all-parallel) case.
 *
 * @param {LocalLop[]} lops
 * @param {{x: number, y: number}} start
 * @returns {{x: number, y: number}}
 */
function linearLopSolve(lops, start) {
  let a11 = 0;
  let a12 = 0;
  let a22 = 0;
  let b1 = 0;
  let b2 = 0;
  for (const lop of lops) {
    a11 += lop.n.x * lop.n.x;
    a12 += lop.n.x * lop.n.y;
    a22 += lop.n.y * lop.n.y;
    b1 += lop.c * lop.n.x;
    b2 += lop.c * lop.n.y;
  }
  // Tikhonov damping toward `start`: minimize ||Ap − b||² + λ||p − s||²
  // solves (A + λI) p = b + λs. Well-conditioned systems are unaffected
  // (the bias is λ/σ² ≪ 1); a flat loss valley returns the valley point
  // nearest `start`.
  const lambda = 1e-9 * Math.max(a11 + a22, 1);
  const det = (a11 + lambda) * (a22 + lambda) - a12 * a12;
  return {
    x:
      ((a22 + lambda) * (b1 + lambda * start.x) -
        a12 * (b2 + lambda * start.y)) /
      det,
    y:
      ((a11 + lambda) * (b2 + lambda * start.y) -
        a12 * (b1 + lambda * start.x)) /
      det,
  };
}

/** Max Levenberg–Marquardt outer iterations and damping retry steps. */
const GN_MAX_ITERS = 50;
const GN_MAX_RETRIES = 12;

/** Step size (m) below which the refinement is considered converged. */
const GN_STEP_TOL_M = 1e-6;

/**
 * Sum of squared constraint distances at `p` — the objective the
 * refinement minimizes.
 *
 * @param {LocalLop[]} lops
 * @param {{centers: {x:number,y:number}[], radii: number[]}} circles
 * @param {{x: number, y: number}} p
 * @returns {number} m²
 */
function fitLoss(lops, circles, p) {
  let s = 0;
  for (const lop of lops) {
    const d = signedDistanceToLop(lop, p);
    s += d * d;
  }
  for (let i = 0; i < circles.centers.length; i++) {
    const d = distanceToCircle(circles.centers[i], circles.radii[i], p);
    s += d * d;
  }
  return s;
}

/**
 * Levenberg–Marquardt refinement of the fit point over lines and
 * circles. Each iteration solves the damped Gauss–Newton system
 * `(JᵀJ + λI) δ = −Jᵀf`; the damping is raised until the step actually
 * reduces the loss and lowered again afterwards, so the iteration
 * behaves like gradient descent far from the minimum (where the
 * quadratic model is optimistic) and like plain Gauss–Newton near it.
 *
 * @param {LocalLop[]} lops
 * @param {{centers: {x:number,y:number}[], radii: number[]}} circles
 * @param {{x: number, y: number}} start
 * @returns {{x: number, y: number}}
 */
function gaussNewtonRefine(lops, circles, start) {
  let p = { x: start.x, y: start.y };
  let loss = fitLoss(lops, circles, p);
  let lambda = 1e-9; // relative to the JᵀJ scale (dimensionless)
  for (let it = 0; it < GN_MAX_ITERS; it++) {
    // Gauss–Newton normal terms at the current point: JᵀJ and −Jᵀf,
    // with one Jacobian row per constraint (n for a line, the radial
    // unit vector for a circle).
    let a11 = 0;
    let a12 = 0;
    let a22 = 0;
    let b1 = 0;
    let b2 = 0;
    for (const lop of lops) {
      const f = signedDistanceToLop(lop, p);
      a11 += lop.n.x * lop.n.x;
      a12 += lop.n.x * lop.n.y;
      a22 += lop.n.y * lop.n.y;
      b1 -= f * lop.n.x;
      b2 -= f * lop.n.y;
    }
    for (let i = 0; i < circles.centers.length; i++) {
      const c = circles.centers[i];
      const dx = p.x - c.x;
      const dy = p.y - c.y;
      const dist = Math.hypot(dx, dy);
      // Radial unit vector; at the exact center the gradient direction
      // is undefined — fall back to +x (the damping keeps it harmless).
      const ux = dist > 1e-9 ? dx / dist : 1;
      const uy = dist > 1e-9 ? dy / dist : 0;
      const f = dist - circles.radii[i];
      a11 += ux * ux;
      a12 += ux * uy;
      a22 += uy * uy;
      b1 -= f * ux;
      b2 -= f * uy;
    }
    const scale = Math.max(a11 + a22, 1);

    // Try the damped step; raise λ until the loss actually improves.
    let stepped = false;
    for (let retry = 0; retry < GN_MAX_RETRIES; retry++) {
      const l = lambda * scale;
      const det = (a11 + l) * (a22 + l) - a12 * a12;
      const dx = ((a22 + l) * b1 - a12 * b2) / det;
      const dy = ((a11 + l) * b2 - a12 * b1) / det;
      const cand = { x: p.x + dx, y: p.y + dy };
      const candLoss = fitLoss(lops, circles, cand);
      if (candLoss <= loss) {
        lambda = Math.max(lambda / 10, 1e-12);
        p = cand;
        loss = candLoss;
        stepped = true;
        if (Math.hypot(dx, dy) < GN_STEP_TOL_M) return p; // converged
        break;
      }
      lambda *= 10;
    }
    if (!stepped) return p; // no damping level improves: at a minimum
  }
  return p;
}

/**
 * Result of resolving a set of observations into a candidate fix.
 *
 * @typedef {Object} ResolveResult
 * @property {number} latitude
 * @property {number} longitude
 * @property {number} residual_nm - cocked-hat spread at the resolved point (max constraint distance)
 * @property {{latitude:number, longitude:number}|null} alternate - second
 *           Circle×Circle candidate (only set when two exist), for the
 *           watchkeeper; null otherwise.
 */

/**
 * Resolves a set of LOP/CPL observations into a candidate fix.
 *
 * - **Two LOPs** that intersect → single point.
 * - **Two LOPs** parallel → least-squares closest-approach + residual gap.
 * - **LOP × Circle** → the intersection nearest the DR position; the other
 *   is surfaced as `alternate` when it's a meaningful second candidate.
 * - **Circle × Circle** → both candidates; the one nearest the DR position
 *   is the primary, the other is `alternate` (SPEC §4.4, Q4).
 * - **≥3 inputs** → least-squares best-fit + residual spread (cocked hat).
 * - **<2 inputs** → not resolvable; returns null (a single observation is
 *   a constraint, not a fix — it must be advanced to combine with a later
 *   one, see `advanceObservation`).
 *
 * @param {Observation[]} observations
 * @param {{latitude: number, longitude: number}} projectionCenter - DR / assumed position
 * @param {{latitude: number, longitude: number}|null} [drPosition] - to pick the plausible side; defaults to projectionCenter
 * @returns {ResolveResult|null}
 */
function resolveFix(observations, projectionCenter, drPosition = null) {
  const dr = drPosition ?? projectionCenter;
  const drLocal = projectToLocal(projectionCenter, dr);

  // Build local-plane primitives.
  const lops = [];
  const cplCenters = [];
  const cplRadii = [];
  for (const obs of observations) {
    if (obs.kind === "lop") {
      lops.push(
        lopToLocal(projectionCenter, {
          assumed_lat: obs.assumed_lat,
          assumed_lon: obs.assumed_lon,
          azimuth_true: obs.azimuth_true,
          intercept_nm: obs.intercept_nm,
        }),
      );
    } else if (obs.kind === "cpl") {
      cplCenters.push(
        projectToLocal(projectionCenter, {
          latitude: obs.center_lat,
          longitude: obs.center_lon,
        }),
      );
      cplRadii.push(obs.radius_nm * METRES_PER_NM);
    }
  }
  const circles = { centers: cplCenters, radii: cplRadii };
  const nInputs = lops.length + cplCenters.length;

  if (nInputs < 2) return null;

  // Pick the resolver branch by composition.
  if (nInputs >= 3) {
    // Cocked-hat / over-determined: least-squares from the DR point.
    const { point, residual } = leastSquaresFit(lops, circles, drLocal);
    const ll = unprojectFromLocal(projectionCenter, point);
    return {
      latitude: ll.latitude,
      longitude: ll.longitude,
      residual_nm: residual.maxNm,
      alternate: null,
    };
  }

  // Exactly two inputs.
  if (lops.length === 2 && cplCenters.length === 0) {
    const pt = intersectLopLop(lops[0], lops[1]);
    if (!pt) {
      // Parallel LOPs: the loss is flat along the common line direction,
      // so least-squares is degenerate. Handle explicitly: the best-fit
      // point is the midline between the two lines, projected to the DR's
      // along-line coordinate (any point on the midline is equally valid
      // since the loss is flat there). The residual is the half-gap — the
      // distance from the resolved point to each line — which is the
      // meaningful cocked-hat size for two parallel constraints.
      const cMid = (lops[0].c + lops[1].c) / 2;
      const n = lops[0].n;
      const along = { x: -n.y, y: n.x }; // unit along-line direction
      const foot = { x: cMid * n.x, y: cMid * n.y }; // foot from origin to midline
      // Walk along `along` to the DR's along-line coordinate.
      const tAlong =
        along.x * (drLocal.x - foot.x) + along.y * (drLocal.y - foot.y);
      const pt2 = {
        x: foot.x + tAlong * along.x,
        y: foot.y + tAlong * along.y,
      };
      const ll = unprojectFromLocal(projectionCenter, pt2);
      const residual = residualSpreadNm(lops, circles, pt2);
      return {
        latitude: ll.latitude,
        longitude: ll.longitude,
        residual_nm: residual.maxNm,
        alternate: null,
      };
    }
    const ll = unprojectFromLocal(projectionCenter, pt);
    const residual = residualSpreadNm(lops, circles, pt);
    return {
      latitude: ll.latitude,
      longitude: ll.longitude,
      residual_nm: residual.maxNm,
      alternate: null,
    };
  }

  if (lops.length === 1 && cplCenters.length === 1) {
    const pts = intersectLopCircle(lops[0], cplCenters[0], cplRadii[0]);
    if (pts.length === 0) {
      // Non-intersecting: least-squares closest approach.
      const { point, residual } = leastSquaresFit(lops, circles, drLocal);
      const ll = unprojectFromLocal(projectionCenter, point);
      return {
        latitude: ll.latitude,
        longitude: ll.longitude,
        residual_nm: residual.maxNm,
        alternate: null,
      };
    }
    if (pts.length === 1) {
      const ll = unprojectFromLocal(projectionCenter, pts[0]);
      const residual = residualSpreadNm(lops, circles, pts[0]);
      return {
        latitude: ll.latitude,
        longitude: ll.longitude,
        residual_nm: residual.maxNm,
        alternate: null,
      };
    }
    // Two candidates: nearest DR is primary, the other is alternate.
    const d0 = Math.hypot(pts[0].x - drLocal.x, pts[0].y - drLocal.y);
    const d1 = Math.hypot(pts[1].x - drLocal.x, pts[1].y - drLocal.y);
    const [primary, alt] = d0 <= d1 ? [pts[0], pts[1]] : [pts[1], pts[0]];
    const ll = unprojectFromLocal(projectionCenter, primary);
    const altLl = unprojectFromLocal(projectionCenter, alt);
    const residual = residualSpreadNm(lops, circles, primary);
    return {
      latitude: ll.latitude,
      longitude: ll.longitude,
      residual_nm: residual.maxNm,
      alternate: { latitude: altLl.latitude, longitude: altLl.longitude },
    };
  }

  if (lops.length === 0 && cplCenters.length === 2) {
    const pts = intersectCircleCircle(
      cplCenters[0],
      cplRadii[0],
      cplCenters[1],
      cplRadii[1],
    );
    if (pts.length === 0) {
      const { point, residual } = leastSquaresFit(lops, circles, drLocal);
      const ll = unprojectFromLocal(projectionCenter, point);
      return {
        latitude: ll.latitude,
        longitude: ll.longitude,
        residual_nm: residual.maxNm,
        alternate: null,
      };
    }
    if (pts.length === 1) {
      const ll = unprojectFromLocal(projectionCenter, pts[0]);
      const residual = residualSpreadNm(lops, circles, pts[0]);
      return {
        latitude: ll.latitude,
        longitude: ll.longitude,
        residual_nm: residual.maxNm,
        alternate: null,
      };
    }
    // Both candidates surfaced (SPEC §4.4).
    const d0 = Math.hypot(pts[0].x - drLocal.x, pts[0].y - drLocal.y);
    const d1 = Math.hypot(pts[1].x - drLocal.x, pts[1].y - drLocal.y);
    const [primary, alt] = d0 <= d1 ? [pts[0], pts[1]] : [pts[1], pts[0]];
    const ll = unprojectFromLocal(projectionCenter, primary);
    const altLl = unprojectFromLocal(projectionCenter, alt);
    const residual = residualSpreadNm(lops, circles, primary);
    return {
      latitude: ll.latitude,
      longitude: ll.longitude,
      residual_nm: residual.maxNm,
      alternate: { latitude: altLl.latitude, longitude: altLl.longitude },
    };
  }

  // Fallback for any other two-input mix not explicitly handled.
  const { point, residual } = leastSquaresFit(lops, circles, drLocal);
  const ll = unprojectFromLocal(projectionCenter, point);
  return {
    latitude: ll.latitude,
    longitude: ll.longitude,
    residual_nm: residual.maxNm,
    alternate: null,
  };
}

/**
 * Advances an observation along the DR track for a running fix (SPEC §4.4).
 * Given an observation taken at `fromTime` and the DR displacement over the
 * elapsed interval, returns a new observation whose reference point
 * (assumed position for a LOP, center for a CPL) has been dead-reckoned
 * forward by the displacement. The geometry of the constraint is preserved
 * (azimuth for a LOP, radius for a CPL), since the DR track transports the
 * whole observation, not just a point on it.
 *
 * The caller supplies the displacement as a bearing/distance — this keeps
 * the resolver decoupled from the DR engine's track representation (the
 * engine will expose a `trackBetween(t0, t1)` accessor; this function
 * consumes its output without depending on it directly).
 *
 * @param {Observation} obs
 * @param {{bearingTrue: number, distanceNm: number}} displacement - DR motion over [fromTime, toTime]
 * @returns {Observation}
 */
function advanceObservation(obs, displacement) {
  if (obs.kind === "lop") {
    const moved = destinationPoint(
      { latitude: obs.assumed_lat, longitude: obs.assumed_lon },
      displacement.bearingTrue,
      displacement.distanceNm,
    );
    return {
      kind: "lop",
      assumed_lat: moved.latitude,
      assumed_lon: moved.longitude,
      azimuth_true: obs.azimuth_true,
      intercept_nm: obs.intercept_nm,
    };
  }
  // CPL: advance the circle's center; radius is unchanged (a circle of
  // equal altitude transported by DR keeps its radius — the body's
  // geographic position moves with the sight time, but for a *running*
  // fix the standard practice is to advance the observer's constraint,
  // not recompute the body. The celestial-recompute case is the sight
  // engine's job, not the resolver's.)
  const moved = destinationPoint(
    { latitude: obs.center_lat, longitude: obs.center_lon },
    displacement.bearingTrue,
    displacement.distanceNm,
  );
  return {
    kind: "cpl",
    center_lat: moved.latitude,
    center_lon: moved.longitude,
    radius_nm: obs.radius_nm,
  };
}

module.exports = {
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
};
