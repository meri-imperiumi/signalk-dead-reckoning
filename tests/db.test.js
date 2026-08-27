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
  getDeviationRateStats,
  recordTrackSamples,
  pruneTrackSamplesBefore,
  loadTrackSamplesSince,
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
    "dr_track_samples",
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

test("getDeviationRateStats returns recent rows filtered by sail/sea state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-devstats-"));
  const db = openDatabase(join(dir, "t.sqlite"));
  const fix = (lat, lon) =>
    recordFix(db, {
      timestamp: "2026-01-01T00:00:00Z",
      source_type: "gps",
      latitude: lat,
      longitude: lon,
      resets_dr_origin: true,
    });
  const corr = (sail, sea, dev, secs) => {
    const fid = fix(60, 24);
    return recordCorrection(db, {
      fix_id: fid,
      timestamp: "2026-01-01T00:00:00Z",
      dr_lat: 60.01,
      dr_lon: 24.01,
      fix_lat: 60,
      fix_lon: 24,
      deviation_nm: dev,
      deviation_bearing: 200,
      dr_elapsed_seconds: secs,
      sail_state: sail,
      sea_state: sea,
    });
  };
  // Two sailing + unknown rows, one motoring row (different sail_state).
  corr("sailing", "unknown", 0.5, 1800);
  corr("sailing", "unknown", 0.3, 1800);
  corr("motoring", "unknown", 0.1, 1800);

  const sailingRows = getDeviationRateStats(db, {
    sail_state: "sailing",
    sea_state: "unknown",
  });
  assert.strictEqual(sailingRows.length, 2);
  // newest-first ordering
  assert.strictEqual(sailingRows[0].deviation_nm, 0.3);
  assert.strictEqual(sailingRows[1].deviation_nm, 0.5);

  // No filter returns all three.
  const allRows = getDeviationRateStats(db, {});
  assert.strictEqual(allRows.length, 3);

  // limit honoured.
  const limited = getDeviationRateStats(db, {
    sail_state: "sailing",
    limit: 1,
  });
  assert.strictEqual(limited.length, 1);
  assert.strictEqual(limited[0].deviation_nm, 0.3);

  // non-matching state returns none.
  const none = getDeviationRateStats(db, {
    sail_state: "motoring",
    sea_state: "calm",
  });
  assert.strictEqual(none.length, 0);

  db.close();
  await rm(dir, { recursive: true, force: true });
});

// --- Observation & fix CRUD (work doc #13 stage D) -------------------------

const {
  recordLineOfPosition,
  recordCircularPositionLine,
  getLineOfPosition,
  getCircularPositionLine,
  getFix,
  deleteLineOfPosition,
  deleteCircularPositionLine,
  deleteFix,
  updateLineOfPosition,
  updateCircularPositionLine,
  updateFix,
  attachObservationsToFix,
} = require("../plugin/db.js");

test("deleteLineOfPosition: deletes pending, refuses attached, 404s missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-db-crud-lop-"));
  const db = openDatabase(join(dir, "crud.sqlite"));
  const pendingId = recordLineOfPosition(db, {
    timestamp: "2026-01-01T00:00:00Z",
    lop_type: "bearing",
    assumed_lat: 60,
    assumed_lon: 24,
    azimuth_true: 45,
  });
  assert.deepStrictEqual(deleteLineOfPosition(db, pendingId), { ok: true });
  assert.strictEqual(getLineOfPosition(db, pendingId), undefined);

  // Attached: confirm a fix that uses the LOP, then refuse the delete.
  const fixId = recordFix(db, {
    timestamp: "2026-01-01T00:01:00Z",
    source_type: "bearing",
    latitude: 60.01,
    longitude: 24.01,
    resets_dr_origin: true,
  });
  const lopId = recordLineOfPosition(db, {
    timestamp: "2026-01-01T00:00:00Z",
    lop_type: "bearing",
    assumed_lat: 60,
    assumed_lon: 24,
    azimuth_true: 45,
  });
  attachObservationsToFix(db, fixId, { lopIds: [lopId], cplIds: [] });
  const refused = deleteLineOfPosition(db, lopId);
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.reason, "attached");
  assert.strictEqual(refused.fixId, fixId);
  assert.ok(getLineOfPosition(db, lopId), "row still there");

  // Missing id.
  assert.deepStrictEqual(deleteLineOfPosition(db, 99999), {
    ok: false,
    reason: "not_found",
  });
  db.close();
  await rm(dir, { recursive: true, force: true });
});

