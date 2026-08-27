/**
 * Signal K Dead Reckoning & Sensor Fusion Engine.
 *
 * Offline-first inertial navigation shadow-boat that runs continuously
 * regardless of GPS trust, learns vessel-specific leeway/speed-loss/upwash
 * corrections via a binned EMA matrix trained against GPS ground truth, and
 * surfaces GPS integrity anomalies without ever auto-switching
 * navigational authority — a human always decides (SPEC §1, §7).
 *
 * @file index.js
 */

/** @typedef {import("@signalk/server-api").ServerAPI} ServerAPI */
/** @typedef {import("@signalk/server-api").Plugin} Plugin */

const { join } = require("node:path");
const crypto = require("node:crypto");
const {
  openDatabase,
  getState,
  setState,
  recordFix,
  recordCorrection,
  getDeviationRateStats,
  markFixLogged,
  enqueueLogbookPending,
  listLogbookPending,
  dequeueLogbookPending,
  listFixes,
  listLinesOfPosition,
  listCircularPositionLines,
  getLineOfPosition,
  getCircularPositionLine,
  listCorrections,
  getFix,
  deleteLineOfPosition,
  deleteCircularPositionLine,
  deleteFix,
  updateLineOfPosition,
  updateCircularPositionLine,
  updateFix,
  recordTrackSamples,
  pruneTrackSamplesBefore,
  loadTrackSamplesSince,
} = require("./db.js");
const { MatrixStore } = require("./matrix.js");
const { DeadReckoningEngine } = require("./engine.js");
const { GroundTrack } = require("./ground-track.js");
const {
  TrainingState,
  tick: trainingTick,
  detectManeuver,
  SOG_MOVING_KN,
} = require("./training.js");
const { resolveCurrent, WeatherCurrentClient } = require("./current.js");
const { distanceNm, bearingDeg } = require("./geo.js");
const {
  recordLineOfPosition,
  recordCircularPositionLine,
  attachObservationsToFix,
} = require("./db.js");
const { resolveCandidateFix, confirmFix } = require("./fix-pipeline.js");
const { reduceSight, reduceNoonSight } = require("./celestial.js");
const starAlmanac = require("./star-almanac.js");
const { computeRadius } = require("./uncertainty.js");
const {
  DEFAULT_FACTOR,
  DEFAULT_SUSTAIN_S,
  DEFAULT_CLEAR_S,
  createDivergenceState,
  divergenceTick,
} = require("./divergence.js");
const {
  composeFixEntry,
  composeTackEntry,
  composeObservationEntry,
  createLogbookClient,
  createAccessRequestClient,
  newClientId,
} = require("./logbook.js");

/**
 * Plugin identifier (matches package name without the scope).
 */
const PLUGIN_ID = "signalk-dead-reckoning";

/**
 * Public REST path the plugin config (incl. position format) is served
 * at. Mounted on the app (not the plugin router) so anonymous / read-only
 * clients — a helm display hitting the page without logging in — can
 * load it. Routes registered through `registerWithRouter` are
 * admin-only; an app-mounted route under the public `/signalk/v2/api/`
 * namespace is the established Signal K pattern (see signalk-status-tiles).
 */
const CONFIG_PATH = `/signalk/v2/api/${PLUGIN_ID}/configuration`;

/** Delta path (relative to `vessels.self`) carrying the current config hash. */
const CONFIG_HASH_PATH = "navigation.deadReckoning.configHash";

/**
 * Canonical JSON serialization: object keys sorted recursively, arrays
 * order-preserving. Two configs that differ only in key order hash
 * identically, so the hash only changes when contents change.
 *
 * @param {unknown} value
 * @returns {string}
 */
