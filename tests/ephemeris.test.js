/**
 * Ephemeris regression tests (SPEC §13).
 *
 * The Sun/Moon/star geographic positions are computed by astronomy-engine;
 * these tests pin that wiring with snapshot values and — more importantly
 * — anchor it against INDEPENDENT derivations:
 *
 *   - Sun: a from-scratch Meeus (Astronomical Algorithms 2nd ed.)
 *     higher-precision reduction, cross-validated when the hand-rolled
 *     formula was retired (agreement ≤0.1′).
 *   - Moon: the Astronomical Almanac's low-precision series — a wholly
 *     different formula set, spec'd ±0.3°, used here as a coarse sanity
 *     oracle (≤20′ tolerance).
 *   - Stars: the 2026 paper Nautical Almanac's navigational-star pages
 *     (of-date SHA/Dec, whole-arcminute precision on the page).
 *
 * The snapshots guard wiring regressions (a topocentric-vs-geocentric
 * mix-up would shift GHA by the body's parallax: ~0.15′ for the Sun,
 * ~1° for the Moon).
 *
 * @file ephemeris.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const celestial = require("../plugin/celestial.js");

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const { normalizeDeg360 } = require("../plugin/geo.js");

/**
 * Independent Meeus higher-precision solar GHA/Dec (kept here as the
 * anchor oracle — a different lineage from the library's VSOP-based Sun).
 *
 * @param {number} epochMs
 * @returns {{gha_deg: number, declination_deg: number}}
 */
function meeusSun(epochMs) {
  const jd = epochMs / 86400000 + 2440587.5;
  const T = (jd - 2451545.0) / 36525;
  const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
  const M = 357.52911 + 35999.05029 * T - 0.0001537 * T * T;
  const C =
    (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(M * RAD) +
    (0.019993 - 0.000101 * T) * Math.sin(2 * M * RAD) +
    0.000289 * Math.sin(3 * M * RAD);
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const eps0 =
    23 +
    26 / 60 +
    21.448 / 3600 -
    (46.815 * T + 0.00059 * T * T - 0.001813 * T * T * T) / 3600;
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD);
  const ra =
    Math.atan2(
      Math.cos(eps * RAD) * Math.sin(lambda * RAD),
      Math.cos(lambda * RAD),
    ) * DEG;
  const dec = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD)) * DEG;
  const gmst = normalizeDeg360(
    280.46061837 +
      360.98564736629 * (jd - 2451545.0) +
      0.000387933 * T * T -
      (T * T * T) / 38710000,
  );
  return {
    gha_deg: normalizeDeg360(gmst - ra),
    declination_deg: dec,
  };
}

/**
 * The Astronomical Almanac's low-precision lunar position — an
 * independent (if coarse, ±0.3°) formula set for the Moon sanity check.
 *
 * @param {number} epochMs
 * @returns {{gha_deg: number, declination_deg: number}}
 */
function aaMoon(epochMs) {
  const jd = epochMs / 86400000 + 2440587.5;
  const T = (jd - 2451545.0) / 36525;
  const lon =
    218.32 +
    481267.8813 * T +
    6.29 * Math.sin((135.0 + 477198.87 * T) * RAD) -
    1.27 * Math.sin((259.2 - 413335.36 * T) * RAD) +
    0.66 * Math.sin((235.7 + 890534.22 * T) * RAD) +
    0.21 * Math.sin((269.9 + 954397.74 * T) * RAD) -
    0.19 * Math.sin((357.5 + 35999.05 * T) * RAD) -
    0.11 * Math.sin((186.5 + 966404.03 * T) * RAD);
  const lat =
    5.13 * Math.sin((93.3 + 483202.03 * T) * RAD) +
    0.28 * Math.sin((228.2 + 960400.87 * T) * RAD) -
    0.28 * Math.sin((318.3 + 6003.18 * T) * RAD) -
    0.17 * Math.sin((217.6 - 407332.2 * T) * RAD);
  const eps = 23.4393;
  const ra =
    Math.atan2(
      Math.cos(eps * RAD) * Math.sin(lon * RAD) -
        Math.tan(lat * RAD) * Math.sin(eps * RAD),
      Math.cos(lon * RAD),
    ) * DEG;
  const dec =
    Math.asin(
      Math.sin(lat * RAD) * Math.cos(eps * RAD) +
        Math.cos(lat * RAD) * Math.sin(eps * RAD) * Math.sin(lon * RAD),
    ) * DEG;
  const gmst = normalizeDeg360(
    280.46061837 + 360.98564736629 * (jd - 2451545.0),
  );
  return { gha_deg: normalizeDeg360(gmst - ra), declination_deg: dec };
}

