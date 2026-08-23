/**
 * Bin-quantization helpers for the EMA matrix (SPEC §4.1).
 *
 * `dr_matrix_bins` is keyed by quantized sail/sea/STW/AWA/heel values. Storing
 * raw continuous values as the primary key would prevent `hit_count` from
 * ever accumulating meaningfully, so every value is rounded to the nearest
 * bin width before insert/lookup. The bin widths are centralized here so
 * the live training path and the backfill path quantize identically.
 *
 * @file bins.js
 */

/** STW bin width in knots (SPEC §4.1 example: nearest 0.5kt). */
const STW_BIN_WIDTH = 0.5;

/** AWA bin width in degrees (SPEC §4.1 example: nearest 5°). */
const AWA_BIN_WIDTH = 5;

/** Heel bin width in degrees (SPEC §4.1 example: nearest 2°). */
const HEEL_BIN_WIDTH = 2;

/**
 * Rounds a value to the nearest bin width.
 *
 * Uses round-half-up via Math.round so a value exactly on a bin edge lands
 * deterministically. Negative heel (leeward heel on the other tack) is
 * handled correctly because Math.round preserves sign.
 *
 * @param {number} value - the raw continuous value
 * @param {number} width - the bin width (must be > 0)
 * @returns {number} the quantized bin value
 */
function quantize(value, width) {
  if (width <= 0) throw new RangeError("bin width must be positive");
  return Math.round(value / width) * width;
}

/**
 * Quantizes speed-through-water to the matrix bin.
 *
 * @param {number} stwKn - speed through water in knots
 * @returns {number}
 */
function quantizeStw(stwKn) {
  return quantize(stwKn, STW_BIN_WIDTH);
}

/**
 * Quantizes apparent wind angle (degrees, absolute) to the matrix bin.
 *
 * AWA is taken as an absolute angle (port/starboard symmetry holds for the
 * leeway/speed-loss physics the matrix learns), so we fold to [0, 180]
 * before quantizing.
 *
 * @param {number} awaDeg - apparent wind angle in degrees (signed ok)
 * @returns {number}
 */
function quantizeAwa(awaDeg) {
  const folded = Math.min(Math.abs(awaDeg), 180);
  return quantize(folded, AWA_BIN_WIDTH);
}

/**
 * Quantizes heel angle (degrees, signed) to the matrix bin.
 *
 * Heel sign encodes which tack the boat is on; the SPEC bins heel directly
 * rather than folding it, so a 10° port-heel bin and a 10° starboard-heel
 * bin are distinct rows. That keeps the leeway direction learned per tack.
 *
 * @param {number} heelDeg - heel angle in degrees (signed)
 * @returns {number}
 */
function quantizeHeel(heelDeg) {
  return quantize(heelDeg, HEEL_BIN_WIDTH);
}

module.exports = {
  STW_BIN_WIDTH,
  AWA_BIN_WIDTH,
  HEEL_BIN_WIDTH,
  quantize,
  quantizeStw,
  quantizeAwa,
  quantizeHeel,
};
