/**
 * Tests for celestial sight reduction (SPEC §13).
 *
 * Hc/Zn are cross-validated against astronomy-engine's Horizon (an
 * independent horizontal-coordinate path through the same library) for
 * the Sun; the star path is validated against paper-almanac anchors.
 * Ephemeris snapshots and almanac anchors live in tests/ephemeris.test.js.
 * @file celestial.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const Astronomy = require("astronomy-engine");
const celestial = require("../plugin/celestial.js");
const almanac = require("../plugin/star-almanac.js");

/** Sidereal time (GAST) in degrees, for deriving SHA of date from GHA. */
function gastDeg(ms) {
  return Astronomy.SiderealTime(new Date(ms)) * 15;
}

test("computeHcZn matches astronomy-engine Horizon (independent cross-check)", () => {
  const cases = [
    { t: "2026-06-21T10:00:00Z", obs: { latitude: 40, longitude: -70 } },
    { t: "2026-12-21T22:00:00Z", obs: { latitude: 60, longitude: 5 } },
    { t: "2026-09-23T12:00:00Z", obs: { latitude: -35, longitude: 18 } },
    { t: "2026-08-15T22:30:00Z", obs: { latitude: -19, longitude: -165 } },
  ];
  for (const { t, obs } of cases) {
    const ms = new Date(t).getTime();
    const gp = celestial.sunGeographicPosition(ms);
    const { hc_deg, zn_deg } = celestial.computeHcZn(obs, gp);
    // Horizon path: the library's own horizontal-coordinate transform
    // (refraction off — Hc is geometric).
    const eq = Astronomy.Equator(
      Astronomy.Body.Sun,
      new Date(ms),
      new Astronomy.Observer(obs.latitude, obs.longitude, 0),
      true,
      false,
    );
    const h = Astronomy.Horizon(
      new Date(ms),
      new Astronomy.Observer(obs.latitude, obs.longitude, 0),
      eq.ra,
      eq.dec,
      null,
    );
    const aeAlt = h.altitude;
    // astronomy-engine azimuth is measured clockwise from north.
    assert.ok(
      Math.abs(hc_deg - aeAlt) < 0.01,
      `${t}: Hc ${hc_deg.toFixed(4)} vs astro-engine ${aeAlt.toFixed(4)}`,
    );
    if (aeAlt > 5) {
      let dAz = Math.abs(zn_deg - h.azimuth);
      dAz = Math.min(dAz, 360 - dAz);
      assert.ok(
        dAz < 0.05,
        `${t}: Zn ${zn_deg.toFixed(3)} vs astro-engine ${h.azimuth.toFixed(3)}`,
      );
    }
  }
});

test("sunGeographicPosition: Dec ≈ 23.44° at the June solstice", () => {
  const t = new Date("2026-06-21T10:00:00Z").getTime();
  const gp = celestial.sunGeographicPosition(t);
  assert.ok(Math.abs(gp.declination_deg - 23.44) < 0.2);
  assert.ok(gp.gha_deg >= 0 && gp.gha_deg < 360);
});

test("sunGeographicPosition: Dec ≈ -23.44° at the December solstice", () => {
  const t = new Date("2026-12-21T22:00:00Z").getTime();
  const gp = celestial.sunGeographicPosition(t);
  assert.ok(Math.abs(gp.declination_deg - -23.44) < 0.2);
});

test("Polaris: altitude ≈ observer latitude at 60N, azimuth ≈ due north", () => {
  const t = new Date("2026-06-21T10:00:00Z").getTime();
  const star = almanac.lookup("Polaris");
  assert.ok(star);
  const gp = celestial.starGeographicPosition(t, star);
  const { hc_deg, zn_deg } = celestial.computeHcZn(
    { latitude: 60, longitude: 5 },
    gp,
  );
  assert.ok(
    Math.abs(hc_deg - 60) < 1.5,
    `Polaris Hc ${hc_deg.toFixed(2)} at 60N`,
  );
  const dAz = Math.min(Math.abs(zn_deg - 0), Math.abs(zn_deg - 360));
  assert.ok(dAz < 3, `Polaris Zn ${zn_deg.toFixed(1)} (expected ~0)`);
});

