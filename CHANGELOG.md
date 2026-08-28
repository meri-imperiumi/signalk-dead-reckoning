# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **`inertial-polar` DR speed fallback (SPEC §3.1, work doc #18)** —
  when the paddlewheel is unusable (`navigation.speedThroughWater`
  missing, or the debounced §6.3 fouling verdict active), DR integrates
  speed from the polar performance plugin's `performance.polarSpeed`
  delta instead of freezing: requires `signalk-polar-performance-plugin`
  installed and configured with its polar speed output enabled; the
  super-jittery raw delta is running-averaged (default 60 s window,
  30 s staleness cutoff) before integration. Gated to underway+sailing
  (no wind-on-mast drift at the dock, no meaningless polar under
  power); no matrix corrections while on polar (bins were trained on
  real STW — a model estimate is circular input); uncertainty grows at
  the fallback rate; Training Mode and maneuver detection suspended;
  the divergence advisory keeps watching. `navigation.speedThroughWater`
  stays silent while on polar (a model estimate is not a measurement).
  The DR state value gains `speedSource: "paddlewheel"|"polar"`, and a
  §3.1 sensor-health alert names the switch (paddlewheel
  unavailable/fouled — DR on polar-derived speed).
- Scalar sibling paths `navigation.deadReckoning.uncertainty.radius`
  and `navigation.deadReckoning.divergence.distance` (metres, with
  nautical-mile display-unit meta) for rule/display engines
  (signalk-status-tiles threshold checks) that cannot read subfields of
  object-valued paths — subscribing to a subfield path never sees a
  delta.

### Changed
- **All published deltas now follow the Signal K SI unit conventions**
  (breaking):
  - `navigation.deadReckoning.log` / `trip.log` publish metres (was
    nautical miles), with `value/1852` NM display-unit meta.
  - The `environment.current` object is replaced by the standard
    `environment.current.setTrue` (radians) and
    `environment.current.drift` (m/s) paths; the DR-specific
    tier/source enrichment rides REST `/status` instead of the bus.
  - The uncertainty object field `radius_nm` becomes `radius_m`; the
    divergence object fields `distance_nm`/`bearing_true` (deg) become
    `distance_m`/`bearing_true` (rad).
  - `navigation.deadReckoning.elapsedSinceFix` gains duration
    display-unit meta so glance consumers render "3h 05m", not
    seconds.
  - All display-unit meta declares `category: "custom"` — the
    server's unit-preference system rewrites category-less
    `displayUnits` to the user's global preference (a seconds path
    rendered as "0.0 hour"); custom keeps the nautical styling.
- **Inbound sensor deltas are now interpreted per the Signal K unit
  conventions** (breaking for feeds that were publishing non-SI):
  `speedThroughWater`/`speedApparent` are read as m/s and heading paths
  as radians, converting to the engine's internal knots/degrees at the
  boundary. Previously m/s and radian values were treated as knots and
  degrees — DR under-travelled ~5× and mis-steered on standard feeds.
  The standard-path passthroughs (`navigation.speedThroughWater`,
  `navigation.headingTrue`) publish what they received, unchanged.
- Logbook fix/tack entries convert SOG/COG/heading at the boundary
  (`_kn`/`_deg` REST fields previously received raw m/s/radians).
- The webapp converts SI bus values (m, m/s, rad) to nautical displays
  centrally in the view model (`metresToNm`/`msToKn`/`radToDeg`).
- REST `/status` and `/current/manual` keep the plugin's internal
  nautical units (`logNm`, `current.setTrue` deg, `drift` kn) — they
  are the plugin's own API, not the Signal K bus.
- `navigation.deadReckoning.method` now reflects the actual speed
  source every tick, completing the SPEC §3.1 enum: the idle branch
  (no usable speed at all) publishes `fallback-zero` instead of
  inheriting the constructor's `inertial-paddlewheel` — the `Polar`/
  `Zero` headline labels added earlier are now driven by real values.
  SPEC §3.1/§3.2/§6.1 aligned with the implemented fallback hierarchy
  (polar first, fault-based selection, speed output silent on polar).
- The "Active method" headline shows a short watchkeeper-sized label
  (`STW` for `inertial-paddlewheel`, `Polar`/`Zero` for the spec's
  reserved methods) with the full token on hover — one of five figures,
  it previously gave a full spec token permanent large-type real estate
  despite having exactly one possible value today.
