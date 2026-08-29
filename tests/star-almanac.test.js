/**
 * Tests for the bundled navigational star almanac (SPEC §13).
 * @file star-almanac.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const almanac = require("../plugin/star-almanac.js");

test("lookup is case-insensitive and returns SHA/Dec/magnitude", () => {
  const polaris = almanac.lookup("polaris");
  assert.ok(polaris);
  assert.ok(polaris.sha_deg >= 0 && polaris.sha_deg < 360);
  assert.ok(Math.abs(polaris.declination_deg - 89.26) < 0.01);
  assert.strictEqual(almanac.lookup("POLARIS").sha_deg, polaris.sha_deg);
  assert.strictEqual(almanac.lookup("Vega").declination_deg, 38.78);
});

test("lookup returns undefined for an unknown star", () => {
  assert.strictEqual(almanac.lookup("MadeUp"), undefined);
  assert.strictEqual(almanac.lookup(""), undefined);
  assert.strictEqual(almanac.lookup(null), undefined);
});

test("isExpired is false inside the valid epoch and true after it", () => {
  assert.ok(!almanac.isExpired(new Date("2028-01-01")));
  assert.ok(almanac.isExpired(new Date("2031-01-01")));
});

test("daysUntilExpiry counts down and goes negative after expiry", () => {
  const now = new Date("2028-01-01");
  const d = almanac.daysUntilExpiry(now);
  assert.ok(d > 1000, `expected >1000 days left, got ${d}`);
  const later = new Date("2031-01-01");
  assert.ok(almanac.daysUntilExpiry(later) < 0);
});

test("the bundled set includes the standard navigational stars", () => {
  for (const name of [
    "Polaris",
    "Vega",
    "Sirius",
    "Canopus",
    "Arcturus",
    "Rigel",
    "Procyon",
    "Capella",
    "Altair",
    "Deneb",
    "Regulus",
    "Spica",
    "Antares",
    "Fomalhaut",
    // Southern-sky set — the working latitudes of the South Pacific
    // passages fix by the Southern Cross, not Polaris.
    "Acrux",
    "Hadar",
    "Achernar",
    "Miaplacidus",
    "Peacock",
  ]) {
    assert.ok(almanac.lookup(name), `missing ${name}`);
  }
  // No duplicate/nonsense entries: every table key looks up cleanly.
  for (const key of Object.keys(almanac.STARS)) {
    assert.ok(
      almanac.lookup(key) != null,
      `table key ${key} does not survive case-insensitive lookup`,
    );
  }
});

test("table SHAs are J2000 mean places, verified against a Hipparcos-derived catalog", () => {
  // Verified entry-by-entry against d3-celestial's Hipparcos-derived
  // stars.6.json (2026-08): all within ~0.5′ of catalog. Regression
  // guards for the historical errors: Regulus was 12.5° off (~750 NM
  // of LOP error), Hamal 2.9°, Polaris 3.1°, Sirius ~0.4°, and
  // Dubhe/Hamal/Miaplacidus/Peacock carried a further 2–10′ of drift.
  assert.ok(Math.abs(almanac.STARS.Regulus.sha_deg - 207.91) < 0.01);
  assert.ok(Math.abs(almanac.STARS.Hamal.sha_deg - 328.21) < 0.01);
  assert.ok(Math.abs(almanac.STARS.Dubhe.sha_deg - 194.07) < 0.01);
  assert.ok(Math.abs(almanac.STARS.Peacock.sha_deg - 53.59) < 0.01);
  assert.ok(Math.abs(almanac.STARS.Sirius.sha_deg - 258.71) < 0.01);
  assert.ok(Math.abs(almanac.STARS.Polaris.sha_deg - 322.05) < 0.01);
  assert.ok(Math.abs(almanac.STARS.Acrux.sha_deg - 173.35) < 0.01);
  assert.strictEqual(almanac.STARS.Capella2, undefined);
});

test("VALID_FROM/VALID_UNTIL are exposed for the startup check", () => {
  assert.ok(almanac.VALID_FROM);
  assert.ok(almanac.VALID_UNTIL);
  assert.ok(new Date(almanac.VALID_FROM) < new Date(almanac.VALID_UNTIL));
});
