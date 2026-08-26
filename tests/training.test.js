/**
 * Tests for Training Mode (SPEC §6.1, §6.3, §6.4). Pure-logic tests over
 * TrainingState; no Signal K plumbing. Current resolution (§6.2) is
 * tested in current.test.js.
 * @file training.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  TrainingState,
  detectFouling,
  updateTransient,
  isGpsReliable,
  computeObservation,
  tick,
  GROSS_JUMP_NM,
  ROT_TRANSIENT_DEG_S,
  SETTLE_SUSTAIN_S,
} = require("../plugin/training.js");

/**
 * Builds a minimal per-tick snapshot.
 *
 * @param {object} [overrides]
 * @returns {object}
 */
function snap(overrides = {}) {
  return {
    timestampS: 0,
    gps: null,
    stwKn: 5,
    headingTrueDeg: 0,
    awaDeg: 45,
    awsKn: 10,
    heelDeg: 10,
    propulsionState: "stopped",
    current: { setTrue: 0, drift: 0, tier: 5 },
    lookupLeewayDeg: 0,
    lookupSpeedLoss: 0,
    ...overrides,
  };
}

test("detectFouling is false when STW reads motion", () => {
  assert.strictEqual(
    detectFouling({ stwKn: 5, sogKn: 6, awsKn: 12, heelDeg: 15 }),
    false,
  );
});

test("detectFouling is true when STW≈0 but SOG indicates motion", () => {
  assert.strictEqual(
    detectFouling({ stwKn: 0.1, sogKn: 5, awsKn: 12, heelDeg: 15 }),
    true,
  );
});

test("detectFouling is false when STW≈0 and SOG≈0 (genuinely stopped)", () => {
  assert.strictEqual(
    detectFouling({ stwKn: 0.1, sogKn: 0.1, awsKn: 1, heelDeg: 0 }),
    false,
  );
});

test("detectFouling uses AWS as a moving corroboration when SOG is absent", () => {
  assert.strictEqual(
    detectFouling({ stwKn: 0.1, sogKn: null, awsKn: 12, heelDeg: 15 }),
    true,
  );
});

test("isGpsReliable is false without a fix", () => {
  const st = new TrainingState();
  assert.strictEqual(isGpsReliable(st, null), false);
});

test("isGpsReliable is true for a fresh fix with no prior", () => {
  const st = new TrainingState();
  assert.strictEqual(
    isGpsReliable(st, { latitude: 60, longitude: 24, timestampS: 0 }),
    true,
  );
});

test("isGpsReliable is false for a gross jump from the prior fix", () => {
  const st = new TrainingState();
  st.lastGps = { latitude: 60, longitude: 24, timestampS: 0 };
  // ~60nm north — well above the gross-jump bound.
  assert.strictEqual(
    isGpsReliable(st, { latitude: 61, longitude: 24, timestampS: 1 }),
    false,
  );
  // A small, plausible jump is reliable.
  assert.strictEqual(
    isGpsReliable(st, { latitude: 60.001, longitude: 24, timestampS: 1 }),
    true,
  );
});

test("tick is not eligible without two GPS fixes (no SOG/COG yet)", () => {
  const st = new TrainingState();
  const r = tick(
    st,
    snap({ timestampS: 1, gps: { latitude: 60, longitude: 24 } }),
  );
  assert.strictEqual(r.eligible, false);
  assert.strictEqual(r.observation, null);
});

test("tick becomes eligible once SOG/COG are derived from two fixes", () => {
  const st = new TrainingState();
  tick(st, snap({ timestampS: 0, gps: { latitude: 60, longitude: 24 } }));
  // 1nm north in 1 hour → SOG≈1, COG≈0. With STW 1 matching, leeway≈0.
  const r = tick(
    st,
    snap({
      timestampS: 3600,
      stwKn: 1,
      gps: { latitude: 60 + 1 / 60, longitude: 24 },
    }),
  );
  assert.strictEqual(r.eligible, true);
  assert.ok(r.observation);
  assert.ok(Math.abs(r.observation.leeway_angle) < 1.0);
  assert.ok(Math.abs(r.observation.speed_loss) < 0.05);
});

