# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial project scaffold: package metadata, CI workflows, plugin entry
  point with subscription/start/stop structure, SQLite schema layer,
  dead-reckoning vector-integration engine, EMA matrix store, unified fix
  model, and `<dr-map-view>` web component stub.
- Unified fix pipeline (SPEC §4.4, §9.1, §9.3): DB helpers for inserting
  lines of position and circular position lines and attaching them to a
  confirmed fix; a pure local-planar geometric resolver (Line×Line,
  Line×Circle, Circle×Circle, with least-squares residual fallback for
  the cocked-hat case) returning a candidate fix plus a residual spread
  and any alternate Circle×Circle candidate; running-fix advance of an
  observation along the DR track; and a `fix-pipeline.js` orchestrator
  (`resolveCandidateFix` → human confirmation → `confirmFix`) that
  writes the `fixes` row, attaches observations, records a
  `dr_corrections` row on origin-reset, and snaps the DR engine origin
  without flipping navigational authority.
- REST fix pipeline (SPEC §4.4, §9.1, §9.3): `POST /fix/lop` and
  `POST /fix/cpl` persist lines/circular position lines and return their
  ids; `POST /fix/resolve` previews a candidate fix (with cocked-hat
  residual and any alternate Circle×Circle candidate) WITHOUT
  confirming; `POST /fix` now routes both point fixes and LOP/CPL-resolved
  fixes through the unified pipeline, attaching observations and recording
  corrections. Point-fix request shape is unchanged (back-compat).
- Celestial sight reduction (SPEC §13): pure `plugin/celestial.js`
  module (Marcq St. Hilaire / intercept method) producing a LOP ready
  for the fix pipeline — Sun/Moon geographic positions via GMST + RA,
  star positions via a bundled `plugin/star-almanac.js` (J2000 SHA/Dec
  for ~23 navigational stars, with an explicit valid epoch and
  `isExpired`/`daysUntilExpiry` for the §12-style startup check);
  altitude corrections (index error, dip, Bennett refraction with a
  5° low-altitude cutoff, Sun/Moon limb semi-diameter, lunar parallax);
  `reduceSight` carries the time-sync staleness indicator (§11) through
  to the result. `POST /celestial/sight` REST endpoint reduces a raw
  sight and persists the resulting celestial LOP, returning the
  reduction details (Hc, Ho, intercept, Zn, LHA) for UI feedback.
- Uncertainty polygon (SPEC §8): pure `plugin/uncertainty.js` growth
  model producing a confidence-weighted circular error region around
  the DR position — empirical regime from an EWMA of recent
  `dr_corrections` deviation rates (per-condition via sail/sea state,
  converted to a per-distance rate so the radius scales with distance
  run, not clock time), conservative angular-margin fallback for
  low-confidence bins, and a continuous blend between them weighted by
  the current matrix bin's effective hit count. Engine gained
  `logNmSinceOrigin` (distance-since-last-snap) alongside
  `elapsedSinceOriginS`, persisted in `dr_state_store` so a
  mid-excursion restart continues the polygon. Published every tick as
  `navigation.deadReckoning.uncertainty` `{radius_nm, method}` with
  meta; recomputed per tick from the current bin so bin transitions
  (tack, sail change) re-evaluate it. New `db.getDeviationRateStats`
  reads recent per-condition correction rows for the model.
- Divergence advisory (SPEC §7.3, gradual band): pure
  `plugin/divergence.js` monitor with sustained-interval hysteresis
  (raises when DR-vs-GPS divergence exceeds 1.5× the uncertainty
  polygon radius for 30s, clears on 30s sustained recovery; both
  tunable via `start({divergence: {...}})`) — the "get a fix" nudge
  the polygon was built to threshold. Publishes/clears
  `notifications.navigation.deadReckoning.divergenceAdvisory` at
  `alert` severity (visual method) with the divergence/expected
  numbers in the message, suppressed at anchor/moored, held (not
  progressed) when either position is missing, and cleared on plugin
  stop if live. Also publishes
  `navigation.deadReckoning.divergence` `{distance_nm, bearing_true}`
  each tick — the §14.1 live divergence readout input.
