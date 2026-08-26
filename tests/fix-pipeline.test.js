/**
 * Tests for the unified fix-confirmation pipeline (SPEC §4.4, §9.1, §9.3).
 *
 * Uses the real `db.js` (temp SQLite files) and a fake DR engine so the
 * persistence + orchestration is exercised end-to-end without the full
 * Signal K plugin wiring.
 * @file fix-pipeline.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

const {
  openDatabase,
  recordFix,
  recordCorrection,
  recordLineOfPosition,
  recordCircularPositionLine,
  attachObservationsToFix,
  getLineOfPosition,
  getCircularPositionLine,
} = require("../plugin/db.js");
const { distanceNm, bearingDeg } = require("../plugin/geo.js");
const {
  resolveCandidateFix,
  confirmFix,
  loadObservationsById,
} = require("../plugin/fix-pipeline.js");

let tempDir;

test.before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "dr-pipeline-"));
});

test.after(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

/** Real db helpers + geo helpers, as the pipeline expects them. */
const helpers = {
  recordFix,
  recordCorrection,
  recordLineOfPosition,
  recordCircularPositionLine,
  attachObservationsToFix,
  distanceNm,
  bearingDeg,
};

/**
 * Minimal fake DR engine: tracks origin + elapsed and records snaps so
 * tests can assert on them.
 */
function fakeEngine(origin, elapsed = 0) {
  const snaps = [];
  return {
    origin,
    elapsedSinceOriginS: elapsed,
    snapToFix(fix) {
      this.origin = { latitude: fix.latitude, longitude: fix.longitude };
      this.elapsedSinceOriginS = 0;
      snaps.push(fix);
    },
    snaps,
  };
}

test("resolveCandidateFix: GPS point returns the point with zero residual", () => {
  const c = resolveCandidateFix({
    source_type: "gps",
    point: { latitude: 60, longitude: 24 },
    engine: fakeEngine({ latitude: 59.9, longitude: 23.9 }),
  });
  assert.ok(c);
  assert.strictEqual(c.source_type, "gps");
  assert.strictEqual(c.latitude, 60);
  assert.strictEqual(c.longitude, 24);
  assert.strictEqual(c.residual_nm, 0);
  assert.strictEqual(c.alternate, null);
  assert.deepStrictEqual(c.observationIds, { lopIds: [], cplIds: [] });
});

test("resolveCandidateFix: two crossing LOPs resolve to a candidate", () => {
  const lopIds = [];
  // Persist two LOPs first (the pipeline expects pre-persisted ids).
  const db = openDatabase(join(tempDir, "lop.sqlite"));
  lopIds.push(
    recordLineOfPosition(db, {
      timestamp: "2026-01-01T00:00:00Z",
      lop_type: "bearing",
      assumed_lat: 60,
      assumed_lon: 24,
      azimuth_true: 0,
      body_or_object: "Rock A",
    }),
  );
  lopIds.push(
    recordLineOfPosition(db, {
      timestamp: "2026-01-01T00:01:00Z",
      lop_type: "bearing",
      assumed_lat: 60,
      assumed_lon: 24,
      azimuth_true: 90,
      body_or_object: "Rock B",
    }),
  );

  const c = resolveCandidateFix({
    source_type: "bearing",
    observations: [
      { kind: "lop", assumed_lat: 60, assumed_lon: 24, azimuth_true: 0 },
      { kind: "lop", assumed_lat: 60, assumed_lon: 24, azimuth_true: 90 },
    ],
    observationIds: { lopIds, cplIds: [] },
    drPosition: { latitude: 60.02, longitude: 24.01 },
  });
  assert.ok(c);
  assert.ok(Math.abs(c.latitude - 60) < 1e-6);
  assert.ok(Math.abs(c.longitude - 24) < 1e-6);
  assert.deepStrictEqual(c.observationIds.lopIds, lopIds);
  db.close();
});

