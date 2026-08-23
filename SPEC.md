# Signal K Offline-First Dead Reckoning & Sensor Fusion Engine
## `sk-dead-reckoning` — Design Specification v0.3

---

## 1. Motivation

This plugin exists for three reasons, and the design deliberately treats them as **sequential facets of one engine**, not three separate features:

1. **Encourage crew to use the hand-bearing compass and sextant more often.** Traditional fix-taking should be rewarding in everyday use, not just an emergency skill nobody practices. The UI treats a celestial or bearing fix as a small, satisfying event — immediate feedback on accuracy, a running log of sights taken, and stats over time — rather than a dry navigational chore.
2. **Get better data out of the paddlewheel and wind sensors through learned calibration.** Cheap production sensors are systematically wrong in predictable, condition-dependent ways (leeway, upwash, speed loss). A multi-dimensional EMA matrix, trained continuously against GPS ground truth, learns those corrections empirically instead of relying on a fixed polar or manufacturer calibration.
3. **Provide a credible fallback when sailing into active electronic-warfare (EW) environments** — the Red Sea and the Baltic being current concrete examples, where GPS jamming and spoofing (not just denial) are documented and ongoing.

The three motivations are causally linked: (1) generates the fix data and crew engagement that feeds (2), and (2) is what makes (3) actually trustworthy rather than theoretical — a fallback system is only as good as the calibration behind it, and that calibration is built during ordinary, low-stakes sailing, not invented at the moment it's needed.

---

## 2. System Overview

`sk-dead-reckoning` is a zero-dependency*, offline-first inertial navigation and sensor fusion engine running locally on a Signal K server (Node.js). It:

- Continuously computes a dead-reckoned "shadow" position from water-track sensors (paddlewheel STW, compass heading, leeway/current corrections), **at all times**, regardless of whether GPS is currently trusted.
- Learns vessel-specific leeway, speed-loss, and heading-deviation corrections via a binned EMA matrix, trained against GPS ground truth during normal sailing.
- Detects GPS anomalies (sudden jumps, implausible-at-anchor/moored displacement, corroborating third-party AIS/ADS-B inconsistency) and alerts the watchkeeper — it does **not** auto-switch navigational authority; a human always decides when to trust DR over GPS.
- Supports a unified concept of "fix" that spans GPS, celestial sights, compass bearings, vertical-angle-to-known-object, and future methods (Starlink-constellation positioning, radio direction finding), each contributing either a point, a line-of-position, or a circular position line to a common fix-resolution model.
- Integrates with `signalk-logbook` (REST API) as an optional, gracefully-degrading write-through layer, so fixes and DR events become part of the vessel's actual logbook record.
- Supports offline historical backfill and backtesting against 4–5 years of Signal K History API data, optionally enriched with reanalysis weather/current data and logbook records when broadband is available.

\* "Zero-dependency" here means no external services required for core operation; the SQLite persistence layer should target Node's built-in `node:sqlite` (or an equivalent no-native-build option) rather than a compiled native binding, given the ARM/Raspberry-Pi-class hardware most Signal K installs run on.

---

## 3. Signal K Data Paths

### 3.1 Published Paths (Source: `plugin:sk-dead-reckoning`)

| Path | Type | Notes |
|---|---|---|
| `navigation.deadReckoning.position` | `{ latitude, longitude, altitude }` | **Always-on** 1Hz inertial "shadow boat" position — computed continuously regardless of mode. |
| `navigation.deadReckoning.active` | boolean | Whether DR is currently the *authoritative* source feeding `navigation.position` (i.e. OVERRIDE engaged), as distinct from merely running in the background. |
| `navigation.deadReckoning.method` | string: `inertial-polar` \| `inertial-paddlewheel` \| `fallback-zero` | Active state calculation mode. |
| `navigation.deadReckoning.log` | number (nm) | Cumulative **water-track** distance, integrated from STW. Independent of GPS. |
| `navigation.deadReckoning.trip.log` | number (nm) | Same, reset at trip boundaries (see §9.2). |
| `navigation.speedThroughWater` | number | Calibrated STW output (matrix-corrected). |
| `navigation.headingTrue` | number | Calibrated true heading (corrected for dynamic deviation). |
| `environment.current` | `{ setTrue, drift, meta: { source, expiresAt } }` | Current vector broadcast, per §6.2 hierarchy. |
| `notifications.navigation.gpsSpoofed` | alarm state | High-severity: sudden position discontinuity inconsistent with DR/physics, or at-anchor/moored displacement beyond plausible bound. See §7. |
| `notifications.navigation.deadReckoning.divergenceAdvisory` | notification (below alarm severity) | Low-severity nudge: DR-vs-GPS divergence or uncertainty-polygon growth exceeding a soft threshold — "get a fix." |
| `notifications.navigation.deadReckoning.status` | notification | Sensor health flags: paddlewheel fouling (STW≈0 while SOG/AWA indicate motion), WMM/almanac expiry, matrix bin coverage gaps, etc. |

### 3.2 Subscribed Paths

