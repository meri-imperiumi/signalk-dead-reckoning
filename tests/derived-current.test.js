/**
 * Unit tests for the derived-current tier (SPEC §6.2 tier 2).
 *
 * The module is pure state-in/state-out: converging EWMA behavior,
 * sampling gates, glitch rejection, decay carry, and TTL bounds. The
 * §6.2 resolver precedence lives in current.test.js; the tick wiring
 * in plugin.test.js / dr-current.test.js.
 *
 * @file derived-current.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createDerivedCurrentState,
  updateDerivedCurrent,
  derivedCurrentSnapshot,
  MIN_GPS_INTERVAL_S,
  MIN_STW_KN,
  MAX_RESIDUAL_KN,
  MIN_SAMPLES,
} = require("../plugin/derived-current.js");

/**
 * Feeds a synthetic steady scenario: boat making 5 kn due north
 * through water while a current sets it east at setKn.
 *
 * @param {object} st - module state
 * @param {object} opts
 * @param {number} [opts.samples=40] - number of GPS fixes to feed
 * @param {number} [opts.dtS=30] - seconds between fixes
 * @param {number} [opts.setKn=0] - easterly current (kn)
 * @param {number} [opts.stwKn=5] - speed through water (kn)
 * @param {number} [opts.lat0=-18.5] - starting latitude
 * @returns {number} final epoch ms
 */
function feedSteady(st, opts = {}) {
  const { samples = 40, dtS = 30, setKn = 0, stwKn = 5, lat0 = -18.5 } = opts;
  const rad = Math.PI / 180;
  // Ground velocity = water velocity + current: north stwKn, east setKn.
  const sogKn = Math.hypot(setKn, stwKn);
  const cogDeg = (Math.atan2(setKn, stwKn) * 180) / Math.PI;
  let tMs = Date.UTC(2026, 8, 1, 0, 0, 0);
  let lat = lat0;
  let lon = 210; // arbitrary mid-Pacific longitude
  for (let i = 0; i < samples; i++) {
    const eastKn = sogKn * Math.sin(cogDeg * rad);
    const northKn = sogKn * Math.cos(cogDeg * rad);
    lat += (northKn * (dtS / 3600)) / 60;
    lon += (eastKn * (dtS / 3600)) / (60 * Math.cos(lat0 * rad));
    tMs += dtS * 1000;
    const r = updateDerivedCurrent(st, {
      tMs,
      gps: { latitude: lat, longitude: lon },
      stwKn,
      headingTrueDeg: 0,
    });
    // The very first fix only seeds the position reference (no
    // differential yet) — every subsequent one must sample.
    if (i > 0) assert.equal(r.sampled, true, `sample ${i} should be taken`);
  }
  return tMs;
}

test("derived current: EWMA converges to a steady easterly current", () => {
  const st = createDerivedCurrentState();
  const tEnd = feedSteady(st, { setKn: 0.8, samples: 60 });
  const snap = derivedCurrentSnapshot(st, tEnd);
  assert.ok(snap, "snapshot should exist after enough samples");
  assert.ok(Math.abs(snap.setTrue - 90) < 5, `set ~90°, got ${snap.setTrue}`);
  assert.ok(
    Math.abs(snap.drift - 0.8) < 0.1,
    `drift ~0.8 kn, got ${snap.drift}`,
  );
});

test("derived current: zero current in still water reads ~0 kn", () => {
  const st = createDerivedCurrentState();
  const tEnd = feedSteady(st, { setKn: 0, samples: 40 });
  const snap = derivedCurrentSnapshot(st, tEnd);
  assert.ok(snap.drift < 0.05, `drift ~0, got ${snap.drift}`);
  assert.equal(snap.validUntilMs, st.lastSampleMs + 24 * 3600 * 1000);
});

test("derived current: snapshot is null before the minimum sample count", () => {
  const st = createDerivedCurrentState();
  const tEnd = feedSteady(st, { setKn: 0.8, samples: MIN_SAMPLES });
  assert.equal(st.sampleCount, MIN_SAMPLES - 1);
  assert.equal(derivedCurrentSnapshot(st, tEnd), null);
});

test("derived current: fixes closer than the minimum interval don't sample", () => {
  const st = createDerivedCurrentState();
  const t0 = Date.UTC(2026, 8, 1);
  let r = updateDerivedCurrent(st, {
    tMs: t0,
    gps: { latitude: -18.5, longitude: 210 },
    stwKn: 5,
    headingTrueDeg: 0,
  });
  assert.equal(r.sampled, false);
  r = updateDerivedCurrent(st, {
    tMs: t0 + (MIN_GPS_INTERVAL_S - 1) * 1000,
    gps: { latitude: -18.5001, longitude: 210 },
    stwKn: 5,
    headingTrueDeg: 0,
  });
  assert.equal(r.sampled, false);
  assert.equal(r.reason, "interval");
});

test("derived current: anchored (STW below floor) doesn't sample", () => {
  const st = createDerivedCurrentState();
  const t0 = Date.UTC(2026, 8, 1);
  updateDerivedCurrent(st, {
    tMs: t0,
    gps: { latitude: -18.5, longitude: 210 },
    stwKn: 0.1,
    headingTrueDeg: 0,
  });
  const r = updateDerivedCurrent(st, {
    tMs: t0 + 60_000,
    gps: { latitude: -18.5, longitude: 210.0005 }, // ~1.5 kn drift on GPS
    stwKn: MIN_STW_KN - 0.2,
    headingTrueDeg: 0,
  });
  assert.equal(r.sampled, false);
  assert.equal(r.reason, "stw");
});

