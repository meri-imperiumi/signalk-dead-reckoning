/**
 * SQLite persistence layer for the dead-reckoning engine (SPEC §4).
 *
 * Uses Node's built-in `node:sqlite` (stable as of Node 24+), which ships
 * with the platform — no native build step, which matters on the
 * ARM/Raspberry-Pi-class hardware most Signal K installs run on (SPEC §2).
 *
 * All schema from SPEC §4.1–§4.6 is created idempotently on open. The
 * connection is synchronous (`DatabaseSync`), which suits the 1Hz DR path:
 * writes are small and local, and a synchronous API keeps the worker
 * thread's logic simple without promise plumbing on the hot path.
 *
 * @file db.js
 */

const { DatabaseSync } = require("node:sqlite");
const { dirname } = require("node:path");
const { mkdirSync } = require("node:fs");

/** Schema version, bumped when a migration is needed. Persisted in dr_state_store. */
const SCHEMA_VERSION = 1;

/**
 * DDL for every table in SPEC §4. Statements run in order; all are
 * `CREATE TABLE IF NOT EXISTS` so re-open is idempotent.
 */
const SCHEMA_DDL = [
  // §4.1 EMA matrix — leeway / speed-loss / upwash
  `CREATE TABLE IF NOT EXISTS dr_matrix_bins (
    sail_state TEXT NOT NULL,
    sea_state TEXT NOT NULL,
    stw_bin REAL NOT NULL,
    awa_bin REAL NOT NULL,
    heel_bin REAL NOT NULL,
    leeway_angle REAL NOT NULL,
    speed_loss REAL NOT NULL,
    upwash_correction REAL NOT NULL,
    hit_count INTEGER NOT NULL,
    live_hit_count INTEGER NOT NULL DEFAULT 0,
    historical_hit_count INTEGER NOT NULL DEFAULT 0,
    historical_confidence_tier TEXT,
    PRIMARY KEY (sail_state, sea_state, stw_bin, awa_bin, heel_bin)
  )`,

  // §4.2 persistent DR state & checkpoints
  `CREATE TABLE IF NOT EXISTS dr_state_store (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  // §4.3 digitized offline pilot charts
  `CREATE TABLE IF NOT EXISTS offline_pilot_currents (
    month INTEGER NOT NULL,
    lat_grid REAL NOT NULL,
    lon_grid REAL NOT NULL,
    current_u REAL NOT NULL,
    current_v REAL NOT NULL,
    PRIMARY KEY (month, lat_grid, lon_grid)
  )`,

  // §4.4 unified fix model — fixes, lines of position, circular position lines
  `CREATE TABLE IF NOT EXISTS fixes (
    fix_id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    source_type TEXT NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    estimated_error_radius REAL,
    confirmed_by TEXT,
    logged_to_logbook BOOLEAN NOT NULL DEFAULT 0,
    logbook_entry_ref TEXT,
    resets_dr_origin BOOLEAN NOT NULL DEFAULT 0,
    notes TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS lines_of_position (
    lop_id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    lop_type TEXT NOT NULL,
    assumed_lat REAL NOT NULL,
    assumed_lon REAL NOT NULL,
    azimuth_true REAL NOT NULL,
    intercept_nm REAL,
    body_or_object TEXT,
    confirmed_by TEXT,
    used_in_fix_id INTEGER,
    FOREIGN KEY (used_in_fix_id) REFERENCES fixes(fix_id)
  )`,

  `CREATE TABLE IF NOT EXISTS circular_position_lines (
    cpl_id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    cpl_type TEXT NOT NULL,
    center_lat REAL NOT NULL,
    center_lon REAL NOT NULL,
    radius_nm REAL NOT NULL,
    radius_uncertainty_nm REAL,
    source_object TEXT,
    confirmed_by TEXT,
    used_in_fix_id INTEGER,
    FOREIGN KEY (used_in_fix_id) REFERENCES fixes(fix_id)
  )`,

  // §4.5 DR correction log
  `CREATE TABLE IF NOT EXISTS dr_corrections (
    correction_id INTEGER PRIMARY KEY AUTOINCREMENT,
    fix_id INTEGER NOT NULL,
    timestamp TEXT NOT NULL,
    dr_lat REAL NOT NULL,
    dr_lon REAL NOT NULL,
    fix_lat REAL NOT NULL,
    fix_lon REAL NOT NULL,
    deviation_nm REAL NOT NULL,
    deviation_bearing REAL NOT NULL,
    dr_elapsed_seconds INTEGER NOT NULL,
    sail_state TEXT,
    sea_state TEXT,
    FOREIGN KEY (fix_id) REFERENCES fixes(fix_id)
  )`,

  // §4.6 anomaly / integrity tables
  `CREATE TABLE IF NOT EXISTS anchor_swing_stats (
    depth_bin REAL NOT NULL,
    scope_bin REAL,
    p50_distance_m REAL NOT NULL,
    p99_distance_m REAL NOT NULL,
    p999_distance_m REAL NOT NULL,
    sample_count INTEGER NOT NULL,
    PRIMARY KEY (depth_bin, scope_bin)
  )`,

  `CREATE TABLE IF NOT EXISTS moored_position_stats (
    location_id INTEGER,
    p50_distance_m REAL NOT NULL,
    p99_distance_m REAL NOT NULL,
    p999_distance_m REAL NOT NULL,
    sample_count INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS gps_anomalies (
    anomaly_id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    context TEXT NOT NULL,
    jump_distance_m REAL NOT NULL,
    duration_seconds INTEGER,
    self_corrected BOOLEAN,
    corroborated_by_ais_adsb BOOLEAN DEFAULT 0,
    severity TEXT NOT NULL
  )`,
];

/**
 * Opens (or creates) the DR database, applies schema, and records the
 * schema version. The parent directory is created if missing.
 *
 * @param {string} dbPath - absolute path to the SQLite file
 * @returns {import("node:sqlite").DatabaseSync}
 */
function openDatabase(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  for (const stmt of SCHEMA_DDL) {
    db.exec(stmt);
  }
  // Record schema version so future migrations can branch on it.
  setState(db, "schema_version", String(SCHEMA_VERSION));
  return db;
}

/**
 * Reads a scalar value from `dr_state_store`.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} key
 * @returns {string|undefined}
 */
function getState(db, key) {
  const row = db
    .prepare("SELECT value FROM dr_state_store WHERE key = ?")
    .get(key);
  return row ? row.value : undefined;
}

/**
 * Writes a scalar value to `dr_state_store`, upserting.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} key
 * @param {string} value
 * @returns {void}
 */
function setState(db, key, value) {
  db.prepare(
    `INSERT INTO dr_state_store (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, new Date().toISOString());
}

/**
 * Records a DR correction on a snap-to-fix event (SPEC §4.5, §9.3).
 * Symmetric across NORMAL and OVERRIDE modes — every confirmed fix that
 * resets the DR origin writes a row, so the table doubles as the passage
 * "how good was DR" diagnostic and the empirical input to the uncertainty
 * polygon (§8) and backtesting (§10.2).
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {object} r
 * @param {number} r.fix_id - fixes row this correction refers to
 * @param {string} r.timestamp - ISO timestamp of the snap
 * @param {number} r.dr_lat
 * @param {number} r.dr_lon
 * @param {number} r.fix_lat
 * @param {number} r.fix_lon
 * @param {number} r.deviation_nm
 * @param {number} r.deviation_bearing
 * @param {number} r.dr_elapsed_seconds
 * @param {string} [r.sail_state]
 * @param {string} [r.sea_state]
 * @returns {number} inserted correction_id
 */
function recordCorrection(db, r) {
  const stmt = db.prepare(
    `INSERT INTO dr_corrections (
       fix_id, timestamp, dr_lat, dr_lon, fix_lat, fix_lon,
       deviation_nm, deviation_bearing, dr_elapsed_seconds,
       sail_state, sea_state
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const info = stmt.run(
    r.fix_id,
    r.timestamp,
    r.dr_lat,
    r.dr_lon,
    r.fix_lat,
    r.fix_lon,
    r.deviation_nm,
    r.deviation_bearing,
    r.dr_elapsed_seconds,
    r.sail_state ?? null,
    r.sea_state ?? null,
  );
  return Number(info.lastInsertRowid);
}

/**
 * Records a fix (SPEC §4.4). Used on every confirmed fix that resets the
 * DR origin (§9.3) and by future fix-pipeline methods (celestial,
 * bearing, ...). Returns the new fix_id so a corresponding
 * dr_corrections row can reference it.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {object} r
 * @param {string} r.timestamp - ISO timestamp
 * @param {string} r.source_type - 'gps' | 'celestial' | 'bearing' | 'manual' | 'backfill'
 * @param {number} r.latitude
 * @param {number} r.longitude
 * @param {number} [r.estimated_error_radius]
 * @param {string} [r.confirmed_by]
 * @param {boolean} [r.resets_dr_origin]
 * @param {string} [r.notes]
 * @returns {number} inserted fix_id
 */
function recordFix(db, r) {
  const stmt = db.prepare(
    `INSERT INTO fixes (
       timestamp, source_type, latitude, longitude,
       estimated_error_radius, confirmed_by, resets_dr_origin, notes
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const info = stmt.run(
    r.timestamp,
    r.source_type,
    r.latitude,
    r.longitude,
    r.estimated_error_radius ?? null,
    r.confirmed_by ?? null,
    r.resets_dr_origin ? 1 : 0,
    r.notes ?? null,
  );
  return Number(info.lastInsertRowid);
}

/**
 * Records a line of position (SPEC §4.4). A LOP is the linearized local
 * form of an observation near an assumed position: a celestial sight
 * (intercept method), a compass bearing, or an RDF bearing. `used_in_fix_id`
 * is left NULL until the LOP is resolved into a confirmed fix via
 * `attachObservationsToFix`.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {object} r
 * @param {string} r.timestamp - ISO timestamp of the observation
 * @param {string} r.lop_type - 'celestial' | 'bearing' | 'rdf'
 * @param {number} r.assumed_lat - assumed position latitude (celestial) or observer latitude (bearing/rdf)
 * @param {number} r.assumed_lon - assumed position longitude
 * @param {number} r.azimuth_true - Zn (celestial) or measured bearing (deg true)
 * @param {number} [r.intercept_nm] - signed intercept, toward/away — celestial only
 * @param {string} [r.body_or_object] - 'Sun LL', 'Polaris', 'Radio Antenna XYZ'
 * @param {string} [r.confirmed_by]
 * @returns {number} inserted lop_id
 */
function recordLineOfPosition(db, r) {
  const stmt = db.prepare(
    `INSERT INTO lines_of_position (
       timestamp, lop_type, assumed_lat, assumed_lon, azimuth_true,
       intercept_nm, body_or_object, confirmed_by
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const info = stmt.run(
    r.timestamp,
    r.lop_type,
    r.assumed_lat,
    r.assumed_lon,
    r.azimuth_true,
    r.intercept_nm ?? null,
    r.body_or_object ?? null,
    r.confirmed_by ?? null,
  );
  return Number(info.lastInsertRowid);
}

/**
 * Records a circular position line (SPEC §4.4). A CPL is the exact
 * (un-linearized) form of an observation: a circle of equal altitude
 * (vertical-angle-to-known-object) or a ranged ADS-B contact. As with
 * LOPs, `used_in_fix_id` is NULL until attached to a confirmed fix.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {object} r
 * @param {string} r.timestamp - ISO timestamp
 * @param {string} r.cpl_type - 'vertical-angle' | 'adsb-ranged' | 'adsb-max-range'
 * @param {number} r.center_lat - charted object (static) or reporting object (transient)
 * @param {number} r.center_lon
 * @param {number} r.radius_nm - radius of the circle
 * @param {number} [r.radius_uncertainty_nm]
 * @param {string} [r.source_object] - chart ref, ICAO hex/callsign
 * @param {string} [r.confirmed_by]
 * @returns {number} inserted cpl_id
 */
function recordCircularPositionLine(db, r) {
  const stmt = db.prepare(
    `INSERT INTO circular_position_lines (
       timestamp, cpl_type, center_lat, center_lon, radius_nm,
       radius_uncertainty_nm, source_object, confirmed_by
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const info = stmt.run(
    r.timestamp,
    r.cpl_type,
    r.center_lat,
    r.center_lon,
    r.radius_nm,
    r.radius_uncertainty_nm ?? null,
    r.source_object ?? null,
    r.confirmed_by ?? null,
  );
  return Number(info.lastInsertRowid);
}

/**
 * Marks the given LOP and CPL rows as the observations that resolved into
 * a confirmed fix, by setting `used_in_fix_id` on each (SPEC §4.4). Call
 * after `recordFix` returns the fix_id. Missing/already-attached ids are
 * ignored rather than throwing, so partial inputs (a fix from a single
 * LOP) attach cleanly.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} fix_id
 * @param {object} ids
 * @param {number[]} [ids.lopIds]
 * @param {number[]} [ids.cplIds]
 */
function attachObservationsToFix(db, fixId, ids) {
  const lop = db.prepare(
    "UPDATE lines_of_position SET used_in_fix_id = ? WHERE lop_id = ?",
  );
  const cpl = db.prepare(
    "UPDATE circular_position_lines SET used_in_fix_id = ? WHERE cpl_id = ?",
  );
  for (const id of ids?.lopIds ?? []) lop.run(fixId, id);
  for (const id of ids?.cplIds ?? []) cpl.run(fixId, id);
}

/**
 * Reads recent `dr_corrections` rows for the uncertainty polygon's
 * empirical deviation-rate (SPEC §8). Returns rows newest-first so the
 * EWMA in `uncertainty.js` can apply them oldest→newest. Filters by
 * sail/sea state so the rate is condition-specific.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {object} q
 * @param {string} [q.sail_state]
 * @param {string} [q.sea_state]
 * @param {number} [q.limit=50]
 * @returns {Array<{deviation_nm: number, dr_elapsed_seconds: number}>}
 */
function getDeviationRateStats(db, q = {}) {
  const limit = q.limit ?? 50;
  const stmt = db.prepare(
    `SELECT deviation_nm, dr_elapsed_seconds
     FROM dr_corrections
     WHERE (? IS NULL OR sail_state = ?)
       AND (? IS NULL OR sea_state = ?)
     ORDER BY correction_id DESC
     LIMIT ?`,
  );
  return stmt.all(
    q.sail_state ?? null,
    q.sail_state ?? null,
    q.sea_state ?? null,
    q.sea_state ?? null,
    limit,
  );
}

module.exports = {
  SCHEMA_VERSION,
  SCHEMA_DDL,
  openDatabase,
  getState,
  setState,
  recordFix,
  recordLineOfPosition,
  recordCircularPositionLine,
  attachObservationsToFix,
  recordCorrection,
  getDeviationRateStats,
};