test("resolveCandidateFix: hydrates observations from lop_ids when no inline observations", () => {
  const lopIds = [];
  const db = openDatabase(join(tempDir, "hydrate.sqlite"));
  lopIds.push(
    recordLineOfPosition(db, {
      timestamp: "2026-01-01T00:00:00Z",
      lop_type: "bearing",
      assumed_lat: 60,
      assumed_lon: 24,
      azimuth_true: 0,
      body_or_object: "Rock A",
    }),
  );
  lopIds.push(
    recordLineOfPosition(db, {
      timestamp: "2026-01-01T00:01:00Z",
      lop_type: "bearing",
      assumed_lat: 60,
      assumed_lon: 24,
      azimuth_true: 90,
      body_or_object: "Rock B",
    }),
  );
  // No inline observations — only lop_ids. The pipeline must load them.
  const c = resolveCandidateFix({
    source_type: "bearing",
    observationIds: { lopIds, cplIds: [] },
    drPosition: { latitude: 60.02, longitude: 24.01 },
    db,
    helpers: { getLineOfPosition, getCircularPositionLine },
  });
  assert.ok(c, "should resolve from hydrated ids");
  assert.ok(Math.abs(c.latitude - 60) < 1e-6);
  assert.ok(Math.abs(c.longitude - 24) < 1e-6);
  db.close();
});

test("loadObservationsById: shapes LOP + CPL rows into resolver inputs", () => {
  const db = openDatabase(join(tempDir, "loadby.sqlite"));
  const lopId = recordLineOfPosition(db, {
    timestamp: "2026-01-01T00:00:00Z",
    lop_type: "bearing",
    assumed_lat: 60,
    assumed_lon: 24,
    azimuth_true: 45,
  });
  const cplId = recordCircularPositionLine(db, {
    timestamp: "2026-01-01T00:00:00Z",
    cpl_type: "vertical-angle",
    center_lat: 60.01,
    center_lon: 24.01,
    radius_nm: 2,
  });
  const obs = loadObservationsById(
    db,
    { getLineOfPosition, getCircularPositionLine },
    [lopId],
    [cplId],
  );
  assert.strictEqual(obs.length, 2);
  assert.strictEqual(obs[0].kind, "lop");
  assert.strictEqual(obs[0].azimuth_true, 45);
  assert.strictEqual(obs[1].kind, "cpl");
  assert.strictEqual(obs[1].radius_nm, 2);
  db.close();
});

test("resolveCandidateFix: single LOP with no point → null (not resolvable)", () => {
  const c = resolveCandidateFix({
    source_type: "celestial",
    observations: [
      { kind: "lop", assumed_lat: 60, assumed_lon: 24, azimuth_true: 0 },
    ],
    drPosition: { latitude: 60, longitude: 24 },
  });
  assert.strictEqual(c, null);
});

test("resolveCandidateFix: Circle×Circle surfaces an alternate candidate", () => {
  const c = resolveCandidateFix({
    source_type: "celestial",
    observations: [
      { kind: "cpl", center_lat: 60, center_lon: 24, radius_nm: 3 },
      { kind: "cpl", center_lat: 60 + 2 / 60, center_lon: 24, radius_nm: 3 },
    ],
    drPosition: { latitude: 60.04, longitude: 24.1 },
  });
  assert.ok(c);
  assert.ok(c.alternate, "Circle×Circle should surface an alternate");
});

