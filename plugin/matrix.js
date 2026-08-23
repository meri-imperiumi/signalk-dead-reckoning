/**
 * EMA matrix store: leeway / speed-loss / upwash (SPEC §4.1, §6.1).
 *
 * The matrix is binned by sail_state × sea_state × STW × AWA × heel and
 * trained continuously against GPS ground truth during normal sailing
 * (Training Mode, §6.1). Each bin holds three learned correction values —
 * leeway angle, speed loss, upwash correction — updated via EMA whose
 * learning rate is modulated by the bin's effective hit count, so a
 * well-sailed bin converges slowly (it already knows the answer) and a
 * fresh bin learns fast (SPEC §4.1 design notes).
 *
 * Live and historical hit counts are tracked separately so a season of
 * live sailing can outweigh years of backfilled data: each live sample
 * counts as `LIVE_WEIGHT_MULTIPLIER`× a historical sample by default
 * (SPEC §4.1), and historical samples are further discounted by their
 * confidence tier.
 *
 * @file matrix.js
 */

const { quantizeStw, quantizeAwa, quantizeHeel } = require("./bins.js");

/**
 * A live sample counts as this many historical samples in the effective
 * hit count (SPEC §4.1: "each live sample should count as several times a
 * historical sample by default").
 */
const LIVE_WEIGHT_MULTIPLIER = 5;

/**
 * Per-tier historical-sample weight (SPEC §4.1). Reanalysis-current bins are
 * more trustworthy than climatology-only bins.
 */
const HISTORICAL_TIER_WEIGHT = {
  reanalysis: 1.0,
  climatology: 0.5,
};

/**
 * Unknown/absent sail or sea state, used when logbook integration isn't
 * available (pre-logbook-integration eras during backfill, or live when
 * the logbook peer is absent).
 */
const UNKNOWN_STATE = "unknown";

/**
 * Effective hit count for learning-rate modulation.
 *
 * `live_hit_count` weighted by the live multiplier plus
 * `historical_hit_count` weighted by its confidence tier. A pure live bin
 * and a heavily-backfilled bin both produce a meaningful, comparable
 * "how much do we know about this condition" number.
 *
 * @param {object} bin
 * @returns {number}
 */
function effectiveHitCount(bin) {
  const live = (bin.live_hit_count || 0) * LIVE_WEIGHT_MULTIPLIER;
  const histWeight =
    HISTORICAL_TIER_WEIGHT[bin.historical_confidence_tier] ?? 0;
  const hist = (bin.historical_hit_count || 0) * histWeight;
  return live + hist;
}

/**
 * Learning rate for an EMA update, as a function of effective hit count.
 *
 * Fresh bin (hit_count → 0): α → 1 (adopt the new observation wholesale).
 * Well-sailed bin (hit_count → ∞): α → small floor (resists transient noise).
 * The floor keeps the matrix from going rigid — a bin never stops learning,
 * it just learns slowly, so a re-rig or a season of changed trim can still
 * migrate it over time.
 *
 * @param {number} hitCount - effective hit count
 * @returns {number} α in (0, 1]
 */
function learningRate(hitCount) {
  const FLOOR = 0.01;
  if (hitCount <= 0) return 1;
  return Math.max(FLOOR, 1 / (1 + hitCount));
}

/**
 * Applies an EMA update to a single value.
 *
 * @param {number} existing
 * @param {number} observed
 * @param {number} alpha
 * @returns {number}
 */
function ema(existing, observed, alpha) {
  return alpha * observed + (1 - alpha) * existing;
}

/**
 * Resolves the bin's current correction values, with neutral defaults for
 * a bin that has never been written (no leeway, no speed loss, no upwash
 * correction — i.e. trust the raw sensors).
 *
 * @param {object|undefined} row
 * @returns {{leeway_angle: number, speed_loss: number, upwash_correction: number, hit_count: number}}
 */
function correctionsOrDefault(row) {
  if (!row) {
    return {
      leeway_angle: 0,
      speed_loss: 0,
      upwash_correction: 0,
      hit_count: 0,
    };
  }
  return {
    leeway_angle: row.leeway_angle,
    speed_loss: row.speed_loss,
    upwash_correction: row.upwash_correction,
    hit_count: effectiveHitCount(row),
  };
}

/**
 * Builds the bin primary-key tuple for a lookup/update.
 *
 * @param {object} ctx - {sail_state, sea_state, stwKn, awaDeg, heelDeg}
 * @returns {{sail_state: string, sea_state: string, stw_bin: number, awa_bin: number, heel_bin: number}}
 */
function binKey(ctx) {
  return {
    sail_state: ctx.sail_state || UNKNOWN_STATE,
    sea_state: ctx.sea_state || UNKNOWN_STATE,
    stw_bin: quantizeStw(ctx.stwKn),
    awa_bin: quantizeAwa(ctx.awaDeg),
    heel_bin: quantizeHeel(ctx.heelDeg),
  };
}

