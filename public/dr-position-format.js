/**
 * Configurable position formatting for the DR webapp (SPEC §14.1).
 *
 * Navigators use different position notations depending on their
 * charts: decimal degrees, degrees/decimal-minutes (DM — the most
 * common on nautical charts), or full DMS. This module centralizes the
 * formatting so the sight panel inputs, map tooltips, and fix labels
 * all match the format the watchkeeper is actually using.
 *
 * Pure ESM, no DOM — unit-tested in Node.
 *
 * @module dr-position-format.js
 */

/**
 * @typedef {"decimal"|"dm"|"dms"} PositionFormat
 */

/**
 * @typedef {object} FormatOptions
 * @property {PositionFormat} format - "decimal" | "dm" | "dms"
 * @property {number} [decimalPlaces=4] - decimal-degree precision
 * @property {boolean} [hemisphere=true] - append N/S/E/W suffix
 */

/**
 * Splits a signed degree value into its absolute value and hemisphere
 * letter.
 *
 * @param {number} deg
 * @param {"lat"|"lon"} kind
 * @returns {{abs: number, hem: string}}
 */
function decompose(deg, kind) {
  const negative = Number(deg) < 0;
  return {
    abs: Math.abs(Number(deg)),
    hem: negative ? (kind === "lat" ? "S" : "W") : kind === "lat" ? "N" : "E",
  };
}

/**
 * Formats a single coordinate (lat or lon) in decimal degrees.
 *
 * @param {number} deg
 * @param {"lat"|"lon"} kind
 * @param {FormatOptions} opts
 * @returns {string}
 */
export function formatCoord(deg, kind, opts) {
  const places = opts.decimalPlaces ?? 4;
  const { abs, hem } = decompose(deg, kind);
  const hemSuffix = opts.hemisphere === false ? "" : hem;
  const sign = opts.hemisphere === false && Number(deg) < 0 ? "-" : "";

  if (opts.format === "decimal") {
    return `${sign}${abs.toFixed(places)}${hemSuffix ? ` ${hemSuffix}` : ""}`;
  }

  if (opts.format === "dms") {
    const d = Math.floor(abs);
    const minFull = (abs - d) * 60;
    const m = Math.floor(minFull);
    const s = ((minFull - m) * 60).toFixed(1);
    return `${d}°${String(m).padStart(2, "0")}'${s.padStart(4, "0")}"${hemSuffix ? ` ${hemSuffix}` : ""}`;
  }

  // "dm" — degrees + decimal minutes (most common on nautical charts)
  const d = Math.floor(abs);
  const m = ((abs - d) * 60).toFixed(3);
  return `${d}°${String(m).padStart(6, "0")}'${hemSuffix ? ` ${hemSuffix}` : ""}`;
}

/**
 * Formats a [lat, lon] pair into a single string.
 *
 * @param {[number, number]} latlon
 * @param {FormatOptions} opts
 * @returns {string}
 */
export function formatPosition(latlon, opts) {
  const [lat, lon] = latlon;
  return `${formatCoord(lat, "lat", opts)} ${formatCoord(lon, "lon", opts)}`;
}

/**
 * Parses a coordinate string in any supported format back into degrees.
 * Accepts decimal ("60.5 N"), DM ("60°30.000' N"), or DMS
 * ("60°30'15.0\" N"). Negative numbers or S/W → negative degrees.
 *
 * @param {string} str
 * @param {"lat"|"lon"} kind
 * @returns {number} signed degrees
 * @throws {Error} if the string can't be parsed
 */