- The DR status no longer claims the vessel is `underway` while
  moored: `navigation.deadReckoning.state.status` gains a `"warm"`
  value (engine integrating on a tied-up boat, SPEC §5 runs it warm for
  instant OVERRIDE handoff — that is not being under way) alongside
  `"underway"` and `"idle"`. The webapp subscribes to the vessel's own
  `navigation.state` (already in the system — nothing is republished
  inside our deltas) and words the line accordingly:
  `DR warm — moored/anchored, integrating sensors` vs
  `Dead reckoning active`. Text logic moved to the pure `drStatusText()`
  view-model helper.

## [0.2.0] - 2026-08-27

### Fixed
- **Map no longer opens blank — defaults to the first chart provider.**
  The webapp previously kept its tile-less offline-first default unless
  the server had *configured* charts, so on servers without any (the
  common case: the layers control showed only "OpenStreetMap (online)",
  unselected) the plot opened on an empty dark canvas. The first entry
  of the chart list — first configured chart when the server has them,
  otherwise the OSM online fallback — is now auto-selected on load, and
  duplicate chart names no longer clobber each other's entry in the
  layers control.
- **Dockside false positives while moored/anchored** — three alerts
  that misfire on a tied-up boat are now suppressed in the moored/
  anchored regime (consistent with the divergence monitor's existing
  §7.1–2 suppression):
  - *Divergence advisory* no longer raises on GPS wander at the dock:
    the uncertainty radius previously collapsed to exactly 0.0 nm at
    zero distance run, so a few metres of marina multipath "exceeded
    expected uncertainty × 1.5" and sustained for 30 s raised
    `DR-GPS divergence 0.00 nm exceeds expected 0.00 nm`. The radius
    now floors at `MIN_RADIUS_NM` (0.02 nm ≈ 37 m, GNSS noise scale)
    — DR error can never honestly be smaller than the GPS it was
    seeded from.
  - *Phantom "paddlewheel fouled" alert* — the fouling detector saw
    STW≈0 (a moored paddlewheel's honest reading) plus wind on the
    mast or GPS jitter and concluded the boat was making way. The
    detector (and the whole training/matrix path, incl. auto tack
    logging) is skipped while moored/anchored, and any earlier verdict
    is withdrawn.
  - *Sticky advisories* — a divergence advisory raised just before
    mooring could never clear (the monitor isn't fed while suppressed).
    It is now withdrawn with a `DR monitoring suspended while
    moored/anchored` notification, and the divergence readout publishes
    an explicit `null` while suppressed so the UI drops the stale
    figure instead of showing a frozen `0.00 nm / 306°`.
- **Sensor-health alerts no longer flap** — the fouling and
  idle-but-making-way verdicts are raw per-tick threshold comparisons
  (STW vs 0.3 kn, wind vs 3 kn, SOG vs 1 kn); a sensor hovering at a
  threshold toggled the alert on and off every tick. Both now pass
  through a reusable symmetric hysteresis
  (`plugin/hysteresis.js`, `sensorHealth.sustainS`/`clearS`, default
  10 s/10 s): a real fault still surfaces after the sustain window,
  threshold hover raises nothing.
- **Water-track log survives restart** — `navigation.deadReckoning.log`
  and the trip log were persisted every flush but never restored at
  start, resetting the headline to 0.00 nm on every server restart
  mid-passage. Both are now restored from the `dr_state_store`.
- **Map layers control usable again** — the divergence chip overlay sat
  at the top-right corner on top of Leaflet's layers control (equal
  z-index, later sibling wins), covering its toggle: broken-looking
  styling and swallowed clicks meant selecting a chart provider did
  nothing. The chip now lives at the bottom-right (attribution is off,
  so the corner is free).
- The DR vs GPS headline no longer shows a bearing below display
  resolution (`0.00 nm / 306°` → `0.00 nm`): the bearing of a
  zero-length noise vector is meaningless.

### Changed
- When the server has no charts configured, the online OpenStreetMap
  fallback layer is offered in the layers control but no longer
  auto-added to the map (it was documented as opt-in; the tile-less
  offline-first plot is the default again until selected).

### Added
- `plugin/hysteresis.js` — generic symmetric sustain/clear debounce for
  boolean conditions, extracted from the divergence advisory's shape
  and unit-tested; also used for the sensor-health alerts.
- Work doc #17 on the rngit board tracks this batch (dockside false
  positives: divergence advisory, fouled paddlewheel, layers control).

## [0.1.0] - 2026-08-27