test("refractionArcmin: Bennett's formula decreases with altitude", () => {
  const r10 = celestial.refractionArcmin(10);
  const r45 = celestial.refractionArcmin(45);
  const r90 = celestial.refractionArcmin(90);
  assert.ok(r10 > r45);
  assert.ok(r45 > r90);
  // At 45°, refraction ≈ 1.0' (Bennett gives ~1.01').
  assert.ok(Math.abs(r45 - 1.0) < 0.05, `r45=${r45}`);
  assert.ok(r90 >= 0, `r90=${r90} (clamped, not negative)`);
});

test("refractionArcmin: 0 for non-positive altitude", () => {
  assert.strictEqual(celestial.refractionArcmin(0), 0);
  assert.strictEqual(celestial.refractionArcmin(-5), 0);
});

test("dipArcmin: scales with sqrt(eye height)", () => {
  // 9 m → 1.76*3 = 5.28'
  assert.ok(Math.abs(celestial.dipArcmin(9) - 5.28) < 0.01);
  assert.strictEqual(celestial.dipArcmin(0), 0);
});

test("correctAltitude: applies index correction, dip, and refraction", () => {
  // Hs 45°, IC +0.1°, eye 9m. Ha = 45.1. Dip = 5.28' = 0.088°. alt for refr = 45.012.
  // Refr at ~45° ≈ 1.01' = 0.0168°. Ho ≈ 45.1 - 0.088 - 0.0168 = 44.9952.
  const r = celestial.correctAltitude({
    hs_deg: 45,
    index_correction_deg: 0.1,
    eye_height_m: 9,
  });
  assert.ok(Math.abs(r.ho_deg - 44.995) < 0.003, `Ho=${r.ho_deg}`);
});

test("reduceSight: produces a LOP with near-zero intercept for a matching sight", () => {
  // A high Sun sight at noon-ish near the observer. Build a case where
  // Ho ≈ Hc so the intercept is small; direction is not asserted (a tiny
  // numerical sign is not meaningful).
  const t = new Date("2026-06-21T17:00:00Z").getTime(); // local noon ~ at 75W
  const dr = { latitude: 40, longitude: -75 };
  const gp = celestial.sunGeographicPosition(t);
  const { hc_deg } = celestial.computeHcZn(dr, gp);
  // Back out Hs for a lower-limb sight: Ho = Hc → Hs = Hc + dip + refr − SD − IC.
  const sd = 0.2666;
  const dip = celestial.dipArcmin(3) / 60;
  const refr = celestial.refractionArcmin(hc_deg) / 60;
  const hs = hc_deg + dip + refr - sd - 0; // IC 0
  const r = celestial.reduceSight({
    body: "Sun",
    hs_deg: hs,
    eye_height_m: 3,
    epoch_ms: t,
    dr_position: dr,
    limb: "lower",
    time_sync_staleness_s: 240,
  });
  assert.ok(Math.abs(r.intercept_nm) < 0.5, `intercept ${r.intercept_nm}`);
  assert.strictEqual(r.body, "Sun");
  assert.strictEqual(r.assumed_lat, 40);
  assert.strictEqual(r.assumed_lon, -75);
  assert.strictEqual(r.time_sync_staleness_s, 240);
});

test("reduceSight: a sight lower than predicted yields 'away' (negative intercept)", () => {
  // Hs lower than Hc → Ho < Hc → the observer is farther from the body
  // than the DR predicts → negative intercept → 'away'.
  const t = new Date("2026-06-21T17:00:00Z").getTime();
  const dr = { latitude: 40, longitude: -75 };
  const gp = celestial.sunGeographicPosition(t);
  const { hc_deg } = celestial.computeHcZn(dr, gp);
  const r = celestial.reduceSight({
    body: "Sun",
    hs_deg: hc_deg - 5, // 5° lower than computed
    eye_height_m: 3,
    epoch_ms: t,
    dr_position: dr,
    limb: "lower",
  });
  assert.ok(r.intercept_nm < 0, `expected negative, got ${r.intercept_nm}`);
  assert.strictEqual(r.intercept_direction, "away");
  // −300 nm from the 5° underestimate, plus ~+16 nm from the lower-limb
  // semi-diameter (SD adds to Ho), so the intercept is ~−284. Allow ±20.
  assert.ok(Math.abs(r.intercept_nm + 287) < 15, `intercept ${r.intercept_nm}`);
});

