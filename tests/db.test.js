/**
 * Tests for the SQLite persistence layer (SPEC §4).
 * @file db.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

const { openDatabase, getState, setState, SCHEMA_VERSION } =
  require("../plugin/db.js");

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