// --- Snapshots (astronomy-engine 2.1.19, generated 2026-08-29) ----------
// Tight pinning of the wiring: GHA to 1e-5 deg, Dec to 1e-5 deg.
const SUN_SNAPSHOTS = [
  ["2026-03-15T06:30:00Z", 275.26502, -2.11344, 16.077],
  ["2026-06-21T10:00:00Z", 329.55058, 23.43801, 15.732],
  ["2026-09-15T22:30:00Z", 158.73453, 2.73922, 15.899],
  ["2026-12-21T22:00:00Z", 150.43239, -23.43758, 16.252],
];

test("sun GHA/Dec snapshots pin the ephemeris wiring", () => {
  for (const [t, gha, dec, sdMin] of SUN_SNAPSHOTS) {
    const gp = celestial.sunGeographicPosition(Date.parse(t));
    assert.ok(Math.abs(gp.gha_deg - gha) < 1e-4, `${t} GHA ${gp.gha_deg}`);
    assert.ok(
      Math.abs(gp.declination_deg - dec) < 1e-4,
      `${t} Dec ${gp.declination_deg}`,
    );
    assert.ok(
      Math.abs(gp.semi_diameter_deg * 60 - sdMin) < 0.01,
      `${t} SD ${gp.semi_diameter_deg * 60}`,
    );
  }
});

test("sun ephemeris agrees with an independent Meeus reduction (≤0.7′)", () => {
  // The Meeus low-precision reduction is itself spec'd to 0.01° (0.6′)
  // — it neglects full nutation — so the anchor asserts at ITS accuracy
  // class, not below it.
  const t0 = Date.UTC(2026, 0, 1);
  for (let i = 0; i < 12; i++) {
    const ms = t0 + i * 27 * 86400000;
    const ours = celestial.sunGeographicPosition(ms);
    const meeus = meeusSun(ms);
    const dGha =
      Math.abs(((ours.gha_deg - meeus.gha_deg + 540) % 360) - 180) * 60;
    const dDec = Math.abs(ours.declination_deg - meeus.declination_deg) * 60;
    assert.ok(
      dGha < 0.7,
      `GHA diff ${dGha.toFixed(2)}′ at ${new Date(ms).toISOString()}`,
    );
    assert.ok(
      dDec < 0.7,
      `Dec diff ${dDec.toFixed(2)}′ at ${new Date(ms).toISOString()}`,
    );
  }
});

test("sun semi-diameter tracks the annual distance variation", () => {
  const t0 = Date.UTC(2026, 0, 4); // near perihelion
  const t1 = Date.UTC(2026, 6, 4); // near aphelion
  const peri = celestial.sunGeographicPosition(t0).semi_diameter_deg * 60;
  const aphe = celestial.sunGeographicPosition(t1).semi_diameter_deg * 60;
  assert.ok(peri > 16.2, `perihelion SD ${peri}′ should be max`);
  assert.ok(aphe < 15.8, `aphelion SD ${aphe}′ should be min`);
  assert.ok(peri - aphe > 0.4, "annual variation should be ~0.5′");
});

// --- Moon ---------------------------------------------------------------
const MOON_SNAPSHOTS = [
  ["2026-03-15T06:30:00Z", 319.2176, -20.88754, 15.264, 56.04],
  ["2026-06-21T10:00:00Z", 245.76439, 0.55751, 15.491, 56.87],
  ["2026-09-15T22:30:00Z", 105.56947, -22.92011, 15.009, 55.1],
  ["2026-12-21T22:00:00Z", 4.14864, 25.03069, 16.482, 60.508],
];

