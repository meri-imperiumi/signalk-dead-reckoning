/**
 * Unified fix-confirmation pipeline (SPEC §4.4, §9.1, §9.3).
 *
 * The pipeline turns raw observations into a confirmed fix through one
 * consistent flow, regardless of source type (GPS point, celestial LOP,
 * compass bearing, vertical-angle CPL, ranged ADS-B):
 *
 *   raw observations
 *     → (for LOP/CPL) resolve into a candidate fix (`resolveCandidateFix`)
 *     → human confirmation, attributed via `confirmed_by`
 *     → `confirmFix`: writes a `fixes` row, attaches the LOP/CPL rows that
 *       resolved into it, writes a `dr_corrections` row if the fix resets
 *       the DR origin, and snaps the DR engine to the new origin.
 *
 * GPS point fixes skip the geometric resolver (a point is already a fix)
 * and go straight to `confirmFix`.
 *
 * The orchestrator is pure with respect to I/O except the DB writes it
 * owns. It receives the `db`, the `engine`, and a `helpers` bundle (the
 * db helpers and geo helpers it needs) so it is unit-testable with an
 * in-memory database and a fake engine, and so `index.js` can wire it
 * through the existing `deps` injection seam without a circular require.
 *
 * Non-goals (kept out of this layer deliberately):
 *   - Auto-switching navigational authority. `confirmFix` only resets the
 *     DR *origin*; it never touches `navigation.deadReckoning.active`.
 *   - Logbook writes (§9.5) — a separate write-through layer.
 *   - UI concerns — the pipeline returns data; the web component renders.
 *
 * @file fix-pipeline.js
 */

const { resolveFix, advanceObservation } = require("./fixes.js");

/**
 * The helpers the orchestrator needs, injected by the caller. In
 * production these come from `./db.js` and `./geo.js` via `index.js`'s
 * `deps` seam; tests pass fakes/stubs.
 *
 * @typedef {Object} PipelineHelpers
 * @property {Function} recordFix
 * @property {Function} recordCorrection
 * @property {Function} recordLineOfPosition
 * @property {Function} recordCircularPositionLine
 * @property {Function} attachObservationsToFix
 * @property {Function} distanceNm
 * @property {Function} bearingDeg
 */

/**
 * Minimal DR-engine surface the pipeline uses: `origin` (current shadow
 * position or null) and `snapToFix(fix)` (reset origin to a fix). The real
 * `DeadReckoningEngine` satisfies this; tests pass a stub.
 *
 * @typedef {Object} DrEngineLike
 * @property {{latitude: number, longitude: number}|null} origin
 * @property {number} [elapsedSinceOriginS]
 * @property {(fix: {latitude: number, longitude: number}) => void} snapToFix
 */

/**
 * A candidate fix produced by the resolver, ready for human confirmation.
 *
 * @typedef {Object} CandidateFix
 * @property {string} source_type - 'gps' | 'celestial' | 'bearing' | 'manual' | 'backfill'
 * @property {number} latitude
 * @property {number} longitude
 * @property {number} residual_nm - cocked-hat spread; 0 for a GPS point fix
 * @property {{latitude:number, longitude:number}|null} alternate - second
 *           Circle×Circle / LOP×Circle candidate for the watchkeeper, or null
 * @property {{lopIds: number[], cplIds: number[]}} observationIds - db ids of
 *           the LOP/CPL rows that resolved into this candidate (empty for GPS)
 * @property {Array<{id: number|null, kind: string, timestamp_ms: number|null,
 *           original: {latitude:number,longitude:number},
 *           advanced: {latitude:number,longitude:number},
 *           displacement: {bearingTrue:number, distanceNm:number}|null}>} [advancements]
 *           per-observation running-fix transport (work doc #13): original
 *           reference point as taken, advanced reference point (equal to
 *           original when not transported), and the displacement used —
 *           empty for GPS point fixes. Lets the preview UI draw the
 *           advancement instead of only the final fix.
 * @property {number|null} [derived_from_fix_id] - the confirmed fix a
 *           single-observation running fix was advanced from; null/absent
 *           for ordinary multi-observation fixes.
 */