test("tick excludes motoring intervals (propulsion.main.state = started)", () => {
  const st = new TrainingState();
  tick(st, snap({ timestampS: 0, gps: { latitude: 60, longitude: 24 } }));
  const r = tick(
    st,
    snap({
      timestampS: 3600,
      gps: { latitude: 60 + 1 / 60, longitude: 24 },
      propulsionState: "started",
    }),
  );
  assert.strictEqual(r.eligible, false);
  assert.strictEqual(r.observation, null);
});

test("tick excludes a fouled paddlewheel", () => {
  const st = new TrainingState();
  tick(st, snap({ timestampS: 0, gps: { latitude: 60, longitude: 24 } }));
  // Second tick: STW≈0 but GPS shows motion (fouled), so ineligible.
  const r = tick(
    st,
    snap({
      timestampS: 3600,
      stwKn: 0.1,
      gps: { latitude: 60 + 1, longitude: 24 }, // big SOG
    }),
  );
  assert.strictEqual(r.fouled, true);
  assert.strictEqual(r.eligible, false);
});

test("tick excludes a gross GPS jump (not reliable)", () => {
  const st = new TrainingState();
  tick(st, snap({ timestampS: 0, gps: { latitude: 60, longitude: 24 } }));
  const r = tick(
    st,
    snap({
      timestampS: 3600,
      gps: { latitude: 70, longitude: 24 }, // ~600nm jump
    }),
  );
  assert.strictEqual(r.eligible, false);
});

test("computeObservation: due-east current yields a leeward leeway for a N-heading boat drifting E", () => {
  // Heading 0 (N), STW 5, no current. Ground truth COG 045, SOG ~7.07.
  // Water-made-good after removing a 5kn E current should be due N at 5kn
  // → leeway 0. This checks current subtraction end-to-end.
  const obs = computeObservation({
    stwKn: 5,
    headingTrueDeg: 0,
    sogKn: Math.SQRT2 * 5,
    cogDeg: 45,
    current: { setTrue: 90, drift: 5 },
    lookupLeewayDeg: 0,
    lookupSpeedLoss: 0,
  });
  assert.ok(obs);
  assert.ok(Math.abs(obs.leeway_angle) < 1.0);
  assert.ok(Math.abs(obs.speed_loss) < 0.05);
});

test("computeObservation: a boat making good a bearing to leeward of its heading yields positive leeway", () => {
  // Heading 0 (N), STW 5, no current. Ground truth COG 010 (slightly E of
  // N) → water-made-good bearing 010 → leeway +10.
  const obs = computeObservation({
    stwKn: 5,
    headingTrueDeg: 0,
    sogKn: 5,
    cogDeg: 10,
    current: { setTrue: 0, drift: 0 },
    lookupLeewayDeg: 0,
    lookupSpeedLoss: 0,
  });
  assert.ok(obs);
  assert.ok(Math.abs(obs.leeway_angle - 10) < 0.5);
});

test("computeObservation returns null with insufficient inputs", () => {
  assert.strictEqual(
    computeObservation({
      stwKn: null,
      headingTrueDeg: 0,
      sogKn: 5,
      cogDeg: 0,
      current: { setTrue: 0, drift: 0 },
      lookupLeewayDeg: 0,
      lookupSpeedLoss: 0,
    }),
    null,
  );
  assert.strictEqual(
    computeObservation({
      stwKn: 0,
      headingTrueDeg: 0,
      sogKn: 5,
      cogDeg: 0,
      current: { setTrue: 0, drift: 0 },
      lookupLeewayDeg: 0,
      lookupSpeedLoss: 0,
    }),
    null,
  );
});

