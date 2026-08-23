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
const { openDatabase, getState, setState, recordFix, recordCorrection } =
  require("./db.js");
const { MatrixStore } = require("./matrix.js");
const { DeadReckoningEngine } = require("./engine.js");
const {
  TrainingState,
  resolveCurrent,
  tick: trainingTick,
} = require("./training.js");
const { distanceNm, bearingDeg } = require("./geo.js");

/**
 * Plugin identifier (matches package name without the scope).
 */
const PLUGIN_ID = "signalk-dead-reckoning";

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
  gpsSpoofed: "notifications.navigation.gpsSpoofed",
  divergenceAdvisory:
    "notifications.navigation.deadReckoning.divergenceAdvisory",
  status: "notifications.navigation.deadReckoning.status",
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
];

/**
 * Default configuration.
 */
const DEFAULT_CONFIG = {
  tickIntervalMs: 1000,
  saveIntervalMs: 60000,
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
  DeadReckoningEngine,
  MatrixStore,
  TrainingState,
  resolveCurrent,
  trainingTick,
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

  /** @type {TrainingState|null} */
  let training = null;

  /** @type {number|null} monotonic seconds counter for the training loop */
  let clockS = 0;

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
      },
    },

    start: (options) => {
      config = { ...DEFAULT_CONFIG, ...(options || {}) };

      dbPath = join(app.getDataDirPath(), "dead-reckoning.sqlite");
      db = deps.openDatabase(dbPath);
      matrix = new deps.MatrixStore(db);
      engine = new deps.DeadReckoningEngine();
      training = new deps.TrainingState();
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
      training = null;
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
        if (v.path === "navigation.position" && !engine?.origin) {
          const pos = unwrapPosition(v.value);
          if (pos) snapToFix(pos, "gps", { confirmed_by: null, resets: true });
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
    const seaState = "unknown";
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

    // Heading: prefer true heading; fall back to magnetic (WMM correction
    // applied upstream in v1 — see SPEC §12). If neither, hold position.
    const headingTrueDeg = headingTrue ?? headingMag;
    if (headingTrueDeg == null || rawStw == null) return;

    // Look up learned corrections for the current condition. Sail/sea state
    // come from the logbook peer when available; absent here they fall to
    // 'unknown' (SPEC §4.1).
    const sailState = resolveSailState();
    const seaState = "unknown";
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
    const current = deps.resolveCurrent({}, undefined);

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

    if (pos) {
      publish({
        [PATHS.position]: pos,
        [PATHS.active]: engine.active,
        [PATHS.method]: engine.method,
        [PATHS.log]: engine.logNm,
        [PATHS.tripLog]: engine.tripLogNm,
        [PATHS.stw]: rawStw,
        [PATHS.headingTrue]: headingTrueDeg,
        [PATHS.current]: current,
      });
    }
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
          ],
        },
      ],
    });
  }

  /**
   * Flushes engine state to the state store so it survives restarts.
   *
   * @returns {void}
   */
  function flushState() {
    if (!db || !engine) return;
    if (engine.origin) {
      deps.setState(db, "last_known_good_fix", JSON.stringify(engine.origin));
    }
    deps.setState(db, "dr_log_nm", String(engine.logNm));
    deps.setState(db, "dr_trip_log_nm", String(engine.tripLogNm));
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
      });
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
      let body = req.body;
      if (body == null) {
        try {
          body = JSON.parse(req.body);
        } catch {
          body = {};
        }
      }
      engine.active = !!body?.active;
      setStatus(engine.active ? "DR OVERRIDE engaged" : "DR OVERRIDE released");
      res.json({ active: engine.active });
    });

    /**
     * POST /fix — confirm a fix (SPEC §9.1). Records a `fixes` row and,
     * when the engine has a prior origin, a `dr_corrections` row (§9.3),
     * then snaps the DR origin to the confirmed position. The full fix
     * pipeline (LOP/CPL combination, celestial/bearing entry) is a
     * separate work doc; this endpoint covers the GPS-confirm and manual-
     * point cases that exercise the correction-recording path.
     *
     * Body: { latitude, longitude, source_type?, confirmed_by?, resets? }
     */
    router.post("/fix", (req, res) => {
      if (!engine || !db) {
        res.status(503).json({ message: "Plugin not started" });
        return;
      }
      let body = req.body;
      if (body == null) {
        try {
          body = JSON.parse(req.body);
        } catch {
          body = {};
        }
      }
      const lat = body?.latitude;
      const lon = body?.longitude;
      if (typeof lat !== "number" || typeof lon !== "number") {
        res.status(400).json({ message: "latitude and longitude required" });
        return;
      }
      const hadPrior = engine.origin != null;
      snapToFix(
        { latitude: lat, longitude: lon },
        body?.source_type || "manual",
        {
          confirmed_by: body?.confirmed_by ?? null,
          resets: body?.resets !== false,
        },
      );
      res.json({
        recorded_correction: hadPrior && body?.resets !== false,
        origin: engine.origin,
      });
    });
  };

  return plugin;
};

// --- Value unpacking helpers (kept module-level for reuse/testing) -------

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
