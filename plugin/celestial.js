/**
 * Celestial sight reduction (SPEC §13).
 *
 * Reduces a raw sextant sight into a line of position ready for the
 * unified fix pipeline (work doc #3): an assumed position, an azimuth
 * (Zn), and a signed intercept (toward/away) in nautical miles.
 *
 * The method is Marcq St. Hilaire (intercept method):
 *
 *   1. From the timestamp and the body, find the body's geographic
 *      position (GP): its GHA (Greenwich hour angle) and declination.
 *      The GP is the point on earth directly under the body.
 *   2. At the assumed position (here: the DR position, or an explicit
 *      assumed_position per design decision Q4), compute the computed
 *      altitude Hc and azimuth Zn of the body.
 *   3. Correct the sextant altitude Hs to the observed altitude Ho
 *      (index error, dip, refraction; plus semi-diameter and parallax
 *      for Sun/Moon limb sights).
 *   4. Intercept = (Ho − Hc) × 60 arcminutes → nautical miles. Positive
 *      means the observer is toward the body from the assumed position
 *      ("toward"); negative means away. The LOP is perpendicular to Zn,
 *      offset by the intercept — exactly the form `recordLineOfPosition`
 *      and the fix resolver expect.
 *
 * Ephemeris (SPEC §13): computed by astronomy-engine (MIT, pure JS,
 * zero sub-dependencies, fully offline) — Sun and Moon geocentric
 * apparent places, stars from the bundled J2000 almanac (verified
 * against a Hipparcos-derived catalog) converted to the date by the
 * library's precession/nutation/aberration. The nautical-almanac
 * convention throughout is GEOCENTRIC, coordinates of date; parallax
 * is applied as a separate sight correction (step 3), never baked into
 * the GP. Library accuracy is arcsecond-class — far below sextant
 * precision — and is pinned by paper-almanac anchors in
 * tests/ephemeris.test.js.
 *
 * The module is pure: no DB, no I/O, no `new Date()` (the sight time is
 * passed in explicitly so reduction is deterministic and testable).
 * Time-sync staleness (§11) is read from a passed-in indicator and
 * carried on the result, not computed here.
 *
 * @file celestial.js
 */

const Astronomy = require("astronomy-engine");
const { normalizeDeg360 } = require("./geo.js");

/** Radians per degree. */
const RAD = Math.PI / 180;
/** Degrees per radian. */
const DEG = 180 / Math.PI;
/** Mean obliquity of the ecliptic (J2000), degrees. */
const OBLIQUITY_DEG = 23.4397;
/** Sun radius, km (IAU nominal). */
const SUN_RADIUS_KM = 695700;
/** Moon radius, km. */
const MOON_RADIUS_KM = 1737.4;
/** Earth equatorial radius, km. */
const EARTH_EQ_RADIUS_KM = 6378.14;

/**
 * Reduces an ecliptic longitude/latitude to right ascension (degrees),
 * for a given obliquity (degrees).
 *
 * @param {number} lonDeg - ecliptic longitude, degrees
 * @param {number} latDeg - ecliptic latitude, degrees (0 for the Sun)
 * @param {number} [epsDeg=OBLIQUITY_DEG] - obliquity of the ecliptic
 * @returns {number} RA, degrees
 */
function raFromEcliptic(lonDeg, latDeg, epsDeg = OBLIQUITY_DEG) {
  const e = epsDeg * RAD;
  const l = lonDeg * RAD;
  const b = latDeg * RAD;
  const ra = Math.atan2(
    Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e),
    Math.cos(l),
  );
  return normalizeDeg360(ra * DEG);
}

/**
 * Reduces an ecliptic longitude/latitude to declination (degrees), for
 * a given obliquity (degrees).
 *
 * @param {number} lonDeg
 * @param {number} latDeg
 * @param {number} [epsDeg=OBLIQUITY_DEG] - obliquity of the ecliptic
 * @returns {number} declination, degrees [-90, 90]
 */
function decFromEcliptic(lonDeg, latDeg, epsDeg = OBLIQUITY_DEG) {
  const e = epsDeg * RAD;
  const l = lonDeg * RAD;
  const b = latDeg * RAD;
  const dec = Math.asin(
    Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l),
  );
  return dec * DEG;
}