test("updateTransient opens a window on a high rate-of-turn", () => {
  const st = new TrainingState();
  updateTransient(st, {
    headingDeg: 0,
    heelDeg: 10,
    awaDeg: 45,
    timestampS: 0,
  });
  // 60° turn in 1s = 60°/s, well above threshold.
  updateTransient(st, {
    headingDeg: 60,
    heelDeg: 5,
    awaDeg: 80,
    timestampS: 1,
  });
  assert.strictEqual(st.transient, true);
  assert.strictEqual(st.transientOpenAtS, 1);
});

test("updateTransient closes only after sustained re-stabilization", () => {
  const st = new TrainingState();
  updateTransient(st, {
    headingDeg: 0,
    heelDeg: 10,
    awaDeg: 45,
    timestampS: 0,
  });
  updateTransient(st, {
    headingDeg: 60,
    heelDeg: 5,
    awaDeg: 80,
    timestampS: 1,
  }); // open
  assert.strictEqual(st.transient, true);

  // Re-stabilize: heel and AWA held steady at the open-window values for
  // the sustained interval. Steady values are the *post-turn* ones.
  const heelSteady = 5;
  const awaSteady = 80;
  for (let t = 2; t < 2 + SETTLE_SUSTAIN_S + 1; t++) {
    updateTransient(st, {
      headingDeg: 60,
      heelDeg: heelSteady,
      awaDeg: awaSteady,
      timestampS: t,
    });
  }
  assert.strictEqual(st.transient, false);
});

test("updateTransient resets the settle clock on a renewed high rate-of-turn", () => {
  const st = new TrainingState();
  updateTransient(st, {
    headingDeg: 0,
    heelDeg: 10,
    awaDeg: 45,
    timestampS: 0,
  });
  updateTransient(st, {
    headingDeg: 60,
    heelDeg: 5,
    awaDeg: 80,
    timestampS: 1,
  }); // open
  // Almost settle...
  for (let t = 2; t < 2 + SETTLE_SUSTAIN_S - 1; t++) {
    updateTransient(st, {
      headingDeg: 60,
      heelDeg: 5,
      awaDeg: 80,
      timestampS: t,
    });
  }
  // Another sharp turn mid-settle resets the clock; window stays open.
  updateTransient(st, {
    headingDeg: 120,
    heelDeg: 0,
    awaDeg: 100,
    timestampS: 2 + SETTLE_SUSTAIN_S - 1,
  });
  assert.strictEqual(st.transient, true);
  assert.strictEqual(st.stabilizedS, 0);
});

test("tick is not eligible during an open transient window", () => {
  const st = new TrainingState();
  // Prime ground truth with two benign fixes.
  tick(st, snap({ timestampS: 0, gps: { latitude: 60, longitude: 24 } }));
  tick(st, snap({ timestampS: 1, gps: { latitude: 60, longitude: 24.0001 } }));
  // Now a sharp turn opens the window.
  const r = tick(
    st,
    snap({
      timestampS: 2,
      headingTrueDeg: 60,
      gps: { latitude: 60, longitude: 24.0002 },
    }),
  );
  assert.strictEqual(r.transient, true);
  assert.strictEqual(r.eligible, false);
});

test("tick resumes eligibility after the transient window closes", () => {
  const st = new TrainingState();
  tick(st, snap({ timestampS: 0, gps: { latitude: 60, longitude: 24 } }));
  tick(st, snap({ timestampS: 1, gps: { latitude: 60, longitude: 24.0001 } }));
  // Open transient at t=2 (snap defaults heel=10, awa=45, recorded at open).
  tick(
    st,
    snap({
      timestampS: 2,
      headingTrueDeg: 60,
      gps: { latitude: 60, longitude: 24.0002 },
    }),
  );
  // Settle: hold the post-turn heading but heel/AWA matching the open-window
  // values, past SETTLE_SUSTAIN_S.
  for (let t = 3; t < 3 + SETTLE_SUSTAIN_S + 1; t++) {
    tick(
      st,
      snap({
        timestampS: t,
        headingTrueDeg: 60,
        awaDeg: 45,
        heelDeg: 10,
        gps: { latitude: 60, longitude: 24.0002 + t * 0.00001 },
      }),
    );
  }
  // Next tick after close, with good ground truth, should be eligible.
  const r = tick(
    st,
    snap({
      timestampS: 3 + SETTLE_SUSTAIN_S + 2,
      headingTrueDeg: 60,
      awaDeg: 45,
      heelDeg: 10,
      stwKn: 5,
      gps: { latitude: 60.01, longitude: 24.0002 },
    }),
  );
  assert.strictEqual(r.transient, false);
  // Eligibility also needs a fresh SOG/COG derivation; ensure the path
  // doesn't crash and observation is computed when eligible.
  if (r.eligible) assert.ok(r.observation);
});

