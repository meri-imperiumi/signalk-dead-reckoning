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
const {
  openDatabase,
  getState,
  setState,
  recordFix,
  recordCorrection,
  getDeviationRateStats,
} = require("./db.js");
const { MatrixStore } = require("./matrix.js");
const { DeadReckoningEngine } = require("./engine.js");
const {
  TrainingState,
  resolveCurrent,
  tick: trainingTick,
} = require("./training.js");
const { distanceNm, bearingDeg } = require("./geo.js");
const {
  recordLineOfPosition,
  recordCircularPositionLine,
  attachObservationsToFix,
} = require("./db.js");
const { resolveCandidateFix, confirmFix } = require("./fix-pipeline.js");
const { reduceSight } = require("./celestial.js");
const starAlmanac = require("./star-almanac.js");
const { computeRadius } = require("./uncertainty.js");
const {
  DEFAULT_FACTOR,
  DEFAULT_SUSTAIN_S,
  DEFAULT_CLEAR_S,
  createDivergenceState,
  divergenceTick,
} = require("./divergence.js");

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
  uncertainty: "navigation.deadReckoning.uncertainty",
  divergence: "navigation.deadReckoning.divergence",
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
  divergence: {
    factor: DEFAULT_FACTOR,
    sustainS: DEFAULT_SUSTAIN_S,
    clearS: DEFAULT_CLEAR_S,
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

  /** @type {ReturnType<typeof createDivergenceState>|null} §7.3 divergence monitor */
  let divergence = null;

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
      // Allow partial divergence overrides without losing the defaults.
      config.divergence = {
        ...DEFAULT_CONFIG.divergence,
        ...(options?.divergence ?? {}),
      };

      dbPath = join(app.getDataDirPath(), "dead-reckoning.sqlite");
      db = deps.openDatabase(dbPath);
      matrix = new deps.MatrixStore(db);
      engine = new deps.DeadReckoningEngine();
      training = new deps.TrainingState();
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
        ...(dvg ? { [PATHS.divergence]: dvg } : {}),
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
   * Publishes (or clears, via state "normal") a Signal K notification
   * (SPEC §3.1). Visual method only — these are low-severity nudges, not
   * sound alarms.
   *
   * @param {string} path
   * @param {{state: string, message: string}} n
   * @returns {void}
   */
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
      const body = parseBody(req.body);
      engine.active = !!body?.active;
      setStatus(engine.active ? "DR OVERRIDE engaged" : "DR OVERRIDE released");
      res.json({ active: engine.active });
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
      res.json({ cpl_id: id });
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
     *     assumed_position?, limb?, confirmed_by?, time_sync_staleness_s? }
     * `body` is 'Sun', 'Moon', or a bundled star name. `epoch_ms` is the
     * sight time (UTC ms). The DR position is used as the reduction point
     * unless `assumed_position` is supplied (design Q4).
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
        result = reduceSight({
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
     * Point body: { latitude, longitude, source_type?, confirmed_by?, resets? }
     * LOP/CPL body: { source_type, observations?, lop_ids?, cpl_ids?,
     *                confirmed_by?, resets? } — resolved via the pipeline
     *   (a pre-resolved `candidate` from POST /fix/resolve may also be passed
     *   back verbatim as { candidate }).
     */
    router.post("/fix", (req, res) => {
      if (!engine || !db) {
        res.status(503).json({ message: "Plugin not started" });
        return;
      }
      const b = parseBody(req.body);
      const resets = b.resets !== false;
      const confirmedBy = b.confirmed_by ?? null;
      const sailState = resolveSailState();
      const seaState = "unknown";
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
      });
      res.json({
        fix_id: result.fix_id,
        correction_id: result.correction_id,
        deviation_nm: result.deviation_nm,
        deviation_bearing: result.deviation_bearing,
        recorded_correction: result.correction_id != null,
        origin: engine.origin,
      });
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