test("deleteCircularPositionLine: same guard as LOPs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-db-crud-cpl-"));
  const db = openDatabase(join(dir, "crud.sqlite"));
  const cplId = recordCircularPositionLine(db, {
    timestamp: "2026-01-01T00:00:00Z",
    cpl_type: "vertical-angle",
    center_lat: 60,
    center_lon: 24,
    radius_nm: 2,
  });
  assert.deepStrictEqual(deleteCircularPositionLine(db, cplId), { ok: true });
  assert.strictEqual(getCircularPositionLine(db, cplId), undefined);
  assert.deepStrictEqual(deleteCircularPositionLine(db, 99999), {
    ok: false,
    reason: "not_found",
  });

  const fixId = recordFix(db, {
    timestamp: "2026-01-01T00:01:00Z",
    source_type: "bearing",
    latitude: 60.01,
    longitude: 24.01,
    resets_dr_origin: true,
  });
  const attachedId = recordCircularPositionLine(db, {
    timestamp: "2026-01-01T00:00:00Z",
    cpl_type: "vertical-angle",
    center_lat: 60,
    center_lon: 24,
    radius_nm: 2,
  });
  attachObservationsToFix(db, fixId, { lopIds: [], cplIds: [attachedId] });
  const refused = deleteCircularPositionLine(db, attachedId);
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.reason, "attached");
  db.close();
  await rm(dir, { recursive: true, force: true });
});

test("deleteFix: returns observations to pending, drops correction + queued logbook", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-db-crud-fix-"));
  const db = openDatabase(join(dir, "crud.sqlite"));
  const fixId = recordFix(db, {
    timestamp: "2026-01-01T00:01:00Z",
    source_type: "bearing",
    latitude: 60.01,
    longitude: 24.01,
    resets_dr_origin: true,
    notes: "will be deleted",
  });
  const lopId = recordLineOfPosition(db, {
    timestamp: "2026-01-01T00:00:00Z",
    lop_type: "bearing",
    assumed_lat: 60,
    assumed_lon: 24,
    azimuth_true: 45,
  });
  const cplId = recordCircularPositionLine(db, {
    timestamp: "2026-01-01T00:00:30Z",
    cpl_type: "vertical-angle",
    center_lat: 60.02,
    center_lon: 24.02,
    radius_nm: 1.5,
  });
  attachObservationsToFix(db, fixId, { lopIds: [lopId], cplIds: [cplId] });
  recordCorrection(db, {
    fix_id: fixId,
    timestamp: "2026-01-01T00:01:00Z",
    dr_lat: 60,
    dr_lon: 24,
    fix_lat: 60.01,
    fix_lon: 24.01,
    deviation_nm: 0.7,
    deviation_bearing: 45,
    dr_elapsed_seconds: 600,
  });
  const { enqueueLogbookPending } = require("../plugin/db.js");
  enqueueLogbookPending(db, "fix", { text: "queued entry" }, fixId);

  assert.deepStrictEqual(deleteFix(db, fixId), { ok: true });
  // Fix + correction + queued logbook row gone.
  assert.strictEqual(getFix(db, fixId), undefined);
  assert.strictEqual(
    db
      .prepare("SELECT COUNT(*) AS n FROM dr_corrections WHERE fix_id = ?")
      .get(fixId).n,
    0,
  );
  assert.strictEqual(
    db
      .prepare("SELECT COUNT(*) AS n FROM logbook_pending WHERE fix_id = ?")
      .get(fixId).n,
    0,
  );
  // Observations survive and are pending again.
  const lop = getLineOfPosition(db, lopId);
  assert.ok(lop);
  assert.strictEqual(lop.used_in_fix_id, null);
  const cpl = getCircularPositionLine(db, cplId);
  assert.ok(cpl);
  assert.strictEqual(cpl.used_in_fix_id, null);
  // Missing id.
  assert.deepStrictEqual(deleteFix(db, 99999), {
    ok: false,
    reason: "not_found",
  });
  db.close();
  await rm(dir, { recursive: true, force: true });
});