/**
 * Resolves a set of observations into a candidate fix for human confirmation.
 *
 * For GPS / point fixes the caller passes a single point observation and
 * this returns it directly (a point is already a fix; no resolver needed).
 * For LOP/CPL inputs the geometric resolver runs and the residual + any
 * alternate candidate are surfaced.
 *
 * The LOP/CPL rows should already be persisted (via `recordLineOfPosition`
 * / `recordCircularPositionLine`) before calling this, so their db ids can
 * be attached to the eventual confirmed fix. This function does NOT write
 * to the DB — it is a pure read-only resolution step.
 *
 * @param {object} input
 * @param {'gps'|'celestial'|'bearing'|'manual'|'backfill'} input.source_type
 * @param {{latitude:number, longitude:number}|null} [input.point] - for gps/manual point fixes
 * @param {import('./fixes.js').Observation[]} [input.observations] - LOP/CPL inputs
 * @param {{latitude:number, longitude:number}} [input.drPosition] - DR/assumed position; defaults to engine origin
 * @param {{lopIds?: number[], cplIds?: number[]}} [input.observationIds] - ids of already-persisted LOP/CPL rows
 * @param {DrEngineLike|null} [input.engine] - to default drPosition from origin
 * @param {import('node:sqlite').DatabaseSync|null} [input.db] - to hydrate observations from ids
 * @param {{getLineOfPosition?: Function, getCircularPositionLine?: Function}} [input.helpers] - db getters for id-hydration
 * @param {((t0: number, t1: number) => ({bearingTrue: number, distanceNm: number}|null))|null} [input.advance] - ground-track displacement provider for running fixes; advances earlier observations to the latest timestamp
 * @param {{fix_id: number, latitude: number, longitude: number, timestamp_ms: number}|null} [input.previous_fix] - last confirmed fix, for the single-observation running fix: the fix is advanced along the DR track to the observation time and projected onto the observation's constraint
 * @returns {CandidateFix|null} null if observations can't be resolved (e.g. a single LOP with no point)
 */
/**
 * Loads persisted LOP/CPL rows by id and shapes them into the
 * {@link import('./fixes.js').Observation} array the resolver expects.
 * Used when a caller (POST /fix/resolve) passes only db ids.
 *
 * @param {import('node:sqlite').DatabaseSync|null} db
 * @param {object} helpers - { getLineOfPosition, getCircularPositionLine }
 * @param {number[]} lopIds
 * @param {number[]} cplIds
 * @returns {Array<{kind:'lop'|'cpl'}>}
 */
function loadObservationsById(db, helpers, lopIds, cplIds) {
  if (!db || !helpers) return [];
  const out = [];
  for (const id of lopIds) {
    const row = helpers.getLineOfPosition(db, id);
    if (!row) continue;
    out.push({
      id: row.lop_id,
      kind: "lop",
      assumed_lat: row.assumed_lat,
      assumed_lon: row.assumed_lon,
      azimuth_true: row.azimuth_true,
      intercept_nm: row.intercept_nm ?? 0,
      timestamp_ms: Date.parse(row.timestamp),
    });
  }
  for (const id of cplIds) {
    const row = helpers.getCircularPositionLine(db, id);
    if (!row) continue;
    out.push({
      id: row.cpl_id,
      kind: "cpl",
      center_lat: row.center_lat,
      center_lon: row.center_lon,
      radius_nm: row.radius_nm,
      timestamp_ms: Date.parse(row.timestamp),
    });
  }
  return out;
}

/**
 * Reference point of an observation — the point a running fix
 * transports along the DR track: the assumed position for a LOP, the
 * center for a CPL.
 *
 * @param {object} o - resolver-shaped observation
 * @returns {{latitude: number, longitude: number}}
 */
function referencePoint(o) {
  if (o.kind === "cpl") {
    return { latitude: o.center_lat, longitude: o.center_lon };
  }
  if (o.kind === "point") {
    return { latitude: o.latitude, longitude: o.longitude };
  }
  return { latitude: o.assumed_lat, longitude: o.assumed_lon };
}

/**
 * Builds the per-observation advancement record (work doc #13 stage C):
 * where the observation was taken (`original`), where it participates
 * in the intersection (`advanced` — equal to `original` when not
 * transported), and the DR displacement used (null when not advanced).
 * Enough for the map to draw both positions and the connecting track
 * vector — the legible running fix.
 *
 * `id` is the db id for persisted observations (null for inline ones);
 * `timestamp_ms` lets the UI distinguish "was the latest observation"
 * from "older but un-advanced" (the honest-failure warning case).
 *
 * @param {object} o - the original observation
 * @param {object} advanced - the (possibly same) advanced observation
 * @param {{bearingTrue: number, distanceNm: number}|null} displacement
 * @returns {object}
 */
function advancementRecord(o, advanced, displacement) {
  return {
    id: o.id ?? null,
    kind: o.kind,
    timestamp_ms: Number.isFinite(o.timestamp_ms) ? o.timestamp_ms : null,
    original: referencePoint(o),
    advanced: referencePoint(advanced),
    displacement,
  };
}