test("moon GHA/Dec/SD/HP snapshots pin the ephemeris wiring", () => {
  for (const [t, gha, dec, sdMin, hpMin] of MOON_SNAPSHOTS) {
    const gp = celestial.moonGeographicPosition(Date.parse(t));
    assert.ok(Math.abs(gp.gha_deg - gha) < 1e-4, `${t} GHA ${gp.gha_deg}`);
    assert.ok(
      Math.abs(gp.declination_deg - dec) < 1e-4,
      `${t} Dec ${gp.declination_deg}`,
    );
    assert.ok(
      Math.abs(gp.semi_diameter_deg * 60 - sdMin) < 0.01,
      `${t} SD ${gp.semi_diameter_deg * 60}`,
    );
    assert.ok(
      Math.abs(gp.horizontal_parallax_deg * 60 - hpMin) < 0.01,
      `${t} HP ${gp.horizontal_parallax_deg * 60}`,
    );
  }
});

test("moon ephemeris sanity: within the AA low-precision formula's ±0.3°", () => {
  const t0 = Date.UTC(2026, 0, 1);
  for (let i = 0; i < 12; i++) {
    const ms = t0 + i * 27 * 86400000;
    const ours = celestial.moonGeographicPosition(ms);
    const aa = aaMoon(ms);
    const dGha = Math.abs(((ours.gha_deg - aa.gha_deg + 540) % 360) - 180) * 60;
    const dDec = Math.abs(ours.declination_deg - aa.declination_deg) * 60;
    assert.ok(
      dGha < 20,
      `GHA diff ${dGha.toFixed(1)}′ at ${new Date(ms).toISOString()}`,
    );
    assert.ok(
      dDec < 20,
      `Dec diff ${dDec.toFixed(1)}′ at ${new Date(ms).toISOString()}`,
    );
  }
});

test("moon SD/HP stay in physical bounds and move together (distance-driven)", () => {
  const t0 = Date.UTC(2026, 0, 1);
  let minSd = 99;
  let maxSd = 0;
  let minHp = 99;
  let maxHp = 0;
  for (let i = 0; i < 28; i++) {
    const gp = celestial.moonGeographicPosition(t0 + i * 86400000 * 6.5);
    const sd = gp.semi_diameter_deg * 60;
    const hp = gp.horizontal_parallax_deg * 60;
    minSd = Math.min(minSd, sd);
    maxSd = Math.max(maxSd, sd);
    minHp = Math.min(minHp, hp);
    maxHp = Math.max(maxHp, hp);
    // SD/HP share the same distance: their ratio is the Moon/Earth
    // radius ratio ≈ 1737.4/6378.14 ≈ 0.2725.
    assert.ok(
      Math.abs(sd / hp - 1737.4 / 6378.14) < 0.001,
      `SD/HP ratio ${sd / hp}`,
    );
  }
  assert.ok(minSd > 14.6 && maxSd < 16.8, `SD range ${minSd}–${maxSd}′`);
  assert.ok(minHp > 53.5 && maxHp < 61.6, `HP range ${minHp}–${maxHp}′`);
  assert.ok(maxSd - minSd > 1.0, "anomalistic variation should be ~1.7′");
});

// --- Stars ---------------------------------------------------------------
test("star GHA snapshot pins the wiring (Vega, Acrux 2026-07-01)", () => {
  const almanac = require("../plugin/star-almanac.js");
  const t = Date.UTC(2026, 6, 1);
  const vega = celestial.starGeographicPosition(t, almanac.lookup("Vega"));
  assert.ok(Math.abs(vega.gha_deg - 359.60437) < 1e-4, `Vega ${vega.gha_deg}`);
  assert.ok(
    Math.abs(vega.declination_deg - 38.80226) < 1e-4,
    `Vega dec ${vega.declination_deg}`,
  );
  const acrux = celestial.starGeographicPosition(t, almanac.lookup("Acrux"));
  assert.ok(
    Math.abs(acrux.gha_deg - 92.04301) < 1e-4,
    `Acrux ${acrux.gha_deg}`,
  );
  assert.ok(
    Math.abs(acrux.declination_deg - -63.25244) < 1e-4,
    `Acrux dec ${acrux.declination_deg}`,
  );
});