/**
 * Geocentric apparent GHA/Dec from true-ecliptic-of-date coordinates.
 * The obliquity (true, of date) and Greenwich apparent sidereal time
 * both come from the library, so nutation is included on both sides of
 * GHA = GAST − RA — the nautical-almanac convention.
 *
 * @param {number} epochMs
 * @param {number} lonDeg - ecliptic longitude of date, degrees
 * @param {number} latDeg - ecliptic latitude of date, degrees
 * @returns {{gha_deg: number, declination_deg: number}}
 */
function ghaDecFromEcliptic(epochMs, lonDeg, latDeg) {
  const date = new Date(epochMs);
  const eps = Astronomy.e_tilt(Astronomy.MakeTime(date)).tobl;
  const ra = raFromEcliptic(lonDeg, latDeg, eps);
  const dec = decFromEcliptic(lonDeg, latDeg, eps);
  const gastDeg = Astronomy.SiderealTime(date) * 15;
  return { gha_deg: normalizeDeg360(gastDeg - ra), declination_deg: dec };
}

/**
 * Sun's geographic position at a timestamp: GHA, declination, and the
 * apparent semi-diameter from the true Earth–Sun distance (varies
 * 0.263–0.274° over the year — the fixed mean left up to ±0.3′).
 *
 * @param {number} epochMs
 * @returns {{gha_deg: number, declination_deg: number, semi_diameter_deg: number}}
 */
function sunGeographicPosition(epochMs) {
  const ecl = Astronomy.SunPosition(new Date(epochMs));
  const distKm = ecl.vec.Length() * Astronomy.KM_PER_AU;
  return {
    ...ghaDecFromEcliptic(epochMs, ecl.elon, ecl.elat),
    semi_diameter_deg: Math.asin(SUN_RADIUS_KM / distKm) * DEG,
  };
}

/**
 * Moon's geographic position at a timestamp: GHA, declination, plus the
 * semi-diameter and horizontal parallax from the true distance. The
 * distance varies ±5.5% over the anomalistic month — the previously
 * fixed SD 0.2725°/HP 0.95° were up to ~2′ wrong near apogee.
 *
 * @param {number} epochMs
 * @returns {{gha_deg: number, declination_deg: number, semi_diameter_deg: number, horizontal_parallax_deg: number}}
 */
function moonGeographicPosition(epochMs) {
  const ecl = Astronomy.EclipticGeoMoon(new Date(epochMs));
  const distKm = ecl.dist * Astronomy.KM_PER_AU;
  return {
    ...ghaDecFromEcliptic(epochMs, ecl.lon, ecl.lat),
    semi_diameter_deg: Math.asin(MOON_RADIUS_KM / distKm) * DEG,
    horizontal_parallax_deg: Math.asin(EARTH_EQ_RADIUS_KM / distKm) * DEG,
  };
}

/**
 * A star's geographic position at a timestamp: GHA and declination.
 * The bundled almanac's J2000 mean place is registered with the library
 * (`DefineStar`), which returns the apparent place of date — full
 * precession, nutation and aberration.
 *
 * `DefineStar` mutates its slot globally; the single-threaded
 * sight-reduction path re-registers per lookup, which is fine for
 * per-sight (rare) events, not per-tick use.
 *
 * @param {number} epochMs
 * @param {{sha_deg: number, declination_deg: number}} star
 * @returns {{gha_deg: number, declination_deg: number}}
 */
function starGeographicPosition(epochMs, star) {
  const date = new Date(epochMs);
  const raHours = (360 - normalizeDeg360(star.sha_deg)) / 15;
  Astronomy.DefineStar(
    Astronomy.Body.Star1,
    raHours,
    star.declination_deg,
    100,
  );
  const eq = Astronomy.Equator(
    Astronomy.Body.Star1,
    date,
    new Astronomy.Observer(0, 0, 0),
    true,
    true,
  );
  const gastDeg = Astronomy.SiderealTime(date) * 15;
  return {
    gha_deg: normalizeDeg360(gastDeg - eq.ra * 15),
    declination_deg: eq.dec,
  };
}

/**
 * Computed altitude (Hc) and azimuth (Zn) of a body at an assumed
 * position, from its geographic position. The spherical-trig heart of
 * sight reduction.
 *
 * @param {{latitude: number, longitude: number}} assumed - degrees
 * @param {{gha_deg: number, declination_deg: number}} gp - body's geographic position
 * @returns {{hc_deg: number, zn_deg: number, lha_deg: number}}
 */