| Path | Purpose |
|---|---|
| `navigation.position` | GPS baseline for training mode and anomaly detection. |
| `navigation.speedThroughWater`, `navigation.headingMagnetic`, `navigation.attitude` | Raw sensor inputs (heel/pitch). |
| `environment.wind.angleApparent`, `environment.wind.speedApparent` | Wind inputs for leeway/upwash modeling. |
| `navigation.sails` | Active sail configuration, from `signalk-logbook`. |
| `environment.seaState` | Sea state tier, from logbook watch entries. |
| `navigation.state` | `anchored` \| `moored` \| `sailing` \| `motoring` \| ... — trip boundaries, and the anchored/moored anomaly-detection gates. |
| `propulsion.main.state` | `started` \| `stopped` — **authoritative** (non-GPS-derived) gate for excluding motoring intervals from sail-leeway matrix training. Preferred over inferring from `navigation.state`, since that is itself typically SOG-threshold-derived and therefore GPS-dependent. |
| `vessels.*` (AIS targets), and any locally available ADS-B feed | Third-party track corroboration for spoofing detection (§7.4). |
| `electrical.solar.*` (path TBD per installation) | Opportunistic passive time/position sanity check (§7.5). |

---

## 4. Database Schema (SQLite)

### 4.1 EMA Matrix — Leeway / Speed-Loss / Upwash

```sql
CREATE TABLE IF NOT EXISTS dr_matrix_bins (
    sail_state TEXT NOT NULL,        -- includes 'unknown' for pre-logbook-integration eras
    sea_state TEXT NOT NULL,         -- includes 'unknown'
    stw_bin REAL NOT NULL,           -- quantized, e.g. nearest 0.5kt
    awa_bin REAL NOT NULL,           -- quantized, e.g. nearest 5°
    heel_bin REAL NOT NULL,          -- quantized, e.g. nearest 2°
    leeway_angle REAL NOT NULL,
    speed_loss REAL NOT NULL,
    upwash_correction REAL NOT NULL,
    hit_count INTEGER NOT NULL,          -- effective count used by the learning-rate function
    live_hit_count INTEGER NOT NULL DEFAULT 0,
    historical_hit_count INTEGER NOT NULL DEFAULT 0,
    historical_confidence_tier TEXT,     -- 'reanalysis' | 'climatology' | NULL (live-only bin)
    PRIMARY KEY (sail_state, sea_state, stw_bin, awa_bin, heel_bin)
);
```

**Design notes:**
- `stw_bin`/`awa_bin`/`heel_bin` must be populated via an explicit quantization function (round to nearest bin width) before insert/lookup — storing raw continuous values as the primary key would prevent `hit_count` from ever accumulating meaningfully.
- `live_hit_count` and `historical_hit_count` are tracked separately so a season of live sailing can outweigh years of backfilled data in the effective confidence/learning-rate calculation — each live sample should count as several times a historical sample by default (tunable), and each historical sample's weight further depends on `historical_confidence_tier` (a bin trained against reanalysis current data is more trustworthy than one that only had climatological pilot-chart current available).
- `sail_state = motoring` (or any interval where `propulsion.main.state = started`) is **excluded** from writes to this table entirely — the underlying physics (prop walk, wake, rudder-induced yaw) differs from sail-driven leeway and would corrupt the model if blended. A separate under-power calibration table is out of scope for v1 (see §12).
- Historical bins written during backfill should apply a mild recency-decay weight, and/or respect configured "epoch boundaries" (known re-rig / instrument-replacement dates) so pre- and post-change data isn't blended across a known discontinuity.

### 4.2 Persistent DR State & Checkpoints

```sql
CREATE TABLE IF NOT EXISTS dr_state_store (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

Used for: running DR log totals, trip log totals, backfill high-water-mark timestamps, last-known-good fix reference, and similar scalar/JSON state that must survive restarts.

### 4.3 Digitized Offline Pilot Charts (climatological current fallback)

```sql
CREATE TABLE IF NOT EXISTS offline_pilot_currents (
    month INTEGER NOT NULL,
    lat_grid REAL NOT NULL,
    lon_grid REAL NOT NULL,
    current_u REAL NOT NULL,
    current_v REAL NOT NULL,
    PRIMARY KEY (month, lat_grid, lon_grid)
);
```

Lowest tier of the current hierarchy (§6.2) — used live when no better source is available, and used for historical backfill training only where reanalysis data (§10.2) doesn't cover a given date/region.

### 4.4 Unified Fix Model

Fixes, lines of position, and circular position lines are modeled as three related but distinct geometric primitives, reflecting how real navigational observations actually work: a **point** observation (GPS, and future Starlink-constellation positioning), a **line** observation ("you are somewhere along this line" — compass bearing, RDF bearing, or the linearized form of a celestial sight near the assumed position), and a **circle** observation ("you are somewhere on this circle" — the un-linearized form of a celestial sight, vertical-angle-to-known-object, or ranged ADS-B). LOPs and CPLs are combined (or advanced along the DR track, for the classic running-fix case) to resolve into a `fixes` row.

```sql
CREATE TABLE IF NOT EXISTS fixes (
    fix_id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    source_type TEXT NOT NULL,       -- 'gps' | 'celestial' | 'bearing' | 'manual' | 'backfill' | future values
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    estimated_error_radius REAL,
    confirmed_by TEXT,                -- crew name; simple free-text picker, no auth model assumed
    logged_to_logbook BOOLEAN NOT NULL DEFAULT 0,
    logbook_entry_ref TEXT,           -- datetime key of the corresponding signalk-logbook entry, if written
    resets_dr_origin BOOLEAN NOT NULL DEFAULT 0,
    notes TEXT
);