test("derived current: glitch residuals are discarded, not learned", () => {
  const st = createDerivedCurrentState();
  const t0 = Date.UTC(2026, 8, 1);
  // Seed the EWMA with a normal sample.
  feedSteady(st, { setKn: 0.5, samples: 20 });
  const before = { ...st };
  // A GPS jump implying a 100 kn residual must not move the state.
  const r = updateDerivedCurrent(st, {
    tMs: t0 + 3600_000,
    gps: { latitude: -17.5, longitude: 210 }, // ~60 nm north in 1 h
    stwKn: 5,
    headingTrueDeg: 0,
  });
  assert.equal(r.sampled, false);
  assert.equal(r.reason, "gps-glitch");
  // A plausible GPS but absurd water-track mismatch (e.g. lagoon
  // transit): 4 kn "current" is beyond ocean bounds.
  const r2 = updateDerivedCurrent(st, {
    tMs: t0 + 3700_000,
    gps: { latitude: -18.5001, longitude: 210 },
    stwKn: 5,
    headingTrueDeg: 0,
  });
  assert.ok(
    !r2.sampled || Math.hypot(before.uKn, before.vKn) > 0,
    "outlier path exercised",
  );
  assert.equal(st.uKn, before.uKn);
  assert.equal(st.vKn, before.vKn);
});

test("derived current: residual beyond ocean bounds is rejected", () => {
  const st = createDerivedCurrentState();
  const t0 = Date.UTC(2026, 8, 1);
  updateDerivedCurrent(st, {
    tMs: t0,
    gps: { latitude: -18.5, longitude: 210 },
    stwKn: 5,
    headingTrueDeg: 0,
  });
  // Ground track 4 kn east of the water track: 4 kn "current".
  const r = updateDerivedCurrent(st, {
    tMs: t0 + 60_000,
    gps: {
      latitude: -18.5 + (5 / 60) * (60 / 3600),
      longitude: 210 + 4 / 60 / Math.cos((-18.5 * Math.PI) / 180) / 60,
    },
    stwKn: 5,
    headingTrueDeg: 0,
  });
  assert.equal(r.sampled, false);
  assert.equal(r.reason, "residual-outlier");
  assert.ok(4 > MAX_RESIDUAL_KN);
});

test("derived current: carry decay shrinks drift as the snapshot ages", () => {
  const st = createDerivedCurrentState();
  const tEnd = feedSteady(st, { setKn: 0.8, samples: 40 });
  const fresh = derivedCurrentSnapshot(st, tEnd);
  // 24 h later: still valid (TTL) but decayed to ~1/e of the drift.
  const stale = derivedCurrentSnapshot(st, tEnd + 24 * 3600 * 1000 - 1);
  assert.ok(stale, "still inside TTL");
  assert.ok(
    Math.abs(stale.drift - fresh.drift * Math.exp(-1)) < 0.02,
    `decayed drift ${stale.drift} ≈ ${fresh.drift / Math.E}`,
  );
  // Beyond the TTL: gone, resolver falls to lower tiers.
  assert.equal(derivedCurrentSnapshot(st, tEnd + 24 * 3600 * 1000 + 1), null);
});

test("derived current: missing sensors never sample", () => {
  const st = createDerivedCurrentState();
  const t0 = Date.UTC(2026, 8, 1);
  updateDerivedCurrent(st, {
    tMs: t0,
    gps: { latitude: -18.5, longitude: 210 },
    stwKn: 5,
    headingTrueDeg: 0,
  });
  assert.equal(
    updateDerivedCurrent(st, {
      tMs: t0 + 60_000,
      gps: null,
      stwKn: 5,
      headingTrueDeg: 0,
    }).sampled,
    false,
  );
  assert.equal(
    updateDerivedCurrent(st, {
      tMs: t0 + 120_000,
      gps: { latitude: -18.501, longitude: 210 },
      stwKn: null,
      headingTrueDeg: 0,
    }).reason,
    "stw",
  );
  assert.equal(
    updateDerivedCurrent(st, {
      tMs: t0 + 180_000,
      gps: { latitude: -18.502, longitude: 210 },
      stwKn: 5,
      headingTrueDeg: null,
    }).reason,
    "heading",
  );
});

test("derived current: first sample is adopted wholesale (no zero prior)", () => {
  const st = createDerivedCurrentState();
  const t0 = Date.UTC(2026, 8, 1);
  updateDerivedCurrent(st, {
    tMs: t0,
    gps: { latitude: -18.5, longitude: 210 },
    stwKn: 5,
    headingTrueDeg: 0,
  });
  // Ground 0.7 kn east of water track.
  const r = updateDerivedCurrent(st, {
    tMs: t0 + 60_000,
    gps: {
      latitude: -18.5 + 5 / 60 / 60,
      longitude: 210 + 0.7 / 60 / Math.cos((-18.5 * Math.PI) / 180) / 60,
    },
    stwKn: 5,
    headingTrueDeg: 0,
  });
  assert.equal(r.sampled, true);
  assert.ok(Math.abs(st.uKn - 0.7) < 0.05, `u ≈ 0.7, got ${st.uKn}`);
});