function computeHcZn(assumed, gp) {
  const lat = assumed.latitude * RAD;
  const dec = gp.declination_deg * RAD;
  // Local hour angle: LHA = GHA + longitude (east-positive convention,
  // matching Signal K). LHA is west-positive: 0 = body on the observer's
  // meridian, 90 = on the western horizon, 270 = on the eastern horizon.
  const lha = normalizeDeg360(gp.gha_deg + assumed.longitude) * RAD;
  const sinHc =
    Math.sin(lat) * Math.sin(dec) +
    Math.cos(lat) * Math.cos(dec) * Math.cos(lha);
  const hc = Math.asin(Math.max(-1, Math.min(1, sinHc))) * DEG;
  // Azimuth (true bearing, clockwise from north):
  //   Zn = atan2(sin LHA, cos LHA·sin lat − tan dec·cos lat) + 180
  // The +180 converts the raw angle (measured from the north point,
  // westward to the body's geographical direction) into the conventional
  // bearing-from-observer-to-body measured clockwise from north.
  const y = Math.sin(lha);
  const x = Math.cos(lha) * Math.sin(lat) - Math.tan(dec) * Math.cos(lat);
  const zn = normalizeDeg360(Math.atan2(y, x) * DEG + 180);
  return { hc_deg: hc, zn_deg: zn, lha_deg: lha * DEG };
}

/**
 * Bennett's refraction formula (arcminutes), valid for altitudes above
 * ~5° (design decision Q3). Returns 0 for non-positive apparent altitude.
 *
 * @param {number} altDeg - apparent (geometric) altitude, degrees
 * @returns {number} refraction in arcminutes (subtract from observed)
 */
function refractionArcmin(altDeg) {
  if (altDeg <= 0) return 0;
  // Bennett's formula (degrees in, arcminutes out):
  //   R = 1.02 / tan(h + 10.3 / (h + 5.11))   with h in degrees.
  // Compute the argument in degrees, then convert to radians for tan.
  const h = altDeg;
  const argDeg = h + 10.3 / (h + 5.11);
  return Math.max(0, 1.02 / Math.tan(argDeg * RAD));
}

/**
 * Dip of the sea horizon in arcminutes, from height of eye in metres.
 *
 * @param {number} eyeHeightM
 * @returns {number} dip in arcminutes (subtract from observed)
 */
function dipArcmin(eyeHeightM) {
  if (!eyeHeightM || eyeHeightM <= 0) return 0;
  // Standard dip: 1.76 * sqrt(h_m), h in metres → arcminutes.
  return 1.76 * Math.sqrt(eyeHeightM);
}

/**
 * Corrects a sextant altitude (Hs) to observed altitude (Ho).
 *
 *   Ho = Hs + index_error − dip − refraction (+ semi-diameter −/+
 *   parallax for Sun/Moon limb sights)
 *
 * Index error is signed (positive if on the arc → subtract; here the
 * convention is: pass the index correction already as "apply to Hs",
 * i.e. Ho = Hs + IC). Dip and refraction are always subtracted (they make
 * the observed body lower than the horizon sight). Refraction uses the
 * *apparent* (post-dip) altitude per convention.
 *
 * @param {object} c
 * @param {number} c.hs_deg - sextant altitude, degrees
 * @param {number} [c.index_correction_deg] - signed index correction (+ added to Hs)
 * @param {number} [c.eye_height_m] - height of eye above sea level, metres
 * @param {number} [c.semi_diameter_deg] - Sun/Moon limb correction (added for lower limb, subtracted for upper)
 * @param {number} [c.parallax_deg] - horizontal parallax correction for the Moon (added)
 * @returns {{hs_deg:number, ha_deg:number, ho_deg:number}}
 */
function correctAltitude(c) {
  const hs = c.hs_deg;
  const ic = c.index_correction_deg ?? 0;
  const ha = hs + ic; // apparent altitude (no dip yet)
  const dip = dipArcmin(c.eye_height_m ?? 0) / 60;
  const altForRefraction = ha - dip;
  const refr = refractionArcmin(altForRefraction) / 60;
  let ho = ha - dip - refr;
  if (c.semi_diameter_deg != null) ho += c.semi_diameter_deg;
  if (c.parallax_deg != null) ho += c.parallax_deg;
  return { hs_deg: hs, ha_deg: ha, ho_deg: ho };
}