CREATE TABLE IF NOT EXISTS lines_of_position (
    lop_id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    lop_type TEXT NOT NULL,           -- 'celestial' | 'bearing' | 'rdf' | future values
    assumed_lat REAL NOT NULL,        -- AP for celestial; observer position for bearing/rdf
    assumed_lon REAL NOT NULL,
    azimuth_true REAL NOT NULL,       -- Zn (celestial) or measured bearing (bearing/rdf)
    intercept_nm REAL,                -- signed, toward/away — celestial only, NULL otherwise
    body_or_object TEXT,              -- 'Sun LL', 'Polaris', 'Radio Antenna XYZ', free text
    confirmed_by TEXT,
    used_in_fix_id INTEGER,
    FOREIGN KEY (used_in_fix_id) REFERENCES fixes(fix_id)
);

CREATE TABLE IF NOT EXISTS circular_position_lines (
    cpl_id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    cpl_type TEXT NOT NULL,           -- 'vertical-angle' | 'adsb-ranged' | 'adsb-max-range' | future values
    center_lat REAL NOT NULL,         -- charted object position (static) or reporting object's own position (transient, e.g. aircraft)
    center_lon REAL NOT NULL,
    radius_nm REAL NOT NULL,
    radius_uncertainty_nm REAL,
    source_object TEXT,               -- chart reference, ICAO hex/callsign, etc.
    confirmed_by TEXT,
    used_in_fix_id INTEGER,
    FOREIGN KEY (used_in_fix_id) REFERENCES fixes(fix_id)
);
```

**Fix-resolution logic** must be written generically against a mix of LOP and CPL inputs, not assume line-line intersection only:
- Line × Line → single intersection (existing running-fix / two-body-sight case).
- Line × Circle → single intersection on the plausible side (bearing + vertical-angle-to-same-object is the common instance — the UI should proactively offer "also take a bearing to this object" when a vertical angle is entered, since that's the natural pairing).
- Circle × Circle → **two** candidate intersections; default to the one nearest current DR position, but surface both to the watchkeeper rather than silently discarding one.
- A single, unresolved LOP or CPL may still be **advanced** along the DR track to combine with a later observation (classic running fix), reusing the DR engine's integrated track over the elapsed interval.

**Non-intersecting / contradictory inputs (residual fallback):** measurement error means an exact geometric intersection is the exception rather than the rule — three or more LOPs/CPLs will almost never cross at a single point (the classical "cocked hat" case), and even a two-input combination can fail to intersect cleanly if one observation was mistimed or misread. The resolver must not fail silently or force a nearest-point snap when inputs disagree beyond expected measurement tolerance. Instead:
- With ≥3 inputs, resolve via least-squares residual minimization (best-fit point minimizing summed distance to each line/circle constraint) rather than requiring exact intersection.
- With exactly 2 inputs that don't intersect within tolerance, present the closest-approach point and the residual gap explicitly, rather than silently picking a point on one of the two constraints.
- Always surface the resulting residual/spread (the "cocked hat" size) to the watchkeeper as an implicit confidence indicator alongside the resolved fix — a tight cluster supports confidence, a wide spread is a signal to retake a sight rather than a solver output to accept blindly.

**UI extensibility principle:** new fix methods are integrated by declaring whether they produce a point, line, or circle, and are routed to the corresponding existing table/pipeline — not by inventing a new generic "fix source" abstraction per method. Anticipated future methods: Starlink-constellation positioning (point), radio direction finding (line, same geometry as bearing).

### 4.5 DR Correction Log

```sql
CREATE TABLE IF NOT EXISTS dr_corrections (
    correction_id INTEGER PRIMARY KEY AUTOINCREMENT,
    fix_id INTEGER NOT NULL,
    timestamp TEXT NOT NULL,
    dr_lat REAL NOT NULL,
    dr_lon REAL NOT NULL,
    fix_lat REAL NOT NULL,
    fix_lon REAL NOT NULL,
    deviation_nm REAL NOT NULL,
    deviation_bearing REAL NOT NULL,
    dr_elapsed_seconds INTEGER NOT NULL,   -- time since DR origin (last snap) — deviation-rate is more meaningful than raw distance
    sail_state TEXT,
    sea_state TEXT,
    FOREIGN KEY (fix_id) REFERENCES fixes(fix_id)
);
```

Recorded on **every** snap-to-fix event, symmetric across NORMAL and OVERRIDE modes — this is both the passage-level "how good was DR" diagnostic and, segmented by `sail_state`/`sea_state`, the empirical input to the uncertainty-polygon growth model (§8).

### 4.6 Anomaly / Integrity Tables

```sql
CREATE TABLE IF NOT EXISTS anchor_swing_stats (
    depth_bin REAL NOT NULL,
    scope_bin REAL,                   -- nullable if rode-paid-out isn't tracked
    p50_distance_m REAL NOT NULL,
    p99_distance_m REAL NOT NULL,
    p999_distance_m REAL NOT NULL,
    sample_count INTEGER NOT NULL,
    PRIMARY KEY (depth_bin, scope_bin)
);