### Changed
- **"Tactical sci-fi" visual theme** applied across the webapp (the
  Lille Ø Signal K UI spec): the GitHub-dark palette is replaced by the
  semantic neon token system (`--color-green/teal/orange/red/grey`, dark
  canvas tokens) declared at the document `:root` and shared into every
  shadow-root component via a new `public/dr-theme.js` module — flat
  geometry (no radii, no shadows), 2px corner brackets on `.sk-card`
  panels, hardware-style controls (transparent buttons with theme
  borders that invert on use, 2px-bottom-rule monospace inputs, sharp
  square checkboxes) with ≥48 px touch targets, massive tabular-nums
  telemetry values, and uppercase tracked headers. Map overlays
  (divergence chip, chart-pick menu, Leaflet controls/tooltips) use the
  semi-transparent dark overlay treatment; the map aggressively fills
  the desktop viewport with a 50 vh mobile floor. Map geometry colors
  remapped to the semantic palette (GPS green, DR/ghost teal, LOP
  orange, consumed grey). `dr-app` now subscribes to
  `vessels.self.environment.mode` and reflects it as
  `data-mode="night"|"day"` on `<html>`, lifting the canvas tokens for
  daylight legibility.
- **"Fix at coordinates" uses the structured coordinate entry** — the
  same deg/min/sec/hemisphere (or decimal) sub-fields as the sight
  forms, driven by the server-configured position format. The fieldset
  builder, seeding and reading logic now live in a shared
  `public/dr-coord-fields.js` module used by both panels (the sight
  panel's private copies were removed). Reading is now format-driven:
  decimal mode reads the decimal field, DM/DMS assemble the visible
  deg/min/sec/hem fields.

### Added
- **Traditional sun-run-sun support: 36 h running-fix window** —
  classic single-sight-per-day practice advances yesterday's LOP by a
  full day's run, so consecutive sights land ~24 h apart; the old 6 h
  buffer couldn't span them. The ground-track window is now
  configurable (`groundTrackHours`, default 36 h ≈ 129 600 samples at
  1 Hz — a day plus drift margin for when the sight slips; the SQLite
  persistence window follows automatically). Memory and database grow
  ~3.6 MB per configured hour.
- **Restart survival for the DR ground track** (work doc #16, sea-trial
  prep): the running-fix advancement buffer (6 h ring of 1 Hz DR
  samples, SPEC §9.1) is now persisted to SQLite (`dr_track_samples`,
  flushed incrementally on the 60 s state-flush cadence plus the
  stop-time flush, pruned to the buffer window, `INSERT OR REPLACE`
  keyed on timestamp to match `GroundTrack.append` semantics) and
  re-seeded on plugin start — a mid-passage server restart no longer
  leaves sights taken before the restart un-advanced. Verified
  end-to-end: plugin run → stop → restart on the same db →
  `POST /fix/resolve` advances a pre-restart sight along the persisted
  DR run.
- **History-backed map restart survival** (work doc #16): a new
  `public/dr-history.js` module speaks the Signal K History API
  (`/signalk/v2/api/history`, no auth) — multi-path `/values` queries
  with aggregation postfixes (`:last` is mandatory for non-numeric
  paths like the divergence record; numbers may use `average`/`sma`/
  `ema`). On load, `<dr-app>` now backfills in one request: the GPS
  track, the DR ghost track (previously live-session only — a page
  reload blanked it), and the divergence sparkline. Tracks merge
  history → live-session points continuously.
- **Header set & drift readout + manual override** (SPEC §6.2 tier 1):
  the webapp header shows the resolved current vector (`067° · 1.2 kn`)
  themed by source (manual = orange with TTL countdown, weather/pilot
  chart = teal, none = offline grey). A new `≋ Current` toolbar button
  opens `<dr-current-panel>` — enter set (° true), drift (kn) and a TTL
  (default 60 min) to `PUT /current/manual`, or clear the override
  (`DELETE /current/manual`); the resolver honors the manual tier over
  every automatic source while the TTL lasts. `GET /status` now also
  reports the resolved `current` vector and any `manualCurrent`, so
  the header can bootstrap and refresh between deltas (the manual TTL
  caption counts down on the 30 s status poll).
- **Stopwatch sight-time entry ("N min N sec ago")**: each sight
  form's time field gains an `ago` mode — enter the minutes/seconds
  elapsed since the sight was taken (stopwatch method) and the offset
  converts to clock time **at entry**: every keystroke re-bases
  "now", so the committed instant is anchored to when the navigator
  stopped the watch, not when the form is submitted. The converted
  time lands in the regular sight-time field (still editable; the
  local/UTC toggle re-expresses it). Pure conversion in
  `vm.stopwatchToIso()`.
- **Running-fix visualization & interactive resolve** (work doc #13):
  - `POST /fix/resolve` candidates now carry per-observation
    `advancements` — the original reference point as taken, the
    DR-transported advanced point, and the displacement used (null when
    not advanced) — so the preview can show the transport instead of
    only the final fix.
  - **Pending observations are first-class**: new `<dr-pending-list>`
    panel alongside the map (moved out of the sight-entry modal) with
    per-row select (map highlight), edit and delete. A single pending
    observation shows a "needs a partner" hint. "Preview selected"
    resolves just the checked subset into a live candidate ring;
    confirm stays the deliberate second step.
  - **Advancement layer on the map**: for each previewed observation,
    the faded original point, the dashed DR-run vector, the advanced
    point and the advanced LOP line. Older observations that could not
    be advanced (no DR track over the interval) render in a warning
    style and the candidate ring flags "includes un-advanced
    observation" — the honest failure made visible.
  - **Map-click detail popover** (`<dr-detail-popover>`): click any
    LOP, CPL or fix on the map for its full record, with Edit (LOP/CPL
    → seeded sight form; fix → inline notes editor) and Delete actions.
  - **Observation & fix CRUD** (REST + db): `DELETE`/`PUT
    /fix/lop/:id`, `/fix/cpl/:id`, `/fix/:id`. LOPs/CPLs attached to a
    confirmed fix are guarded (409 — delete the fix first); deleting a
    fix un-confirms it: its observations return to pending, the
    correction row and any queued logbook entry are dropped, and the
    DR origin is not rewound. Fix edits allow only audit metadata
    (notes, confirmed_by, estimated error radius) — position and
    source_type are guarded.
  - **Phone-first layout pass** for the fix workflow: dialogs become
    bottom sheets on narrow viewports, tap targets ≥ 44 px, no
    hover-only affordances.
- **"Fix at coordinates" dialog** (replaces the one-tap "Fix at GPS"
  button): opens prefilled with the live GNSS position, editable before
  confirming. Covers three point-fix workflows with one flow —
  the GPS reality check (accept the prefill as-is), known-position fixes
  (type a berth/dock position, works without GNSS), and offline fixes
  from paper forms (backdated fix time, `backfill` source type). The
  dialog shows GNSS fix-quality stats when the receiver publishes them
  (`navigation.gnss.*`): system (GPS/GLONASS/…), fix method (2D/3D/DGNSS),
  satellites in use/visible, and HDOP with a rough error estimate that
  prefills the new estimated-error field. Coordinates accept decimal,
  DM or DMS free text so they can be transcribed from paper exactly as
  written; editing a prefilled GNSS coordinate switches the source to
  manual automatically.
- `POST /fix` accepts optional `timestamp`, `notes` and
  `estimated_error_nm` on point fixes (the fix pipeline already
  supported them; the route now forwards them). Backfilled fixes are
  recorded at their observation time — in `fixes`, `dr_corrections` and
  the signalk-logbook write-through — not at entry time. `backfill`
  fixes get a distinct map color.
- Sea-trial safety hardening — honest DR under sensor failure:
  - **Idle-while-making-way detection**: when STW/heading drop but
    GPS-derived motion shows the vessel still making way (fouled
    paddlewheel, compass dropout), the frozen DR position is flagged
    `moving: true` in `navigation.deadReckoning.state`, the uncertainty
    polygon keeps growing by GPS-derived ground distance (instead of
    freezing with the water track), and a §3.1 sensor-health alert
    (`notifications.navigation.deadReckoning.status`) is raised:
    "DR stopped tracking… position is stale". GPS remains authoritative
    until proven faulty or OVERRIDE — the watchkeeper is informed, not
    left with falsely-confident DR.
  - **Paddlewheel fouling surfaced**: `detectFouling`'s verdict (STW≈0
    while SOG/wind indicate motion) now raises the same §3.1 alert and
    sets `fouled: true` on the state, instead of silently gating
    training.
  - **Transient flag**: the underway state now carries
    `transient: true` during a tack/gybe — the UI explains an expected
    divergence spike instead of reading it as a fault.
  - **"Since last fix" headline**: `navigation.deadReckoning.elapsedSinceFix`
    (s, per-tick) drives the previously-unwired UI figure — the
    watchkeeper's fix-cadence cue (`elapsedText` formatter in the
    view-model).
  - UI status panel renders the new states with distinct styling:
    stale-DR / fouled (red), maneuver-in-progress (amber).
- Signal K Weather API current (SPEC §6.2 tier 3): a new
  `plugin/current.js` subsystem polls
  `/signalk/v2/api/weather/forecasts/point` at the vessel position
  (default every 30 min, off the 1 Hz hot path) and integrates the
  point-forecast `current` — `set` (rad) / `drift` (m/s), converted and
  u/v-interpolated between bracketing forecast entries — into the DR
  solution as set/drift. Offshore this is typically backed by a GRIB
  another process already downloaded, so it works without the plugin
  itself having connectivity. `resolveCurrent` (moved from
  `training.js`) resolves the full hierarchy: manual override (tier 1,
  not yet wired to an input) → weather API (tier 3) → offline pilot
  charts (tier 4, reserved hook) → zero vector (tier 5). A failed
  fetch keeps the previous cache until its TTL lapses; the resolved
  tier + source is published with `environment.current`. Config:
  `weatherCurrent.enabled` (default on), `.intervalMs`. The endpoint
  requires no authentication (verified against a live server), so no
  token plumbing is needed.

### Fixed
- **GPS track history backfill was silently 404ing**: the webapp
  queried `/signalk/v1/history/values`, but the history API (and the
  installed `signalk-history-sqlite` provider) serves
  `/signalk/v2/api/history/values` — the fallback to the live-session
  track always kicked in. The query now uses the v2 endpoint with the
  `duration` parameter from the History API contract.
- Sight panel assumed-position seeding threw on every DR/GPS position
  update: the `seedCoord` sub-field selector was missing its closing
  `]` (invalid selector), so the celestial form's assumed position
  never tracked the boat. Fixed in the shared `dr-coord-fields.js`
  module with a regression test.
- Sight panel DM/DMS submissions could send a stale seeded decimal
  value instead of the user-edited deg/min/sec fields: the form parser
  preferred the (hidden) decimal field whenever it was non-empty.
  Reading is now driven by the panel's `data-pos-format` attribute, so
  only the fields the user actually sees are read.
- Windows CI: the plugin smoke tests leaked open SQLite handles in the
  shared temp directory (four `makeStarted()` tests never called
  `plugin.stop()`). On Linux/macOS an open file can still be unlinked; on
  Windows the cleanup `rm` failed with `EBUSY: resource busy or locked`.
  Those tests now stop the plugin, and the shared teardown retries the
  removal (`maxRetries`/`retryDelay`, which `fs.rm` applies to EBUSY/EPERM
  on Windows only) to ride out transient locks from AV scanners on CI
  runners.
- `POST /fix/resolve` and `POST /fix` no longer return `observations not
  resolvable` when called with only `lop_ids`/`cpl_ids` (the common sight
  panel path). The pipeline now hydrates the observation bodies from the
  database via the new `getLineOfPosition`/`getCircularPositionLine` db
  helpers, then runs the geometric resolver on them.
- Bearing LOP no longer "runs through and past the object to the
  opposite bearing." A bearing LOP is now drawn as a ray from the
  charted object toward the navigator's side (the reciprocal of the
  measured bearing), with a short stub past the object, instead of a
  symmetric infinite line through the object. Celestial LOPs stay
  symmetric infinite lines. `lopLineSpec` now exposes `lopType`, and
  `extendLineSpec` renders bearing vs celestial LOPs differently.