/**
 * Matrix store bound to a SQLite database.
 */
class MatrixStore {
  /**
   * @param {import("node:sqlite").DatabaseSync} db
   */
  constructor(db) {
    this.db = db;
    this._lookupStmt = db.prepare(
      `SELECT leeway_angle, speed_loss, upwash_correction,
              hit_count, live_hit_count, historical_hit_count,
              historical_confidence_tier
       FROM dr_matrix_bins
       WHERE sail_state = ? AND sea_state = ? AND stw_bin = ?
         AND awa_bin = ? AND heel_bin = ?`,
    );
    this._upsertStmt = db.prepare(
      `INSERT INTO dr_matrix_bins (
         sail_state, sea_state, stw_bin, awa_bin, heel_bin,
         leeway_angle, speed_loss, upwash_correction,
         hit_count, live_hit_count, historical_hit_count,
         historical_confidence_tier
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(sail_state, sea_state, stw_bin, awa_bin, heel_bin)
       DO UPDATE SET
         leeway_angle = excluded.leeway_angle,
         speed_loss = excluded.speed_loss,
         upwash_correction = excluded.upwash_correction,
         hit_count = excluded.hit_count,
         live_hit_count = excluded.live_hit_count,
         historical_hit_count = excluded.historical_hit_count,
         historical_confidence_tier = excluded.historical_confidence_tier`,
    );
    this._countStmt = db.prepare("SELECT COUNT(*) AS n FROM dr_matrix_bins");
  }

  /**
   * Looks up learned corrections for a condition, with neutral defaults.
   *
   * @param {object} ctx - {sail_state, sea_state, stwKn, awaDeg, heelDeg}
   * @returns {{leeway_angle: number, speed_loss: number, upwash_correction: number, hit_count: number}}
   */
  lookup(ctx) {
    const k = binKey(ctx);
    const row = this._lookupStmt.get(
      k.sail_state,
      k.sea_state,
      k.stw_bin,
      k.awa_bin,
      k.heel_bin,
    );
    return correctionsOrDefault(row);
  }

  /**
   * Updates a bin with a new observed correction vector via EMA.
   *
   * `source` controls which hit counter advances: `'live'` for live
   * sailing (Training Mode), `'historical'` for backfill. Historical
   * updates carry a `confidence_tier` (`'reanalysis'` or `'climatology'`)
   * that weights the bin's effective hit count thereafter.
   *
   * @param {object} ctx - {sail_state, sea_state, stwKn, awaDeg, heelDeg}
   * @param {object} observed - {leeway_angle, speed_loss, upwash_correction}
   * @param {object} [opts]
   * @param {"live"|"historical"} [opts.source="live"]
   * @param {"reanalysis"|"climatology"|null} [opts.confidenceTier=null]
   * @returns {void}
   */
  update(ctx, observed, opts = {}) {
    const source = opts.source || "live";
    const confidenceTier = opts.confidenceTier || null;
    const k = binKey(ctx);
    const existing = this._lookupStmt.get(
      k.sail_state,
      k.sea_state,
      k.stw_bin,
      k.awa_bin,
      k.heel_bin,
    );

    const hitCount = existing ? effectiveHitCount(existing) : 0;
    const alpha = learningRate(hitCount);

    const base = correctionsOrDefault(existing);
    const leeway = ema(base.leeway_angle, observed.leeway_angle, alpha);
    const speedLoss = ema(base.speed_loss, observed.speed_loss, alpha);
    const upwash = ema(
      base.upwash_correction,
      observed.upwash_correction,
      alpha,
    );

    const liveHits = existing ? existing.live_hit_count : 0;
    const histHits = existing ? existing.historical_hit_count : 0;
    const totalHits = hitCount + 1;

    this._upsertStmt.run(
      k.sail_state,
      k.sea_state,
      k.stw_bin,
      k.awa_bin,
      k.heel_bin,
      leeway,
      speedLoss,
      upwash,
      totalHits,
      source === "live" ? liveHits + 1 : liveHits,
      source === "historical" ? histHits + 1 : histHits,
      confidenceTier,
    );
  }

  /**
   * Total number of populated bins — a rough coverage indicator for the
   * calibration dashboard (SPEC §14.1) and for tests.
   *
   * @returns {number}
   */
  count() {
    return this._countStmt.get().n;
  }
}

module.exports = {
  MatrixStore,
  LIVE_WEIGHT_MULTIPLIER,
  HISTORICAL_TIER_WEIGHT,
  UNKNOWN_STATE,
  effectiveHitCount,
  learningRate,
  ema,
  correctionsOrDefault,
  binKey,
};