CREATE TABLE IF NOT EXISTS moored_position_stats (
    location_id INTEGER,              -- optional per-berth clustering
    p50_distance_m REAL NOT NULL,
    p99_distance_m REAL NOT NULL,
    p999_distance_m REAL NOT NULL,
    sample_count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS gps_anomalies (
    anomaly_id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    context TEXT NOT NULL,            -- 'anchored' | 'moored' | 'underway'
    jump_distance_m REAL NOT NULL,
    duration_seconds INTEGER,         -- if self-corrected
    self_corrected BOOLEAN,
    corroborated_by_ais_adsb BOOLEAN DEFAULT 0,
    severity TEXT NOT NULL            -- 'advisory' | 'alarm'
);
```

`gps_anomalies` is deliberately separate from `dr_corrections` — a `dr_corrections` row represents "we trusted DR and it disagreed with a subsequent fix"; a `gps_anomalies` row represents "GPS was internally inconsistent with itself (or with third-party tracks), independent of whether DR was involved." Different diagnostic purpose, kept schema-separate.

---

## 5. Execution Architecture

```
Main Thread (Signal K Event Loop)
  N2K/N0183 Ingest → Delta Router → signalk-logbook API (REST, optional)
                                   → GRIB Provider Service
                                   → AIS/ADS-B target tracking

Worker Thread (DR Physics)
  Router --1Hz sensor stream--> Message Queue → State Machine & Matrix Lookup
    → World Magnetic Model (bundled, expiry-checked)
    → Current Hierarchy Resolver
    → Fouling Detector (STW≈0 while SOG/AWA indicate motion)
    → Dead Reckoning Vector Integration
  → 1Hz delta emits back to Router (always-on: navigation.deadReckoning.position)
  → Periodic flush to SQLite
```

- Vector math and matrix lookups run isolated in a Worker Thread to avoid blocking the Signal K main event loop under high-frequency sensor input.
- REST calls to `signalk-logbook` happen on the **main thread**, never the physics worker — network I/O has no place on the 1Hz hot path.
- The DR engine computes continuously regardless of mode (see §3.1, `navigation.deadReckoning.active`), so switching to OVERRIDE is a warm, instant authority handoff rather than a cold start.
- A separate, explicitly user-triggered backfill job (§10) runs as a one-shot batch process, not on the live path.

---

## 6. Machine Learning & Sensor Fusion Engine

### 6.1 Training Mode vs. Inference Mode

**Training Mode** — active when `isGpsReliable = true` AND `propulsion.main.state = stopped` AND paddlewheel not fouled (§6.3):
- Computes error vectors: GPS SOG/COG vs. sensor STW/heading, minus the resolved current vector (§6.2), updated into matching `dr_matrix_bins` via EMA, learning rate modulated by effective `hit_count`.

**Inference Mode** — active when `isGpsReliable = false` OR OVERRIDE is manually engaged:
- Freezes matrix learning. Reads raw sensors, looks up matching bins, applies corrections, integrates the resolved current vector, publishes `navigation.deadReckoning.position` as authoritative (`navigation.deadReckoning.active = true`).
- If the paddlewheel is fouled during Inference Mode, falls back to GPS-SOG-derived speed (if GPS is at least partially available) or holds last-known-good STW with explicitly faster-growing uncertainty (if not) — distinct fallback branch from the "GPS unreliable" case, since the two can occur independently or together.

### 6.2 Current Hierarchy of Truth

1. Manual Override — watchstander input with valid TTL (`environment.current`).
2. Live High-Res — Starlink-cached coastal NetCDF vectors.
3. Sparse Forecast — bilinear/temporal-interpolated radio GRIB vectors.
4. Offline Pilot Charts — static SQLite monthly historical averages (`offline_pilot_currents`).
5. Zero Vector — pure inertial water track (U: 0, V: 0).

### 6.3 Paddlewheel Fouling Detection

Detected as: STW reads ~0 (or implausibly low) **while** GPS SOG is well above zero and/or AWA/AWS and non-negligible heel indicate the vessel is clearly moving. This distinguishes fouling from "boat is genuinely stopped" (where SOG≈0 too).

- Gates Training Mode entirely — a fouled reading must never be allowed to train the matrix (it would falsely teach "0 STW happens at these wind/heel conditions").
- Feeds `notifications.navigation.deadReckoning.status` as the concrete trigger for the paddlewheel-health flag.
- Applied retroactively during backfill/backtest as an outlier-rejection pass, alongside GPS-glitch filtering (§10.1), since historical logs almost certainly contain uncorrected fouled stretches.

### 6.4 Tack/Gybe Transient Suppression

During a tack or gybe the vessel passes through a transient state — heel sign-flip, sails luffing or slamming, leeway vector abruptly reversing — that does not represent steady-state sailing behavior for the new tack. If the matrix updater samples heavily during this window, transient noise pollutes the steady-state bins it should be learning.

- **Detection:** rate-of-turn (gyro/rate compass) exceeding a threshold (e.g. > 3°/sec) marks the start of a transient window.
- **Suppression:** matrix writes are suspended for the duration of the transient and a settle period afterward. The settle period is not a fixed timer — it ends when heel and AWA re-stabilize within tolerance for a sustained interval, since a slow tack in light air settles faster than a hard tack in a breeze, and a fixed 15–30s window would be wrong in both directions depending on conditions.
- This is the same category of exclusion already applied to motoring intervals (§4.1) and fouled-sensor readings (§6.3) — a third source of transient/invalid training data, handled by the same "gate writes, don't corrupt the bin" principle.
- Applies equally during backfill (§10.1): historical rate-of-turn, where available at sufficient resolution, should gate training-sample inclusion the same way; where turn-rate isn't reliably derivable from ~10s-resolution history, a conservative fixed exclusion window around detected heading reversals is an acceptable fallback for backfilled data specifically (consistent with backfill already being treated as lower-confidence than live data, §4.1).

### 6.5 Sensor Mounting

Paddlewheel, wind sensor, and compass mounting positions/offsets are treated as fixed at install time and out of scope for dynamic compensation in this plugin — assumed handled upstream if relevant.

---

## 7. GPS Integrity & Spoofing Detection

Detection is deliberately regime-specific — the plausible-motion envelope differs enormously between anchored, moored, and underway, and each regime supports a meaningfully different detection approach. **In no case does the system auto-switch navigational authority.** A human watchkeeper always makes the OVERRIDE decision; the system's job is to make sure that decision is made with good, timely information.

### 7.1 At Anchor

- Reference point is derived from the **settled** portion of the anchored stay, not the "anchor is down" click timestamp — the click has human timing error, and the anchor may drag while setting before it bites. A warm-up window (e.g. 10–15 minutes, or until swing-pattern variance drops below a threshold) is excluded from reference-point computation.
- Plausibility bound combines:
  - a **geometric bound**: `sqrt(rode_length² − depth²)` as an outer limit (with a scope-ratio default if rode length isn't directly tracked), and
  - an **empirical bound**: percentile distance-from-reference distributions built from History API backfill (`anchor_swing_stats`), binned by depth (and scope where available) — this naturally captures real-world slop (wind, current, snubber stretch) that pure geometry misses.
  - The larger (more conservative) of the two is used as the alarm threshold.
- Backfill for `anchor_swing_stats` must separately identify and exclude **genuine dragging episodes** (sustained, growing, physically-plausible-given-wind/current displacement) from the "normal swing" sample set — those are the anchor alarm's own job to catch, not this table's, and mixing them in would corrupt the plausibility distribution in the wrong direction.
- The detector is backtested against the full historical anchored dataset before being trusted live, explicitly confirming it flags known past incidents (e.g. the ~100m GPS jumps observed) without false-positiving on ordinary swing.

### 7.2 Moored

- `navigation.state = 'moored'` gates this check directly (native Signal K state value).
- True position variance while moored is smaller than typical GPS jitter, which **inverts** the anchored case: the threshold needs to be tight, not generous — any displacement clearly beyond normal receiver noise is anomalous.
- `moored_position_stats`, built the same way as the anchor table (percentile distance-from-reference from History API backfill), doubles as a useful **GPS noise-floor baseline** for the receiver generally, and can inform how conservative the anchored-state empirical bound needs to be.

### 7.3 Underway

The harder case, and the one closest to the core EW use case (motivation 3). Two distinct signal bands, both surfaced, neither auto-switching:

- **Sudden position discontinuity** inconsistent with DR-predicted motion (a "jump") → **high-severity alert** (`notifications.navigation.gpsSpoofed`). Message content should explicitly note that AIS reliability is also compromised in this situation (it depends on the same GPS), not just position — prompting the watchkeeper toward manual OVERRIDE, alternate position verification, and a sharper lookout.
- **Gradual DR-vs-GPS divergence growth** beyond the current uncertainty-polygon's expected rate → **low-severity advisory** (`notifications.navigation.deadReckoning.divergenceAdvisory`), nudging the watchkeeper to get a fix by any convenient method, including a one-tap "confirm GPS fix" if GPS otherwise still looks trustworthy. This is not necessarily a spoofing scenario — often just "it's been a while since a confirmed fix."
- Candidate signal set for the underway jump detector (flagged as needing a follow-up design pass before implementation): position-jump magnitude vs. DR-predicted position, velocity/heading discontinuity, HDOP/DOP anomalies if exposed by the GPS unit, multi-constellation disagreement if available, and AIS/ADS-B corroboration (§7.4).
- Continuous background DR (§5, §3.1) means the divergence computation for both bands is always live, not something that has to spin up after the fact.

### 7.4 AIS / ADS-B Corroboration

- Subscribe to AIS target deltas (`vessels.*`) and, where available, a local ADS-B feed.
- For each tracked target, check **own-track internal consistency** (a jump or discontinuity inconsistent with the target's own prior heading/speed) — this is analogous to the vessel's own DR-vs-GPS jump check, applied to third-party tracks.
- Separately flag **range-anomalous receptions**: a target received from far beyond the normal reception envelope for its type/altitude/band is a strong Sporadic-E (or other anomalous propagation) candidate, not a spoofing indicator — its own track is typically internally consistent, it's just surprising that it was heard at all. Filter these out of the spoofing signal using a configured max-normal-range threshold; log them separately as incidental/interesting data.
- Only the *own-track-inconsistent, not range-anomalous* class of third-party events feeds the underway spoofing detector — multiple independent targets showing simultaneous track-inconsistent jumps alongside the vessel's own GPS anomaly is meaningfully stronger corroboration than either alone, and should be weighted accordingly in the eventual detector scoring (§7.3).

### 7.5 Solar Panel Curve — Opportunistic Passive Sanity Check

- On clear, unshaded, level (moored/anchored, minimal heel) days, detect sunrise/sunset crossing and solar-noon peak timing from `electrical.solar.*` output, and compare against ephemeris-computed values for the last-known-good position.
- This is a genuinely GNSS-independent signal (depends only on the sun, true physical location, and system clock), which makes it a candidate cross-check specifically against **time integrity** — a dimension none of the position-based checks above address. It does not disambiguate whether a discrepancy is a position error or a clock error, only that something is inconsistent.
- Explicitly **not** a formal fix input (too coarse, too conditionally reliable — cloud cover, panel shading/orientation during heel destroy the signal on most days). Scoped as a low-priority background diagnostic, logged alongside the other integrity signals, not fed into the fix-resolution engine.

---

## 8. Uncertainty Polygon

Displayed continuously around the shadow-boat DR position; also governs the practical threshold for the divergence advisory (§7.3).

**Growth model — combined approach:**
- **Primary driver:** empirically observed deviation-rate, computed from `dr_corrections` (`deviation_nm` / `dr_elapsed_seconds`), bucketed by `sail_state`/`sea_state`, weighted by the current bin's `hit_count`/confidence in `dr_matrix_bins`. As the matrix accumulates live data, the polygon visibly tightens for well-covered conditions — a tangible, motivating signal of the system improving over a season (reinforcing motivation 2).
- **Fallback:** a conservative fixed distance-based growth rate (elapsed distance run × an assumed angular-error margin, rather than pure elapsed time, since DR error compounds with distance more honestly than with clock time) for bins with low `hit_count` — early in the plugin's life, or unusual conditions not yet well-sailed.
- Growth rate is **re-evaluated at each bin transition** (tack, sail change, sea-state change) during a DR excursion, not frozen at excursion-start, so the polygon reflects momentarily better or worse conditions as they occur.

---

## 9. Fix Confirmation, Snap-to-Fix, and DR Correction

### 9.1 Unified Confirmation Flow

Every fix — regardless of `source_type` — goes through the same pipeline: raw observation(s) → (for LOP/CPL types) combine or advance-and-combine → candidate fix presented to watchkeeper with corroborating context (for GPS: recent stability, HDOP, agreement with the uncertainty polygon; for celestial/bearing: computed intercept/geometry) → explicit human confirmation, attributed via `confirmed_by` → `fixes` row written, DR origin reset if applicable.

Routine GPS confirmations are visually de-emphasized / one-tap in the UI; celestial and bearing entry remain the deliberate, full-detail forms — same backend pipeline, different UI weight, consistent with motivation 1's goal of making deliberate fix-taking feel worthwhile rather than routine-GPS-taps feeling like unnecessary friction.

### 9.2 Trip Boundaries

`navigation.state` transitions (`anchored`/`moored` ↔ underway) define trip start/end, resetting `navigation.deadReckoning.trip.log`. This also gives backfill a clean historical segmentation mechanism, independent of the sail/motor training-gate distinction (§6.1), which instead uses `propulsion.main.state`.

### 9.3 Snap-to-Fix & Correction Recording

On every confirmed fix that resets the DR origin (symmetric across NORMAL and OVERRIDE modes):
- A `dr_corrections` row is written (deviation distance/bearing, elapsed time, sail/sea state context).
- The map (`<dr-map-view>`) draws a brief, distinctly-styled (e.g. dashed) vector from the pre-snap shadow-boat position to the new confirmed fix.
- The deviation-rate (nm/hour, not raw distance) is surfaced immediately as positive/informative feedback ("DR held to 0.2nm over 45 minutes") — reinforcing trust incrementally rather than only mattering the one time it's mission-critical.

### 9.4 Automatic Tack/Gybe Logbook Entries

The rate-of-turn detection already built for matrix-training suppression (§6.4) is a free source of a routine, easily-forgotten logbook event: reuse the same tack/gybe detection to auto-generate a `signalk-logbook` entry (`category: navigation`, `origin: agent`, per the field mapping in §9.5) whenever a completed tack or gybe is detected — direction (tack→tack or gybe), new heading, and timestamp are all already available from the same signal.

- No watchkeeper confirmation step is needed for this entry type — unlike fixes, there's no ambiguity or human judgment involved in "a tack happened," so it can write directly rather than going through the confirm-first pipeline used for fixes.
- Should respect the same "avoid flooding the logbook" concern raised for routine GPS fixes (§9.1) — a beat to windward with frequent short tacks could generate a lot of entries; consider a minimum-interval debounce (e.g. don't log a second tack within some short window, treating rapid back-to-back direction changes as one transient event) rather than logging every single rate-of-turn crossing.
- This is incidental to the core DR/matrix purpose but effectively free, since the detection work is already required for §6.4.

### 9.5 `signalk-logbook` Field Mapping

The logbook's `NewEntry`/`Entry` schema (OpenAPI, confirmed against the actual plugin) has no dedicated fix-type or celestial-specific fields — it's a general entry with a required free-text `text` plus optional structured fields. `fixes` remains the local source of truth; the logbook write is a formatted export, not the canonical record.

| `fixes` / DR field | Logbook field | Notes |
|---|---|---|
| `timestamp` | `datetime` | Use explicit `datetime`, not `ago` — confirmations can lag a DR-origin reset by more than the 15-minute cap `ago` allows. |
| `latitude`/`longitude` | `position.latitude`/`position.longitude` | |
| — | `position.source` | Free string: `"GPS"` / `"Celestial"` / `"Bearing"` / `"DR"`. |
| celestial specifics (body, Hs, Ho, Hc, intercept, azimuth, index error) | `text` | No structured field exists for these — compose into the free-text summary, templated per `source_type`. |
| `confirmed_by` | `author` | |
| — | `category` | `"navigation"`. |
| — | `origin` | `"agent"` for plugin-generated entries from a human-confirmed fix (not `"manual"` — no free text was typed by a human; not `"auto"` — a human did confirm the underlying observation). Convention adopted for this plugin; verify against how `origin: agent` is used elsewhere before finalizing. |
| DR-integrated distance since last fix | `log` | Sourced from `navigation.deadReckoning.log`, not GPS-derived distance (§10.3), especially important during OVERRIDE. |
| STW/SOG, heading/COG if available | `speed.stw`/`speed.sog`, `heading`/`course` | |
| `environment.seaState`, if available | `observations.seaState` | Schema is `additionalProperties: false` — only populate defined fields, don't attempt to pass extra data through. |

Writes are POSTed from the main thread (never the physics worker), gated on `signalk-logbook` being detected as installed at startup (optional peer, degrade gracefully if absent — `fixes` remains complete regardless), and always use explicit `datetime` rather than relying on retry/idempotency assumptions not yet confirmed from the plugin's actual behavior under connectivity loss.

---

## 10. Historical Backfill & Backtesting

Two distinct jobs, both explicit, user-triggered, broadband-gated (Starlink) operations — never silent background behavior, consistent with the general "connectivity-dependent actions are deliberate" principle applied elsewhere (e.g. WMM updates, §11).

### 10.1 Backfill (training)

Replays History API data (4–5 years) through the same bin/EMA logic as live training mode, to seed `dr_matrix_bins` before significant live sailing accumulates.

- **Weather/current enrichment:** when run with broadband available, fetches historical reanalysis current/wind data (e.g. Copernicus Marine Service / ERA5-class products — license/attribution terms to be confirmed before committing to a specific provider) for the dates/positions actually visited, rather than relying solely on climatological pilot-chart averages. Query set is deduplicated to distinct (date, grid-cell) tuples before fetching, batched and rate-limited/backed-off per the provider's documented limits, with a persisted progress checkpoint (`dr_state_store` high-water-mark) so an interrupted run can resume. Bins trained with reanalysis current get a higher `historical_confidence_tier` weight than climatology-only bins (§4.1).
- **Logbook enrichment:** where `signalk-logbook` entries exist for the historical window (likely not the full 4–5 years), join by nearest-timestamp (~±30min) to recover `sail_state`/`observations.seaState` for spans that would otherwise fall to `'unknown'`. Historical `navigation`-category logbook entries with a `position` are additionally ingested into `fixes` (`source_type = 'backfill'`), so passage review isn't blank for the pre-plugin era.
- **Resolution/provenance caveats, explicitly documented rather than silently absorbed:** ~10s History API resolution under-represents instantaneous heel/AWA response (gust/roll dynamics) versus live 1Hz IMU data; paddlewheel fouling status is essentially unknown for historical data and must be inferred via the STW≈0-while-moving heuristic (§6.3) applied retroactively; `navigation.log`/`navigation.trip.log`/logbook `log` fields are GPS-track-derived, not water-track, and must never be used as an STW proxy or ground truth during backfill.
- **Outlier rejection:** a max-plausible-speed/position-jump filter, plus the fouling heuristic, applied before samples enter training — historical GPS glitches are otherwise uncorrected and would poison bins.
- Also used to build `anchor_swing_stats` and `moored_position_stats` (§7.1, §7.2), each with their own drag-exclusion / settle-window preprocessing. Recomputed periodically (e.g. quarterly) rather than live-updated, since these have no need for 1Hz reactivity.

### 10.2 Backtesting (validation)

Runs the **already-trained** matrix in inference mode against historical GPS tracks with known outcomes, computing what `dr_corrections`-style deviations would have been — a "replay this passage, show ghost-track-vs-actual divergence" tool. Treated as a first-class feature (not incidental to backfill): it's how matrix and anomaly-detector quality get validated against years of real passages before being trusted live in a genuine EW transit. The at-anchor jump detector specifically should be backtested against the full historical anchored dataset as an early, self-contained validation script, confirming it flags known past incidents without false-positiving on ordinary swing.

### 10.3 GPS-Derived Distance During OVERRIDE

`navigation.log`/`trip.log`/`navigation.log` are GPS-derived and therefore exactly as unreliable as position during a genuine spoofing event. Logbook writes made while `navigation.deadReckoning.active = true` should source distance from `navigation.deadReckoning.log`/`trip.log` instead, never from the GPS-derived paths.

---

## 11. Time Synchronization & Clock Integrity

Celestial sight reduction and the solar-panel sanity check (§7.5) both assume the system clock is accurate to within a few seconds — celestial longitude error scales directly with time error (4 seconds of time error ≈ 1nm of longitude error), so an uncorrected drifting clock silently degrades sight accuracy and can also cause the solar-noon check to falsely flag a position/GPS anomaly that is actually just a clock error.

- Single-board-computer RTCs are prone to drifting seconds-to-minutes per week without periodic correction, and offshore stretches without cellular/internet NTP access are exactly when this matters most and is least likely to be caught.
- **GPS time is a usable independent reference for this purpose even when GPS *position* is under suspicion** — a spoofing signal aimed at deceiving position does not necessarily also present a self-consistent, disciplined time signal, so trusting GPS time while distrusting GPS position is a legitimate, separable judgment, not a contradiction of the rest of §7's skepticism.
- Track time-since-last-GPS-time-sync in `dr_state_store`. On startup and periodically, if drift since last sync exceeds a threshold, raise via `notifications.navigation.deadReckoning.status`.
- Sight-reduction and solar-noon-check outputs should carry a confidence/staleness indicator tied to this value — a sight taken long after the last known-good time sync is less trustworthy, and that should be visible to the watchkeeper rather than presented with the same confidence as one taken right after a sync.
- WWV/CHU radio time ticks are a plausible secondary independent reference if ever instrumented, but out of scope for v1 — noted here as a future option, not a current requirement.

---

## 12. WMM & Star Almanac Data

- **Baseline (v1):** bundled coefficient/almanac data with an embedded epoch/valid-until date. On startup, compare against current date; if expired or nearing expiry, raise via the existing `notifications.navigation.deadReckoning.status` path rather than silently continuing on stale data. WMM degrades gracefully (slowly, not catastrophically) past expiry, so this is a warning, not a hard failure.
- **Deferred to v2:** user-triggered manual update ("update navigation data" button), fetching a fresh coefficient/almanac set when broadband is available. No automatic/background fetching, consistent with the deliberate-connectivity-action principle used for backfill.

---

## 13. Celestial Sight Reduction

- Sun and Moon ephemeris via `suncalc` (sufficient accuracy for practical sight reduction).
- Stars/planets require a bundled static almanac subset (positions, GHA/SHA/declination — proper motion negligible short-term) plus a locally-implemented sight-reduction routine (Marcq St. Hilaire / intercept method) — no external star-catalog dependency needed. The bundled dataset must carry an explicit valid-epoch range (e.g. "valid 2026–2030") stored alongside the data, checked at startup the same way as WMM expiry (§12), and surfaced via the same status notification if expired — proper motion is negligible over that span, but the dataset should never be silently trusted past a stated bound.
- A single celestial LOP is, geometrically, the linearized local approximation of a circle of equal altitude (radius = 90° − Ho, centered on the body's geographic position) around the assumed position — valid over the small distance the AP is from true position. This is why `lines_of_position` (linearized, for combining near a known DR position) and `circular_position_lines` (exact, for single unlinearized observations like vertical-angle-to-known-object or ranged ADS-B) are related-but-distinct tables rather than redundant (§4.4).
- The sight-reduction engine is a module parallel to the DR physics worker (not UI-only), since it needs the same "best current position estimate" context — celestial fixes are typically used to correct DR, not computed in isolation.
- Sight-reduction results should carry the time-sync staleness indicator described in §11.

---

## 14. UI: `<dr-map-view>` Web Component

Native Web Components + OpenLayers/Leaflet (EUPL-1.2 compatible), no build tooling required.

### 14.1 Core Capabilities

- **Dual/continuous track rendering:** physical GPS track vs. the always-on inertial "Ghost Track," regardless of current mode.
- **Live divergence readout:** distance + bearing between GPS fix and shadow DR position, with a short trend sparkline — the primary at-a-glance diagnostic of model quality.
- **Uncertainty polygon:** per §8's combined growth model, visibly tightening over time as matrix confidence improves.
- **Three renderable geometric primitives**, styled distinctly:
  - **Fixes** (points).
  - **Lines of position** (`#ffcc00` on `#003399`, per original spec) — including advanced/running-fix LOPs.
  - **Circular / arc position lines** — new primitive, distinct styling from LOPs so it's visually clear it's a different kind of constraint.
- **Snap-to-fix correction vector:** brief dashed segment from pre-snap ghost position to confirmed fix (§9.3).
- **Manual LOP & Sight Input:** frictionless entry for compass bearings, vertical-angle sights, and celestial sights (Marcq St. Hilaire); UI proactively offers pairing a bearing with a vertical-angle observation of the same object.
- **Environmental Override Panel:** manual Set/Drift/TTL sliders (§6.2, hierarchy tier 1).
- **Failover Control:** prominent manual NORMAL ↔ OVERRIDE switcher — always human-initiated, informed by (never bypassed by) the alerts in §7.
- **Calibration dashboard:** matrix bin coverage/confidence by sail/sea/heel state, leeway-angle-vs-heel curves, speed-loss tables — supports motivation 2 as a standalone reference view, not only the EW use case.
- **Sight/fix stats view:** accuracy-vs-GPS/DR trend over time, optionally per `confirmed_by` — supports motivation 1's skill-building/engagement goal.

---

## 15. Open Items (flagged for follow-up design passes, not blocking v1 implementation)

1. **Underway spoofing jump-detector algorithm** — candidate signal set is listed (§7.3) but the actual detection/scoring logic (thresholds, how AIS/ADS-B corroboration is weighted in) needs a dedicated design pass before implementation.
2. **Confidence-based uncertainty polygon implementation** — the combined model (§8) is specified conceptually; the concrete function mapping `dr_matrix_bins` confidence + `dr_corrections` history to a live growth rate needs to be worked out.
3. **Under-power (motoring) calibration** — explicitly out of scope for v1; if pursued later, likely a separate small matrix keyed on RPM/rudder angle rather than reuse of `dr_matrix_bins`.
4. **Future fix methods** — Starlink-constellation positioning (point) and radio direction finding (line) are anticipated but not implemented; both fit the existing extensibility model (§4.4) without schema changes.
5. **v2 candidate:** manual/opportunistic WMM & star-almanac network update (§12).
6. **Secondary time reference (WWV/CHU)** — noted as a plausible future cross-check for clock integrity (§11) beyond GPS time, not required for v1.