/**
 * Advances earlier observations to the timestamp of the latest one along
 * the vessel's ground track (running fix / sun-run-sun, SPEC §9.1).
 * Observations without a timestamp, or taken at the latest time, are
 * left in place. If no displacement provider is supplied or it returns
 * null for an interval (no GPS history for that span), that observation
 * is left un-advanced — the resolver may still succeed if the other
 * inputs suffice, but a single stale LOP will not silently yield a
 * wrong fix.
 *
 * Returns both the advanced observation array and a per-input
 * advancement record so the resolve preview can show the transport
 * (original → advanced + the displacement used) instead of only the
 * final fix.
 *
 * @param {Array<object>} observations - each may carry `timestamp_ms`
 * @param {((t0: number, t1: number) => ({bearingTrue: number, distanceNm: number}|null))|null} advance
 * @returns {{observations: Array<object>, advancements: Array<object>}}
 */
function advanceToLatest(observations, advance) {
  const stamped = observations.filter((o) => Number.isFinite(o.timestamp_ms));
  const unadvanced = () => ({
    observations,
    advancements: observations.map((o) => advancementRecord(o, o, null)),
  });
  if (!advance || stamped.length < 2) return unadvanced();
  const tLate = Math.max(...stamped.map((o) => o.timestamp_ms));
  const out = [];
  const advancements = [];
  for (const o of observations) {
    if (!Number.isFinite(o.timestamp_ms) || o.timestamp_ms >= tLate) {
      out.push(o);
      advancements.push(advancementRecord(o, o, null));
      continue;
    }
    const disp = advance(o.timestamp_ms, tLate);
    if (!disp) {
      out.push(o);
      advancements.push(advancementRecord(o, o, null));
      continue;
    }
    if (disp.distanceNm === 0) {
      // The track covers the interval but the vessel made no way over
      // it (becalmed, anchored): the observation is already where the
      // run puts it, and the displacement is recorded — covered, just
      // zero — so downstream honesty checks don't mistake this for a
      // coverage gap.
      out.push(o);
      advancements.push(advancementRecord(o, o, disp));
      continue;
    }
    const moved = advanceObservation(o, disp);
    out.push(moved);
    advancements.push(advancementRecord(o, moved, disp));
  }
  return { observations: out, advancements };
}

function resolveCandidateFix(input) {
  const sourceType = input.source_type;
  const lopIds = input.observationIds?.lopIds ?? [];
  const cplIds = input.observationIds?.cplIds ?? [];

  // Point fix: no resolution needed.
  if (input.point) {
    return {
      source_type: sourceType,
      latitude: input.point.latitude,
      longitude: input.point.longitude,
      residual_nm: 0,
      alternate: null,
      observationIds: { lopIds: [...lopIds], cplIds: [...cplIds] },
      advancements: [],
    };
  }

  let observations = input.observations ?? [];
  // When the caller passes only persisted observation ids (no inline
  // observations), hydrate them from the db so the resolver has inputs.
  // This is the common path for the sight panel: POST /fix/resolve with
  // lop_ids/cpl_ids collected from the pending list.
  if (observations.length === 0 && (lopIds.length || cplIds.length)) {
    observations = loadObservationsById(
      input.db,
      input.helpers,
      lopIds,
      cplIds,
    );
  }
  if (observations.length === 0) return null;

  // Single-observation running fix against a previous confirmed fix
  // (SPEC §9.1 sun-run-sun economy — one sight per day; equally a
  // single bearing when making landfall): the fix enters as a point
  // observation, `advanceToLatest` transports it along the DR track to
  // the observation time, and the resolver projects it onto the
  // observation's constraint. Engaged only when exactly one geometric
  // observation is in play and it is newer than the fix; anything else
  // goes through the normal multi-observation resolution.
  let derivedFromFixId = null;
  if (
    !input.point &&
    input.previous_fix &&
    observations.length === 1 &&
    observations[0].kind !== "point"
  ) {
    const prev = input.previous_fix;
    const sight = observations[0];
    if (
      Number.isFinite(sight.timestamp_ms) &&
      Number.isFinite(prev.timestamp_ms) &&
      sight.timestamp_ms > prev.timestamp_ms
    ) {
      observations = [
        {
          kind: "point",
          latitude: prev.latitude,
          longitude: prev.longitude,
          timestamp_ms: prev.timestamp_ms,
        },
        sight,
      ];
      derivedFromFixId = prev.fix_id;
    }
  }

  // Running fix (SPEC §9.1, sun-run-sun): when observations carry
  // timestamps and span a time interval, advance the earlier ones to the
  // latest observation time along the vessel's ground track before
  // resolving. This turns two LOPs taken at different times into a
  // fix — the celestial analog of a terrestrial running fix. Without a
  // displacement provider (no GPS history), earlier observations are
  // left in place and the resolver may fail or return a weaker result —
  // the honest failure rather than a silently-wrong un-advanced fix.
  const { observations: advancedObs, advancements } = advanceToLatest(
    observations,
    input.advance || null,
  );
  observations = advancedObs;

  // Running-fix honesty gate: the previous fix must actually have been
  // transported to the observation time. Without DR-track coverage over
  // the interval, projecting the fix's *stale* position onto the
  // constraint would be silently wrong — return the honest null instead.
  if (
    derivedFromFixId != null &&
    !advancements.some((a) => a.kind === "point" && a.displacement != null)
  ) {
    return null;
  }

  const drPosition = input.drPosition ??
    input.engine?.origin ?? { latitude: 0, longitude: 0 };
  const resolved = resolveFix(observations, drPosition, drPosition);
  if (!resolved) return null;

  return {
    source_type: sourceType,
    latitude: resolved.latitude,
    longitude: resolved.longitude,
    residual_nm: resolved.residual_nm,
    alternate: resolved.alternate,
    observationIds: { lopIds: [...lopIds], cplIds: [...cplIds] },
    advancements,
    ...(derivedFromFixId != null
      ? { derived_from_fix_id: derivedFromFixId }
      : {}),
  };
}