test("reduceSight: uses an explicit assumed_position when supplied", () => {
  const t = new Date("2026-06-21T17:00:00Z").getTime();
  const ap = { latitude: 41, longitude: -74 };
  const r = celestial.reduceSight({
    body: "Sun",
    hs_deg: 70,
    epoch_ms: t,
    assumed_position: ap,
    dr_position: { latitude: 40, longitude: -75 },
  });
  assert.strictEqual(r.assumed_lat, 41);
  assert.strictEqual(r.assumed_lon, -74);
});

test("reduceSight: refuses sights below the 5° refraction cutoff", () => {
  // Pick a time/place where the computed Sun altitude is well below 5°.
  // 2026-06-21T08:30:00Z at 40N/65W is a near-rise, low-sun case.
  const t = new Date("2026-06-21T08:30:00Z").getTime();
  const dr = { latitude: 40, longitude: -65 };
  const gp = celestial.sunGeographicPosition(t);
  const { hc_deg } = celestial.computeHcZn(dr, gp);
  assert.ok(
    hc_deg < 5,
    `test setup needs a low-sun case; Hc was ${hc_deg.toFixed(2)}`,
  );
  assert.throws(
    () =>
      celestial.reduceSight({
        body: "Sun",
        hs_deg: hc_deg + 1,
        epoch_ms: t,
        dr_position: dr,
      }),
    /refraction cutoff/,
  );
});

test("reduceSight: star via almanac", () => {
  const t = new Date("2026-06-21T22:00:00Z").getTime();
  const r = celestial.reduceSight({
    body: "Vega",
    hs_deg: 45,
    eye_height_m: 2,
    epoch_ms: t,
    dr_position: { latitude: 60, longitude: 5 },
    almanac,
  });
  assert.strictEqual(r.body, "Vega");
  assert.ok(Number.isFinite(r.azimuth_true));
  assert.ok(Number.isFinite(r.intercept_nm));
});

test("reduceSight: unknown star without almanac throws", () => {
  const t = new Date("2026-06-21T22:00:00Z").getTime();
  assert.throws(
    () =>
      celestial.reduceSight({
        body: "MadeUp",
        hs_deg: 45,
        epoch_ms: t,
        dr_position: { latitude: 60, longitude: 5 },
      }),
    /unknown body/,
  );
});

test("reduceNoonSight: recovers observer latitude (Sun south of observer)", () => {
  // Observer at 40N, Sun on the meridian due south. Ho = 90 - (lat - dec).
  // Pick the June solstice (dec ≈ 23.44) and local noon at 75W.
  const t = new Date("2026-06-21T17:00:00Z").getTime(); // noon at ~75W
  const dr = { latitude: 40, longitude: -75 };
  const gp = celestial.sunGeographicPosition(t);
  const dec = gp.declination_deg;
  // Expected meridian altitude (Ho) at 40N with the Sun due south.
  const trueHo = 90 - Math.abs(40 - dec);
  // Back out Hs for a lower-limb sight: Hs = Ho + dip + refr - SD.
  const sd = 0.2666;
  const dip = celestial.dipArcmin(3) / 60;
  const refr = celestial.refractionArcmin(trueHo) / 60;
  const hs = trueHo + dip + refr - sd;
  const r = celestial.reduceNoonSight({
    body: "Sun",
    hs_deg: hs,
    eye_height_m: 3,
    epoch_ms: t,
    dr_position: dr,
    limb: "lower",
  });
  assert.ok(Math.abs(r.assumed_lat - 40) < 0.5, `lat ${r.assumed_lat}`);
  assert.strictEqual(r.assumed_lon, -75);
  assert.strictEqual(r.azimuth_true, 180); // Sun due south
  assert.strictEqual(r.intercept_nm, 0);
  assert.strictEqual(r.lha_deg, 0);
});