export function parseCoord(str, kind) {
  if (str == null || str === "") throw new Error("empty coordinate");
  const s = String(str).trim().toUpperCase();
  // Determine sign from hemisphere letter, else from a leading sign.
  let negative = false;
  let body = s;
  const hemLat = s.includes("S") || s.includes("N");
  const hemLon = s.includes("W") || s.includes("E");
  const hasHem = kind === "lat" ? hemLat : hemLon;
  if (hasHem) {
    const hem =
      kind === "lat"
        ? s.includes("S")
          ? "S"
          : "N"
        : s.includes("W")
          ? "W"
          : "E";
    negative = hem === "S" || hem === "W";
    body = s.replace(/[NSEW]/g, "").trim();
  } else if (body.startsWith("-")) {
    negative = true;
    body = body.slice(1);
  } else if (body.startsWith("+")) {
    body = body.slice(1);
  }

  const parts = body.match(/(\d+(?:\.\d+)?)/g);
  if (!parts) throw new Error(`cannot parse coordinate: "${str}"`);

  let deg;
  if (parts.length === 1) {
    // decimal degrees
    deg = Number(parts[0]);
  } else if (parts.length === 2) {
    // degrees + decimal minutes
    deg = Number(parts[0]) + Number(parts[1]) / 60;
  } else if (parts.length >= 3) {
    // degrees + minutes + seconds
    deg = Number(parts[0]) + Number(parts[1]) / 60 + Number(parts[2]) / 3600;
  } else {
    throw new Error(`cannot parse coordinate: "${str}"`);
  }
  if (Number.isNaN(deg)) throw new Error(`cannot parse coordinate: "${str}"`);
  return negative ? -deg : deg;
}

/**
 * Parses a [lat, lon] pair from two strings.
 *
 * @param {string} latStr
 * @param {string} lonStr
 * @returns {[number, number]}
 */
export function parsePosition(latStr, lonStr) {
  return [parseCoord(latStr, "lat"), parseCoord(lonStr, "lon")];
}

/**
 * Global default format options — shared across the whole UI so the
 * sight panel, map tooltips, and fix labels all match. Default is DMS
 * (the traditional nautical chart format). Change via `setFormat()`.
 *
 * @type {FormatOptions}
 */
let defaultOpts = {
  format: "dms",
  decimalPlaces: 4,
  hemisphere: true,
};

/**
 * Sets the global position format. Called once at startup (e.g. from a
 * settings dropdown) to switch the whole UI between decimal / DM / DMS.
 *
 * @param {PositionFormat} format
 * @param {Partial<FormatOptions>} [extra]
 * @returns {void}
 */
export function setFormat(format, extra = {}) {
  defaultOpts = { ...defaultOpts, ...extra, format };
}

/**
 * @returns {FormatOptions} a copy of the current default options
 */
export function getFormat() {
  return { ...defaultOpts };
}

/**
 * Formats a coordinate using the global default format.
 *
 * @param {number} deg
 * @param {"lat"|"lon"} kind
 * @returns {string}
 */
export function fmt(deg, kind) {
  return formatCoord(deg, kind, defaultOpts);
}

/**
 * Formats a [lat, lon] pair using the global default format.
 *
 * @param {[number, number]} latlon
 * @returns {string}
 */
export function fmtPos(latlon) {
  return formatPosition(latlon, defaultOpts);
}

/**
 * Splits a signed degree value into its structured components for
 * seeding multi-field input forms (degrees, minutes, seconds,
 * hemisphere). The seconds field is only non-null for DMS format.
 *
 * @param {number} deg
 * @param {"lat"|"lon"} kind
 * @param {PositionFormat} [format] - defaults to the global format
 * @returns {{deg: number, min: number, sec: number|null, hem: string}}
 */
export function coordParts(deg, kind, format = defaultOpts.format) {
  const { abs, hem } = decompose(deg, kind);
  const d = Math.floor(abs);
  const minFull = (abs - d) * 60;
  if (format === "dms") {
    const m = Math.floor(minFull);
    const s = (minFull - m) * 60;
    return { deg: d, min: m, sec: Math.round(s * 10) / 10, hem };
  }
  // decimal or dm → degrees + decimal minutes (seconds omitted)
  return { deg: d, min: Math.round(minFull * 1000) / 1000, sec: null, hem };
}

/**
 * Parses structured form fields (degrees, minutes, optional seconds,
 * hemisphere) back into signed degrees.
 *
 * @param {{deg: number|string, min: number|string, sec?: number|string|null, hem: string}} parts
 * @returns {number}
 */
export function parseParts(parts) {
  const d = Math.abs(Number(parts.deg)) || 0;
  const m = Math.abs(Number(parts.min)) || 0;
  const s =
    parts.sec == null || parts.sec === "" ? 0 : Math.abs(Number(parts.sec));
  let deg = d + m / 60 + s / 3600;
  const hem = (parts.hem || "").toUpperCase();
  if (hem === "S" || hem === "W") deg = -deg;
  return deg;
}
