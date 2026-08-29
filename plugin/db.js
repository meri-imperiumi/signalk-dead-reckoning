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

/** Schema version, bumped when a migration is needed. Persisted in dr_state_store.
 * v2: `fixes.derived_from_fix_id` — provenance for single-observation
 * running fixes advanced from a previous confirmed fix. */
const SCHEMA_VERSION = 2;

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
    derived_from_fix_id INTEGER,
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

  // §9.5: entries awaiting a logbook token (access-request approval
  // window, or token expiry mid-write). Persisted so a plugin restart
  // doesn't lose the approval-window entries; bounded by MAX_PENDING.
  // `fix_id` links a queued fix entry back to its `fixes` row so the
  // delayed flush can mark it logged (the confirm route's own .then
  // only fires when the write is immediate, not queued).
  `CREATE TABLE IF NOT EXISTS logbook_pending (
    pending_id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    kind TEXT NOT NULL,
    fix_id INTEGER,
    payload TEXT NOT NULL
  )`,

  // §9.1 restart survival: the running-fix advancement ring buffer
  // (GroundTrack) is in-memory; these rows persist it so a mid-passage
  // server restart keeps displacementBetween() working for sights
  // taken before the restart. Keyed on the sample timestamp (ms) with
  // INSERT OR REPLACE to mirror GroundTrack.append's same-ms replace.
  `CREATE TABLE IF NOT EXISTS dr_track_samples (
    timestamp INTEGER PRIMARY KEY,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL
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
  // v1 → v2: running-fix provenance column on `fixes`. Fresh databases
  // get the column from the DDL above; existing ones are altered in
  // place. The stored version is read *after* the DDL (it creates
  // dr_state_store on a fresh database, where there is nothing to
  // migrate) and *before* the new version is recorded below.
  const storedVersion = getState(db, "schema_version");
  if (storedVersion != null && Number(storedVersion) < 2) {
    db.exec("ALTER TABLE fixes ADD COLUMN derived_from_fix_id INTEGER");
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
 * @param {number} [r.derived_from_fix_id] - the fix this running fix was
 *   advanced from (single-observation running fix)
 * @param {string} [r.notes]
 * @returns {number} inserted fix_id
 */
function recordFix(db, r) {
  const stmt = db.prepare(
    `INSERT INTO fixes (
       timestamp, source_type, latitude, longitude,
       estimated_error_radius, confirmed_by, resets_dr_origin,
       derived_from_fix_id, notes
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const info = stmt.run(
    r.timestamp,
    r.source_type,
    r.latitude,
    r.longitude,
    r.estimated_error_radius ?? null,
    r.confirmed_by ?? null,
    r.resets_dr_origin ? 1 : 0,
    r.derived_from_fix_id ?? null,
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

/**
 * Marks a `fixes` row as written to the signalk-logbook, storing the
 * entry reference (its datetime key). A failed write leaves the row
 * unmarked — visible in `fixes`, never blocking the fix flow.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} fixId
 * @param {string|null} logbookRef - entry datetime key
 * @returns {void}
 */
function markFixLogged(db, fixId, logbookRef) {
  db.prepare(
    "UPDATE fixes SET logged_to_logbook = 1, logbook_entry_ref = ? WHERE fix_id = ?",
  ).run(logbookRef ?? null, fixId);
}

/** Max queued logbook entries (approval window + retry storms). */
const MAX_PENDING = 200;

/**
 * Queues a logbook entry for later delivery (tokenless window). Oldest
 * entries are dropped beyond MAX_PENDING — bounded storage, newest data
 * wins; the plugin DB remains the source of truth for anything numeric.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} kind - 'fix' | 'tack' | 'observation'
 * @param {object} payload - NewEntry-shaped body
 * @returns {void}
 */
function enqueueLogbookPending(db, kind, payload, fixId = null) {
  db.prepare(
    "INSERT INTO logbook_pending (created_at, kind, fix_id, payload) VALUES (?, ?, ?, ?)",
  ).run(new Date().toISOString(), kind, fixId, JSON.stringify(payload));
  db.prepare(
    "DELETE FROM logbook_pending WHERE pending_id <= (SELECT MAX(pending_id) FROM logbook_pending) - ?",
  ).run(MAX_PENDING);
}

/**
 * Lists queued logbook entries, oldest first, for the flush.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @returns {Array<{pending_id: number, created_at: string, kind: string, payload: object}>}
 */
function listLogbookPending(db) {
  return db
    .prepare(
      "SELECT pending_id, created_at, kind, fix_id, payload FROM logbook_pending ORDER BY pending_id",
    )
    .all()
    .map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
}

/**
 * Drops a queued entry after successful delivery.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} pendingId
 * @returns {void}
 */
function dequeueLogbookPending(db, pendingId) {
  db.prepare("DELETE FROM logbook_pending WHERE pending_id = ?").run(pendingId);
}

/**
 * Lists recent confirmed fixes for the UI (SPEC §14.1 fix points).
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {object} [q]
 * @param {number} [q.limit=100]
 * @returns {Array<object>} newest-first
 */
function listFixes(db, q = {}) {
  return db
    .prepare(
      `SELECT fix_id, timestamp, source_type, latitude, longitude,
              estimated_error_radius, confirmed_by, resets_dr_origin,
              derived_from_fix_id
       FROM fixes ORDER BY fix_id DESC LIMIT ?`,
    )
    .all(q.limit ?? 100);
}

/**
 * Fetches a single line of position by id (for resolving a fix from
 * persisted observation ids without the client re-sending the
 * observation bodies).
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} id
 * @returns {object|null}
 */
function getLineOfPosition(db, id) {
  return db
    .prepare(
      `SELECT lop_id, timestamp, lop_type, assumed_lat, assumed_lon,
              azimuth_true, intercept_nm, body_or_object, used_in_fix_id
       FROM lines_of_position WHERE lop_id = ?`,
    )
    .get(id);
}

/**
 * Fetches a single circular position line by id.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} id
 * @returns {object|null}
 */
function getCircularPositionLine(db, id) {
  return db
    .prepare(
      `SELECT cpl_id, timestamp, cpl_type, center_lat, center_lon,
              radius_nm, source_object, used_in_fix_id
       FROM circular_position_lines WHERE cpl_id = ?`,
    )
    .get(id);
}

/**
 * Lists persisted lines of position for the UI (SPEC §14.1 LOP overlay).
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {object} [q]
 * @param {number} [q.limit=100]
 * @returns {Array<object>} newest-first
 */
function listLinesOfPosition(db, q = {}) {
  return db
    .prepare(
      `SELECT lop_id, timestamp, lop_type, assumed_lat, assumed_lon,
              azimuth_true, intercept_nm, body_or_object, used_in_fix_id
       FROM lines_of_position ORDER BY lop_id DESC LIMIT ?`,
    )
    .all(q.limit ?? 100);
}

/**
 * Lists persisted circular position lines for the UI (SPEC §14.1 CPL
 * overlay — distinct primitive from LOPs).
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {object} [q]
 * @param {number} [q.limit=100]
 * @returns {Array<object>} newest-first
 */
function listCircularPositionLines(db, q = {}) {
  return db
    .prepare(
      `SELECT cpl_id, timestamp, center_lat, center_lon, radius_nm,
              source_object, used_in_fix_id
       FROM circular_position_lines ORDER BY cpl_id DESC LIMIT ?`,
    )
    .all(q.limit ?? 100);
}

/**
 * Lists recent snap-to-fix corrections for the UI (SPEC §9.3/§14.1 —
 * dashed vector from pre-snap ghost position to confirmed fix).
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {object} [q]
 * @param {number} [q.limit=20]
 * @returns {Array<object>} newest-first
 */
function listCorrections(db, q = {}) {
  return db
    .prepare(
      `SELECT correction_id, timestamp, dr_lat, dr_lon, fix_lat, fix_lon,
              deviation_nm, deviation_bearing, dr_elapsed_seconds,
              sail_state, sea_state
       FROM dr_corrections ORDER BY correction_id DESC LIMIT ?`,
    )
    .all(q.limit ?? 20);
}

// -------------------------------------------------------------------------
// Observation & fix CRUD (work doc #13 stage D)
//
// Guard policy: a LOP/CPL already resolved into a confirmed fix
// (`used_in_fix_id IS NOT NULL`) is part of the navigational record and
// must not be silently edited or deleted — the honest path is deleting
// the fix first, which un-confirms it and returns the observations to
// pending. The helpers surface refusals as result objects so the REST
// layer can answer 409 with the attached fix id.
// -------------------------------------------------------------------------

/**
 * @typedef {Object} CrudResult
 * @property {boolean} ok
 * @property {"not_found"|"attached"|"guarded"|"no_fields"} [reason]
 * @property {number} [fixId] - the fix blocking an attached observation
 * @property {Array<string>} [fields] - guarded field names, for the message
 * @property {object} [row] - the row after a successful update
 */

/**
 * Deletes a pending line of position. Refuses when the LOP is attached
 * to a confirmed fix (delete the fix instead — its observations return
 * to pending).
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} id
 * @returns {CrudResult}
 */
function deleteLineOfPosition(db, id) {
  const row = getLineOfPosition(db, id);
  if (!row) return { ok: false, reason: "not_found" };
  if (row.used_in_fix_id != null) {
    return { ok: false, reason: "attached", fixId: row.used_in_fix_id };
  }
  db.prepare("DELETE FROM lines_of_position WHERE lop_id = ?").run(id);
  return { ok: true };
}

/**
 * Deletes a pending circular position line, with the same attached-to-fix
 * guard as {@link deleteLineOfPosition}.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} id
 * @returns {CrudResult}
 */
function deleteCircularPositionLine(db, id) {
  const row = getCircularPositionLine(db, id);
  if (!row) return { ok: false, reason: "not_found" };
  if (row.used_in_fix_id != null) {
    return { ok: false, reason: "attached", fixId: row.used_in_fix_id };
  }
  db.prepare("DELETE FROM circular_position_lines WHERE cpl_id = ?").run(id);
  return { ok: true };
}

/**
 * Deletes a confirmed fix and un-confirms it: the LOP/CPL rows that
 * resolved into it are returned to pending (`used_in_fix_id` NULL), the
 * matching `dr_corrections` row and any queued logbook entry are
 * dropped. The DR origin is NOT rewound — deleting a fix is a
 * data-correction, not a time machine.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} id
 * @returns {CrudResult}
 */
function deleteFix(db, id) {
  const row = db.prepare("SELECT fix_id FROM fixes WHERE fix_id = ?").get(id);
  if (!row) return { ok: false, reason: "not_found" };
  db.prepare(
    "UPDATE lines_of_position SET used_in_fix_id = NULL WHERE used_in_fix_id = ?",
  ).run(id);
  db.prepare(
    "UPDATE circular_position_lines SET used_in_fix_id = NULL WHERE used_in_fix_id = ?",
  ).run(id);
  db.prepare("DELETE FROM dr_corrections WHERE fix_id = ?").run(id);
  db.prepare("DELETE FROM logbook_pending WHERE fix_id = ?").run(id);
  db.prepare("DELETE FROM fixes WHERE fix_id = ?").run(id);
  return { ok: true };
}

/**
 * Fetches a single fix row with the full record (incl. notes) for the
 * detail popover / edit round-trip.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} id
 * @returns {object|null}
 */
function getFix(db, id) {
  return db
    .prepare(
      `SELECT fix_id, timestamp, source_type, latitude, longitude,
              estimated_error_radius, confirmed_by, resets_dr_origin,
              notes, logged_to_logbook, logbook_entry_ref, derived_from_fix_id
       FROM fixes WHERE fix_id = ?`,
    )
    .get(id);
}

/** Columns a pending LOP may be edited on (geometry + object label). */
const LOP_EDITABLE_COLUMNS = [
  "body_or_object",
  "assumed_lat",
  "assumed_lon",
  "azimuth_true",
  "intercept_nm",
];

/** Columns a pending CPL may be edited on. */
const CPL_EDITABLE_COLUMNS = [
  "source_object",
  "center_lat",
  "center_lon",
  "radius_nm",
];

/**
 * Partially updates a pending LOP. Refuses attached observations for the
 * same reason as delete: editing a LOP that already produced a confirmed
 * fix would silently invalidate the fix.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} id
 * @param {object} fields - subset of LOP_EDITABLE_COLUMNS; unknown ignored
 * @returns {CrudResult}
 */
function updateLineOfPosition(db, id, fields) {
  const row = getLineOfPosition(db, id);
  if (!row) return { ok: false, reason: "not_found" };
  if (row.used_in_fix_id != null) {
    return { ok: false, reason: "attached", fixId: row.used_in_fix_id };
  }
  return updateRow(
    db,
    "lines_of_position",
    "lop_id",
    id,
    LOP_EDITABLE_COLUMNS,
    fields,
    getLineOfPosition,
  );
}

/**
 * Partially updates a pending CPL (same guard as LOPs).
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} id
 * @param {object} fields - subset of CPL_EDITABLE_COLUMNS; unknown ignored
 * @returns {CrudResult}
 */
function updateCircularPositionLine(db, id, fields) {
  const row = getCircularPositionLine(db, id);
  if (!row) return { ok: false, reason: "not_found" };
  if (row.used_in_fix_id != null) {
    return { ok: false, reason: "attached", fixId: row.used_in_fix_id };
  }
  return updateRow(
    db,
    "circular_position_lines",
    "cpl_id",
    id,
    CPL_EDITABLE_COLUMNS,
    fields,
    getCircularPositionLine,
  );
}

/** Columns a fix may be edited on — audit metadata only. */
const FIX_EDITABLE_COLUMNS = [
  "notes",
  "confirmed_by",
  "estimated_error_radius",
];

/** Fix columns that must never change after confirmation. */
const FIX_GUARDED_COLUMNS = [
  "latitude",
  "longitude",
  "source_type",
  "timestamp",
];

/**
 * Partially updates a fix's audit metadata (notes, confirmed_by,
 * estimated error radius). Position and source_type are guarded: a
 * fix's position is the output of an observation — repositioning it is
 * "delete + manual fix entry", not an edit (keeps the fix table
 * auditable).
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} id
 * @param {object} fields
 * @returns {CrudResult}
 */
function updateFix(db, id, fields) {
  const row = getFix(db, id);
  if (!row) return { ok: false, reason: "not_found" };
  const guarded = FIX_GUARDED_COLUMNS.filter(
    (c) => fields[c] !== undefined && fields[c] !== row[c],
  );
  if (guarded.length > 0) {
    return { ok: false, reason: "guarded", fields: guarded };
  }
  return updateRow(
    db,
    "fixes",
    "fix_id",
    id,
    FIX_EDITABLE_COLUMNS,
    fields,
    getFix,
  );
}

/**
 * Shared partial-update runner: builds `SET` from the allowed columns
 * present in `fields`, runs it, and returns the refreshed row.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} table
 * @param {string} idCol
 * @param {number} id
 * @param {Array<string>} allowed
 * @param {object} fields
 * @param {(db: object, id: number) => object|null} getter - re-reads the row
 * @returns {CrudResult}
 */
function updateRow(db, table, idCol, id, allowed, fields, getter) {
  const sets = [];
  const vals = [];
  for (const col of allowed) {
    if (fields[col] !== undefined) {
      sets.push(`${col} = ?`);
      vals.push(fields[col]);
    }
  }
  if (sets.length === 0) return { ok: false, reason: "no_fields" };
  vals.push(id);
  db.prepare(`UPDATE ${table} SET ${sets.join(", ")} WHERE ${idCol} = ?`).run(
    ...vals,
  );
  return { ok: true, row: getter(db, id) };
}

/**
 * Persists ground-track samples (running-fix advancement buffer).
 * INSERT OR REPLACE matches GroundTrack.append's same-timestamp
 * replace semantics.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{timestamp: number, latitude: number, longitude: number}[]} samples
 * @returns {void}
 */
function recordTrackSamples(db, samples) {
  if (samples.length === 0) return;
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO dr_track_samples (timestamp, latitude, longitude) VALUES (?, ?, ?)",
  );
  db.exec("BEGIN");
  try {
    for (const s of samples) {
      stmt.run(s.timestamp, s.latitude, s.longitude);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Deletes ground-track samples older than the cutoff (ms epoch).
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} cutoffMs
 * @returns {void}
 */
function pruneTrackSamplesBefore(db, cutoffMs) {
  db.prepare("DELETE FROM dr_track_samples WHERE timestamp < ?").run(cutoffMs);
}

/**
 * Loads ground-track samples taken at/after `sinceMs`, oldest first —
 * used to seed a fresh GroundTrack after a restart.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} sinceMs
 * @returns {{timestamp: number, latitude: number, longitude: number}[]}
 */
function loadTrackSamplesSince(db, sinceMs) {
  return db
    .prepare(
      "SELECT timestamp, latitude, longitude FROM dr_track_samples WHERE timestamp >= ? ORDER BY timestamp",
    )
    .all(sinceMs)
    .map((r) => ({
      timestamp: Number(r.timestamp),
      latitude: Number(r.latitude),
      longitude: Number(r.longitude),
    }));
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
  markFixLogged,
  enqueueLogbookPending,
  recordTrackSamples,
  pruneTrackSamplesBefore,
  loadTrackSamplesSince,
  listLogbookPending,
  dequeueLogbookPending,
  listFixes,
  getLineOfPosition,
  getCircularPositionLine,
  listLinesOfPosition,
  listCircularPositionLines,
  listCorrections,
  getFix,
  deleteLineOfPosition,
  deleteCircularPositionLine,
  deleteFix,
  updateLineOfPosition,
  updateCircularPositionLine,
  updateFix,
};
