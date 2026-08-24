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
  ]) {
    assert.ok(almanac.lookup(name), `missing ${name}`);
  }
});

test("VALID_FROM/VALID_UNTIL are exposed for the startup check", () => {
  assert.ok(almanac.VALID_FROM);
  assert.ok(almanac.VALID_UNTIL);
  assert.ok(new Date(almanac.VALID_FROM) < new Date(almanac.VALID_UNTIL));
});
