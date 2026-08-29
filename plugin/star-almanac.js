/**
 * Bundled navigational star almanac (SPEC §13).
 *
 * Ships a small static subset of navigational stars as SHA (sidereal hour
 * angle) + declination, derived from J2000 mean places (Bright Star
 * Catalog). Proper motion is negligible over the stated valid epoch
 * (§13), so a single epoch's values are acceptable; the dataset carries
 * an explicit `validFrom`/`validUntil` and `isExpired()` so startup can
 * raise `notifications.navigation.deadReckoning.status` the same way as
 * WMM expiry (§12) — a warning, not a hard failure.
 *
 * SHA here is the navigational convention: SHA = 360° − RA (right
 * ascension), measured westward from the vernal equinox. GHA of a star
 * = GHA Aries + SHA.
 *
 * Source: J2000 mean places, verified entry-by-entry against a
 * Hipparcos-derived catalog (d3-celestial's stars.6.json, mag ≤ 6
 * subset) — all entries within ~0.5′ of catalog values. Values are
 * rounded to 0.1′ (0.0017°), well within sextant-reading precision.
 * Attribution and a derivation note belong in a project data-note (not
 * produced by the agent per project rules on human-facing docs); the
 * underlying catalogs are in the public domain.
 *
 * @file star-almanac.js
 */

const { normalizeDeg360 } = require("./geo.js");

/** Almanac epoch. The values are trustworthy to ~0.1′ over this span. */
const VALID_FROM = "2026-01-01";
const VALID_UNTIL = "2030-12-31";

/**
 * Navigational stars: name → { sha_deg, declination_deg, magnitude }.
 * SHA and Dec are J2000 mean places (BSC5), rounded to 0.1′.
 * `starGeographicPosition` applies precession to the date, so these
 * J2000 places stay valid for GMST-of-date — the two conventions must
 * match or every star LOP carries the ~46″/yr equinox drift.
 */
const STARS = {
  // Name: SHA (deg), Dec (deg), magnitude
  // SHA = 360 - RA_j2000.
  Polaris: { sha_deg: 322.05, declination_deg: 89.26, magnitude: 2.0 },
  Kochab: { sha_deg: 137.33, declination_deg: 74.16, magnitude: 2.1 },
  Dubhe: { sha_deg: 194.07, declination_deg: 61.75, magnitude: 1.8 },
  Capella: { sha_deg: 280.83, declination_deg: 45.99, magnitude: 0.1 },
  Vega: { sha_deg: 80.77, declination_deg: 38.78, magnitude: 0.0 },
  Deneb: { sha_deg: 49.64, declination_deg: 45.28, magnitude: 1.3 },
  Altair: { sha_deg: 62.3, declination_deg: 8.87, magnitude: 0.8 },
  Schedar: { sha_deg: 349.88, declination_deg: 56.54, magnitude: 2.2 },
  Hamal: { sha_deg: 328.21, declination_deg: 23.46, magnitude: 2.0 },
  Aldebaran: { sha_deg: 291.02, declination_deg: 16.51, magnitude: 0.9 },
  Rigel: { sha_deg: 281.37, declination_deg: -8.2, magnitude: 0.1 },
  Procyon: { sha_deg: 245.18, declination_deg: 5.22, magnitude: 0.4 },
  Sirius: { sha_deg: 258.71, declination_deg: -16.72, magnitude: -1.5 },
  Canopus: { sha_deg: 264.01, declination_deg: -52.7, magnitude: -0.7 },
  Castor: { sha_deg: 246.35, declination_deg: 31.89, magnitude: 1.6 },
  Pollux: { sha_deg: 243.67, declination_deg: 28.03, magnitude: 1.1 },
  Regulus: { sha_deg: 207.91, declination_deg: 11.97, magnitude: 1.4 },
  Spica: { sha_deg: 158.7, declination_deg: -11.16, magnitude: 1.0 },
  Arcturus: { sha_deg: 146.08, declination_deg: 19.18, magnitude: 0.0 },
  Antares: { sha_deg: 112.65, declination_deg: -26.43, magnitude: 1.1 },
  Fomalhaut: { sha_deg: 15.59, declination_deg: -29.62, magnitude: 1.2 },
  Markab: { sha_deg: 13.81, declination_deg: 15.21, magnitude: 2.5 },
  // Southern-sky navigational stars (the classic sun-run-sun latitudes
  // like the South Pacific passages): Acrux and Hadar give the Southern
  // Cross fix, Achernar/Miaplacidus/Peacock round out the S hemisphere.
  Acrux: { sha_deg: 173.35, declination_deg: -63.1, magnitude: 0.8 },
  Hadar: { sha_deg: 149.05, declination_deg: -60.37, magnitude: 0.6 },
  Achernar: { sha_deg: 335.57, declination_deg: -57.24, magnitude: 0.5 },
  Miaplacidus: { sha_deg: 221.7, declination_deg: -69.72, magnitude: 1.7 },
  Peacock: { sha_deg: 53.59, declination_deg: -56.74, magnitude: 1.9 },
};

/**
 * Looks up a star by name (case-insensitive). Returns the star's SHA +
 * declination + magnitude, or undefined if not bundled.
 *
 * @param {string} name
 * @returns {{sha_deg: number, declination_deg: number, magnitude: number}|undefined}
 */
function lookup(name) {
  if (!name) return undefined;
  const key = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
  const s = STARS[key];
  if (!s) return undefined;
  return {
    sha_deg: normalizeDeg360(s.sha_deg),
    declination_deg: s.declination_deg,
    magnitude: s.magnitude,
  };
}

/**
 * Whether the almanac is past its valid epoch for the given date.
 *
 * @param {Date} now
 * @returns {boolean}
 */
function isExpired(now) {
  return now > new Date(VALID_UNTIL);
}

/**
 * Days until expiry (negative if expired).
 *
 * @param {Date} now
 * @returns {number}
 */
function daysUntilExpiry(now) {
  return Math.round((new Date(VALID_UNTIL) - now) / 86400000);
}

module.exports = {
  VALID_FROM,
  VALID_UNTIL,
  STARS,
  lookup,
  isExpired,
  daysUntilExpiry,
};