function canonicalJson(value) {
  if (value === undefined) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Stable hash of the config contents (sha256 over canonical JSON). A
 * change token, not a checksum the webapp verifies: only needs to be
 * stable for identical content and different for different content.
 *
 * @param {object} config
 * @returns {string}
 */
function configHash(config) {
  return crypto
    .createHash("sha256")
    .update(canonicalJson(config ?? {}))
    .digest("hex");
}

/**
 * Extracts the username from the Signal K authentication cookie
 * (mirrors signalk-logbook's `parseJwt`). Used so the server populates
 * `confirmed_by` from the logged-in watchkeeper instead of trusting a
 * client-supplied field.
 *
 * @param {object} [cookies]
 * @returns {string} username, or "" when not authenticated
 */
function usernameFromCookies(cookies) {
  const token = cookies?.JAUTHENTICATION;
  if (!token) return "";
  try {
    return (
      JSON.parse(Buffer.from(token.split(".")[1], "base64").toString()).id || ""
    );
  } catch {
    return "";
  }
}

/**
 * Signal K paths published by this plugin (SPEC §3.1).
 */
const PATHS = {
  position: "navigation.deadReckoning.position",
  active: "navigation.deadReckoning.active",
  method: "navigation.deadReckoning.method",
  log: "navigation.deadReckoning.log",
  tripLog: "navigation.deadReckoning.trip.log",
  stw: "navigation.speedThroughWater",
  headingTrue: "navigation.headingTrue",
  current: "environment.current",
  uncertainty: "navigation.deadReckoning.uncertainty",
  divergence: "navigation.deadReckoning.divergence",
  state: "navigation.deadReckoning.state",
  elapsedSinceFix: "navigation.deadReckoning.elapsedSinceFix",
  divergenceAdvisory:
    "notifications.navigation.deadReckoning.divergenceAdvisory",
  // SPEC §3.1: sensor-health flags (idle-while-making-way, paddlewheel
  // fouling). Published only on transitions, like the divergence advisory.
  sensorHealth: "notifications.navigation.deadReckoning.status",
};

/**
 * Paths subscribed to (SPEC §3.2). `navigation.position` is the GPS baseline
 * for training and anomaly detection; the water-track/wind/attitude paths
 * are raw sensor inputs.
 */
const SUBSCRIPTION_PATHS = [
  "navigation.position",
  "navigation.speedThroughWater",
  "navigation.headingMagnetic",
  "navigation.headingTrue",
  "navigation.attitude",
  "environment.wind.angleApparent",
  "environment.wind.speedApparent",
  "navigation.state",
  "propulsion.main.state",
  // Sea state: SPEC §3.2 subscribes environment.seaState; the logbook
  // actually publishes environment.water.swell.state (verified in its
  // source). Subscribe both, prefer whichever carries a value.
  "environment.seaState",
  "environment.water.swell.state",
];

/**
 * Default configuration.
 */
const DEFAULT_CONFIG = {
  tickIntervalMs: 1000,
  saveIntervalMs: 60000,
  positionFormat: "dms",
  divergence: {
    factor: DEFAULT_FACTOR,
    sustainS: DEFAULT_SUSTAIN_S,
    clearS: DEFAULT_CLEAR_S,
  },
  logbook: {
    enabled: false,
    url: "http://localhost:3000/plugins/signalk-logbook/logs",
    baseUrl: "http://localhost:3000",
    pollIntervalMs: 30000,
    tackDebounceS: 120,
    token: "",
  },
  training: {
    settleSustainS: null, // null → module default (10s)
  },
  weatherCurrent: {
    enabled: true,
    baseUrl: "", // empty → http://localhost:<server port>
    intervalMs: 1800000,
  },
};

/**
 * Overridable dependencies for testing (mirrors the energy-predictor
 * pattern). Production callers leave these at their defaults.
 */
const deps = {
  openDatabase,
  getState,
  setState,
  recordFix,
  recordCorrection,
  getDeviationRateStats,
  recordLineOfPosition,
  recordCircularPositionLine,
  attachObservationsToFix,
  resolveCandidateFix,
  confirmFix,
  computeRadius,
  createDivergenceState,
  divergenceTick,
  composeFixEntry,
  composeTackEntry,
  composeObservationEntry,
  createLogbookClient,
  createAccessRequestClient,
  newClientId,
  markFixLogged,
  enqueueLogbookPending,
  listLogbookPending,
  dequeueLogbookPending,
  recordTrackSamples,
  pruneTrackSamplesBefore,
  loadTrackSamplesSince,
  listFixes,
  listLinesOfPosition,
  listCircularPositionLines,
  getLineOfPosition,
  getCircularPositionLine,
  listCorrections,
  getFix,
  deleteLineOfPosition,
  deleteCircularPositionLine,
  deleteFix,
  updateLineOfPosition,
  updateCircularPositionLine,
  updateFix,
  DeadReckoningEngine,
  MatrixStore,
  GroundTrack,
  TrainingState,
  resolveCurrent,
  WeatherCurrentClient,
  trainingTick,
  detectManeuver,
  distanceNm,
  bearingDeg,
};

/**
 * @param {ServerAPI} app - Signal K server API
 * @returns {Plugin}
 */
module.exports = (app) => {
  /** @type {Function} */
  const setStatus = (app.setPluginStatus || app.setProviderStatus)?.bind(app);

  /** @type {Function[]} */
  const unsubscribes = [];

  /** @type {Map<string, unknown>} latest per-path values from the delta stream */
  const deltaState = new Map();

  /** @type {import("node:sqlite").DatabaseSync|null} */
  let db = null;

  /** @type {MatrixStore|null} */
  let matrix = null;

  /** @type {DeadReckoningEngine|null} */
  let engine = null;

  /** @type {import("./ground-track.js").GroundTrack|null} */
  let groundTrack = null;

  /**
   * High-water mark (ms epoch) of ground-track samples already flushed
   * to `dr_track_samples` — restart-survival incremental flush.
   * @type {number}
   */
  let trackFlushedTs = 0;

  /** @type {WeatherCurrentClient|null} §6.2 tier-3 weather current poller */
  let weatherClient = null;

  /**
   * Manual set-and-drift override (§6.2 tier 1): watchstander input,
   * honored while its TTL lasts. Set/cleared via
   * PUT/DELETE /current/manual.
   * @type {{setTrue: number, drift: number, validUntilMs: number, setBy: string|null, setAtMs: number}|null}
   */
  let manualCurrent = null;

  /**
   * Last resolved current vector (§6.2) — mirrored into GET /status so
   * the UI can render the header readout without waiting for a delta.
   * @type {{setTrue: number, drift: number, tier: number, source: string}|null}
   */
  let lastCurrent = null;

  /**
   * GPS-derived vessel speed (kn) from consecutive fixes — the motion
   * signal for "idle but making way" (§6.3/§8). EMA-smoothed so a single
   * jittery fix doesn't flap it.
   * @type {{lastGps: {latitude: number, longitude: number, tsMs: number}|null, speedKn: number|null}}
   */
  let gpsMotion = { lastGps: null, speedKn: null };

  /**
   * Distance (nm) the vessel made over ground while DR was idle — grown
   * into the uncertainty polygon's effective "distance run" so the
   * polygon keeps growing when the water track freezes. Reset when a
   * confirmed fix resets the engine log.
   * @type {number}
   */
  let idleRunNm = 0;

  /** Previous tick's engine log — detects the reset that follows a fix. */
  let prevLogNm = 0;

  /**
   * Active sensor-health issue ("idle-moving" | "fouled" | null) —
   * tracked so the §3.1 status notification publishes on transitions
   * only, mirroring the divergence advisory's hysteresis.
   * @type {string|null}
   */
  let sensorHealthIssue = null;

  /** @type {TrainingState|null} */
  let training = null;

  /** @type {number|null} monotonic seconds counter for the training loop */
  let clockS = 0;

  /** @type {ReturnType<typeof createDivergenceState>|null} §7.3 divergence monitor */
  let divergence = null;

  /** @type {object|null} §9.5 logbook write-through client */
  let logbook = null;

  /** @type {object|null} §7-access-request lifecycle (poll interval + state) */
  let accessPoll = null;

  /** @type {number|null} timestamp (ms) of the last logged maneuver, §9.4 debounce */
  let lastTackLoggedMs = null;

  /** @type {number|null} */
  let tickInterval = null;

  /** @type {number|null} */
  let saveInterval = null;

  /** @type {object|null} */
  let config = null;

  /** @type {string|null} */
  let dbPath = null;

  const plugin = {
    id: PLUGIN_ID,
    name: "Dead Reckoning",
    description:
      "Offline-first dead reckoning and sensor fusion engine with learned leeway calibration and GPS integrity monitoring",

    schema: {
      type: "object",
      properties: {
        tickIntervalMs: {
          type: "integer",
          title: "DR Integration Interval (ms)",
          default: DEFAULT_CONFIG.tickIntervalMs,
        },
        saveIntervalMs: {
          type: "integer",
          title: "State Save Interval (ms)",
          default: DEFAULT_CONFIG.saveIntervalMs,
        },
        positionFormat: {
          type: "string",
          title: "Position format shown in the UI",
          enum: ["decimal", "dm", "dms"],
          default: DEFAULT_CONFIG.positionFormat,
        },
        "logbook.enabled": {
          type: "boolean",
          title: "Write fixes and maneuvers to signalk-logbook",
          default: DEFAULT_CONFIG.logbook.enabled,
        },
        "logbook.url": {
          type: "string",
          title: "signalk-logbook URL",
          default: DEFAULT_CONFIG.logbook.url,
        },
        "logbook.token": {
          type: "string",
          title:
            "Access token (optional — when empty, obtained via the server's access-request flow on first write)",
          default: DEFAULT_CONFIG.logbook.token,
        },
        "weatherCurrent.enabled": {
          type: "boolean",
          title: "Use Signal K Weather API current (set/drift) for DR",
          description:
            "Polls the server's weather provider (typically a GRIB another process downloaded) for the point-forecast current at the vessel position and integrates it into the DR solution (SPEC §6.2 tier 3). Falls back to the zero vector when unavailable.",
          default: DEFAULT_CONFIG.weatherCurrent.enabled,
        },
        "weatherCurrent.intervalMs": {
          type: "integer",
          title: "Weather current poll interval (ms)",
          default: DEFAULT_CONFIG.weatherCurrent.intervalMs,
        },
      },
    },

    start: (options) => {
      config = { ...DEFAULT_CONFIG, ...(options || {}) };
      // Allow partial divergence overrides without losing the defaults.
      config.divergence = {
        ...DEFAULT_CONFIG.divergence,
        ...(options?.divergence ?? {}),
      };
      config.logbook = {
        ...DEFAULT_CONFIG.logbook,
        ...(options?.logbook ?? {}),
      };
      config.training = {
        ...DEFAULT_CONFIG.training,
        ...(options?.training ?? {}),
      };
      config.weatherCurrent = {
        ...DEFAULT_CONFIG.weatherCurrent,
        ...(options?.weatherCurrent ?? {}),
      };

      dbPath = join(app.getDataDirPath(), "dead-reckoning.sqlite");
      db = deps.openDatabase(dbPath);
      matrix = new deps.MatrixStore(db);
      engine = new deps.DeadReckoningEngine();
      groundTrack = new deps.GroundTrack();

      // Restart survival (SPEC §9.1): seed the advancement buffer from
      // the persisted window so running-fix displacement keeps working
      // for sights taken before a mid-passage restart. The flush
      // high-water mark starts at the newest persisted sample.
      const trackWindowMs =
        groundTrack.capacity * (config.tickIntervalMs / 1000) * 1000;
      const seedTs = Date.now() - trackWindowMs;
      for (const s of deps.loadTrackSamplesSince(db, seedTs)) {
        groundTrack.append(s);
      }
      trackFlushedTs =
        groundTrack.samples.length > 0
          ? groundTrack.samples[groundTrack.samples.length - 1].timestamp
          : seedTs;

      // §6.2 tier 3: poll the Signal K Weather API for the point-forecast
      // current at the vessel position (typically a GRIB another process
      // downloaded). Off the 1 Hz hot path: slow interval, cached read.
      if (config.weatherCurrent.enabled) {
        // Mirror signalk-energy-predictor's base-URL resolution.
        const port = app.config?.port ?? 3000;
        const baseUrl =
          config.weatherCurrent.baseUrl || `http://localhost:${port}`;
        weatherClient = new deps.WeatherCurrentClient({
          baseUrl,
          intervalMs: config.weatherCurrent.intervalMs,
          getPosition: () => {
            const gps = unwrapPosition(deltaState.get("navigation.position"));
            if (gps) return gps;
            return engine?.origin ?? null;
          },
          onStatus: (msg) => setStatus(msg),
        });
        weatherClient.start();
      }
      training = new deps.TrainingState({
        settleSustainS: config.training.settleSustainS,
      });
      divergence = deps.createDivergenceState();
      clockS = 0;

      // Seed the engine origin from the last known good position, if any.
      const lastFix = deps.getState(db, "last_known_good_fix");
      if (lastFix) {
        try {
          const fix = JSON.parse(lastFix);
          if (fix && fix.latitude != null && fix.longitude != null) {
            engine.snapToFix(fix);
          }
        } catch {
          // Corrupt persisted state — start from scratch, the next GPS fix
          // or confirmed fix will seed the origin.
        }
      }
      // §8: restore the per-excursion distance so a mid-excursion restart
      // continues the uncertainty polygon rather than resetting it.
      const logSinceOrigin = deps.getState(db, "dr_log_since_origin");
      if (logSinceOrigin) engine.logNmSinceOrigin = Number(logSinceOrigin) || 0;

      initLogbook();

      // Subscribe to the sensor inputs the engine needs.
      const subscription = {
        context: "vessels.self",
        subscribe: SUBSCRIPTION_PATHS.map((path) => ({
          path,
          policy: "instant",
        })),
      };
      app.subscriptionmanager.subscribe(
        subscription,
        unsubscribes,
        (err) => app.error(`Subscription error: ${err}`),
        (delta) => feedDelta(delta),
      );

      // 1Hz integration loop: advance the shadow boat and publish.
      tickInterval = setInterval(() => {
        try {
          step();
        } catch (err) {
          app.error(`DR tick failed: ${err.message}`);
        }
      }, config.tickIntervalMs);

      // Periodic state flush.
      saveInterval = setInterval(() => {
        try {
          flushState();
        } catch (err) {
          app.error(`DR save failed: ${err.message}`);
        }
      }, config.saveIntervalMs);

      publishMeta();
      setStatus("Dead reckoning started");

      // Public config endpoint (CONFIG_PATH): mounted on the app so
      // anonymous / read-only clients can read the plugin config
      // (incl. positionFormat) without admin auth. Mirrors
      // signalk-status-tiles' pattern.
      app.get(CONFIG_PATH, (_req, res) => {
        if (!config) {
          res.status(503).json({ message: "Plugin not started" });
          return;
        }
        res.set("Cache-Control", "no-store");
        res.json({ config, configHash: configHash(config) });
      });
      // Signal config changes to connected webapps: publish the hash as
      // a delta on the same stream the webapp already consumes, so a
      // server-side config edit (restart) triggers a client re-fetch.
      app.handleMessage(PLUGIN_ID, {
        context: "vessels.self",
        updates: [
          {
            timestamp: new Date().toISOString(),
            values: [{ path: CONFIG_HASH_PATH, value: configHash(config) }],
          },
        ],
      });
      // §13: star almanac expiry check — warn (not fail) the same way WMM
      // does (§12). A warning here surfaces via the plugin status message;
      // a full notification delta is left to the integrity/notification
      // work and is out of scope for this doc.
      if (starAlmanac.isExpired(new Date())) {
        const d = starAlmanac.daysUntilExpiry(new Date());
        setStatus(
          `Star almanac expired (${d} days past validity) — sights may be inaccurate`,
        );
      }
    },

    stop: () => {
      if (tickInterval) clearInterval(tickInterval);
      if (saveInterval) clearInterval(saveInterval);
      tickInterval = null;
      saveInterval = null;
      for (const f of unsubscribes) f();
      unsubscribes.length = 0;
      deltaState.clear();
      if (db) {
        flushState();
        db.close();
        db = null;
      }
      matrix = null;
      engine = null;
      groundTrack = null;
      weatherClient?.stop();
      weatherClient = null;
      training = null;
      // Hygiene: clear a live advisory so it doesn't linger after the
      // plugin stops monitoring.
      if (divergence?.active) {
        publishNotification(PATHS.divergenceAdvisory, {
          state: "normal",
          message: "DR monitoring stopped",
        });
      }
      divergence = null;
      if (sensorHealthIssue) {
        publishNotification(PATHS.sensorHealth, {
          state: "normal",
          message: "DR monitoring stopped",
        });
        sensorHealthIssue = null;
      }
      gpsMotion = { lastGps: null, speedKn: null };
      idleRunNm = 0;
      prevLogNm = 0;
      if (accessPoll) {
        clearInterval(accessPoll);
        accessPoll = null;
      }
      logbook = null;
      logbookPhase = null;
      lastTackLoggedMs = null;
      clockS = 0;
      setStatus("Dead reckoning stopped");
    },
  };

  // --- Internal helpers --------------------------------------------------

  /**
   * Ingests a Signal K delta into the per-path state cache. Only self-
   * context values are relevant.
   *
   * @param {object} delta
   * @returns {void}
   */
  function feedDelta(delta) {
    if (!delta?.updates) return;
    for (const update of delta.updates) {
      if (!update.values) continue;
      for (const v of update.values) {
        deltaState.set(v.path, v.value);
        // Seed the engine origin from the first GPS fix if we have none yet.
        if (v.path === "navigation.position") {
          if (!engine?.origin) {
            const pos = unwrapPosition(v.value);
            if (pos)
              snapToFix(pos, "gps", { confirmed_by: null, resets: true });
          }
        }
      }
    }
  }

  /**
   * Snaps the DR origin to a fix, recording a `fixes` row and — when there
   * was a prior origin to deviate from — a `dr_corrections` row (SPEC
   * §4.5, §9.3). Symmetric across NORMAL and OVERRIDE: every confirmed
   * fix that resets the origin is recorded, regardless of mode.
   *
   * @param {{latitude:number, longitude:number}} fix
   * @param {string} sourceType - 'gps' | 'celestial' | 'bearing' | 'manual'
   * @param {object} [opts]
   * @param {string|null} [opts.confirmed_by]
   * @param {boolean} [opts.resets] - whether this fix resets the DR origin
   * @returns {void}
   */
  function snapToFix(fix, sourceType, opts = {}) {
    if (!engine || !db) return;
    const priorOrigin = engine.origin;
    const elapsed = engine.elapsedSinceOriginS;
    const sailState = resolveSailState();
    const seaState = resolveSeaState();
    const ts = new Date().toISOString();

    const fixId = deps.recordFix(db, {
      timestamp: ts,
      source_type: sourceType,
      latitude: fix.latitude,
      longitude: fix.longitude,
      confirmed_by: opts.confirmed_by ?? null,
      resets_dr_origin: opts.resets !== false,
    });

    if (priorOrigin && opts.resets !== false) {
      const deviation = deps.distanceNm(priorOrigin, fix);
      const devBearing = deps.bearingDeg(priorOrigin, fix);
      deps.recordCorrection(db, {
        fix_id: fixId,
        timestamp: ts,
        dr_lat: priorOrigin.latitude,
        dr_lon: priorOrigin.longitude,
        fix_lat: fix.latitude,
        fix_lon: fix.longitude,
        deviation_nm: deviation,
        deviation_bearing: devBearing,
        dr_elapsed_seconds: elapsed,
        sail_state: sailState,
        sea_state: seaState,
      });
    }

    if (opts.resets !== false) engine.snapToFix(fix);
  }

  /**
   * Advances one integration step and publishes the shadow-boat delta.
   *
   * @returns {void}
   */
  function step() {
    if (!engine || !matrix || !training) return;

    clockS += config.tickIntervalMs / 1000;

    const rawStw = unwrapNumber(deltaState.get("navigation.speedThroughWater"));
    const headingMag = unwrapNumber(
      deltaState.get("navigation.headingMagnetic"),
    );
    const headingTrue = unwrapNumber(deltaState.get("navigation.headingTrue"));
    const awaRad = unwrapNumber(
      deltaState.get("environment.wind.angleApparent"),
    );
    const aws = unwrapNumber(deltaState.get("environment.wind.speedApparent"));
    const heel = unwrapHeel(deltaState.get("navigation.attitude"));
    const gps = unwrapPosition(deltaState.get("navigation.position"));

    // GPS-derived motion (independent of the water-track sensors):
    // updated every tick, used to detect "idle but making way" below.
    updateGpsMotion(gps);

    // A confirmed fix resets the engine log (logNmSinceOrigin → 0);
    // drop the accumulated idle-run distance with it.
    if (engine.logNmSinceOrigin < prevLogNm) idleRunNm = 0;
    prevLogNm = engine.logNmSinceOrigin;

    // Heading: prefer true heading; fall back to magnetic (WMM correction
    // applied upstream in v1 — see SPEC §12). If neither, hold position.
    const headingTrueDeg = headingTrue ?? headingMag;
    if (headingTrueDeg == null || rawStw == null) {
      // Publish why DR is idle so the UI (SPEC §14.1) can explain the empty
      // readout instead of leaving the user to guess. The vessel isn't
      // necessarily broken — moored/anchored with no STW/heading is normal.
      const navState = deltaState.get("navigation.state");
      let reason;
      if (navState === "moored" || navState === "anchored") {
        reason = navState;
      } else if (rawStw == null && headingTrueDeg == null) {
        reason = "no speed or heading";
      } else if (rawStw == null) {
        reason = "no speed through water";
      } else {
        reason = "no heading";
      }

      // §8/§6.3: idle is honest only when the boat actually stopped. When
      // GPS shows the vessel still making way (fouled paddlewheel, compass
      // dropout), the frozen DR position is stale and the uncertainty
      // polygon must keep growing — by the ground distance travelled with
      // no water track — or it falsely advertises confidence. GPS stays
      // authoritative until proven faulty or OVERRIDE (§7), so the
      // watchkeeper is alerted, not left guessing.
      const moving =
        gpsMotion.speedKn != null && gpsMotion.speedKn > SOG_MOVING_KN;
      let uncertaintyValue = null;
      if (moving) {
        idleRunNm += (gpsMotion.speedKn * config.tickIntervalMs) / 3600000;
        const u = deps.computeRadius({
          elapsedDistanceNm: engine.logNmSinceOrigin + idleRunNm,
          effectiveHitCount: 0, // unknown bin while idle — fallback growth
          stwKn: 0,
        });
        uncertaintyValue = { radius_nm: u.radius_nm, method: u.method };
      }
      setSensorHealth(
        moving ? "idle-moving" : null,
        moving
          ? `DR stopped tracking (${reason}) but the vessel is making ~${gpsMotion.speedKn.toFixed(1)} kn over ground — DR position is stale, uncertainty growing`
          : null,
      );

      publish({
        [PATHS.state]: { status: "idle", reason, moving },
        ...(uncertaintyValue ? { [PATHS.uncertainty]: uncertaintyValue } : {}),
        [PATHS.elapsedSinceFix]: engine.elapsedSinceOriginS,
      });
      return;
    }

    // Look up learned corrections for the current condition. Sail/sea state
    // come from the logbook peer when available; absent here they fall to
    // 'unknown' (SPEC §4.1).
    const sailState = resolveSailState();
    const seaState = resolveSeaState();
    const awaDeg = awaRad != null ? (awaRad * 180) / Math.PI : 0;
    const corrections = matrix.lookup({
      sail_state: sailState,
      sea_state: seaState,
      stwKn: rawStw,
      awaDeg,
      heelDeg: heel ?? 0,
    });

    // Resolve the best available current vector (SPEC §6.2). v1 ships
    // tier 5 (zero); the resolver has a hook for tier 4 pilot charts.
    // Resolve the best available current vector (SPEC §6.2): tier 1
    // manual override → tier 3 (Weather API GRIB via the poller cache)
    // → tier 4 pilot charts (reserved) → tier 5 zero. Synchronous
    // cache read, no network on the tick path.
    const current = deps.resolveCurrent({
      manual: manualCurrent,
      weather: weatherClient?.currentAt(Date.now()),
      nowMs: Date.now(),
    });
    lastCurrent = current;

    const pos = engine.tick(
      {
        stwKn: rawStw,
        headingTrueDeg,
        leewayDeg: corrections.leeway_angle,
        speedLoss: corrections.speed_loss,
        current,
      },
      config.tickIntervalMs / 1000,
    );

    // Feed the DR position into the track buffer so running-fix advances
    // work without GPS (SPEC §9.1). GPS samples (appended in the delta
    // handler) take precedence at a given instant.
    if (pos && groundTrack) {
      groundTrack.append({
        timestamp: Date.now(),
        latitude: pos.latitude,
        longitude: pos.longitude,
      });
    }

    // --- Training Mode (SPEC §6.1) --------------------------------------
    // When GPS is reliable and we're sailing (not motoring, paddlewheel
    // not fouled, not in a tack/gybe transient), compute the error vector
    // vs. GPS ground truth and EMA-merge it into the matching bin.
    const tr = deps.trainingTick(training, {
      timestampS: clockS,
      gps,
      stwKn: rawStw,
      headingTrueDeg,
      awaDeg,
      awsKn: aws,
      heelDeg: heel ?? 0,
      propulsionState: deltaState.get("propulsion.main.state"),
      current,
      lookupLeewayDeg: corrections.leeway_angle,
      lookupSpeedLoss: corrections.speed_loss,
    });
    if (tr.observation) {
      matrix.update(
        {
          sail_state: sailState,
          sea_state: seaState,
          stwKn: rawStw,
          awaDeg,
          heelDeg: heel ?? 0,
        },
        tr.observation,
        { source: "live" },
      );
    }

    // §6.3: the fouling detector's verdict (STW≈0 while SOG/wind say
    // the boat moves) is surfaced, not just used to gate training — a
    // fouled paddlewheel silently integrating 0 speed is the classic
    // way DR freezes while the vessel sails on.
    setSensorHealth(
      tr.fouled ? "fouled" : null,
      tr.fouled
        ? "Paddlewheel appears fouled — STW≈0 while the vessel makes way. DR is integrating near-zero speed; verify position by other means"
        : null,
    );

    // §9.4: auto tack/gybe logbook entries. The transient window's close
    // edge is a completed maneuver; classify from the AWA change across
    // the window. Debounced so a beat's rapid back-to-back maneuvers
    // (or a botched tack immediately redone) log as one event.
    const maneuver = deps.detectManeuver(training, {
      awaDeg,
      headingDeg: headingTrueDeg,
    });
    if (maneuver) {
      const now = Date.now();
      const debounceMs = (config.logbook?.tackDebounceS ?? 120) * 1000;
      if (lastTackLoggedMs == null || now - lastTackLoggedMs >= debounceMs) {
        lastTackLoggedMs = now;
        const entry = deps.composeTackEntry({
          direction: maneuver.direction,
          newHeadingDeg: maneuver.newHeadingDeg,
          datetime: new Date().toISOString(),
          sea_state: seaState !== "unknown" ? Number(seaState) : null,
        });
        writeLogbookEntry(entry, "tack")
          .then(() => {})
          .catch(() => {});
      }
    }

    if (pos) {
      // §8: uncertainty polygon around the DR position. Recomputed each
      // tick from the current bin (so a tack/sail change re-evaluates),
      // the recent per-condition dr_corrections, and the distance run
      // since the last snap — radius scales with distance, not time.
      const devRows = deps.getDeviationRateStats(db, {
        sail_state: sailState,
        sea_state: seaState,
        limit: 50,
      });
      const u = deps.computeRadius({
        elapsedDistanceNm: engine.logNmSinceOrigin,
        effectiveHitCount: corrections.hit_count,
        deviationRows: devRows,
        stwKn: rawStw,
      });

      // §7.3 band 2: gradual DR-vs-GPS divergence vs the polygon's
      // expected growth (§8), with sustained-interval hysteresis so a
      // single jittery fix neither raises nor flaps the advisory.
      // §14.1's live divergence readout (distance + bearing) is published
      // alongside. Suppressed at anchor/moored (different regime, §7.1–2).
      const navState = deltaState.get("navigation.state");
      const underway = navState !== "anchored" && navState !== "moored";
      let dvg = null;
      if (gps && underway) {
        const distNm = deps.distanceNm(pos, gps);
        const brg = deps.bearingDeg(pos, gps);
        dvg = { distance_nm: distNm, bearing_true: brg };
        const d = deps.divergenceTick(
          divergence,
          {
            divergenceNm: distNm,
            radiusNm: u.radius_nm,
            dtS: config.tickIntervalMs / 1000,
          },
          config.divergence,
        );
        if (d.transition === "raise") {
          publishNotification(PATHS.divergenceAdvisory, {
            state: "alert",
            message: `DR-GPS divergence ${d.divergenceNm.toFixed(2)} nm exceeds expected ${d.expectedNm.toFixed(2)} nm (uncertainty × ${config.divergence.factor}) — consider taking a fix`,
          });
        } else if (d.transition === "clear") {
          publishNotification(PATHS.divergenceAdvisory, {
            state: "normal",
            message: `DR-GPS divergence back within expected uncertainty (${d.divergenceNm.toFixed(2)} nm)`,
          });
        }
      }

      publish({
        [PATHS.position]: pos,
        [PATHS.active]: engine.active,
        [PATHS.method]: engine.method,
        [PATHS.log]: engine.logNm,
        [PATHS.tripLog]: engine.tripLogNm,
        [PATHS.stw]: rawStw,
        [PATHS.headingTrue]: headingTrueDeg,
        [PATHS.current]: current,
        [PATHS.uncertainty]: {
          radius_nm: u.radius_nm,
          method: u.method,
        },
        // §6.4: transient flags a tack/gybe in progress — the moment when
        // a large DR divergence is expected (unsteady flow over the
        // paddlewheel, rapid heading changes) and not yet a fault signal.
        [PATHS.state]: {
          status: "underway",
          transient: tr.transient,
          fouled: tr.fouled,
        },
        [PATHS.elapsedSinceFix]: engine.elapsedSinceOriginS,
        ...(dvg ? { [PATHS.divergence]: dvg } : {}),
      });
    }
  }

  /**
   * Resolves the current sea state for bin/correction context (SPEC
   * §3.2). The logbook publishes WMO sea-state codes via
   * `environment.water.swell.state`; `environment.seaState` is the SPEC's
   * spelling and other sources may publish it. Either is accepted —
   * numeric string form ("3") keeps matrix bins and dr_corrections
   * directly comparable with the logbook schema without a translation
   * table.
   *
   * @returns {string}
   */
  function resolveSeaState() {
    const swell = deltaState.get("environment.water.swell.state");
    if (Number.isFinite(Number(swell)))
      return String(Math.round(Number(swell)));
    const seaState = deltaState.get("environment.seaState");
    if (Number.isFinite(Number(seaState))) {
      return String(Math.round(Number(seaState)));
    }
    return "unknown";
  }

  /**
   * Resolves the current sail state. SPEC §4.1 excludes motoring intervals
   * from matrix writes via `propulsion.main.state = started` — that gate is
   * applied at training time, not here; this returns a coarse label for
   * binning.
   *
   * @returns {string}
   */
  function resolveSailState() {
    const propulsion = deltaState.get("propulsion.main.state");
    if (propulsion === "started") return "motoring";
    const navState = deltaState.get("navigation.state");
    if (navState === "sailing") return "sailing";
    return "unknown";
  }

  /**
   * Publishes a delta update with the given path→value pairs.
   *
   * @param {Record<string, unknown>} values
   * @returns {void}
   */
  function publish(values) {
    app.handleMessage(PLUGIN_ID, {
      context: "vessels.self",
      updates: [
        {
          source: { label: PLUGIN_ID, src: "dr" },
          timestamp: new Date().toISOString(),
          values: Object.entries(values).map(([path, value]) => ({
            path,
            value,
          })),
        },
      ],
    });
  }

  /**
   * Publishes (or clears, via state "normal") a Signal K notification
   * (SPEC §3.1). Visual method only — these are low-severity nudges, not
   * sound alarms.
   *
   * @param {string} path
   * @param {{state: string, message: string}} n
   * @returns {void}
   */
  // --- Logbook write-through (SPEC §9.4, §9.5) ----------------------------

  /**
   * Initializes the logbook client when enabled. Token acquisition via
   * the server's Access Requests flow: a config token short-circuits it;
   * otherwise a stable clientId (persisted) requests access, an admin
   * approves in the server UI, and a poll interval picks up the granted
   * token. A DENIED verdict stops polling until the next start. Writes
   * are simply skipped while no token is available.
   *
   * @returns {void}
   */
  /**
   * Current access-flow phase, for status + write-time re-request
   * decisions: "granted" (token working), "pending" (request submitted,
   * admin approval awaited), "open" (no auth needed — writes verified
   * live), "denied", "unreachable". @type {string|null}
   */
  let logbookPhase = null;

  function initLogbook() {
    if (!config.logbook?.enabled) return;

    // Persistent client identity (spec: same clientId for every request).
    let clientId = deps.getState(db, "logbook_client_id");
    if (!clientId) {
      clientId = deps.newClientId();
      deps.setState(db, "logbook_client_id", clientId);
    }

    const storedToken =
      config.logbook.token || deps.getState(db, "logbook_token");
    const expiresRaw = deps.getState(db, "logbook_token_expires");
    const expired = expiresRaw != null && Date.parse(expiresRaw) <= Date.now();

    if (storedToken && !expired) {
      logbook = deps.createLogbookClient({
        url: config.logbook.url,
        token: storedToken,
      });
      logbookPhase = "granted";
      setStatus("Logbook write-through enabled");
      // Any entries queued before a restart land here.
      flushLogbookPending();
      return;
    }

    // No usable token: submit an access request and poll for approval.
    // Entries written while waiting are queued (SQLite) and flushed on
    // grant — nothing is lost in the approval window.
    const access = deps.createAccessRequestClient({
      baseUrl: config.logbook.baseUrl,
    });
    logbookPhase = "pending";
    setStatus("Logbook access requested — approve in the server UI");
    access
      .request({
        clientId,
        description:
          "signalk-dead-reckoning: fix & maneuver logbook writes (requires admin: plugin routes are admin-gated)",
        // Plugin REST routes are admin-gated (verified: the server wraps
        // /plugins in adminAuthenticationMiddleware), so the token must be
        // admin-level. Requesting it explicitly means the administrator
        // approves exactly that — and the server grants the requested
        // level verbatim on approval.
        permissions: "admin",
      })
      .then((href) => {
        if (href === "unreachable") {
          // Transport failure: don't pretend it's an open server, don't
          // poll a bogus href. Writes queue; the next write re-runs
          // initLogbook() to retry once the server is reachable again.
          logbookPhase = "unreachable";
          setStatus("Logbook unreachable — entries queued");
          return;
        }
        if (!href) {
          // 501/404 = the server advertises no access-request flow
          // (open server). Try an unauthenticated write; if it lands,
          // we're in business. Anything else (incl. network refusal)
          // stays queued and retries on the next write.
          logbook = deps.createLogbookClient({
            url: config.logbook.url,
          });
          logbookPhase = "open";
          flushLogbookPending();
          return;
        }
        accessPoll = setInterval(async () => {
          try {
            const verdict = await access.poll(href);
            if (verdict === "DENIED") {
              clearInterval(accessPoll);
              accessPoll = null;
              logbookPhase = "denied";
              logbook = null;
              setStatus("Logbook access denied — no logbook writes");
              return;
            }
            if (verdict?.token) {
              clearInterval(accessPoll);
              accessPoll = null;
              deps.setState(db, "logbook_token", verdict.token);
              if (verdict.expirationTime) {
                deps.setState(
                  db,
                  "logbook_token_expires",
                  verdict.expirationTime,
                );
              }
              logbook = deps.createLogbookClient({
                url: config.logbook.url,
                token: verdict.token,
              });
              logbookPhase = "granted";
              setStatus("Logbook write-through enabled");
              flushLogbookPending();
            }
          } catch {
            // Poll failure: keep polling; the next interval retries.
          }
        }, config.logbook.pollIntervalMs);
      })
      .catch(() => {
        // Network refusal at request time: unreachable — writes queue.
        logbookPhase = "unreachable";
        setStatus("Logbook unreachable — entries queued");
      });
  }

  /**
   * Writes a logbook entry, handling the unauthorized case by dropping the
   * stored token and re-requesting access (the spec's 403 handling). Never
   * throws — logbook failures never block the fix/matrix/polygon paths.
   *
   * @param {object} body - NewEntry-shaped
   * @returns {Promise<string|null>} the entry ref on success
   */
  /**
   * Flushes queued logbook entries oldest-first once a client exists
   * (token granted / open server verified live). Stops at the first
   * failure so ordering is preserved and the queue stays intact.
   * @returns {Promise<void>}
   */
  async function flushLogbookPending() {
    if (!logbook || !db) return;
    for (const row of deps.listLogbookPending(db)) {
      const ref = await logbook.createEntry(row.payload);
      if (ref === "unauthorized" || ref == null) {
        if (ref === "unauthorized") {
          // Token rejected mid-flush: re-request, keep the queue.
          logbook = null;
          deps.setState(db, "logbook_token", "");
          logbookPhase = "pending";
          initLogbook();
        }
        return; // transient failure — retry on next trigger
      }
      deps.dequeueLogbookPending(db, row.pending_id);
      // A delayed fix delivery: mark the `fixes` row now that the entry
      // actually landed (the confirm route only marks on immediate writes).
      if (row.fix_id != null && ref != null) {
        deps.markFixLogged(db, row.fix_id, ref);
      }
    }
    const remaining = deps.listLogbookPending(db).length;
    if (remaining === 0 && logbookPhase === "granted") {
      setStatus("Logbook write-through enabled");
    }
  }

  /**
   * Writes a logbook entry. While no client is available (tokenless /
   * unreachable) the entry is queued (SQLite) and delivered when the
   * access flow lands; on 401/403 the token is dropped and access
   * re-requested — the entry re-queues, so expiry mid-passage loses
   * nothing. Never throws — logbook failures never block the fix /
   * matrix / polygon paths.
   *
   * @param {object} body - NewEntry-shaped
   * @param {object} body - NewEntry-shaped
   * @param {string} [kind="entry"] - 'fix' | 'tack' | 'bearing' | 'observation'
   * @param {number|null} [fixId=null] - links a fix entry to its `fixes` row
   *   so the delayed flush can mark it logged.
   * @returns {Promise<string|null>} the entry ref on success
   */
  async function writeLogbookEntry(body, kind = "entry", fixId = null) {
    if (!db) return null;
    if (!logbook) {
      // Tokenless: queue for the approval window. Also re-kick the
      // access flow — covers expiry/loss after start() already ran it.
      deps.enqueueLogbookPending(db, kind, body, fixId);
      if (logbookPhase !== "pending" && logbookPhase !== "denied") {
        initLogbook();
      }
      return null;
    }
    const ref = await logbook.createEntry(body);
    if (ref === "unauthorized") {
      // Token expired/revoked: queue this entry, drop the token,
      // re-request. Delivery resumes when re-approved.
      deps.enqueueLogbookPending(db, kind, body, fixId);
      logbook = null;
      deps.setState(db, "logbook_token", "");
      logbookPhase = "pending";
      initLogbook();
      return null;
    }
    if (ref == null) {
      // Transient failure (network, 5xx): queue so a later success
      // (or restart) delivers it. Bounded, ordered, source-of-truth
      // stays the plugin DB.
      deps.enqueueLogbookPending(db, kind, body, fixId);
      setStatus("Logbook write failed — entry queued");
    }
    return ref;
  }

  /**
   * Updates the GPS-derived motion estimate (kn) from consecutive fixes.
   * EMA-smoothed (α=0.3, mirroring the trainer's ground-truth filter) so a
   * single jittery fix doesn't flap the "idle but making way" alert.
   *
   * @param {{latitude:number, longitude:number}|null} gps
   * @returns {void}
   */
  function updateGpsMotion(gps) {
    if (!gps) return;
    const last = gpsMotion.lastGps;
    // Only sample when the fix actually changed — the tick may run faster
    // than the GPS, and re-sampling an unchanged fix would drag the EMA
    // toward zero.
    if (
      last &&
      last.latitude === gps.latitude &&
      last.longitude === gps.longitude
    ) {
      return;
    }
    const tsMs = Date.now();
    gpsMotion.lastGps = { ...gps, tsMs };
    if (!last) return;
    const dtH = (tsMs - last.tsMs) / 3600000;
    if (dtH <= 0) return;
    const speedKn = deps.distanceNm(last, gps) / dtH;
    gpsMotion.speedKn =
      gpsMotion.speedKn == null
        ? speedKn
        : gpsMotion.speedKn * 0.7 + speedKn * 0.3;
  }

  /**
   * Publishes the §3.1 sensor-health notification on *transitions only*
   * (raise when an issue appears, clear when it resolves) — the same
   * hysteresis discipline as the divergence advisory. No issue → null.
   *
   * @param {string|null} issue - "idle-moving" | "fouled" | null
   * @param {string|null} message - human explanation for the raise
   * @returns {void}
   */
  function setSensorHealth(issue, message) {
    if (issue === sensorHealthIssue) return;
    const wasIssue = sensorHealthIssue;
    sensorHealthIssue = issue;
    if (issue) {
      publishNotification(PATHS.sensorHealth, { state: "alert", message });
    } else if (wasIssue) {
      publishNotification(PATHS.sensorHealth, {
        state: "normal",
        message: "DR sensor health nominal",
      });
    }
  }

  function publishNotification(path, n) {
    app.handleMessage(PLUGIN_ID, {
      context: "vessels.self",
      updates: [
        {
          values: [
            {
              path,
              value: {
                message: n.message,
                state: n.state,
                method: ["visual"],
                timestamp: new Date().toISOString(),
              },
            },
          ],
        },
      ],
    });
  }

  /**
   * Publishes meta for our paths so consumers know units/meaning.
   *
   * @returns {void}
   */
  function publishMeta() {
    app.handleMessage(PLUGIN_ID, {
      context: "vessels.self",
      updates: [
        {
          meta: [
            {
              path: PATHS.position,
              value: {
                displayName: "Dead reckoning position",
                description: "Always-on 1Hz inertial shadow-boat position",
              },
            },
            {
              path: PATHS.log,
              value: {
                units: "nm",
                displayName: "DR water-track log",
                description: "Cumulative water-track distance from STW",
              },
            },
            {
              path: PATHS.tripLog,
              value: {
                units: "nm",
                displayName: "DR trip log",
                description: "Water-track distance since trip start",
              },
            },
            {
              path: PATHS.uncertainty,
              value: {
                displayName: "DR uncertainty polygon",
                description:
                  "Confidence-weighted circular error region around the DR position; radius scales with distance run and tightens as the matching matrix bin accumulates hits.",
              },
            },
            {
              path: PATHS.elapsedSinceFix,
              value: {
                units: "s",
                displayName: "Time since last fix",
                description:
                  "Seconds since the DR origin was last snapped to a confirmed fix — the watchkeeper's fix-cadence cue.",
              },
            },
            {
              path: PATHS.divergence,
              value: {
                displayName: "DR-GPS divergence",
                description:
                  "Live distance and true bearing from the shadow-boat DR position to the last GPS fix — the at-a-glance model-quality diagnostic.",
              },
            },
          ],
        },
      ],
    });
  }

  /**
   * Flushes engine state to the state store so it survives restarts.
   * Also persists new ground-track samples (running-fix advancement
   * buffer) and prunes rows older than the buffer window.
   *
   * @returns {void}
   */
  function flushState() {
    if (!db || !engine) return;
    if (groundTrack) {
      const windowMs =
        groundTrack.capacity * (config.tickIntervalMs / 1000) * 1000;
      const fresh = groundTrack.samples.filter(
        (s) => s.timestamp > trackFlushedTs,
      );
      deps.recordTrackSamples(db, fresh);
      deps.pruneTrackSamplesBefore(db, Date.now() - windowMs);
      if (fresh.length > 0) {
        trackFlushedTs = fresh[fresh.length - 1].timestamp;
      }
    }
    if (engine.origin) {
      deps.setState(db, "last_known_good_fix", JSON.stringify(engine.origin));
    }
    deps.setState(db, "dr_log_nm", String(engine.logNm));
    deps.setState(db, "dr_trip_log_nm", String(engine.tripLogNm));
    deps.setState(db, "dr_log_since_origin", String(engine.logNmSinceOrigin));
  }

  // --- REST API ----------------------------------------------------------

  /**
   * Registers REST routes on the plugin router.
   *
   * @param {object} router - Express router
   */
  plugin.registerWithRouter = (router) => {
    /**
     * GET /status — current DR engine snapshot for the web component.
     */
    router.get("/status", (_req, res) => {
      if (!engine || !matrix) {
        res.status(503).json({ message: "Plugin not started" });
        return;
      }
      res.json({
        active: engine.active,
        method: engine.method,
        origin: engine.origin,
        logNm: engine.logNm,
        tripLogNm: engine.tripLogNm,
        elapsedSinceOriginS: engine.elapsedSinceOriginS,
        binCount: matrix.count(),
        // §6.2: the resolved current vector + any manual override, so
        // the UI's header readout can bootstrap without a delta.
        current: lastCurrent,
        manualCurrent,
      });
    });

    /**
     * GET /fixes — recent confirmed fixes for the map overlay (SPEC
     * §14.1 fix points). `limit` caps the result (default 100).
     */
    router.get("/fixes", (req, res) => {
      if (!engine || !db) {
        res.status(503).json({ message: "Plugin not started" });
        return;
      }
      const limit = Math.max(
        1,
        Math.min(1000, Number(req.query?.limit) || 100),
      );
      res.json({ fixes: deps.listFixes(db, { limit }) });
    });

    /**
     * GET /observations — persisted LOPs and CPLs for the map overlay
     * (SPEC §14.1 geometric primitives). Unused/unresolved observations
     * (used_in_fix_id IS NULL) are marked so the UI can emphasize them.
     */
    router.get("/observations", (req, res) => {
      if (!engine || !db) {
        res.status(503).json({ message: "Plugin not started" });
        return;
      }
      const limit = Math.max(
        1,
        Math.min(1000, Number(req.query?.limit) || 100),
      );
      res.json({
        lops: deps.listLinesOfPosition(db, { limit }),
        cpls: deps.listCircularPositionLines(db, { limit }),
      });
    });

    /**
     * GET /corrections — recent snap-to-fix corrections for the dashed
     * vector overlay (SPEC §9.3, §14.1).
     */
    router.get("/corrections", (req, res) => {
      if (!engine || !db) {
        res.status(503).json({ message: "Plugin not started" });
        return;
      }
      const limit = Math.max(1, Math.min(200, Number(req.query?.limit) || 20));
      res.json({ corrections: deps.listCorrections(db, { limit }) });
    });

    /**
     * PUT /override — engage (true) or release (false) OVERRIDE so DR
     * becomes authoritative for navigation.position. Always human-
     * initiated (SPEC §7, §14.1).
     */
    router.put("/override", (req, res) => {
      if (!engine) {
        res.status(503).json({ message: "Plugin not started" });
        return;
      }
      const body = parseBody(req.body);
      engine.active = !!body?.active;
      setStatus(engine.active ? "DR OVERRIDE engaged" : "DR OVERRIDE released");
      res.json({ active: engine.active });
    });

    /**
     * PUT /current/manual — set the manual set-and-drift override
     * (SPEC §6.2 tier 1: watchstander input outranks every automatic
     * source while its TTL lasts). Body: `setTrue` (deg true, the
     * direction the current flows toward), `drift` (kn), optional
     * `ttlMinutes` (default 60, max 1440) and `setBy`. Always
     * human-initiated, like OVERRIDE.
     */
    router.put("/current/manual", (req, res) => {
      if (!engine) {
        res.status(503).json({ message: "Plugin not started" });
        return;
      }
      const b = parseBody(req.body);
      const setTrue = Number(b?.setTrue);
      const drift = Number(b?.drift);
      if (!Number.isFinite(setTrue) || !Number.isFinite(drift) || drift < 0) {
        res.status(400).json({
          message: "setTrue (deg true) and drift (kn >= 0) required",
        });
        return;
      }
      const ttlMin = Math.max(
        1,
        Math.min(1440, Number(b?.ttlMinutes) > 0 ? Number(b.ttlMinutes) : 60),
      );
      const now = Date.now();
      manualCurrent = {
        setTrue: ((setTrue % 360) + 360) % 360,
        drift,
        validUntilMs: now + ttlMin * 60_000,
        setBy:
          (typeof b?.setBy === "string" && b.setBy) ||
          usernameFromCookies(req.cookies) ||
          null,
        setAtMs: now,
      };
      setStatus(
        `Manual current set: ${manualCurrent.setTrue.toFixed(0)}° true, ${drift.toFixed(2)} kn (${ttlMin} min TTL)`,
      );
      res.json({ manualCurrent });
    });

    /**
     * DELETE /current/manual — clear the override; the resolver falls
     * back down the §6.2 hierarchy on the next tick.
     */
    router.delete("/current/manual", (_req, res) => {
      if (!engine) {
        res.status(503).json({ message: "Plugin not started" });
        return;
      }
      manualCurrent = null;
      setStatus("Manual current cleared");
      res.json({ manualCurrent: null });
    });

    /**
     * POST /fix/lop — persist a line of position (SPEC §4.4) and return its
     * id, so the UI can submit observations first and then resolve+confirm
     * them in a separate, explicit step (§9.1).
     *
     * Body fields mirror `recordLineOfPosition`: timestamp, lop_type,
     * assumed_lat, assumed_lon, azimuth_true, intercept_nm?, body_or_object?,
     * confirmed_by?
     */
    router.post("/fix/lop", (req, res) => {
      if (!engine || !db) {
        res.status(503).json({ message: "Plugin not started" });
        return;
      }
      const b = parseBody(req.body);
      if (
        typeof b.assumed_lat !== "number" ||
        typeof b.assumed_lon !== "number" ||
        typeof b.azimuth_true !== "number"
      ) {
        res
          .status(400)
          .json({ message: "assumed_lat, assumed_lon, azimuth_true required" });
        return;
      }
      const id = deps.recordLineOfPosition(db, {
        timestamp: b.timestamp ?? new Date().toISOString(),
        lop_type: b.lop_type || "bearing",
        assumed_lat: b.assumed_lat,
        assumed_lon: b.assumed_lon,
        azimuth_true: b.azimuth_true,
        intercept_nm: b.intercept_nm ?? null,
        body_or_object: b.body_or_object ?? null,
        confirmed_by: b.confirmed_by ?? null,
      });
      // §9.5: log the observation as a navigational event (taking the
      // sight is loggable independent of a later fix). Fire-and-forget.
      const obsBy = b.confirmed_by || usernameFromCookies(req.cookies) || null;
      writeLogbookEntry(
        deps.composeObservationEntry({
          kind: "bearing",
          datetime: b.timestamp ?? new Date().toISOString(),
          body_or_object: b.body_or_object ?? null,
          confirmed_by: obsBy,
          latitude: b.assumed_lat,
          longitude: b.assumed_lon,
          sea_state:
            resolveSeaState() !== "unknown" ? Number(resolveSeaState()) : null,
        }),
        "bearing",
      ).catch(() => {});
      res.json({ lop_id: id });
    });

    /**
     * POST /fix/cpl — persist a circular position line (SPEC §4.4) and
     * return its id.
     *
     * Body fields mirror `recordCircularPositionLine`: timestamp, cpl_type,
     * center_lat, center_lon, radius_nm, radius_uncertainty_nm?, source_object?,
     * confirmed_by?
     */
    router.post("/fix/cpl", (req, res) => {
      if (!engine || !db) {
        res.status(503).json({ message: "Plugin not started" });
        return;
      }
      const b = parseBody(req.body);
      if (
        typeof b.center_lat !== "number" ||
        typeof b.center_lon !== "number" ||
        typeof b.radius_nm !== "number"
      ) {
        res
          .status(400)
          .json({ message: "center_lat, center_lon, radius_nm required" });
        return;
      }
      const id = deps.recordCircularPositionLine(db, {
        timestamp: b.timestamp ?? new Date().toISOString(),
        cpl_type: b.cpl_type || "vertical-angle",
        center_lat: b.center_lat,
        center_lon: b.center_lon,
        radius_nm: b.radius_nm,
        radius_uncertainty_nm: b.radius_uncertainty_nm ?? null,
        source_object: b.source_object ?? null,
        confirmed_by: b.confirmed_by ?? null,
      });
      const obsBy = b.confirmed_by || usernameFromCookies(req.cookies) || null;
      writeLogbookEntry(
        deps.composeObservationEntry({
          kind: "vertical",
          datetime: b.timestamp ?? new Date().toISOString(),
          body_or_object: b.source_object ?? null,
          confirmed_by: obsBy,
          latitude: b.center_lat,
          longitude: b.center_lon,
          sea_state:
            resolveSeaState() !== "unknown" ? Number(resolveSeaState()) : null,
        }),
        "observation",
      ).catch(() => {});
      res.json({ cpl_id: id });
    });

    /**
     * GET /celestial/bodies — list the celestial bodies available for sight
     * reduction (Sun, Moon, and the bundled navigational stars), plus the
     * almanac validity window so the UI can warn when sights may be
     * inaccurate (SPEC §12/§13). Lets the sight panel populate its body
     * selector without hardcoding a list that can drift from the almanac.
     */
    router.get("/celestial/bodies", (_req, res) => {
      const stars = Object.keys(starAlmanac.STARS);
      res.json({
        bodies: ["Sun", "Moon", ...stars],
        valid_from: starAlmanac.VALID_FROM,
        valid_until: starAlmanac.VALID_UNTIL,
        expired: starAlmanac.isExpired(new Date()),
      });
    });

    /**
     * POST /celestial/sight — reduce a raw sextant sight (SPEC §13) and
     * persist the resulting line of position. Returns the LOP id plus the
     * reduction details (Hc, Ho, intercept, Zn, LHA) for UI feedback. The
     * LOP is then resolvable/confirmable through POST /fix/resolve +
     * POST /fix (work doc #3).
     *
     * Body:
     *   { body, hs_deg, index_correction_deg?, eye_height_m?, epoch_ms,
     *     assumed_position?, limb?, confirmed_by?, time_sync_staleness_s?,
     *     noon? }
     * `body` is 'Sun', 'Moon', or a bundled star name. `epoch_ms` is the
     * sight time (UTC ms). The DR position is used as the reduction point
     * unless `assumed_position` is supplied (design Q4). `noon: true` selects
     * the local-apparent-noon Sun reduction: a meridian-altitude latitude
     * sight (Lat = Dec ± z), emitted as an east-west LOP with zero intercept.
     */
    router.post("/celestial/sight", (req, res) => {
      if (!engine || !db) {
        res.status(503).json({ message: "Plugin not started" });
        return;
      }
      const b = parseBody(req.body);
      if (!b.body || typeof b.hs_deg !== "number" || !b.epoch_ms) {
        res.status(400).json({ message: "body, hs_deg, epoch_ms required" });
        return;
      }
      let result;
      try {
        const reducer = b.noon ? reduceNoonSight : reduceSight;
        result = reducer({
          body: b.body,
          hs_deg: b.hs_deg,
          index_correction_deg: b.index_correction_deg,
          eye_height_m: b.eye_height_m,
          epoch_ms: b.epoch_ms,
          assumed_position: b.assumed_position,
          dr_position: engine.origin ?? { latitude: 0, longitude: 0 },
          limb: b.limb,
          time_sync_staleness_s: b.time_sync_staleness_s,
          almanac: starAlmanac,
        });
      } catch (err) {
        res.status(400).json({ message: err.message });
        return;
      }
      const lopId = deps.recordLineOfPosition(db, {
        timestamp: new Date(b.epoch_ms).toISOString(),
        lop_type: "celestial",
        assumed_lat: result.assumed_lat,
        assumed_lon: result.assumed_lon,
        azimuth_true: result.azimuth_true,
        intercept_nm: result.intercept_nm,
        body_or_object: result.body,
        confirmed_by: b.confirmed_by ?? null,
      });
      const obsBy = b.confirmed_by || usernameFromCookies(req.cookies) || null;
      writeLogbookEntry(
        deps.composeObservationEntry({
          kind: "celestial",
          datetime: new Date(b.epoch_ms).toISOString(),
          body_or_object: result.body,
          confirmed_by: obsBy,
          latitude: result.assumed_lat,
          longitude: result.assumed_lon,
          reduction: {
            azimuth_true: result.azimuth_true,
            intercept_nm: result.intercept_nm,
          },
          sea_state:
            resolveSeaState() !== "unknown" ? Number(resolveSeaState()) : null,
        }),
        "observation",
      ).catch(() => {});
      res.json({
        lop_id: lopId,
        reduction: {
          body: result.body,
          assumed_lat: result.assumed_lat,
          assumed_lon: result.assumed_lon,
          azimuth_true: result.azimuth_true,
          intercept_nm: result.intercept_nm,
          intercept_direction: result.intercept_direction,
          hc_deg: result.hc_deg,
          ho_deg: result.ho_deg,
          lha_deg: result.lha_deg,
          time_sync_staleness_s: result.time_sync_staleness_s,
        },
      });
    });

    /**
     * POST /fix/resolve — preview a candidate fix from LOP/CPL inputs WITHOUT
     * confirming it (SPEC §9.1: candidate is presented to the watchkeeper with
     * context, then a human explicitly confirms). Returns the resolved
     * position, the cocked-hat residual, and any alternate Circle×Circle /
     * LOP×Circle candidate. Point fixes (gps/manual) resolve trivially.
     *
     * Body:
     *   { source_type, point?, observations?, lop_ids?, cpl_ids? }
     * `observations` is the array of LOP/CPL primitives (see plugin/fixes.js);
     * `lop_ids`/`cpl_ids` are db ids of already-persisted observations to
     * attach on a later confirm.
     */
    router.post("/fix/resolve", (req, res) => {
      if (!engine || !db) {
        res.status(503).json({ message: "Plugin not started" });
        return;
      }
      const b = parseBody(req.body);
      const candidate = deps.resolveCandidateFix({
        source_type: b.source_type || "manual",
        point:
          typeof b.latitude === "number" && typeof b.longitude === "number"
            ? { latitude: b.latitude, longitude: b.longitude }
            : null,
        observations: Array.isArray(b.observations) ? b.observations : [],
        observationIds: {
          lopIds: Array.isArray(b.lop_ids) ? b.lop_ids : [],
          cplIds: Array.isArray(b.cpl_ids) ? b.cpl_ids : [],
        },
        drPosition: engine.origin ?? undefined,
        engine,
        db,
        helpers: {
          getLineOfPosition: deps.getLineOfPosition,
          getCircularPositionLine: deps.getCircularPositionLine,
        },
        advance: (t0, t1) => groundTrack?.displacementBetween(t0, t1) ?? null,
      });
      if (!candidate) {
        res.status(400).json({ message: "observations not resolvable" });
        return;
      }
      res.json({ candidate });
    });

    /**
     * POST /fix — confirm a fix (SPEC §9.1, §9.3). Routes both point fixes
     * (GPS confirm, manual point) and LOP/CPL-resolved fixes through the
     * unified pipeline: writes a `fixes` row, attaches any LOP/CPL rows,
     * writes a `dr_corrections` row when there is a prior DR origin and the
     * fix resets it (symmetric across NORMAL/OVERRIDE), and snaps the DR
     * origin. Does NOT flip navigational authority — OVERRIDE stays a
     * separate human action (§7, §14.1).
     *
     * Point body: { latitude, longitude, source_type?, confirmed_by?, resets?,
     *                timestamp?, notes?, estimated_error_nm? }
     * LOP/CPL body: { source_type, observations?, lop_ids?, cpl_ids?,
     *                confirmed_by?, resets? } — resolved via the pipeline
     *   (a pre-resolved `candidate` from POST /fix/resolve may also be passed
     *   back verbatim as { candidate }).
     *
     * `timestamp` (ISO), `notes` and `estimated_error_nm` record fixes made
     * away from the console (paper forms, known berth coordinates) with
     * their own observation time and context; the logbook write-through
     * uses the fix timestamp, not the entry time.
     */
    router.post("/fix", (req, res) => {
      if (!engine || !db) {
        res.status(503).json({ message: "Plugin not started" });
        return;
      }
      const b = parseBody(req.body);
      const resets = b.resets !== false;
      // Optional fix-time metadata (backfilled/offline fixes). Invalid
      // timestamps are ignored rather than rejected — the fix is still
      // confirmed at entry time.
      let fixTimestamp = null;
      if (
        typeof b.timestamp === "string" &&
        !Number.isNaN(Date.parse(b.timestamp))
      ) {
        fixTimestamp = new Date(b.timestamp).toISOString();
      }
      // `confirmed_by`: prefer an explicit client value, else the
      // logged-in watchkeeper from the auth cookie (mirrors
      // signalk-logbook). Falls back to null for anonymous clients.
      const confirmedBy =
        b.confirmed_by || usernameFromCookies(req.cookies) || null;
      const sailState = resolveSailState();
      const seaState = resolveSeaState();
      const helpers = {
        recordFix: deps.recordFix,
        recordCorrection: deps.recordCorrection,
        recordLineOfPosition: deps.recordLineOfPosition,
        recordCircularPositionLine: deps.recordCircularPositionLine,
        attachObservationsToFix: deps.attachObservationsToFix,
        distanceNm: deps.distanceNm,
        bearingDeg: deps.bearingDeg,
      };

      // Build the candidate: either a passed-back pre-resolved candidate,
      // a point fix, or a fresh LOP/CPL resolution.
      let candidate;
      if (b.candidate?.source_type) {
        candidate = b.candidate;
      } else if (
        typeof b.latitude === "number" &&
        typeof b.longitude === "number"
      ) {
        candidate = deps.resolveCandidateFix({
          source_type: b.source_type || "manual",
          point: { latitude: b.latitude, longitude: b.longitude },
          observationIds: {
            lopIds: Array.isArray(b.lop_ids) ? b.lop_ids : [],
            cplIds: Array.isArray(b.cpl_ids) ? b.cpl_ids : [],
          },
          engine,
          db,
          helpers: {
            getLineOfPosition: deps.getLineOfPosition,
            getCircularPositionLine: deps.getCircularPositionLine,
          },
          advance: (t0, t1) => groundTrack?.displacementBetween(t0, t1) ?? null,
        });
      } else {
        candidate = deps.resolveCandidateFix({
          source_type: b.source_type || "manual",
          observations: Array.isArray(b.observations) ? b.observations : [],
          observationIds: {
            lopIds: Array.isArray(b.lop_ids) ? b.lop_ids : [],
            cplIds: Array.isArray(b.cpl_ids) ? b.cpl_ids : [],
          },
          drPosition: engine.origin ?? undefined,
          engine,
          db,
          helpers: {
            getLineOfPosition: deps.getLineOfPosition,
            getCircularPositionLine: deps.getCircularPositionLine,
          },
          advance: (t0, t1) => groundTrack?.displacementBetween(t0, t1) ?? null,
        });
      }
      if (!candidate) {
        res.status(400).json({ message: "observations not resolvable" });
        return;
      }

      const result = deps.confirmFix(db, candidate, engine, helpers, {
        confirmedBy,
        resets,
        sailState,
        seaState,
        timestamp: fixTimestamp ?? undefined,
        notes: typeof b.notes === "string" && b.notes ? b.notes : undefined,
        estimatedErrorRadius:
          typeof b.estimated_error_nm === "number" && b.estimated_error_nm > 0
            ? b.estimated_error_nm
            : undefined,
      });

      // §9.5: write-through to signalk-logbook (optional peer). `fixes`
      // stays canonical; the entry is a formatted export. Fire-and-forget
      // — a failure never blocks the confirm, and leaves the row
      // unmarked (`logged_to_logbook = 0`, visible in `fixes`).
      writeLogbookEntry(
        deps.composeFixEntry({
          datetime: fixTimestamp ?? new Date().toISOString(),
          source_type: candidate.source_type,
          latitude: candidate.latitude,
          longitude: candidate.longitude,
          confirmed_by: confirmedBy,
          deviation_nm: result.deviation_nm,
          dr_log_nm: engine.logNmSinceOrigin,
          residual_nm: candidate.residual_nm ?? null,
          observation_count:
            (candidate.observationIds?.lopIds?.length ?? 0) +
            (candidate.observationIds?.cplIds?.length ?? 0),
          stw_kn: unwrapNumber(deltaState.get("navigation.speedThroughWater")),
          sog_kn: unwrapNumber(deltaState.get("navigation.speedOverGround")),
          heading_deg: unwrapNumber(deltaState.get("navigation.headingTrue")),
          course_deg: unwrapNumber(
            deltaState.get("navigation.courseOverGround"),
          ),
          sea_state: seaState !== "unknown" ? Number(seaState) : null,
        }),
        "fix",
        result.fix_id,
      )
        .then((ref) => {
          if (ref) deps.markFixLogged(db, result.fix_id, ref);
        })
        .catch(() => {});

      res.json({
        fix_id: result.fix_id,
        correction_id: result.correction_id,
        confirmed_by: confirmedBy,
        deviation_nm: result.deviation_nm,
        deviation_bearing: result.deviation_bearing,
        recorded_correction: result.correction_id != null,
        origin: engine.origin,
      });
    });

    // ------------------------------------------------------------------
    // Observation & fix CRUD (work doc #13 stage D)
    // ------------------------------------------------------------------

    /**
     * Parses and validates a numeric `:id` route param.
     * @param {unknown} raw
     * @returns {number|null}
     */
    const numericId = (raw) => {
      const n = Number(raw);
      return Number.isInteger(n) && n > 0 ? n : null;
    };

    /**
     * DELETE /fix/lop/:id — delete a pending LOP. 409 when attached to a
     * confirmed fix (delete the fix instead; its observations return to
     * pending).
     */
    router.delete("/fix/lop/:id", (req, res) => {
      if (!db) {
        res.status(503).json({ message: "Plugin not started" });
        return;
      }
      const id = numericId(req.params?.id);
      if (id == null) {
        res.status(400).json({ message: "invalid id" });
        return;
      }
      const result = deps.deleteLineOfPosition(db, id);
      if (!result.ok) {
        if (result.reason === "not_found") {
          res.status(404).json({ message: `LOP ${id} not found` });
        } else if (result.reason === "attached") {
          res.status(409).json({
            message: `LOP ${id} is attached to fix #${result.fixId} — delete the fix instead (its observations return to pending)`,
            fix_id: result.fixId,
          });
        } else {
          res.status(400).json({ message: result.reason });
        }
        return;
      }
      res.json({ ok: true });
    });

    /**
     * DELETE /fix/cpl/:id — delete a pending CPL (same guard as LOPs).
     */
    router.delete("/fix/cpl/:id", (req, res) => {
      if (!db) {
        res.status(503).json({ message: "Plugin not started" });
        return;
      }
      const id = numericId(req.params?.id);
      if (id == null) {
        res.status(400).json({ message: "invalid id" });
        return;
      }
      const result = deps.deleteCircularPositionLine(db, id);
      if (!result.ok) {
        if (result.reason === "not_found") {
          res.status(404).json({ message: `CPL ${id} not found` });
        } else if (result.reason === "attached") {
          res.status(409).json({
            message: `CPL ${id} is attached to fix #${result.fixId} — delete the fix instead (its observations return to pending)`,
            fix_id: result.fixId,
          });
        } else {
          res.status(400).json({ message: result.reason });
        }
        return;
      }
      res.json({ ok: true });
    });

    /**
     * DELETE /fix/:id — un-confirm a fix: its LOP/CPL rows return to
     * pending, the correction row and any queued logbook entry are
     * dropped. The DR origin is NOT rewound (data-correction, not a
     * time machine).
     */
    router.delete("/fix/:id", (req, res) => {
      if (!db) {
        res.status(503).json({ message: "Plugin not started" });
        return;
      }
      const id = numericId(req.params?.id);
      if (id == null) {
        res.status(400).json({ message: "invalid id" });
        return;
      }
      const result = deps.deleteFix(db, id);
      if (!result.ok) {
        res.status(404).json({ message: `fix ${id} not found` });
        return;
      }
      res.json({ ok: true });
    });

    /**
     * PUT /fix/lop/:id — partial update of a pending LOP's editable
     * columns (object name, assumed position, azimuth, intercept).
     */
    router.put("/fix/lop/:id", (req, res) => {
      if (!db) {
        res.status(503).json({ message: "Plugin not started" });
        return;
      }
      const id = numericId(req.params?.id);
      if (id == null) {
        res.status(400).json({ message: "invalid id" });
        return;
      }
      const b = parseBody(req.body);
      const result = deps.updateLineOfPosition(db, id, b);
      if (!result.ok) {
        if (result.reason === "not_found") {
          res.status(404).json({ message: `LOP ${id} not found` });
        } else if (result.reason === "attached") {
          res.status(409).json({
            message: `LOP ${id} is attached to fix #${result.fixId} — delete the fix before editing`,
            fix_id: result.fixId,
          });
        } else {
          res.status(400).json({ message: "no editable fields in body" });
        }
        return;
      }
      res.json({ ok: true, lop: result.row });
    });

    /**
     * PUT /fix/cpl/:id — partial update of a pending CPL's editable
     * columns (object, center, radius).
     */
    router.put("/fix/cpl/:id", (req, res) => {
      if (!db) {
        res.status(503).json({ message: "Plugin not started" });
        return;
      }
      const id = numericId(req.params?.id);
      if (id == null) {
        res.status(400).json({ message: "invalid id" });
        return;
      }
      const b = parseBody(req.body);
      const result = deps.updateCircularPositionLine(db, id, b);
      if (!result.ok) {
        if (result.reason === "not_found") {
          res.status(404).json({ message: `CPL ${id} not found` });
        } else if (result.reason === "attached") {
          res.status(409).json({
            message: `CPL ${id} is attached to fix #${result.fixId} — delete the fix before editing`,
            fix_id: result.fixId,
          });
        } else {
          res.status(400).json({ message: "no editable fields in body" });
        }
        return;
      }
      res.json({ ok: true, cpl: result.row });
    });

    /**
     * PUT /fix/:id — partial update of a fix's audit metadata (notes,
     * confirmed_by, estimated error radius). Position/source_type/
     * timestamp are guarded (409) — repositioning a fix is "delete +
     * manual entry", not an edit.
     */
    router.put("/fix/:id", (req, res) => {
      if (!db) {
        res.status(503).json({ message: "Plugin not started" });
        return;
      }
      const id = numericId(req.params?.id);
      if (id == null) {
        res.status(400).json({ message: "invalid id" });
        return;
      }
      const b = parseBody(req.body);
      const result = deps.updateFix(db, id, b);
      if (!result.ok) {
        if (result.reason === "not_found") {
          res.status(404).json({ message: `fix ${id} not found` });
        } else if (result.reason === "guarded") {
          res.status(409).json({
            message: `cannot edit ${result.fields.join(", ")} of a confirmed fix — delete it and re-enter instead`,
            fields: result.fields,
          });
        } else {
          res.status(400).json({ message: "no editable fields in body" });
        }
        return;
      }
      res.json({ ok: true, fix: result.row });
    });
  };

  return plugin;
};

// --- Value unpacking helpers (kept module-level for reuse/testing) -------

/**
 * Normalizes a route body that may arrive already-parsed (object) or as a
 * JSON string (some Signal K server setups). Never throws.
 *
 * @param {unknown} body
 * @returns {Record<string, unknown>}
 */
function parseBody(body) {
  if (body == null) return {};
  if (typeof body === "object") return body;
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

/**
 * Unwraps a Signal K position value to {latitude, longitude}.
 *
 * @param {unknown} v
 * @returns {{latitude: number, longitude: number}|null}
 */
function unwrapPosition(v) {
  if (v == null) return null;
  if (typeof v === "object") {
    if (typeof v.latitude === "number" && typeof v.longitude === "number") {
      return { latitude: v.latitude, longitude: v.longitude };
    }
    if (typeof v.value === "object" && v.value) {
      return unwrapPosition(v.value);
    }
  }
  return null;
}

/**
 * Unwraps a numeric value from a bare number or {value:number}.
 *
 * @param {unknown} v
 * @returns {number|null}
 */
function unwrapNumber(v) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "object" && typeof v.value === "number")
    return Number.isFinite(v.value) ? v.value : null;
  return null;
}

/**
 * Unwraps heel angle in degrees from a navigation.attitude delta.
 *
 * @param {unknown} v
 * @returns {number|null}
 */
function unwrapHeel(v) {
  if (v == null || typeof v !== "object") return null;
  const roll = v.roll ?? v.value?.roll;
  const deg = unwrapNumber(roll);
  if (deg == null) return null;
  // Signal K attitude roll is in radians.
  return (deg * 180) / Math.PI;
}

module.exports.PLUGIN_ID = PLUGIN_ID;
module.exports.PATHS = PATHS;
module.exports.SUBSCRIPTION_PATHS = SUBSCRIPTION_PATHS;
module.exports.DEFAULT_CONFIG = DEFAULT_CONFIG;
module.exports.unwrapPosition = unwrapPosition;
module.exports.unwrapNumber = unwrapNumber;
module.exports.unwrapHeel = unwrapHeel;
module.exports.parseBody = parseBody;
