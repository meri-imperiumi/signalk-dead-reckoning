/**
 * Tests for the SQLite persistence layer (SPEC §4).
 * @file db.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

const {
  openDatabase,
  getState,
  setState,
  recordFix,
  recordCorrection,
  SCHEMA_VERSION,
} = require("../plugin/db.js");

let tempDir;

test.before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "dr-db-"));
});

test.after(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

test("openDatabase creates all SPEC §4 tables idempotently", () => {
  const db = openDatabase(join(tempDir, "a.sqlite"));
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);
  for (const expected of [
    "dr_matrix_bins",
    "dr_state_store",
    "offline_pilot_currents",
    "fixes",
    "lines_of_position",
    "circular_position_lines",
    "dr_corrections",
    "anchor_swing_stats",
    "moored_position_stats",
    "gps_anomalies",
  ]) {
    assert.ok(tables.includes(expected), `missing table ${expected}`);
  }
  // Re-open is idempotent (no throw).
  db.close();
  const db2 = openDatabase(join(tempDir, "a.sqlite"));
  db2.close();
});

test("openDatabase records the schema version in dr_state_store", () => {
  const db = openDatabase(join(tempDir, "b.sqlite"));
  assert.strictEqual(getState(db, "schema_version"), String(SCHEMA_VERSION));
  db.close();
});

test("setState upserts and getState reads back", () => {
  const db = openDatabase(join(tempDir, "c.sqlite"));
  setState(db, "dr_log_nm", "123.45");
  assert.strictEqual(getState(db, "dr_log_nm"), "123.45");
  setState(db, "dr_log_nm", "200");
  assert.strictEqual(getState(db, "dr_log_nm"), "200");
  assert.strictEqual(getState(db, "missing"), undefined);
  db.close();
});

test("dr_matrix_bins primary key enforces bin-level uniqueness", () => {
  const db = openDatabase(join(tempDir, "d.sqlite"));
  const ins = db.prepare(
    `INSERT INTO dr_matrix_bins (sail_state, sea_state, stw_bin, awa_bin, heel_bin,
       leeway_angle, speed_loss, upwash_correction, hit_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  ins.run("sailing", "unknown", 5, 45, 10, 3, 0.05, 1, 1);
  // Same key again must conflict.
  assert.throws(() => ins.run("sailing", "unknown", 5, 45, 10, 4, 0.06, 2, 1));
  // Different heel bin is a distinct row.
  ins.run("sailing", "unknown", 5, 45, 12, 4, 0.06, 2, 1);
  const count = db.prepare("SELECT COUNT(*) AS n FROM dr_matrix_bins").get().n;
  assert.strictEqual(count, 2);
  db.close();
});

test("recordFix inserts a fixes row and returns its id", () => {
  const db = openDatabase(join(tempDir, "e.sqlite"));
  const id = recordFix(db, {
    timestamp: "2026-01-01T00:00:00Z",
    source_type: "gps",
    latitude: 60.1,
    longitude: 24.9,
    confirmed_by: "crew",
    resets_dr_origin: true,
  });
  assert.strictEqual(typeof id, "number");
  assert.ok(id > 0);
  const row = db.prepare("SELECT * FROM fixes WHERE fix_id = ?").get(id);
  assert.strictEqual(row.source_type, "gps");
  assert.strictEqual(row.latitude, 60.1);
  assert.strictEqual(row.confirmed_by, "crew");
  assert.strictEqual(row.resets_dr_origin, 1);
  assert.strictEqual(row.logged_to_logbook, 0); // default
  db.close();
});

test("recordCorrection inserts a dr_corrections row referencing a fix", () => {
  const db = openDatabase(join(tempDir, "f.sqlite"));
  const fixId = recordFix(db, {
    timestamp: "2026-01-01T00:00:00Z",
    source_type: "gps",
    latitude: 60,
    longitude: 24,
    resets_dr_origin: true,
  });
  const cid = recordCorrection(db, {
    fix_id: fixId,
    timestamp: "2026-01-01T00:00:00Z",
    dr_lat: 60.01,
    dr_lon: 24.01,
    fix_lat: 60,
    fix_lon: 24,
    deviation_nm: 0.62,
    deviation_bearing: 200,
    dr_elapsed_seconds: 2700,
    sail_state: "sailing",
    sea_state: "unknown",
  });
  assert.ok(cid > 0);
  const row = db
    .prepare("SELECT * FROM dr_corrections WHERE correction_id = ?")
    .get(cid);
  assert.strictEqual(row.fix_id, fixId);
  assert.strictEqual(row.deviation_nm, 0.62);
  assert.strictEqual(row.dr_elapsed_seconds, 2700);
  assert.strictEqual(row.sail_state, "sailing");
  db.close();
});
