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
  detectManeuver,
  GROSS_JUMP_NM,
  ROT_TRANSIENT_DEG_S,
  SETTLE_SUSTAIN_S,
  TRANSIENT_MAX_S,
  STABILIZE_HEEL_DEG,
  STABILIZE_AWA_DEG,
  STABILIZE_HEADING_DEG,
  stabilizeTolerances,
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
    // Resolved current (SPEC §6.2 tier 2 derived) — training requires
    // a non-zero-vector current; the tier-5 gate has its own test.
    current: { setTrue: 0, drift: 0, tier: 2 },
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

test("detectFouling: a live SOG≈0 outranks wind — breeze on a moored mast is not fouling", () => {
  // The at-anchor false positive (work doc #17's class): STW reads 0
  // because the boat is tied up, GPS agrees it isn't going anywhere,
  // but the masthead breeze blows. Wind only corroborates fouling when
  // GPS is silent; a live SOG reading is authoritative either way.
  assert.strictEqual(
    detectFouling({ stwKn: 0, sogKn: 0.2, awsKn: 15, heelDeg: 5 }),
    false,
  );
});

test("detectFouling: quiet wind with no SOG is not fouling either", () => {
  assert.strictEqual(
    detectFouling({ stwKn: 0.1, sogKn: null, awsKn: 2, heelDeg: 0 }),
    false,
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

test("tick suspends training while the current is unresolved (tier 5 / missing)", () => {
  const st = new TrainingState();
  tick(st, snap({ timestampS: 0, gps: { latitude: 60, longitude: 24 } }));
  // Tier 5 (zero vector — current unknown): eligible is false even
  // though every other gate would pass, and no observation is produced
  // (the unmodeled current must not be baked into the bins —
  // Huahine→Aitutaki backtest, 72 vs 65 nm cold).
  for (const current of [{ setTrue: 0, drift: 0, tier: 5 }, undefined]) {
    const r = tick(
      st,
      snap({
        timestampS: 3600,
        stwKn: 1,
        gps: { latitude: 60 + 1 / 60, longitude: 24 },
        current,
      }),
    );
    assert.strictEqual(r.eligible, false, `tier ${current?.tier}`);
    assert.strictEqual(r.observation, null, `tier ${current?.tier}`);
  }
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

/**
 * Drives `seconds` of sustained rotation at `rateDegS` (deg/s) starting
 * from heading `from`, one snapshot per second. Returns the next
 * timestamp. A real tack/gybe sustains its turn across the ROT window;
 * wave yaw does not — the tests below mirror that distinction.
 *
 * @param {import("../plugin/training.js").TrainingState} st
 * @param {object} o
 * @returns {number} next timestamp (s)
 */
function sustainedTurn(st, o) {
  // Seed the starting heading so the ROT window fills from t = o.t.
  updateTransient(st, {
    headingDeg: o.from,
    heelDeg: o.heel ?? 0,
    awaDeg: o.awa ?? 45,
    timestampS: o.t,
    seaState: o.seaState ?? null,
  });
  const t = o.t;
  for (let i = 1; i <= o.seconds; i++) {
    const heading = o.from + o.rateDegS * i;
    updateTransient(st, {
      headingDeg: heading,
      heelDeg: o.heel ?? 0,
      awaDeg: o.awa ?? 45,
      timestampS: t + i,
      seaState: o.seaState ?? null,
    });
  }
  return t + o.seconds;
}

test("updateTransient opens a window on a sustained high rate-of-turn", () => {
  const st = new TrainingState();
  sustainedTurn(st, { t: 0, from: 0, rateDegS: 10, seconds: 7, awa: 80 });
  assert.strictEqual(st.transient, true);
  // The window opens only once the ROT window is full (6 s of history).
  assert.strictEqual(st.transientOpenAtS, 6);
});

test("a single tick of wave yaw does not open a window (sea trial 2026-08-31)", () => {
  const st = new TrainingState();
  // Steady for 7 s to fill the ROT window…
  sustainedTurn(st, { t: 0, from: 60, rateDegS: 0, seconds: 7, awa: 80 });
  assert.strictEqual(st.transient, false);
  // …then one second of 8° yaw (surfing a wave) and steadying again.
  updateTransient(st, {
    headingDeg: 68,
    heelDeg: 4,
    awaDeg: 85,
    timestampS: 8,
  });
  updateTransient(st, {
    headingDeg: 68,
    heelDeg: 4,
    awaDeg: 85,
    timestampS: 9,
  });
  assert.strictEqual(st.transient, false, "single-tick yaw must not open");
});

test("updateTransient closes only after sustained re-stabilization", () => {
  const st = new TrainingState();
  sustainedTurn(st, {
    t: 0,
    from: 0,
    rateDegS: 10,
    seconds: 7,
    heel: 5,
    awa: 80,
  });
  assert.strictEqual(st.transient, true);
  const settledHeading = 70;
  // The ROT window keeps containing turn samples for ~ROT_WINDOW_S after
  // the turn stops (re-anchoring + resetting the clock), so settle loops
  // run past SETTLE_SUSTAIN_S by that decay margin.
  for (let t = 8; t < 8 + SETTLE_SUSTAIN_S + 8; t++) {
    updateTransient(st, {
      headingDeg: settledHeading,
      heelDeg: 5,
      awaDeg: 80,
      timestampS: t,
    });
  }
  assert.strictEqual(st.transient, false);
});

test("updateTransient resets the settle clock on a renewed window rate-of-turn", () => {
  const st = new TrainingState();
  let t = sustainedTurn(st, {
    t: 0,
    from: 0,
    rateDegS: 10,
    seconds: 7,
    heel: 5,
    awa: 80,
  });
  // Almost settle…
  for (let i = 1; i < SETTLE_SUSTAIN_S; i++) {
    updateTransient(st, {
      headingDeg: 70,
      heelDeg: 5,
      awaDeg: 80,
      timestampS: ++t,
    });
  }
  // Another sustained turn mid-settle resets the clock; window stays open.
  t = sustainedTurn(st, {
    t,
    from: 70,
    rateDegS: 10,
    seconds: 7,
    heel: 0,
    awa: 100,
  });
  assert.strictEqual(st.transient, true);
  assert.strictEqual(st.stabilizedS, 0);
});

test("stabilizeTolerances scale with sea state, flat-water base preserved", () => {
  const base = stabilizeTolerances(null);
  assert.strictEqual(base.heelDeg, STABILIZE_HEEL_DEG);
  assert.strictEqual(base.awaDeg, STABILIZE_AWA_DEG);
  assert.strictEqual(base.headingDeg, STABILIZE_HEADING_DEG);
  const ss4 = stabilizeTolerances(4);
  assert.strictEqual(ss4.heelDeg, STABILIZE_HEEL_DEG + 6);
  assert.strictEqual(ss4.awaDeg, STABILIZE_AWA_DEG + 8);
  assert.strictEqual(ss4.headingDeg, STABILIZE_HEADING_DEG + 6);
});

test("ss3-4 swell motion re-stabilizes within scaled tolerances (sea trial latch)", () => {
  const st = new TrainingState({ settleSustainS: 10 });
  let t = sustainedTurn(st, {
    t: 0,
    from: 280,
    rateDegS: 8,
    seconds: 7,
    heel: 4,
    awa: -120,
  });
  assert.strictEqual(st.transient, true);
  // Let the ROT window decay past the turn (anchors stay at the turn-end
  // values: heel 4, heading 336 — the swell's center)…
  for (let i = 0; i < 8; i++) {
    updateTransient(st, {
      headingDeg: 336,
      heelDeg: 4,
      awaDeg: -120,
      timestampS: ++t,
      seaState: 4,
    });
  }
  assert.strictEqual(st.transient, true, "settle window not yet sustained");
  // …then broad-reach seaway: heel ±5° and heading ±8° around the settled
  // values at swell period — the ss4 tolerances (heel 8°, heading 11°)
  // must absorb it and the window must close.
  for (let i = 1; i <= 20; i++) {
    updateTransient(st, {
      headingDeg: 336 + (i % 2 === 0 ? 8 : -8),
      heelDeg: 4 + (i % 2 === 0 ? 5 : -5),
      awaDeg: -120,
      timestampS: ++t,
      seaState: 4,
    });
  }
  assert.strictEqual(st.transient, false, "ss4 seaway must re-stabilize");
});

test("the same swell motion in flat-water tolerances keeps the window open", () => {
  const st = new TrainingState({ settleSustainS: 10 });
  let t = sustainedTurn(st, {
    t: 0,
    from: 280,
    rateDegS: 8,
    seconds: 7,
    heel: 4,
    awa: -120,
  });
  for (let i = 0; i < 8; i++) {
    updateTransient(st, {
      headingDeg: 336,
      heelDeg: 4,
      awaDeg: -120,
      timestampS: ++t,
    });
  }
  for (let i = 1; i <= 20; i++) {
    updateTransient(st, {
      headingDeg: 336 + (i % 2 === 0 ? 8 : -8),
      heelDeg: 4 + (i % 2 === 0 ? 5 : -5),
      awaDeg: -120,
      timestampS: ++t,
    });
  }
  assert.strictEqual(
    st.transient,
    true,
    "base tolerances must not absorb ss4 swell",
  );
});

test("TRANSIENT_MAX_S force-closes a latched window without a maneuver", () => {
  const st = new TrainingState();
  let t = sustainedTurn(st, {
    t: 0,
    from: 280,
    rateDegS: 8,
    seconds: 7,
    heel: 4,
    awa: -120,
  });
  assert.strictEqual(st.transient, true);
  // Prime detectManeuver's per-tick edge tracking while open.
  assert.strictEqual(
    detectManeuver(st, { awaDeg: -120, headingDeg: 336 }),
    null,
  );
  // Sailing on in seaway, never within flat-water tolerance…
  for (let i = 1; i <= TRANSIENT_MAX_S; i++) {
    updateTransient(st, {
      headingDeg: 336 + (i % 2 === 0 ? 8 : -8),
      heelDeg: 4 + (i % 2 === 0 ? 5 : -5),
      awaDeg: -120,
      timestampS: ++t,
    });
  }
  assert.strictEqual(
    st.transient,
    false,
    "latch breaker must close the window",
  );
  assert.strictEqual(st.suppressManeuver, true);
  assert.strictEqual(
    detectManeuver(st, { awaDeg: -120, headingDeg: 336 }),
    null,
    "forced close must not classify a maneuver",
  );
});

test("tick is not eligible during an open transient window", () => {
  const st = new TrainingState();
  // Prime ground truth with two benign fixes.
  tick(st, snap({ timestampS: 0, gps: { latitude: 60, longitude: 24 } }));
  tick(st, snap({ timestampS: 1, gps: { latitude: 60, longitude: 24.0001 } }));
  // A sustained turn opens the window.
  let r = null;
  for (let t = 2; t <= 9; t++) {
    r = tick(
      st,
      snap({
        timestampS: t,
        headingTrueDeg: 10 * (t - 1),
        gps: { latitude: 60, longitude: 24.0002 },
      }),
    );
  }
  assert.strictEqual(r.transient, true);
  assert.strictEqual(r.eligible, false);
});

test("tick resumes eligibility after the transient window closes", () => {
  const st = new TrainingState();
  tick(st, snap({ timestampS: 0, gps: { latitude: 60, longitude: 24 } }));
  tick(st, snap({ timestampS: 1, gps: { latitude: 60, longitude: 24.0001 } }));
  let t = 1;
  for (let i = 1; i <= 7; i++) {
    t += 1;
    tick(
      st,
      snap({
        timestampS: t,
        headingTrueDeg: 10 * i,
        awaDeg: 45,
        heelDeg: 10,
        gps: { latitude: 60, longitude: 24.0002 },
      }),
    );
  }
  // Settle: hold the post-turn heading but heel/AWA matching the open-window
  // values, past SETTLE_SUSTAIN_S.
  for (let i = 0; i < SETTLE_SUSTAIN_S + 8; i++) {
    t += 1;
    tick(
      st,
      snap({
        timestampS: t,
        headingTrueDeg: 70,
        awaDeg: 45,
        heelDeg: 10,
        gps: { latitude: 60, longitude: 24.0002 + i * 0.00001 },
      }),
    );
  }
  // Next tick after close, with good ground truth, should be eligible.
  const r = tick(
    st,
    snap({
      timestampS: t + 2,
      headingTrueDeg: 70,
      awaDeg: 45,
      heelDeg: 10,
      stwKn: 5,
      gps: { latitude: 60.01, longitude: 24.0002 },
    }),
  );
  assert.strictEqual(r.transient, false);
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
  const st = new TrainingState();
  let t = 0;
  const at = (heading, awa, ts) =>
    updateTransient(st, {
      headingDeg: heading,
      heelDeg: 0,
      awaDeg: awa,
      timestampS: ts,
    });
  // Steady starboard close-hauled…
  for (let i = 0; i < 7; i++) at(350, 30, t++);
  // …then a sustained tack onto port: opens the window once ROT is
  // measurable across the full window; the pre-maneuver AWA (30) is
  // retained for classification.
  for (let i = 1; i <= 7; i++) at(350 + 6 * i, 330, t++);
  assert.strictEqual(st.transient, true);
  // While the window is open: no maneuver detection.
  assert.strictEqual(
    detectManeuver(st, { awaDeg: 330, headingDeg: 392 % 360 }),
    null,
  );
  // Re-stabilize on port (plus ROT-window decay margin) closes it.
  const settled = 392 % 360;
  for (let i = 0; i < SETTLE_SUSTAIN_S + 8; i++) at(settled, 330, t++);
  assert.strictEqual(st.transient, false);
  // Falling edge: tack detected with the new heading.
  const m = detectManeuver(st, { awaDeg: 330, headingDeg: settled });
  assert.deepStrictEqual(m, { direction: "tack", newHeadingDeg: settled });
  // Not a second time.
  assert.strictEqual(
    detectManeuver(st, { awaDeg: 330, headingDeg: settled }),
    null,
  );
});

test("detectManeuver: a window that closed without an AWA band crossing yields null", () => {
  const st = new TrainingState();
  let t = 0;
  const at = (heading, awa, ts) =>
    updateTransient(st, {
      headingDeg: heading,
      heelDeg: 0,
      awaDeg: awa,
      timestampS: ts,
    });
  for (let i = 0; i < 7; i++) at(100, 100, t++);
  for (let i = 1; i <= 7; i++) at(100 + 6 * i, 100, t++); // hard sustained change, AWA stays ~100
  for (let i = 0; i < SETTLE_SUSTAIN_S + 8; i++) at(142, 100, t++);
  assert.strictEqual(st.transient, false);
  assert.strictEqual(
    detectManeuver(st, { awaDeg: 100, headingDeg: 142 }),
    null,
  );
});

test("transient window stays open while the heading is still settling", () => {
  const st = new TrainingState({ settleSustainS: 2 });
  let t = 0;
  const at = (heading, awa, ts) =>
    updateTransient(st, {
      headingDeg: heading,
      heelDeg: 0,
      awaDeg: awa,
      timestampS: ts,
    });
  for (let i = 0; i < 7; i++) at(350, 30, t++); // steady starboard close-hauled
  for (let i = 1; i <= 7; i++) at(350 + 6 * i, 330, t++); // sustained tack opens
  // Heel + AWA steady, but the boat keeps bearing away — sustained ROT
  // above the threshold keeps refreshing the reference and resetting the
  // settle clock.
  for (let i = 1; i <= 8; i++) at(392 + 5 * i, 330, t++);
  assert.strictEqual(
    st.transient,
    true,
    "window open while heading still swings",
  );
  // Prime detectManeuver's per-tick edge tracking while open (it is
  // called every tick in production).
  assert.strictEqual(
    detectManeuver(st, { awaDeg: 330, headingDeg: 432 }),
    null,
  );
  // Now hold steady on the settled course: settle clock accumulates and
  // the close edge fires with the *settled* heading.
  const settled = 432;
  for (let i = 0; i < 4; i++) at(settled, 330, t++);
  assert.strictEqual(st.transient, false, "closed after heading settled");
  const m = detectManeuver(st, { awaDeg: 330, headingDeg: settled });
  assert.deepStrictEqual(m, { direction: "tack", newHeadingDeg: settled });
});

test("a window whose heel/AWA steadied but heading drifts past tolerance does not close", () => {
  const st = new TrainingState({ settleSustainS: 2 });
  let t = 0;
  const at = (heading, awa, ts) =>
    updateTransient(st, {
      headingDeg: heading,
      heelDeg: 0,
      awaDeg: awa,
      timestampS: ts,
    });
  for (let i = 0; i < 7; i++) at(350, 30, t++);
  for (let i = 1; i <= 7; i++) at(350 + 6 * i, 330, t++); // open, heading 392
  // ROT falls below the gate; the reference freezes — then a slow drift
  // beyond the heading tolerance must reset the settle clock.
  at(394, 330, t++);
  at(396, 330, t++);
  at(403, 330, t++); // |403−394| > 5° from the frozen reference
  assert.strictEqual(st.stabilizedS, 0, "settle clock reset by heading drift");
  assert.strictEqual(st.transient, true);
});