/**
 * Sight-reduction input.
 *
 * @typedef {Object} SightInput
 * @property {string} body - 'Sun' | 'Moon' | star name from the almanac
 * @property {number} hs_deg - sextant altitude, degrees
 * @property {number} [index_correction_deg] - signed IC, + added to Hs
 * @property {number} [eye_height_m] - height of eye, metres (for dip)
 * @property {number} epoch_ms - sight time, UTC ms (Date.getTime())
 * @property {{latitude:number, longitude:number}} [assumed_position] - reduction point; defaults to dr_position
 * @property {{latitude:number, longitude:number}} dr_position - dead-reckoned position
 * @property {'lower'|'upper'|null} [limb] - 'lower'|'upper' for Sun/Moon limb sights
 * @property {number} [time_sync_staleness_s] - carried through to the result (§11)
 * @property {object} [almanac] - star almanac lookup (for star bodies)
 */

/**
 * Result of a sight reduction — the LOP plus diagnostic detail for the UI.
 *
 * @typedef {Object} SightResult
 * @property {string} body
 * @property {number} assumed_lat
 * @property {number} assumed_lon
 * @property {number} azimuth_true - Zn, degrees true
 * @property {number} intercept_nm - signed, + toward body
 * @property {'toward'|'away'} intercept_direction
 * @property {number} hc_deg
 * @property {number} ho_deg
 * @property {number} lha_deg
 * @property {number|null} time_sync_staleness_s
 */

/**
 * Reduces a sight to a line of position. Returns the LOP fields ready for
 * `recordLineOfPosition`, plus Hc/Ho/LHA for UI feedback.
 *
 * @param {SightInput} input
 * @returns {SightResult}
 */
function reduceSight(input) {
  const assumed = input.assumed_position ?? input.dr_position;
  const epochMs = input.epoch_ms;

  // 1. Geographic position of the body.
  let gp;
  let semiDiameterDeg = null;
  let parallaxDeg = null;
  const body = input.body;
  if (body === "Sun") {
    gp = sunGeographicPosition(epochMs);
    // Apparent semi-diameter from the true Earth–Sun distance
    // (0.263–0.274° over the year).
    const sd = gp.semi_diameter_deg;
    semiDiameterDeg =
      input.limb === "upper" ? -sd : input.limb === "lower" ? sd : null;
  } else if (body === "Moon") {
    gp = moonGeographicPosition(epochMs);
    // Semi-diameter and horizontal parallax from the true distance
    // (varies ±5.5% over the anomalistic month). Parallax-in-altitude
    // correction = HP·cos(Ha).
    const sd = gp.semi_diameter_deg;
    semiDiameterDeg =
      input.limb === "upper" ? -sd : input.limb === "lower" ? sd : null;
    const ha = (input.hs_deg + (input.index_correction_deg ?? 0)) * RAD;
    parallaxDeg = gp.horizontal_parallax_deg * Math.cos(ha);
  } else if (input.almanac) {
    const star = input.almanac.lookup(body);
    if (!star) throw new Error(`unknown body: ${body}`);
    gp = starGeographicPosition(epochMs, star);
  } else {
    throw new Error(`unknown body and no almanac provided: ${body}`);
  }

  // 2. Hc and Zn at the assumed position.
  const { hc_deg, zn_deg, lha_deg } = computeHcZn(assumed, gp);

  // Refuse low-altitude sights (Q3): refraction is unreliable below 5°.
  if (hc_deg < 5) {
    throw new Error(
      `sight below the 5° refraction cutoff (Hc=${hc_deg.toFixed(1)}°)`,
    );
  }

  // 3. Ho from Hs.
  const { ho_deg } = correctAltitude({
    hs_deg: input.hs_deg,
    index_correction_deg: input.index_correction_deg,
    eye_height_m: input.eye_height_m,
    semi_diameter_deg: semiDiameterDeg,
    parallax_deg: parallaxDeg,
  });

  // 4. Intercept: (Ho − Hc) in degrees × 60 = nautical miles.
  const interceptNm = (ho_deg - hc_deg) * 60;
  const direction = interceptNm >= 0 ? "toward" : "away";

  return {
    body,
    assumed_lat: assumed.latitude,
    assumed_lon: assumed.longitude,
    azimuth_true: zn_deg,
    intercept_nm: interceptNm,
    intercept_direction: direction,
    hc_deg,
    ho_deg,
    lha_deg,
    time_sync_staleness_s: input.time_sync_staleness_s ?? null,
  };
}