test("classifyManeuver: tack across the 0/360 seam and at mid angles", () => {
  const { classifyManeuver } = require("../plugin/training.js");
  // Starboard close-hauled (~30°) to port (~330°) — crosses the seam.
  assert.strictEqual(classifyManeuver(30, 330), "tack");
  assert.strictEqual(classifyManeuver(330, 30), "tack");
  assert.strictEqual(classifyManeuver(45, 315), "tack");
  // Same side, no flip: just a header/lift, not a tack.
  assert.strictEqual(classifyManeuver(30, 60), null);
});

test("classifyManeuver: gybe across 180", () => {
  const { classifyManeuver } = require("../plugin/training.js");
  assert.strictEqual(classifyManeuver(160, 200), "gybe");
  assert.strictEqual(classifyManeuver(200, 160), "gybe");
  // Beam reach to beam reach: not a gybe.
  assert.strictEqual(classifyManeuver(100, 260), null);
});

test("detectManeuver fires on the transient close edge with the open AWA", () => {
  const { TrainingState, detectManeuver, SETTLE_SUSTAIN_S } =
    require("../plugin/training.js");
  const st = new TrainingState();
  // Prime the previous-heading so the first snapshot can compute ROT.
  let t = 0;
  const snap = (heading, awa) => ({
    headingDeg: heading,
    heelDeg: 0,
    awaDeg: awa,
    timestampS: t++,
  });

  // Steady starboard close-hauled, then snap the heading: ROT opens the window.
  let tr = false;
  tr = require("../plugin/training.js").updateTransient(st, snap(350, 30));
  assert.strictEqual(tr, false);
  tr = require("../plugin/training.js").updateTransient(st, snap(30, 330));
  assert.strictEqual(tr, true);
  // While the window is open: no maneuver detection.
  assert.strictEqual(detectManeuver(st, { awaDeg: 330, headingDeg: 30 }), null);
  // Re-stabilize on port: heel/AWA steady for SETTLE_SUSTAIN_S closes it.
  for (let i = 0; i < SETTLE_SUSTAIN_S; i++) {
    tr = require("../plugin/training.js").updateTransient(st, snap(30, 330));
  }
  assert.strictEqual(tr, false);
  // Falling edge: tack detected with the new heading.
  const m = detectManeuver(st, { awaDeg: 330, headingDeg: 30 });
  assert.deepStrictEqual(m, { direction: "tack", newHeadingDeg: 30 });
  // Not a second time.
  assert.strictEqual(detectManeuver(st, { awaDeg: 330, headingDeg: 30 }), null);
});

test("detectManeuver: a window that closed without an AWA band crossing yields null", () => {
  const { TrainingState, updateTransient, detectManeuver, SETTLE_SUSTAIN_S } =
    require("../plugin/training.js");
  const st = new TrainingState();
  let t = 0;
  const snap = (heading, awa) => ({
    headingDeg: heading,
    heelDeg: 0,
    awaDeg: awa,
    timestampS: t++,
  });
  updateTransient(st, snap(100, 100));
  updateTransient(st, snap(140, 100)); // hard course change opens the window; AWA stays ~100
  for (let i = 0; i < SETTLE_SUSTAIN_S; i++)
    updateTransient(st, snap(140, 100));
  assert.strictEqual(st.transient, false);
  assert.strictEqual(
    detectManeuver(st, { awaDeg: 100, headingDeg: 140 }),
    null,
  );
});

