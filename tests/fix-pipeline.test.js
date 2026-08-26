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
  advanceToLatest,
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

test("advanceToLatest: advances earlier observations to the latest timestamp", () => {
  // Two LOPs 4h apart; the first anchored at 60N/24E. DR displacement
  // 25 nm due east over the interval. The advanced LOP's anchor should
  // move east by ~25 nm; the later one is untouched.
  const T0 = Date.UTC(2026, 0, 1, 10, 0, 0);
  const T1 = Date.UTC(2026, 0, 1, 14, 17, 0);
  const obs = [
    {
      kind: "lop",
      assumed_lat: 60,
      assumed_lon: 24,
      azimuth_true: 0,
      timestamp_ms: T0,
    },
    {
      kind: "lop",
      assumed_lat: 60,
      assumed_lon: 24.5,
      azimuth_true: 90,
      timestamp_ms: T1,
    },
  ];
  const { observations: advanced, advancements } = advanceToLatest(obs, () => ({
    bearingTrue: 90,
    distanceNm: 25,
  }));
  // First LOP moved east; second untouched.
  assert.ok(advanced[0].assumed_lon > 24);
  assert.strictEqual(advanced[1].assumed_lon, 24.5);
  // Advancement records describe the transport (work doc #13 stage C).
  assert.strictEqual(advancements.length, 2);
  const [first, second] = advancements;
  assert.strictEqual(first.kind, "lop");
  assert.deepStrictEqual(first.original, { latitude: 60, longitude: 24 });
  assert.ok(first.advanced.longitude > 24, "advanced east of original");
  assert.deepStrictEqual(first.displacement, {
    bearingTrue: 90,
    distanceNm: 25,
  });
  // The latest observation reports advanced == original, no displacement.
  assert.deepStrictEqual(second.original, { latitude: 60, longitude: 24.5 });
  assert.deepStrictEqual(second.advanced, second.original);
  assert.strictEqual(second.displacement, null);
});

test("advanceToLatest: advancements report the provider's per-interval displacement", () => {
  const obs = [
    {
      kind: "cpl",
      center_lat: 60,
      center_lon: 24,
      radius_nm: 2,
      timestamp_ms: 0,
    },
    {
      kind: "cpl",
      center_lat: 60,
      center_lon: 25,
      radius_nm: 2,
      timestamp_ms: 1000,
    },
  ];
  const provider = (t0, t1) =>
    t0 === 0 ? { bearingTrue: 45, distanceNm: 10 } : null;
  const { advancements } = advanceToLatest(obs, provider);
  assert.deepStrictEqual(advancements[0].displacement, {
    bearingTrue: 45,
    distanceNm: 10,
  });
  // provider saw the right interval
  assert.strictEqual(advancements[1].displacement, null);
});

test("advanceToLatest: no provider → observations unchanged", () => {
  const obs = [
    {
      kind: "lop",
      assumed_lat: 60,
      assumed_lon: 24,
      azimuth_true: 0,
      timestamp_ms: 0,
    },
    {
      kind: "lop",
      assumed_lat: 60,
      assumed_lon: 24,
      azimuth_true: 90,
      timestamp_ms: 1000,
    },
  ];
  const out = advanceToLatest(obs, null).observations;
  assert.strictEqual(out[0].assumed_lon, 24);
  assert.strictEqual(out[1].assumed_lon, 24);
  // No provider → every record reports advanced == original, null displacement.
  const { advancements } = advanceToLatest(obs, null);
  for (const a of advancements) {
    assert.deepStrictEqual(a.advanced, a.original);
    assert.strictEqual(a.displacement, null);
  }
});