/**
 * Reduces a noon (local-apparent-noon) Sun sight to a latitude LOP.
 *
 * At LAN the Sun is on the observer's meridian, due north or due south,
 * so the sight yields latitude directly by the meridian-altitude formula
 *
 *   Lat = Dec ± z,  where z = 90° − Ho is the zenith distance.
 *
 * The sign is + (Dec + z) when the Sun is south of the observer
 * (Dec < assumed latitude), − (Dec − z) when the Sun is north. This is
 * a single-sight latitude fix — no assumed-position dependency, no
 * intercept — but it still produces an LOP (a parallel of latitude,
 * azimuth 0°/180° → east-west line, intercept 0) so it flows through the
 * existing recordLineOfPosition / fix-resolver pipeline unchanged.
 *
 * A companion longitude sight (or the DR longitude) then gives a full
 * fix; the noon latitude LOP crosses any other LOP/CPL normally.
 *
 * Note: longitude by equal-altitude averaging (the technique of taking
 * matching sights before and after culmination to find the exact moment
 * of LAN, then longitude from GHA + the equation of time) is a separate
 * procedure and out of scope here — this reduction covers only the
 * meridian-altitude latitude.
 *
 * @param {SightInput} input - `body` must be "Sun"; `assumed_position` or
 *   `dr_position` supplies the longitude to anchor the LOP and the
 *   hemisphere test (latitude is computed, not used as assumed).
 * @returns {SightResult} with `azimuth_true` 0 or 180 and `intercept_nm` 0;
 *   `assumed_lat` is the computed latitude, `hc_deg` is the computed
 *   meridian altitude at the DR latitude (for UI diagnostics only).
 */
function reduceNoonSight(input) {
  if (input.body !== "Sun") {
    throw new Error("noon sight requires the Sun");
  }
  const assumed = input.assumed_position ?? input.dr_position;
  if (!assumed) {
    throw new Error("noon sight requires an assumed/dr position for longitude");
  }
  const epochMs = input.epoch_ms;

  // 1. Sun declination at the sight time.
  const gp = sunGeographicPosition(epochMs);
  const dec = gp.declination_deg;

  // 2. Ho from Hs (same corrections as a normal sight; limb sights apply).
  const sd = 0.2666;
  const semiDiameterDeg =
    input.limb === "upper" ? -sd : input.limb === "lower" ? sd : null;
  const { ho_deg } = correctAltitude({
    hs_deg: input.hs_deg,
    index_correction_deg: input.index_correction_deg,
    eye_height_m: input.eye_height_m,
    semi_diameter_deg: semiDiameterDeg,
    parallax_deg: null,
  });

  // Refuse low sights (same 5° cutoff as the intercept method).
  if (ho_deg < 5) {
    throw new Error(
      `noon sight below the 5° cutoff (Ho=${ho_deg.toFixed(1)}°)`,
    );
  }

  // 3. Zenith distance and latitude. Sun south of observer → Lat = Dec + z;
  // Sun north → Lat = Dec − z. Decide from the DR/assumed latitude.
  const z = 90 - ho_deg;
  const sunSouth = dec < assumed.latitude;
  const latitude = sunSouth ? dec + z : dec - z;

  // Azimuth: 180° (due south) when the Sun is south of the observer,
  // 0° (due north) when it's north. Either yields an east-west LOP.
  const azimuth = sunSouth ? 180 : 0;

  // Diagnostic: the meridian altitude computed at the DR latitude.
  const hc_deg = 90 - Math.abs(assumed.latitude - dec);

  return {
    body: input.body,
    assumed_lat: latitude,
    assumed_lon: assumed.longitude,
    azimuth_true: azimuth,
    intercept_nm: 0,
    intercept_direction: "toward",
    hc_deg,
    ho_deg,
    lha_deg: 0, // by definition on the meridian
    time_sync_staleness_s: input.time_sync_staleness_s ?? null,
  };
}

module.exports = {
  raFromEcliptic,
  decFromEcliptic,
  sunGeographicPosition,
  moonGeographicPosition,
  starGeographicPosition,
  computeHcZn,
  refractionArcmin,
  dipArcmin,
  correctAltitude,
  reduceSight,
  reduceNoonSight,
};