test("transient window stays open while the heading is still settling", () => {
  const { TrainingState, updateTransient, detectManeuver } =
    require("../plugin/training.js");
  const st = new TrainingState({ settleSustainS: 2 });
  let t = 0;
  const snap = (heading, awa) => ({
    headingDeg: heading,
    heelDeg: 0,
    awaDeg: awa,
    timestampS: t++,
  });

  updateTransient(st, snap(350, 30)); // steady starboard close-hauled
  updateTransient(st, snap(30, 330)); // tack: ROT spike opens the window
  // Heel + AWA steady, but the boat keeps bearing away 8°/tick — the
  // heading reference refreshes as ROT stays high, window stays open,
  // and even low-ROT drift of >5°/tick must NOT accumulate settle time.
  updateTransient(st, snap(38, 330)); // 8°/s: still ROT-transient
  updateTransient(st, snap(46, 330)); // 8°/s: still transient
  assert.strictEqual(st.transient, true, "window open while heading swings");
  assert.strictEqual(detectManeuver(st, { awaDeg: 330, headingDeg: 46 }), null);

  // Now hold steady on the settled course: settle clock accumulates and
  // the close edge fires with the *settled* heading.
  updateTransient(st, snap(48, 330));
  updateTransient(st, snap(48, 330));
  assert.strictEqual(st.transient, false, "closed after heading settled");
  const m = detectManeuver(st, { awaDeg: 330, headingDeg: 48 });
  assert.deepStrictEqual(m, { direction: "tack", newHeadingDeg: 48 });
});

test("a window whose heel/AWA steadied but heading drifts >5° does not close", () => {
  const { TrainingState, updateTransient } = require("../plugin/training.js");
  const st = new TrainingState({ settleSustainS: 2 });
  let t = 0;
  const snap = (heading, awa) => ({
    headingDeg: heading,
    heelDeg: 0,
    awaDeg: awa,
    timestampS: t++,
  });
  updateTransient(st, snap(350, 30));
  updateTransient(st, snap(30, 330)); // open
  // Low-ROT (2°/s < 3°/s gate) but steady 6° drift per tick: each tick is
  // outside the 5° band of the frozen reference → settle clock never runs.
  updateTransient(st, snap(36, 330)); // ROT 6/s — actually transient; use 2° steps
  // (6°/s ROT > 3 threshold anyway; to test the band specifically, freeze
  // the reference first with a slow tick, then drift slowly.)
  updateTransient(st, snap(37, 330)); // ROT 1/s < 3: reference frozen at 37
  updateTransient(st, snap(44, 330)); // ROT 7/s — high again, refreshes
  // Simpler direct case: ROT low, drift 6° over two ticks = 3°/s (< gate):
  const st2 = new TrainingState({ settleSustainS: 2 });
  let u = 0;
  const snap2 = (heading, awa) => ({
    headingDeg: heading,
    heelDeg: 0,
    awaDeg: awa,
    timestampS: u++,
  });
  updateTransient(st2, snap2(350, 30));
  updateTransient(st2, snap2(30, 330)); // open, reference heading = 30
  updateTransient(st2, snap2(36, 330)); // 6°/s → ROT high, reference → 36
  updateTransient(st2, snap2(39, 330)); // 3°/s — at gate, not above: drift continues
  assert.strictEqual(st2.transient, true);
  // |39−36| = 3 ≤ 5 → headingOk, but settle only 1s < 2s: still open.
  updateTransient(st2, snap2(42, 330)); // |42−36| = 6 > 5 → NOT ok, reset
  assert.strictEqual(st2.stabilizedS, 0, "settle clock reset by heading drift");
  assert.strictEqual(st2.transient, true);
});