test("reduceNoonSight: Sun north of observer (southern hemisphere)", () => {
  // Observer at 40S; at the June solstice the Sun is north of them.
  const t = new Date("2026-06-21T17:00:00Z").getTime();
  const dr = { latitude: -40, longitude: -75 };
  const gp = celestial.sunGeographicPosition(t);
  const dec = gp.declination_deg;
  const trueHo = 90 - Math.abs(-40 - dec); // dec≈23.44, so |−40−23.44|=63.44
  const sd = 0.2666;
  const dip = celestial.dipArcmin(3) / 60;
  const refr = celestial.refractionArcmin(trueHo) / 60;
  const hs = trueHo + dip + refr - sd;
  const r = celestial.reduceNoonSight({
    body: "Sun",
    hs_deg: hs,
    eye_height_m: 3,
    epoch_ms: t,
    dr_position: dr,
    limb: "lower",
  });
  assert.ok(Math.abs(r.assumed_lat - -40) < 0.5, `lat ${r.assumed_lat}`);
  assert.strictEqual(r.azimuth_true, 0); // Sun due north
  assert.strictEqual(r.intercept_nm, 0);
});

test("reduceNoonSight: rejects non-Sun bodies", () => {
  assert.throws(() =>
    celestial.reduceNoonSight({
      body: "Moon",
      hs_deg: 45,
      epoch_ms: Date.now(),
      dr_position: { latitude: 40, longitude: -75 },
    }),
  );
});

test("reduceNoonSight: produces an east-west LOP (azimuth 0 or 180)", () => {
  // The LOP convention: normal = (sin θ, cos θ). For θ=180° the normal
  // is (0, -1) → line runs east-west. Either noon azimuth satisfies this.
  const t = new Date("2026-06-21T17:00:00Z").getTime();
  const dr = { latitude: 40, longitude: -75 };
  const gp = celestial.sunGeographicPosition(t);
  const trueHo = 90 - Math.abs(40 - gp.declination_deg);
  const hs = trueHo + celestial.dipArcmin(3) / 60 - 0.2666;
  const r = celestial.reduceNoonSight({
    body: "Sun",
    hs_deg: hs,
    eye_height_m: 3,
    epoch_ms: t,
    dr_position: dr,
    limb: "lower",
  });
  assert.ok(r.azimuth_true === 0 || r.azimuth_true === 180);
});

test("starGeographicPosition: of-date places match paper-almanac anchors", () => {
  // At 2026-07-01 the paper almanac's of-date SHA/Dec for Vega ≈
  // 80°33' / N38°48' and Regulus ≈ 207°34' / N11°51'. A J2000 table used
  // without conversion to the date would sit ~0.3° (≈20 NM of LOP error)
  // off; the library's precession/nutation/aberration closes the gap.
  const t = Date.UTC(2026, 6, 1, 0, 0, 0);
  const { starGeographicPosition } = celestial;

  for (const [name, expSha, expDec] of [
    ["Vega", 80.55, 38.8],
    ["Regulus", 207.56, 11.84],
  ]) {
    const gp = starGeographicPosition(t, almanac.lookup(name));
    const shaOfDate = (((gp.gha_deg - gastDeg(t)) % 360) + 360) % 360;
    assert.ok(
      Math.abs(shaOfDate - expSha) < 0.05,
      `${name} SHA of date ${shaOfDate.toFixed(3)} vs almanac ~${expSha}`,
    );
    assert.ok(
      Math.abs(gp.declination_deg - expDec) < 0.05,
      `${name} Dec of date ${gp.declination_deg.toFixed(3)} vs almanac ~${expDec}`,
    );
    // Sanity: the of-date SHA differs from the J2000 table value by the
    // accumulated precession (Vega ≈ 0.2°, Regulus ≈ 0.35°).
    const tableSha = almanac.lookup(name).sha_deg;
    assert.ok(
      Math.abs(shaOfDate - tableSha) > 0.1,
      `${name}: of-date SHA should differ from the J2000 table`,
    );
  }
});
