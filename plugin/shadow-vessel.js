/**
 * Shadow vessel publisher (work doc #21).
 *
 * Publishes the DR "shadow boat" position as a synthetic vessel on a
 * non-self `vessels.<id>` context, so chart plotters that source vessels
 * from the Signal K stream — Freeboard-SK's AIS layer chief among them —
 * render it on the chart alongside own-vessel and AIS traffic. Opt-in via
 * plugin config; the plugin stays the source of truth (the shadow is an
 * additional chart-visible target, not a navigational authority).
 *
 * Freeboard-SK renders any `vessels.*` context that isn't `self` as an
 * AIS-style target (traced in skstream.worker.ts: isSelf → vessels.self,
 * else → vessels.aisTargets, drawn by layer-aisvessels.component.ts). The
 * only per-target, data-driven visual lever in the AIS layer's style
 * decision tree is the `buddy` flag → the green `ais_buddy` glyph. The
 * shadow sets it so it reads as a friendly shadow target, distinct from
 * own vessel (the own-boat glyph, drawn topmost with its own vectors) and
 * from ordinary AIS traffic (magenta `ais_active`).
 *
 * The COG/SOG published here drive the plotter's projected COG line for
 * the shadow — the gap between the own vessel's heading and the shadow's
 * COG visualizes set + leeway, mirroring how the plotter treats the own
 * vessel. `headingTrue` is also published for users who prefer heading
 * orientation and as honest data.
 *
 * @file shadow-vessel.js
 */

const { normalizeDeg360, degToRad, radToDeg } = require("./geo.js");

/** Default source label for the shadow delta. */
const SOURCE_LABEL = "signalk-dead-reckoning";

/**
 * Resolves the shadow boat's ground velocity vector (COG/SOG) from the
 * same inputs the engine integrated on this tick: the water-track vector
 * (heading + leeway over effective STW) plus the resolved current vector.
 * Mirrors DeadReckoningEngine.tick's motion model so the projected COG
 * line matches where the shadow boat is actually going.
 *
 * Returns null when there is no heading or speed to build a vector from,
 * or when the vector sums to zero (genuinely stopped) — the caller then
 * omits COG/SOG from the delta so the plotter doesn't draw a stale or
 * zero-length projected line.
 *
 * @param {object} inputs
 * @param {number|null} inputs.stwKn - calibrated STW (knots)
 * @param {number|null} inputs.headingTrueDeg - true heading (degrees)
 * @param {number} [inputs.leewayDeg] - learned leeway (degrees, + to leeward)
 * @param {number} [inputs.speedLoss] - learned speed-loss fraction [0,1]
 * @param {{setTrue: number, drift: number}|null} [inputs.current]
 *   resolved current (deg true, kn)
 * @returns {{cogDeg: number, sogKn: number}|null}
 */
function resolveVelocity(inputs) {
  const stw = inputs.stwKn;
  const hdg = inputs.headingTrueDeg;
  if (stw == null || hdg == null) return null;
  const leeway = inputs.leewayDeg ?? 0;
  const speedLoss = Math.max(0, Math.min(1, inputs.speedLoss ?? 0));
  const current = inputs.current ?? { setTrue: 0, drift: 0 };

  const effectiveStw = stw * (1 - speedLoss);
  const courseDeg = normalizeDeg360(hdg + leeway);

  // Decompose into east/north components, sum, recompose. This is the
  // vector sum of water-track motion and current — exactly what the
  // engine integrates per tick, so the COG line projects consistently.
  const waterEast = effectiveStw * Math.sin(degToRad(courseDeg));
  const waterNorth = effectiveStw * Math.cos(degToRad(courseDeg));
  const setTrue = current.setTrue ?? 0;
  const drift = current.drift ?? 0;
  const curEast = drift * Math.sin(degToRad(setTrue));
  const curNorth = drift * Math.cos(degToRad(setTrue));

  const east = waterEast + curEast;
  const north = waterNorth + curNorth;
  const sogKn = Math.hypot(east, north);
  if (sogKn === 0) return null;
  const cogDeg = normalizeDeg360(radToDeg(Math.atan2(east, north)));
  return { cogDeg, sogKn };
}

/**
 * Creates a shadow-vessel publisher.
 *
 * The publisher holds no timers — it emits only when `publish()` is called
 * (once per DR tick from the plugin). On `stop()` it goes inert; the
 * plotter ages the target out via its own staleness window (Freeboard-SK
 * default 3 min) — Signal K has no clean delete-delta for a synthetic
 * context, and a lingering green dot for a few minutes after the plugin
 * stops is harmless.
 *
 * @param {object} opts
 * @param {object} opts.app - Signal K server API (handleMessage)
 * @param {string} opts.context - stable `vessels.<id>` context string
 * @param {string} opts.name - chart label shown by the plotter
 * @param {string} [opts.sourceLabel] - delta source label
 * @returns {{publish: (state: object) => void, stop: () => void}}
 */
function createShadowVesselPublisher(opts) {
  const { app, context, name } = opts;
  const source = opts.sourceLabel ?? SOURCE_LABEL;
  let running = true;

  /**
   * Publishes the shadow vessel delta. No-op when stopped or when there
   * is no position to plot (no DR origin yet).
   *
   * @param {object} state
   * @param {{latitude: number, longitude: number}|null} state.position
   * @param {number|null} [state.headingTrueRad] - glyph orientation (rad)
   * @param {number|null} [state.cogRad] - COG (rad) for the projected line
   * @param {number|null} [state.sogMs] - SOG (m/s); 0 clears the COG line
   * @returns {void}
   */
  function publish(state) {
    if (!running) return;
    const position = state.position;
    if (!position) return;

    const values = [
      // Root value: name + buddy flag. The buddy flag is the only
      // per-target data-driven visual lever in Freeboard's AIS layer →
      // the green ais_buddy glyph. Published every tick so a plotter
      // reconnect picks it up without a separate metadata handshake,
      // and so `lastUpdated` stays fresh (a position delta refreshes it
      // too, but the root value is belt-and-braces).
      { path: "", value: { name, buddy: true } },
      {
        path: "navigation.position",
        value: {
          latitude: position.latitude,
          longitude: position.longitude,
        },
      },
    ];
    if (state.headingTrueRad != null) {
      values.push({
        path: "navigation.headingTrue",
        value: state.headingTrueRad,
      });
    }
    if (state.cogRad != null) {
      values.push({
        path: "navigation.courseOverGroundTrue",
        value: state.cogRad,
      });
    }
    if (state.sogMs != null) {
      values.push({
        path: "navigation.speedOverGround",
        value: state.sogMs,
      });
    }

    app.handleMessage(source, {
      context,
      updates: [
        {
          timestamp: new Date().toISOString(),
          values,
        },
      ],
    });
  }

  function stop() {
    running = false;
  }

  return { publish, stop };
}

module.exports = {
  createShadowVesselPublisher,
  resolveVelocity,
  SOURCE_LABEL,
};