test("advanceToLatest: provider returns null → that observation left in place", () => {
  const obs = [
    {
      kind: "lop",
      assumed_lat: 60,
      assumed_lon: 24,
      azimuth_true: 0,
      timestamp_ms: 0,
    },
    {
      kind: "lop",
      assumed_lat: 60,
      assumed_lon: 25,
      azimuth_true: 90,
      timestamp_ms: 1000,
    },
  ];
  const out = advanceToLatest(obs, () => null).observations;
  assert.strictEqual(out[0].assumed_lon, 24);
  // Un-advanced (provider null) still records the original, verbatim.
  const { advancements } = advanceToLatest(obs, () => null);
  assert.deepStrictEqual(advancements[0].original, {
    latitude: 60,
    longitude: 24,
  });
  assert.deepStrictEqual(advancements[0].advanced, advancements[0].original);
  assert.strictEqual(advancements[0].displacement, null);
  // The older timestamp is preserved so the UI can flag "un-advanced".
  assert.strictEqual(advancements[0].timestamp_ms, 0);
});

test("resolveCandidateFix: running fix — two time-separated LOPs resolve with an advance provider", () => {
  const T0 = Date.UTC(2026, 0, 1, 10, 0, 0);
  const T1 = Date.UTC(2026, 0, 1, 14, 0, 0);
  // First LOP: a north-south line (azimuth 0 → east-west LOP) through 60N/24E.
  // After 4h sailing due east at 6kn = 24 nm, the line moves to ~24.4E.
  // Second LOP: an east-west line (azimuth 90 → north-south LOP) through 60N/24.4E,
  // taken at T1. They cross at ~60N/24.4E.
  const c = resolveCandidateFix({
    source_type: "celestial",
    observations: [
      {
        kind: "lop",
        assumed_lat: 60,
        assumed_lon: 24,
        azimuth_true: 0,
        intercept_nm: 0,
        timestamp_ms: T0,
      },
      {
        kind: "lop",
        assumed_lat: 60,
        assumed_lon: 24.4,
        azimuth_true: 90,
        intercept_nm: 0,
        timestamp_ms: T1,
      },
    ],
    drPosition: { latitude: 60, longitude: 24.4 },
    advance: () => ({ bearingTrue: 90, distanceNm: 24 }),
  });
  assert.ok(c, "running fix should resolve");
  // The crossing is at the second LOP's longitude and the first's latitude.
  assert.ok(Math.abs(c.latitude - 60) < 0.05, `lat ${c.latitude}`);
  assert.ok(Math.abs(c.longitude - 24.4) < 0.05, `lon ${c.longitude}`);
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

test("resolveCandidateFix: candidate carries advancements with db ids for hydrated observations", () => {
  const T0 = Date.UTC(2026, 0, 1, 10, 0, 0);
  const T1 = Date.UTC(2026, 0, 1, 14, 0, 0);
  const db = openDatabase(join(tempDir, "adv-ids.sqlite"));
  const lopId = recordLineOfPosition(db, {
    timestamp: new Date(T0).toISOString(),
    lop_type: "celestial",
    assumed_lat: 60,
    assumed_lon: 24,
    azimuth_true: 0,
    intercept_nm: 0,
  });
  const cplId = recordCircularPositionLine(db, {
    timestamp: new Date(T1).toISOString(),
    cpl_type: "vertical-angle",
    center_lat: 60.02,
    center_lon: 24.2,
    radius_nm: 2,
  });
  const c = resolveCandidateFix({
    source_type: "celestial",
    observationIds: { lopIds: [lopId], cplIds: [cplId] },
    drPosition: { latitude: 60.01, longitude: 24.1 },
    db,
    helpers: { getLineOfPosition, getCircularPositionLine },
    advance: () => ({ bearingTrue: 90, distanceNm: 5 }),
  });
  assert.ok(c);
  assert.strictEqual(c.advancements.length, 2);
  const [lopAdv, cplAdv] = c.advancements;
  assert.strictEqual(lopAdv.id, lopId);
  assert.strictEqual(lopAdv.kind, "lop");
  assert.ok(lopAdv.advanced.longitude > lopAdv.original.longitude);
  assert.strictEqual(lopAdv.timestamp_ms, T0);
  // The latest observation is not transported.
  assert.strictEqual(cplAdv.id, cplId);
  assert.strictEqual(cplAdv.kind, "cpl");
  assert.deepStrictEqual(cplAdv.advanced, cplAdv.original);
  assert.strictEqual(cplAdv.displacement, null);
  db.close();
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