test("confirmFix: GPS point writes a fixes row, snaps engine, records correction", () => {
  const db = openDatabase(join(tempDir, "gps.sqlite"));
  const engine = fakeEngine({ latitude: 60.01, longitude: 24.01 }, 1800);
  const candidate = {
    source_type: "gps",
    latitude: 60,
    longitude: 24,
    residual_nm: 0,
    alternate: null,
    observationIds: { lopIds: [], cplIds: [] },
  };
  const res = confirmFix(db, candidate, engine, helpers, {
    confirmedBy: "alice",
    sailState: "sailing",
    seaState: "calm",
    timestamp: "2026-01-01T00:30:00Z",
  });
  assert.ok(res.fix_id > 0);
  assert.ok(res.correction_id > 0);
  assert.ok(res.deviation_nm > 0);
  assert.strictEqual(
    res.deviation_bearing,
    bearingDeg(
      { latitude: 60.01, longitude: 24.01 },
      { latitude: 60, longitude: 24 },
    ),
  );

  // fixes row
  const fix = db
    .prepare("SELECT * FROM fixes WHERE fix_id = ?")
    .get(res.fix_id);
  assert.strictEqual(fix.source_type, "gps");
  assert.strictEqual(fix.confirmed_by, "alice");
  assert.strictEqual(fix.resets_dr_origin, 1);

  // dr_corrections row
  const corr = db
    .prepare("SELECT * FROM dr_corrections WHERE correction_id = ?")
    .get(res.correction_id);
  assert.strictEqual(corr.fix_id, res.fix_id);
  assert.strictEqual(corr.sail_state, "sailing");
  assert.strictEqual(corr.dr_elapsed_seconds, 1800);

  // engine snapped
  assert.strictEqual(engine.snaps.length, 1);
  assert.ok(Math.abs(engine.origin.latitude - 60) < 1e-9);
  db.close();
});

test("confirmFix: resets=false writes fixes row but no correction and no snap", () => {
  const db = openDatabase(join(tempDir, "noreset.sqlite"));
  const engine = fakeEngine({ latitude: 60.01, longitude: 24.01 }, 1800);
  const candidate = {
    source_type: "manual",
    latitude: 60,
    longitude: 24,
    residual_nm: 0,
    alternate: null,
    observationIds: { lopIds: [], cplIds: [] },
  };
  const res = confirmFix(db, candidate, engine, helpers, {
    confirmedBy: "bob",
    resets: false,
    timestamp: "2026-01-01T00:30:00Z",
  });
  assert.ok(res.fix_id > 0);
  assert.strictEqual(res.correction_id, null);
  assert.strictEqual(res.deviation_nm, null);
  assert.strictEqual(engine.snaps.length, 0);
  const fix = db
    .prepare("SELECT * FROM fixes WHERE fix_id = ?")
    .get(res.fix_id);
  assert.strictEqual(fix.resets_dr_origin, 0);
  db.close();
});

test("confirmFix: no prior origin → no correction row but fix still written", () => {
  const db = openDatabase(join(tempDir, "cold.sqlite"));
  const engine = fakeEngine(null, 0);
  const candidate = {
    source_type: "gps",
    latitude: 60,
    longitude: 24,
    residual_nm: 0,
    alternate: null,
    observationIds: { lopIds: [], cplIds: [] },
  };
  const res = confirmFix(db, candidate, engine, helpers, {
    confirmedBy: "carol",
    timestamp: "2026-01-01T00:00:00Z",
  });
  assert.ok(res.fix_id > 0);
  assert.strictEqual(res.correction_id, null);
  // Engine still snapped (the fix seeds the origin).
  assert.strictEqual(engine.snaps.length, 1);
  db.close();
});

test("confirmFix: LOP/CPL observations are attached to the confirmed fix", () => {
  const db = openDatabase(join(tempDir, "attach.sqlite"));
  const lopId = recordLineOfPosition(db, {
    timestamp: "2026-01-01T00:00:00Z",
    lop_type: "bearing",
    assumed_lat: 60,
    assumed_lon: 24,
    azimuth_true: 0,
    body_or_object: "Rock",
  });
  const cplId = recordCircularPositionLine(db, {
    timestamp: "2026-01-01T00:00:00Z",
    cpl_type: "vertical-angle",
    center_lat: 60,
    center_lon: 24,
    radius_nm: 2,
    source_object: "Lighthouse",
  });
  const engine = fakeEngine({ latitude: 60.02, longitude: 24.02 }, 900);
  // Build a candidate directly (a LOP×CPL crossing).
  const candidate = resolveCandidateFix({
    source_type: "bearing",
    observations: [
      { kind: "lop", assumed_lat: 60, assumed_lon: 24, azimuth_true: 0 },
      { kind: "cpl", center_lat: 60, center_lon: 24, radius_nm: 2 },
    ],
    observationIds: { lopIds: [lopId], cplIds: [cplId] },
    drPosition: { latitude: 60.04, longitude: 24.1 },
  });
  assert.ok(candidate);
  const res = confirmFix(db, candidate, engine, helpers, {
    confirmedBy: "dave",
    timestamp: "2026-01-01T00:15:00Z",
  });
  // The LOP and CPL rows now carry used_in_fix_id.
  const lop = db
    .prepare("SELECT used_in_fix_id FROM lines_of_position WHERE lop_id = ?")
    .get(lopId);
  const cpl = db
    .prepare(
      "SELECT used_in_fix_id FROM circular_position_lines WHERE cpl_id = ?",
    )
    .get(cplId);
  assert.strictEqual(lop.used_in_fix_id, res.fix_id);
  assert.strictEqual(cpl.used_in_fix_id, res.fix_id);
  db.close();
});