/**
 * Confirmation options for `confirmFix`.
 *
 * @typedef {Object} ConfirmOptions
 * @property {string|null} [confirmedBy] - crew name; null for unattributed
 * @property {boolean} [resets] - whether this fix resets the DR origin (default true)
 * @property {string|null} [sailState] - for dr_corrections context
 * @property {string|null} [seaState] - for dr_corrections context
 * @property {string} [timestamp] - ISO timestamp; defaults to now
 * @property {string|null} [notes] - free-text notes for the fixes row
 * @property {number} [estimatedErrorRadius] - optional, nm
 */

/**
 * Confirms a candidate fix: persists the `fixes` row, attaches the LOP/CPL
 * rows that resolved into it, writes a `dr_corrections` row when the fix
 * resets the DR origin and there was a prior origin to deviate from, and
 * snaps the DR engine to the new origin.
 *
 * Symmetric across NORMAL and OVERRIDE modes (SPEC §9.3): every confirmed
 * fix that resets the origin is recorded, regardless of whether DR was
 * authoritative at the time.
 *
 * Does NOT switch navigational authority — `navigation.deadReckoning.active`
 * is untouched here; a human makes that decision separately.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {CandidateFix} candidate
 * @param {DrEngineLike|null} engine - current DR engine; snapped if resets
 * @param {PipelineHelpers} helpers
 * @param {ConfirmOptions} [opts]
 * @returns {{fix_id: number, correction_id: number|null, deviation_nm: number|null, deviation_bearing: number|null}}
 */
function confirmFix(db, candidate, engine, helpers, opts = {}) {
  const resets = opts.resets !== false;
  const ts = opts.timestamp ?? new Date().toISOString();
  const priorOrigin = engine?.origin ?? null;
  const elapsed = engine?.elapsedSinceOriginS ?? 0;

  const fixId = helpers.recordFix(db, {
    timestamp: ts,
    source_type: candidate.source_type,
    latitude: candidate.latitude,
    longitude: candidate.longitude,
    estimated_error_radius:
      opts.estimatedErrorRadius ?? (candidate.residual_nm || null),
    confirmed_by: opts.confirmedBy ?? null,
    resets_dr_origin: resets,
    derived_from_fix_id: candidate.derived_from_fix_id ?? null,
    notes: opts.notes ?? null,
  });

  // Attach the LOP/CPL rows that resolved into this fix (no-op for GPS points).
  if (candidate.observationIds) {
    helpers.attachObservationsToFix(db, fixId, candidate.observationIds);
  }

  let correctionId = null;
  let deviationNm = null;
  let deviationBearing = null;
  if (priorOrigin && resets) {
    deviationNm = helpers.distanceNm(priorOrigin, {
      latitude: candidate.latitude,
      longitude: candidate.longitude,
    });
    deviationBearing = helpers.bearingDeg(priorOrigin, {
      latitude: candidate.latitude,
      longitude: candidate.longitude,
    });
    correctionId = helpers.recordCorrection(db, {
      fix_id: fixId,
      timestamp: ts,
      dr_lat: priorOrigin.latitude,
      dr_lon: priorOrigin.longitude,
      fix_lat: candidate.latitude,
      fix_lon: candidate.longitude,
      deviation_nm: deviationNm,
      deviation_bearing: deviationBearing,
      dr_elapsed_seconds: elapsed,
      sail_state: opts.sailState ?? null,
      sea_state: opts.seaState ?? null,
    });
  }

  if (resets && engine) {
    engine.snapToFix({
      latitude: candidate.latitude,
      longitude: candidate.longitude,
    });
  }

  return {
    fix_id: fixId,
    correction_id: correctionId,
    deviation_nm: deviationNm,
    deviation_bearing: deviationBearing,
  };
}

module.exports = {
  resolveCandidateFix,
  confirmFix,
  loadObservationsById,
  advanceToLatest,
};
