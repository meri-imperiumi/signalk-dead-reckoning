/**
 * Geodetic and trigonometric helpers for the dead-reckoning engine.
 *
 * Everything here is pure and unit-tested in isolation. Conversions follow
 * Signal K's radian convention for angles and the `{latitude, longitude}`
 * convention for positions. Distances are nautical miles (1 nm = 1852 m),
 * the natural unit for navigation; the matrix bins and DR log both use nm.
 *
 * @file geo.js
 */

/** Nautical mile in metres. */
const METRES_PER_NM = 1852;

/** Mean earth radius in metres (WGS84 mean). */
const EARTH_RADIUS_M = 6371008.8;

/** Radians per degree. */
const RAD_PER_DEG = Math.PI / 180;

/** Degrees per radian. */
const DEG_PER_RAD = 180 / Math.PI;

/**
 * Converts degrees to radians.
 *
 * @param {number} deg
 * @returns {number}
 */
function degToRad(deg) {
  return deg * RAD_PER_DEG;
}

/**
 * Converts radians to degrees.
 *
 * @param {number} rad
 * @returns {number}
 */
function radToDeg(rad) {
  return rad * DEG_PER_RAD;
}

/**
 * Normalizes an angle in degrees to [-180, 180).
 *
 * @param {number} deg
 * @returns {number}
 */
function normalizeDeg180(deg) {
  let d = deg % 360;
  if (d >= 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/**
 * Normalizes an angle in degrees to [0, 360).
 *
 * @param {number} deg
 * @returns {number}
 */
function normalizeDeg360(deg) {
  let d = deg % 360;
  if (d < 0) d += 360;
  return d;
}

/**
 * Great-circle distance between two points, in nautical miles.
 *
 * Uses the haversine formula, which is numerically stable for small
 * distances (the case that matters most for DR divergence measurement).
 *
 * @param {{latitude: number, longitude: number}} a
 * @param {{latitude: number, longitude: number}} b
 * @returns {number} distance in nm
 */
function distanceNm(a, b) {
  const lat1 = degToRad(a.latitude);
  const lat2 = degToRad(b.latitude);
  const dLat = degToRad(b.latitude - a.latitude);
  const dLon = degToRad(b.longitude - a.longitude);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h =
    sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  const c = 2 * Math.asin(Math.min(1, Math.sqrt(h)));
  return (EARTH_RADIUS_M * c) / METRES_PER_NM;
}

/**
 * Initial great-circle bearing from a to b, in degrees true [0, 360).
 *
 * @param {{latitude: number, longitude: number}} a
 * @param {{latitude: number, longitude: number}} b
 * @returns {number} bearing in degrees true
 */
function bearingDeg(a, b) {
  const lat1 = degToRad(a.latitude);
  const lat2 = degToRad(b.latitude);
  const dLon = degToRad(b.longitude - a.longitude);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return normalizeDeg360(radToDeg(Math.atan2(y, x)));
}

/**
 * Destination point given a start, a bearing, and a distance.
 *
 * Standard spherical destination formula. Bearing in degrees true,
 * distance in nautical miles. Used by the DR integrator: each tick
 * advances the shadow-boat position by the resolved water-track vector
 * plus the resolved current vector.
 *
 * @param {{latitude: number, longitude: number}} start
 * @param {number} bearingDegTrue - bearing in degrees true
 * @param {number} nm - distance in nautical miles
 * @returns {{latitude: number, longitude: number}}
 */
function destinationPoint(start, bearingDegTrue, nm) {
  const lat1 = degToRad(start.latitude);
  const lon1 = degToRad(start.longitude);
  const brng = degToRad(bearingDegTrue);
  const d = (nm * METRES_PER_NM) / EARTH_RADIUS_M;

  const sinLat1 = Math.sin(lat1);
  const cosLat1 = Math.cos(lat1);
  const sinD = Math.sin(d);
  const cosD = Math.cos(d);

  const lat2 = Math.asin(sinLat1 * cosD + cosLat1 * sinD * Math.cos(brng));
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(brng) * sinD * cosLat1,
      cosD - sinLat1 * Math.sin(lat2),
    );

  return {
    latitude: radToDeg(lat2),
    longitude: normalizeDeg180(radToDeg(lon2)),
  };
}

/**
 * Adds a vector (bearing, distance) to a position. Convenience wrapper
 * around destinationPoint that accepts the natural DR representation of a
 * resolved motion vector.
 *
 * @param {{latitude: number, longitude: number}} start
 * @param {{bearingTrue: number, distanceNm: number}} vector
 * @returns {{latitude: number, longitude: number}}
 */
function advanceByVector(start, vector) {
  return destinationPoint(start, vector.bearingTrue, vector.distanceNm);
}

/**
 * Knots (nm/h) to metres per second.
 *
 * @param {number} kn
 * @returns {number}
 */
function knotsToMs(kn) {
  return (kn * METRES_PER_NM) / 3600;
}

/**
 * Metres per second to knots.
 *
 * @param {number} ms
 * @returns {number}
 */
function msToKnots(ms) {
  return (ms * 3600) / METRES_PER_NM;
}

module.exports = {
  METRES_PER_NM,
  EARTH_RADIUS_M,
  RAD_PER_DEG,
  DEG_PER_RAD,
  degToRad,
  radToDeg,
  normalizeDeg180,
  normalizeDeg360,
  distanceNm,
  bearingDeg,
  destinationPoint,
  advanceByVector,
  knotsToMs,
  msToKnots,
};