- Sun-run-sun / running fix (SPEC §9.1): `resolveCandidateFix` now
  advances earlier observations to the timestamp of the latest one along
  the vessel's DR track before resolving, turning two LOPs taken at
  different times into a fix. The displacement comes from a new
  `GroundTrack` DR-history buffer (`plugin/ground-track.js`) fed by the
  DR engine's water-track integration only — **never GPS** (celestial is
  a GPS-independent position check; GPS is used only to calibrate DR
  accuracy, not to advance celestial LOPs). Boats without water-track
  sensors get no advance — the honest failure rather than a wrong fix.
  New `advanceToLatest` + `input.advance` provider in the pipeline.
- "Fix at GPS" quick action in the DR toolbar: confirms a GPS point fix
  (`source_type: "gps"`) at the current GNSS position — the GPS reality
  check that snaps the DR origin to GPS when the watchkeeper judges GPS
  good. Disabled when no GPS position is known.
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
- Logbook write-through no longer loses entries in the approval window:
  while no admin token is granted (access request pending, server
  unreachable, or token expired mid-passage), every fix / tack /
  observation entry is queued in a new `logbook_pending` SQLite table
  (bounded to 200, ordered) and flushed oldest-first once a token lands —
  nothing written during the approval window is dropped. The access flow
  now distinguishes an open server (501/404 → unauthenticated writes) from
  a transport failure (`unreachable` → queue + honest status, retry on
  the next write instead of falsely claiming an open server), and a
  tokenless write re-kicks `initLogbook()` so a lost/expired grant is
  re-requested at write time, not only at startup. A denied access request
  stops writes without re-request spam. Delayed fix deliveries mark their
  `fixes` row logged (the confirm route only marks immediate writes).
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