test("updateLineOfPosition: edits allowed columns, ignores unknown, guards attached", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-db-crud-upd-"));
  const db = openDatabase(join(dir, "crud.sqlite"));
  const lopId = recordLineOfPosition(db, {
    timestamp: "2026-01-01T00:00:00Z",
    lop_type: "bearing",
    assumed_lat: 60,
    assumed_lon: 24,
    azimuth_true: 45,
    body_or_object: "Rock",
  });
  const result = updateLineOfPosition(db, lopId, {
    azimuth_true: 52,
    body_or_object: "North Rock",
    lop_type: "celestial", // not editable — ignored
    assumed_lat: 60.001,
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.row.azimuth_true, 52);
  assert.strictEqual(result.row.body_or_object, "North Rock");
  assert.strictEqual(result.row.assumed_lat, 60.001);
  assert.strictEqual(result.row.lop_type, "bearing", "type not editable");

  // No editable fields → refusal the route maps to 400.
  assert.deepStrictEqual(updateLineOfPosition(db, lopId, { lop_type: "rdf" }), {
    ok: false,
    reason: "no_fields",
  });

  // Attached → refuse.
  const fixId = recordFix(db, {
    timestamp: "2026-01-01T00:01:00Z",
    source_type: "bearing",
    latitude: 60.01,
    longitude: 24.01,
    resets_dr_origin: true,
  });
  attachObservationsToFix(db, fixId, { lopIds: [lopId], cplIds: [] });
  const refused = updateLineOfPosition(db, lopId, { azimuth_true: 10 });
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.reason, "attached");

  assert.deepStrictEqual(updateLineOfPosition(db, 99999, { azimuth_true: 1 }), {
    ok: false,
    reason: "not_found",
  });
  db.close();
  await rm(dir, { recursive: true, force: true });
});

test("updateCircularPositionLine: edits center/radius/object", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-db-crud-updc-"));
  const db = openDatabase(join(dir, "crud.sqlite"));
  const cplId = recordCircularPositionLine(db, {
    timestamp: "2026-01-01T00:00:00Z",
    cpl_type: "vertical-angle",
    center_lat: 60,
    center_lon: 24,
    radius_nm: 2,
    source_object: "light",
  });
  const result = updateCircularPositionLine(db, cplId, {
    radius_nm: 2.75,
    center_lon: 24.02,
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.row.radius_nm, 2.75);
  assert.strictEqual(result.row.center_lon, 24.02);
  db.close();
  await rm(dir, { recursive: true, force: true });
});

test("updateFix: edits audit metadata, guards position/source_type/timestamp", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-db-crud-updf-"));
  const db = openDatabase(join(dir, "crud.sqlite"));
  const fixId = recordFix(db, {
    timestamp: "2026-01-01T00:01:00Z",
    source_type: "bearing",
    latitude: 60.01,
    longitude: 24.01,
    resets_dr_origin: true,
  });
  const result = updateFix(db, fixId, { notes: "re-checked on chart" });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.row.notes, "re-checked on chart");

  // Guarded columns.
  const guarded = updateFix(db, fixId, { latitude: 61 });
  assert.strictEqual(guarded.ok, false);
  assert.strictEqual(guarded.reason, "guarded");
  assert.deepStrictEqual(guarded.fields, ["latitude"]);
  const both = updateFix(db, fixId, { longitude: 25, source_type: "gps" });
  assert.deepStrictEqual(both.fields, ["longitude", "source_type"]);

  // Same-value guarded fields are tolerated (no-op, not a refusal).
  const same = updateFix(db, fixId, {
    latitude: 60.01,
    notes: "again",
  });
  assert.strictEqual(same.ok, true);

  assert.deepStrictEqual(updateFix(db, 99999, { notes: "x" }), {
    ok: false,
    reason: "not_found",
  });
  db.close();
  await rm(dir, { recursive: true, force: true });
});

test("track samples: record, incremental re-record (replace), prune, load", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-db-track-"));
  const db = openDatabase(join(dir, "t.sqlite"));

  // Empty write is a no-op.
  recordTrackSamples(db, []);

  const t0 = 1_000_000;
  recordTrackSamples(
    db,
    [0, 1, 2].map((i) => ({
      timestamp: t0 + i * 1000,
      latitude: -18.86 + i * 0.01,
      longitude: -159.8 + i * 0.01,
    })),
  );
  let loaded = loadTrackSamplesSince(db, t0 - 1);
  assert.strictEqual(loaded.length, 3);
  assert.deepStrictEqual(loaded[0], {
    timestamp: t0,
    latitude: -18.86,
    longitude: -159.8,
  });
  // Oldest-first ordering.
  assert.strictEqual(loaded[2].timestamp, t0 + 2000);

  // Same-timestamp sample replaces (GroundTrack.append semantics).
  recordTrackSamples(db, [
    { timestamp: t0 + 1000, latitude: -18.5, longitude: -159.5 },
  ]);
  loaded = loadTrackSamplesSince(db, t0 + 999);
  assert.strictEqual(loaded.length, 2);
  assert.strictEqual(loaded[0].latitude, -18.5);

  // Prune older than cutoff; `since` is inclusive of the boundary.
  pruneTrackSamplesBefore(db, t0 + 1000);
  loaded = loadTrackSamplesSince(db, 0);
  assert.deepStrictEqual(
    loaded.map((s) => s.timestamp),
    [t0 + 1000, t0 + 2000],
  );

  db.close();
  await rm(dir, { recursive: true, force: true });
});