test("confirmFix: does not flip DR authority — only resets origin", () => {
  // The pipeline has no notion of OVERRIDE; it only snaps the origin.
  // This test documents that contract: confirmFix returns no `active` flag.
  const db = openDatabase(join(tempDir, "authority.sqlite"));
  const engine = fakeEngine({ latitude: 60.01, longitude: 24.01 }, 600);
  const candidate = {
    source_type: "celestial",
    latitude: 60,
    longitude: 24,
    residual_nm: 0.1,
    alternate: null,
    observationIds: { lopIds: [], cplIds: [] },
  };
  const res = confirmFix(db, candidate, engine, helpers, {
    confirmedBy: "eve",
    timestamp: "2026-01-01T00:10:00Z",
  });
  assert.ok(res.fix_id > 0);
  // Engine snapped, but there is no authority field on the result.
  assert.strictEqual(engine.snaps.length, 1);
  assert.strictEqual(res.active, undefined);
  db.close();
});

test("full pipeline: two bearings → resolve → confirm → correction recorded", () => {
  const db = openDatabase(join(tempDir, "full.sqlite"));
  const engine = fakeEngine({ latitude: 60.05, longitude: 24.05 }, 3600);

  // Persist two bearing LOPs.
  const id1 = recordLineOfPosition(db, {
    timestamp: "2026-01-01T01:00:00Z",
    lop_type: "bearing",
    assumed_lat: 60,
    assumed_lon: 24,
    azimuth_true: 0,
    body_or_object: "North Rock",
  });
  const id2 = recordLineOfPosition(db, {
    timestamp: "2026-01-01T01:01:00Z",
    lop_type: "bearing",
    assumed_lat: 60,
    assumed_lon: 24,
    azimuth_true: 90,
    body_or_object: "East Rock",
  });

  const candidate = resolveCandidateFix({
    source_type: "bearing",
    observations: [
      { kind: "lop", assumed_lat: 60, assumed_lon: 24, azimuth_true: 0 },
      { kind: "lop", assumed_lat: 60, assumed_lon: 24, azimuth_true: 90 },
    ],
    observationIds: { lopIds: [id1, id2], cplIds: [] },
    drPosition: engine.origin,
  });
  assert.ok(candidate);
  assert.ok(candidate.residual_nm < 1e-6);

  const res = confirmFix(db, candidate, engine, helpers, {
    confirmedBy: "frank",
    sailState: "sailing",
    timestamp: "2026-01-01T01:05:00Z",
  });

  // All three rows written and linked.
  assert.ok(res.fix_id > 0);
  assert.ok(res.correction_id > 0);
  assert.ok(res.deviation_nm > 0);
  const attached = db
    .prepare(
      "SELECT COUNT(*) AS n FROM lines_of_position WHERE used_in_fix_id = ?",
    )
    .get(res.fix_id).n;
  assert.strictEqual(attached, 2);
  const corrCount = db
    .prepare("SELECT COUNT(*) AS n FROM dr_corrections WHERE fix_id = ?")
    .get(res.fix_id).n;
  assert.strictEqual(corrCount, 1);
  db.close();
});
