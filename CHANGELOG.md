# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- `POST /fix/resolve` and `POST /fix` no longer return `observations not
  resolvable` when called with only `lop_ids`/`cpl_ids` (the common sight
  panel path). The pipeline now hydrates the observation bodies from the
  database via the new `getLineOfPosition`/`getCircularPositionLine` db
  helpers, then runs the geometric resolver on them.

### Added
- Noon Sun sight reduction (SPEC §13): `POST /celestial/sight` with
  `noon: true` reduces a local-apparent-noon meridian-altitude sight to
  latitude directly (Lat = Dec ± z) via `reduceNoonSight`, emitted as an
  east-west LOP with zero intercept — a single-sight latitude fix that
  crosses any other LOP/CPL normally through the existing pipeline.
- Observations logged to the logbook on creation (SPEC §9.5): a bearing
  LOP, vertical-angle CPL, or celestial sight writes a `navigation` entry
  via `composeObservationEntry` — taking the sight is itself a navigational
  event, independent of whether it later resolves into a fix. The entry's
  `position` is the assumed/object/charted position; `text` describes what
  was observed (body name, Zn, intercept for celestial).
- Initial project scaffold: package metadata, CI workflows, plugin entry
  point with subscription/start/stop structure, SQLite schema layer,
  dead-reckoning vector-integration engine, EMA matrix store, unified fix
  model, and `<dr-map-view>` web component stub.
- DR web UI (SPEC §14.1): a pure, dependency-free view-model
  (`public/dr-viewmodel.js` — TrackLog ring buffers, LOP/CPL/fix/correction
  render specs, uncertainty + divergence helpers, sparkline reduction, and
  a Signal K `resources/charts` tile-layer parser) backed by unit tests, and
  a vendored-Leaflet `<dr-map-view>` adapter plus `<dr-app>` layout with
  headline figures, dual Ghost/GPS track rendering, uncertainty polygon,
  LOP/CPL/snap-vector overlays, the divergence chip + sparkline, and the
  always-human-initiated Failover Override control. Tile-less by default
  (offline-first); basemaps come from the server's configured charts
  (`/signalk/v1/api/resources/charts`) via a Leaflet layers control, never
  hardcoded OSM. New `GET /fixes`, `GET /observations`, `GET /corrections`
  routes feed the persisted overlays.
- DR engine idle-state reporting: the plugin publishes
  `navigation.deadReckoning.state` (`{status: "idle"|"underway", reason}`)
  so the UI can explain why the readout is empty when moored/anchored or
  lacking speed/heading, instead of leaving the user to guess. The
  webapp shows a status banner (amber idle, green underway, red link-lost)
  and the GPS boat marker is always drawn when a fix is available.
- Historical GPS track from the Signal K history API
  (`/signalk/v1/history/values`, same pattern as signalk-logbook's Map):
  fetched once on load to seed the track, then extended by live deltas —
  shows where the boat has actually been, the baseline against which DR
  divergence is measured. Falls back to the live-session track when no
  history provider is configured (route 404s).
- Sight & LOP input panel (SPEC §14.1 "Manual LOP & Sight Input"):
  a new `<dr-sight-panel>` web component (in a `<dialog>` opened from the
  headline toolbar) with three modes — compass bearing (→ LOP through the
  observer), vertical-angle sight (→ CPL by height/tan(angle) distance),
  and celestial sight (→ LOP via Marcq St. Hilaire, with reduction
  feedback: Hc/Ho/Zn/intercept/LHA). Observations collect in a pending
  list; "Resolve" previews a candidate fix on the map (hollow yellow
  ring); "Confirm" snaps the DR origin via the unified fix pipeline.
  - **Chart pick**: right-click (or long-press) a charted object to get
    a context menu ("Add bearing to here" / "Distance CPL at here") that
    opens the sight dialog with the object position pre-seeded.
  - **Pending list survives reload**: observations are persisted
    server-side; reopening the dialog re-hydrates the pending list from
    any unattached LOPs/CPLs (`used_in_fix_id IS NULL`), so a page
    reload or dialog close doesn't lose work-in-progress. Each item
    shows a readable label (e.g. "#5 · lighthouse brg 045°",
    "#3 · lighthouse 0.46nm"). The candidate itself is a computed preview
    (not persisted) but can be re-derived with "Resolve candidate".
  - **Bearing LOP semantics corrected**: a bearing is taken to a known
    charted object, so the form collects the *object's* position (not the
    observer's assumed position). The view-model shaper rotates the
    azimuth +90° so the engine's perpendicular-line convention yields a
    line running along the bearing through the object (you are somewhere
    on it), matching traditional nav practice.
  - **Configurable position format** (`decimal` / `dm` / `dms`, default
    DMS) set in the plugin config and served to the UI via a public
    `GET /signalk/v2/api/signalk-dead-reckoning/configuration` endpoint
    (mirrors signalk-status-tiles' pattern); a config-hash delta triggers
    a live reload on server-side edits. Coordinate entry uses structured
    deg/min/sec/hemisphere fields (not a single error-prone text field)
    that show/hide based on the configured format. Assumed-position
    defaults track the live DR (or GPS when moored) and re-seed on format
    change.
  - **Server-derived `confirmed_by`**: the watchkeeper is taken from the
    `JAUTHENTICATION` cookie JWT (mirrors signalk-logbook), so there is
    no manual "confirmed by" form field.
  Pure view-model form→REST-body shapers (`bearingLopBody`,
  `verticalAngleCplBody`, `celestialSightBody`, `bearingToTrue`,
  `verticalAngleDistanceNm`) and the position formatter
  (`formatCoord`/`parseCoord`/`coordParts`/`parseParts` + `setFormat`/
  `fmt`/`fmtPos`) are unit-tested. New `GET /celestial/bodies` route
  lists Sun/Moon/bundled stars + almanac validity for the body selector.
- Stream subscription hardened after signalk-status-tiles' st-stream.js:
  `/signalk/v1/stream?subscribe=none&sendMeta=all` URL, `minPeriod: 1000`
  throttle, auto-reconnect on link loss with immediate re-subscribe,
  hello/ack filtering, and link-state reporting to the UI.
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
- Logbook integration (SPEC §9.4, §9.5): `plugin/logbook.js` with
  §9.5 field-mapped fix-entry composition (explicit `datetime`,
  DR-log for `log` per §10.3, per-source_type text templates,
  `origin: agent`, closed-schema observations), auto tack/gybe
  entries, and a REST client sending auth as both Bearer header and
  JAUTHENTICATION cookie (the signalk-dsc pattern; no `app.fetch` —
  verified against signalk-server 2.29.0). Token acquisition via
  the server's Access Requests flow: stable persisted clientId,
  `permissions: "admin"` requested explicitly (plugin routes are
  admin-gated — verified), 30s approval polling, DENIED stops
  polling, 401/403 drops the token and re-requests; a config token
  short-circuits and 501/404 falls back to unauthenticated writes.
  Confirmed fixes write through fire-and-forget and mark
  `logged_to_logbook`/`logbook_entry_ref` on success (`db.markFixLogged`);
  the GPS auto-seed snap does not (not human-confirmed). Maneuver
  classification from the AWA change across the §6.4 transient
  window (pre-maneuver AWA captured at window open; tack = bow
  through the wind within ±90°, gybe = stern through within ±60° of
  downwind), debounced (default 120s) so a beat doesn't flood the
  log; the window now also requires the heading itself to
  re-stabilize (±5°) before closing, so the logged course is the
  settled one. `environment.seaState` (and the logbook's actual
  `environment.water.swell.state`) now feed `sea_state` everywhere —
  bins, dr_corrections, and polygon rates become condition-specific
  for real.
