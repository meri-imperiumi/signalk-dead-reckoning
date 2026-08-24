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

const { resolveFix } = require("./fixes.js");

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
 * @returns {CandidateFix|null} null if observations can't be resolved (e.g. a single LOP with no point)
 */
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
    };
  }

  const observations = input.observations ?? [];
  if (observations.length === 0) return null;

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
};
