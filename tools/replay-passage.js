#!/usr/bin/env node
/**
 * Historical passage replay / backtest (minimal SPEC §10.2 scope).
 *
 * Replays one passage from the Signal K History API through the actual
 * DR engine (plugin/engine.js), starting the shadow boat at a GPS fix
 * and never re-anchoring it, then reports how dead reckoning diverged
 * from the GPS ground truth over the passage.
 *
 * Two variants run side by side:
 *
 *  - **cold** — untrained matrix (no leeway, no speed loss, zero
 *    current): the honest "what would DR do on day one of a fresh
 *    install" baseline.
 *  - **learning** — Training Mode enabled, exactly as the live plugin
 *    runs it (plugin/training.js + plugin/matrix.js, in-memory SQLite):
 *    simulates this passage being the boat's *first live passage ever*,
 *    with the matrix filling up as it sails.
 *
 * Both variants use the tier-5 zero current — there is no historical
 * weather/current source in this scope — so the divergence is the sum
 * of unmodeled set/drift plus unlearned leeway/speed error. The script
 * also derives the *implied* current (GPS ground vector minus water-
 * track vector) as a diagnostic of what DR was missing.
 *
 * Data caveats (SPEC §10.1): history resolution is ~10s vs live 1Hz;
 * `navigation.attitude` is only recorded as its component paths, so the
 * tool queries `navigation.attitude.roll` directly for heel; sparse
 * event-like paths (navigation/propulsion state) are forward-filled.
 *
 * Usage:
 *   node tools/replay-passage.js \
 *     --url http://192.168.2.105 \
 *     --from 2026-08-13T00:00:00Z --to 2026-08-17T22:00:00Z \
 *     [--out DIR] [--no-train] [--resolution 10] [--chunk-hours 6]
 *
 * Writes replay.geojson, replay-samples.json and a self-contained
 * SVG-based HTML report into --out (default ~/tmp/dr-replay), and
 * prints an hourly divergence table plus a summary.
 *
 * @file tools/replay-passage.js
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { DeadReckoningEngine } = require("../plugin/engine.js");
const { TrainingState, tick: trainingTick } = require("../plugin/training.js");
const { MatrixStore } = require("../plugin/matrix.js");
const { openDatabase } = require("../plugin/db.js");
const {
  distanceNm,
  bearingDeg,
  radToDeg,
  normalizeDeg180,
  normalizeDeg360,
  msToKnots,
} = require("../plugin/geo.js");

/** Requested history paths, in column order of the response rows. */
const PATH_SPECS = [
  "navigation.position:first",
  "navigation.speedThroughWater:average",
  "navigation.headingTrue:average",
  "environment.wind.angleApparent:average",
  "environment.wind.speedApparent:average",
  "navigation.state:last",
  "propulsion.main.state:last",
  "navigation.attitude.roll:average",
];

/** Tier-5 current: none resolved (SPEC §6.2). */
const ZERO_CURRENT = { setTrue: 0, drift: 0, tier: 5 };

/** SOG (kn) above which a sample counts as underway, for summaries. */
const UNDERWAY_SOG_KN = 1.0;

/** Below this STW (kn) the water track carries no useful direction. */
const STW_USABLE_KN = 0.5;

/**
 * Builds a history-values URL with an absolute from/to range.
 *
 * @param {string} base - server origin, e.g. http://192.168.2.105
 * @param {string} from - ISO timestamp
 * @param {string} to - ISO timestamp
 * @param {number} resolutionSec - bucket size
 * @param {string[]} [paths] - path specs (default PATH_SPECS)
 * @returns {string} URL
 */
function historyUrl(base, from, to, resolutionSec, paths = PATH_SPECS) {
  const params = new URLSearchParams({
    from,
    to,
    resolution: String(Math.max(1, Math.floor(resolutionSec))),
    paths: paths.join(","),
  });
  return `${base.replace(/\/$/, "")}/signalk/v2/api/history/values?${params.toString()}`;
}

/**
 * Parses one history response into raw row objects (no filling).
 *
 * @param {object} response - parsed JSON body
 * @returns {{tMs: number, position: {latitude:number, longitude:number}|null,
 *   stwMs: number|null, headingTrueRad: number|null, awaRad: number|null,
 *   awsMs: number|null, navState: unknown, propulsionState: unknown,
 *   rollRad: number|null}[]}
 */
function rowsFromResponse(response) {
  const data = Array.isArray(response?.data) ? response.data : [];
  const rows = [];
  for (const row of data) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const tMs = Date.parse(row[0]);
    if (!Number.isFinite(tMs)) continue;
    const pos = row[1];
    rows.push({
      tMs,
      position:
        Array.isArray(pos) && pos.length >= 2
          ? { latitude: Number(pos[1]), longitude: Number(pos[0]) }
          : null,
      stwMs: row[2],
      headingTrueRad: row[3],
      awaRad: row[4],
      awsMs: row[5],
      navState: row[6],
      propulsionState: row[7],
      rollRad: row[8],
    });
  }
  rows.sort((a, b) => a.tMs - b.tMs);
  return rows;
}

/**
 * Forward-fills sparse cells (hold-last) and unwraps the signed AWA
 * across ±π so bucket-to-bucket continuity is preserved through gybes.
 * Position is never filled (a missing GPS is a missing GPS). Rows
 * without a position are dropped entirely.
 *
 * @param {object[]} rows - output of rowsFromResponse
 * @returns {object[]} filled rows, position always present
 */
function forwardFill(rows) {
  const out = [];
  const last = {
    stwMs: null,
    headingTrueRad: null,
    awaRad: null,
    awsMs: null,
    navState: null,
    propulsionState: null,
    rollRad: null,
  };
  let prevAwaUnwrapped = null;
  for (const row of rows) {
    if (!row.position) continue;
    const filled = { ...row };
    const rawAwa = filled.awaRad;
    for (const key of Object.keys(last)) {
      if (filled[key] == null) filled[key] = last[key];
      else last[key] = filled[key];
    }
    if (typeof rawAwa === "number") {
      // Unwrap the signed [-π, π] apparent wind angle relative to the
      // previous value, so a gybe through ±π reads as continuity.
      if (prevAwaUnwrapped != null) {
        const delta = normalizeDeg180(
          ((rawAwa - prevAwaUnwrapped) * 180) / Math.PI,
        );
        prevAwaUnwrapped = prevAwaUnwrapped + (delta * Math.PI) / 180;
      } else {
        prevAwaUnwrapped = rawAwa;
      }
    }
    filled.awaUnwrappedRad = prevAwaUnwrapped;
    out.push(filled);
  }
  return out;
}

/**
 * Fetches a full range in chunks and returns filled rows.
 *
 * @param {object} opts
 * @param {string} opts.baseUrl
 * @param {string} opts.from
 * @param {string} opts.to
 * @param {number} [opts.resolutionSec=10]
 * @param {number} [opts.chunkHours=6]
 * @param {typeof fetch} [opts.fetchImpl]
 * @returns {Promise<object[]>}
 */
async function fetchHistory(opts) {
  const {
    baseUrl,
    from,
    to,
    resolutionSec = 10,
    chunkHours = 6,
    fetchImpl = fetch,
  } = opts;
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    throw new Error(`Invalid range ${from} → ${to}`);
  }
  const chunkMs = chunkHours * 3600 * 1000;
  const rows = [];
  for (let start = fromMs; start < toMs; start += chunkMs) {
    const end = Math.min(start + chunkMs, toMs);
    const url = historyUrl(
      baseUrl,
      new Date(start).toISOString(),
      new Date(end).toISOString(),
      resolutionSec,
    );
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(120000) });
    if (!res.ok) {
      throw new Error(`History request failed (${res.status}): ${url}`);
    }
    rows.push(...rowsFromResponse(await res.json()));
    process.stderr.write(
      `fetched ${rows.length} rows through ${new Date(end).toISOString()}\n`,
    );
  }
  return forwardFill(rows);
}

/**
 * Resolves the sail state the way the live plugin does (propulsion
 * started → motoring, autostate sailing → sailing, else unknown).
 *
 * @param {object} row - filled history row
 * @returns {string}
 */
function resolveSailState(row) {
  if (row.propulsionState === "started") return "motoring";
  if (row.navState === "sailing") return "sailing";
  return "unknown";
}

/** PacIOOS ERDDAP serving NASA/JPL SCUD Pacific surface currents. */
const SCUD_ERDDAP =
  "https://pae-paha.pacioos.hawaii.edu/erddap/griddap/scud_pac.json";

/** Margin (deg) around the track bounds for the SCUD fetch box. */
const SCUD_BOX_MARGIN_DEG = 0.5;

/**
 * Fetches a SCUD current grid over a lat/lon box and time range.
 *
 * The grid comes back as one row per (time, lat, lon) with u/v in m/s;
 * longitudes are 0–360 on the server. Days missing from the source
 * (SCUD has holes) simply leave gaps that {@link currentAt} bridges by
 * linear time interpolation between the bracketing available days.
 *
 * @param {object} opts
 * @param {string} opts.from - ISO timestamp
 * @param {string} opts.to - ISO timestamp
 * @param {number} opts.latMin
 * @param {number} opts.latMax
 * @param {number} opts.lonMin - degrees east, 0–360
 * @param {number} opts.lonMax - degrees east, 0–360
 * @param {typeof fetch} [opts.fetchImpl]
 * @returns {Promise<{timesMs: number[], lats: number[], lons: number[],
 *   u: number[][][], v: number[][][]}>} grid indexed [t][lat][lon]
 */
async function fetchScudGrid(opts) {
  const { from, to, latMin, latMax, lonMin, lonMax, fetchImpl = fetch } = opts;
  const cons = `[(${from}):(${to})][(${latMin}):(${latMax})][(${lonMin}):(${lonMax})]`;
  const url = `${SCUD_ERDDAP}?u${encodeURIComponent(cons)},v${encodeURIComponent(cons)}`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) {
    throw new Error(`SCUD request failed (${res.status}): ${url}`);
  }
  const body = await res.json();
  const rows = body?.table?.rows ?? [];
  const timesMs = [];
  const lats = [];
  const lons = [];
  for (const r of rows) {
    const t = Date.parse(r[0]);
    if (!timesMs.includes(t)) timesMs.push(t);
    if (!lats.includes(r[1])) lats.push(r[1]);
    if (!lons.includes(r[2])) lons.push(r[2]);
  }
  timesMs.sort((a, b) => a - b);
  lats.sort((a, b) => a - b);
  lons.sort((a, b) => a - b);
  const ti = new Map(timesMs.map((t, i) => [t, i]));
  const ai = new Map(lats.map((v, i) => [v, i]));
  const oi = new Map(lons.map((v, i) => [v, i]));
  const u = timesMs.map(() => lats.map(() => lons.map(() => NaN)));
  const v = timesMs.map(() => lats.map(() => lons.map(() => NaN)));
  for (const r of rows) {
    u[ti.get(Date.parse(r[0]))][ai.get(r[1])][oi.get(r[2])] = r[3];
    v[ti.get(Date.parse(r[0]))][ai.get(r[1])][oi.get(r[2])] = r[4];
  }
  return { timesMs, lats, lons, u, v };
}

/**
 * Looks up the SCUD current at a time/position, nearest grid cell in
 * space and linearly interpolated in time (bridging missing days).
 * Outside the grid's time span the nearest end is held.
 *
 * @param {{timesMs: number[], lats: number[], lons: number[],
 *   u: number[][][], v: number[][][]}} grid
 * @param {number} tMs
 * @param {number} lat
 * @param {number} lon - degrees east, negative (−180…0) allowed
 * @returns {{setTrue: number, drift: number}|null} set in deg true,
 *   drift in kn; null when the nearest cell has no data
 */
function currentAt(grid, tMs, lat, lon) {
  const lon360 = lon < 0 ? lon + 360 : lon;
  const nearest = (xs, x) =>
    xs.reduce((best, cur) =>
      Math.abs(cur - x) < Math.abs(best - x) ? cur : best,
    );
  const latV = nearest(grid.lats, lat);
  const lonV = nearest(grid.lons, lon360);
  const ai = grid.lats.indexOf(latV);
  const oi = grid.lons.indexOf(lonV);

  let t0 = 0;
  for (let i = 0; i < grid.timesMs.length; i++) {
    if (grid.timesMs[i] <= tMs) t0 = i;
  }
  const t1 = Math.min(t0 + 1, grid.timesMs.length - 1);
  const span = grid.timesMs[t1] - grid.timesMs[t0];
  const frac = span > 0 ? (tMs - grid.timesMs[t0]) / span : 0;

  const u0 = grid.u[t0][ai][oi];
  const v0 = grid.v[t0][ai][oi];
  const u1 = grid.u[t1][ai][oi];
  const v1 = grid.v[t1][ai][oi];
  if (Number.isNaN(u0) || Number.isNaN(v0)) return null;
  if (Number.isNaN(u1) || Number.isNaN(v1)) {
    // No valid next day to interpolate towards: hold the current one.
    return {
      setTrue: normalizeDeg360((Math.atan2(u0, v0) * 180) / Math.PI),
      drift: msToKnots(Math.hypot(u0, v0)),
    };
  }
  const uu = u0 + (u1 - u0) * frac;
  const vv = v0 + (v1 - v0) * frac;
  return {
    setTrue: normalizeDeg360((Math.atan2(uu, vv) * 180) / Math.PI),
    drift: msToKnots(Math.hypot(uu, vv)),
  };
}

/**
 * One replay variant's mutable state.
 *
 * @param {object} cfg
 * @param {string} cfg.key - sample-record key ("cold", "learn", …)
 * @param {boolean} cfg.train - Training Mode on
 * @param {((position: {latitude:number,longitude:number}, tMs: number) =>
 *   {setTrue:number, drift:number}|null)|null} [cfg.currentProvider]
 *   resolved-current source, or null for tier-5 zero
 * @returns {object}
 */
function makeVariant(cfg) {
  const { key, train, currentProvider = null } = cfg;
  const engine = new DeadReckoningEngine();
  const variant = {
    key,
    train,
    engine,
    matrix: null,
    training: null,
    position: null,
    divNm: null,
    corrections: { leeway_angle: 0, speed_loss: 0 },
    update(row, dtS) {
      const stwKn = typeof row.stwMs === "number" ? msToKnots(row.stwMs) : null;
      const headingTrueDeg =
        typeof row.headingTrueRad === "number"
          ? normalizeDeg360(radToDeg(row.headingTrueRad))
          : null;
      const awaDeg =
        row.awaUnwrappedRad != null ? radToDeg(row.awaUnwrappedRad) : 0;
      // quantizeAwa normalizes to [-180, 180) itself; the unwrapped
      // value may exceed that range after several gybes.
      const heelDeg =
        typeof row.rollRad === "number" ? radToDeg(row.rollRad) : 0;

      // Resolve the current at the shadow boat's own position — the
      // honest simulation of a GPS-less boat asking "what current am I
      // in?" (live, the plugin would use the trusted position; once
      // GPS is gone, DR is all it has).
      const current = currentProvider
        ? (currentProvider(engine.origin, row.tMs) ?? ZERO_CURRENT)
        : ZERO_CURRENT;

      if (this.train) {
        const tr = trainingTick(this.training, {
          timestampS: row.tMs / 1000,
          gps: row.position,
          stwKn,
          headingTrueDeg,
          awaDeg,
          awsKn: typeof row.awsMs === "number" ? msToKnots(row.awsMs) : null,
          heelDeg, // attitude roll, recorded as a component path
          propulsionState: row.propulsionState,
          current,
          lookupLeewayDeg: this.corrections.leeway_angle,
          lookupSpeedLoss: this.corrections.speed_loss,
        });
        if (tr.observation) {
          this.matrix.update(
            {
              sail_state: resolveSailState(row),
              sea_state: "unknown",
              stwKn,
              awaDeg,
              heelDeg,
            },
            tr.observation,
          );
        }
        this.corrections = this.matrix.lookup({
          sail_state: resolveSailState(row),
          sea_state: "unknown",
          stwKn,
          awaDeg,
          heelDeg,
        });
      }

      this.position = this.engine.tick(
        {
          stwKn,
          headingTrueDeg,
          leewayDeg: this.corrections.leeway_angle,
          speedLoss: this.corrections.speed_loss,
          current,
        },
        dtS,
      );
      if (row.position) {
        this.divNm = distanceNm(this.engine.origin, row.position);
      }
    },
  };
  if (train) {
    const db = openDatabase(":memory:");
    variant.matrix = new MatrixStore(db);
    variant.training = new TrainingState();
  }
  return variant;
}

/**
 * Runs the replay over filled rows. The DR origin is seeded from the
 * first GPS fix (mirroring the live plugin's auto-seed) and is never
 * re-anchored — the whole point of the exercise.
 *
 * @param {object[]} rows - filled rows
 * @param {object} [opts]
 * @param {boolean} [opts.train=true] - include the learning variant
 * @param {object|null} [opts.scudGrid] - SCUD current grid; enables the
 *   current-corrected variants
 * @returns {{samples: object[], variants: object[]}}
 */
function runReplay(rows, opts = {}) {
  const wantTrain = opts.train !== false;
  const scud = opts.scudGrid ?? null;
  const scudProvider = scud
    ? (position, tMs) =>
        position
          ? currentAt(scud, tMs, position.latitude, position.longitude)
          : null
    : null;

  const variants = [makeVariant({ key: "cold", train: false })];
  if (wantTrain) variants.push(makeVariant({ key: "learn", train: true }));
  if (scud) {
    variants.push(
      makeVariant({ key: "scud", train: false, currentProvider: scudProvider }),
    );
    if (wantTrain) {
      variants.push(
        makeVariant({
          key: "scudLearn",
          train: true,
          currentProvider: scudProvider,
        }),
      );
    }
  }

  const first = rows.find((r) => r.position);
  if (!first) throw new Error("No GPS positions in range");
  for (const v of variants) v.engine.snapToFix(first.position);

  const samples = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const row = rows[i];
    const dtS = (row.tMs - prev.tMs) / 1000;
    if (dtS <= 0) continue;

    for (const v of variants) v.update(row, dtS);

    // Implied current: ground displacement minus water-track displacement.
    let setTrue = null;
    let drift = null;
    let sogKn = null;
    const stwKn = typeof prev.stwMs === "number" ? msToKnots(prev.stwMs) : 0;
    if (
      prev.position &&
      row.position &&
      stwKn > STW_USABLE_KN &&
      typeof prev.headingTrueRad === "number"
    ) {
      const groundNm = distanceNm(prev.position, row.position);
      const groundBrg = bearingDeg(prev.position, row.position);
      sogKn = groundNm / (dtS / 3600);
      const gE = sogKn * Math.sin((groundBrg * Math.PI) / 180);
      const gN = sogKn * Math.cos((groundBrg * Math.PI) / 180);
      const hdgDeg = normalizeDeg360(radToDeg(prev.headingTrueRad));
      const wE = stwKn * Math.sin((hdgDeg * Math.PI) / 180);
      const wN = stwKn * Math.cos((hdgDeg * Math.PI) / 180);
      const cE = gE - wE;
      const cN = gN - wN;
      drift = Math.hypot(cE, cN);
      setTrue =
        drift > 1e-6
          ? normalizeDeg360((Math.atan2(cE, cN) * 180) / Math.PI)
          : null;
    }

    samples.push({
      tMs: row.tMs,
      gps: row.position,
      sogKn,
      stwKn,
      setTrue,
      drift,
      // SCUD current at the GPS position/time, for comparison against
      // the implied current derived from the boat's own motion.
      scudAt: scud
        ? currentAt(
            scud,
            row.tMs,
            row.position.latitude,
            row.position.longitude,
          )
        : null,
    });
    for (const v of variants) {
      samples[samples.length - 1][v.key] = {
        position: v.engine.origin,
        divNm: v.divNm,
      };
    }
  }
  return { samples, variants };
}

/**
 * Variant presentation: sample-record key → label and color, in
 * output column order.
 */
const VARIANT_STYLE = {
  cold: { label: "DR cold (no training, zero current)", color: "#fb923c" },
  learn: { label: "DR learning (training on, zero current)", color: "#4ade80" },
  scud: { label: "DR cold + SCUD current", color: "#c084fc" },
  scudLearn: { label: "DR learning + SCUD current", color: "#facc15" },
};

/**
 * Variant keys present in a sample set, in VARIANT_STYLE order.
 *
 * @param {object[]} samples
 * @returns {string[]}
 */
function variantKeys(samples) {
  const first = samples[0] ?? {};
  return Object.keys(VARIANT_STYLE).filter((k) => first[k] != null);
}

/**
 * Buckets samples into hourly aggregates.
 *
 * @param {object[]} samples
 * @returns {{hourKey: number, meanDiv: Record<string, number|null>,
 *   maxDiv: Record<string, number>, meanSet: number|null,
 *   meanDrift: number|null, scudSet: number|null, scudDrift: number|null}[]}
 */
function hourlyBuckets(samples) {
  const keys = variantKeys(samples);
  const byHour = new Map();
  for (const s of samples) {
    const key = Math.floor(s.tMs / 3600000);
    if (!byHour.has(key)) byHour.set(key, []);
    byHour.get(key).push(s);
  }
  const vectorMean = (pairs) => {
    if (!pairs.length) return null;
    const e =
      pairs.reduce(
        (a, p) => a + p.drift * Math.sin((p.set * Math.PI) / 180),
        0,
      ) / pairs.length;
    const n =
      pairs.reduce(
        (a, p) => a + p.drift * Math.cos((p.set * Math.PI) / 180),
        0,
      ) / pairs.length;
    const drift = Math.hypot(e, n);
    const set =
      drift > 1e-6 ? normalizeDeg360((Math.atan2(e, n) * 180) / Math.PI) : null;
    return { set, drift };
  };
  const out = [];
  for (const [hourKey, group] of [...byHour.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    const mean = (xs) => {
      const vs = xs.filter((x) => x != null);
      return vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null;
    };
    const underway = group.filter((s) => (s.sogKn ?? 0) > UNDERWAY_SOG_KN);
    const meanDiv = {};
    const maxDiv = {};
    for (const k of keys) {
      meanDiv[k] = mean(group.map((s) => s[k]?.divNm));
      maxDiv[k] = maxOf(group.map((s) => s[k]?.divNm ?? 0));
    }
    const implied = vectorMean(
      underway
        .filter((s) => s.setTrue != null && s.drift != null)
        .map((s) => ({ set: s.setTrue, drift: s.drift })),
    );
    const scud = vectorMean(
      underway
        .filter((s) => s.scudAt?.setTrue != null && s.scudAt?.drift != null)
        .map((s) => ({ set: s.scudAt.setTrue, drift: s.scudAt.drift })),
    );
    out.push({
      hourKey,
      meanDiv,
      maxDiv,
      meanSet: implied?.set ?? null,
      meanDrift: implied?.drift ?? null,
      scudSet: scud?.set ?? null,
      scudDrift: scud?.drift ?? null,
    });
  }
  return out;
}

/**
 * Array max that doesn't blow the stack on 30k+ samples (Math.max
 * with a spread does).
 *
 * @param {number[]} xs
 * @returns {number}
 */
function maxOf(xs) {
  let m = -Infinity;
  for (const x of xs) m = Math.max(m, x);
  return m;
}

/**
 * Summarizes a finished replay.
 *
 * @param {object[]} samples
 * @returns {object}
 */
function summarize(samples) {
  const underwaySamples = samples.filter(
    (s) => (s.sogKn ?? 0) > UNDERWAY_SOG_KN,
  );
  let runNmGps = 0;
  let prev = null;
  for (const s of samples) {
    if (prev && s.gps) runNmGps += distanceNm(prev, s.gps);
    if (s.gps) prev = s.gps;
  }
  const last = samples[samples.length - 1];
  const sets = underwaySamples.filter(
    (s) => s.setTrue != null && s.drift != null,
  );
  const e =
    sets.reduce(
      (a, s) => a + s.drift * Math.sin((s.setTrue * Math.PI) / 180),
      0,
    ) / Math.max(1, sets.length);
  const n =
    sets.reduce(
      (a, s) => a + s.drift * Math.cos((s.setTrue * Math.PI) / 180),
      0,
    ) / Math.max(1, sets.length);
  const finalDiv = {};
  const maxDiv = {};
  for (const k of variantKeys(samples)) {
    finalDiv[k] = last[k]?.divNm ?? null;
    maxDiv[k] = maxOf(samples.map((s) => s[k]?.divNm ?? 0));
  }
  return {
    from: new Date(samples[0].tMs).toISOString(),
    to: new Date(last.tMs).toISOString(),
    runNmGps,
    finalDiv,
    maxDiv,
    impliedCurrent: {
      setTrue:
        Math.hypot(e, n) > 1e-6
          ? normalizeDeg360((Math.atan2(e, n) * 180) / Math.PI)
          : null,
      driftKn: Math.hypot(e, n),
      sampleCount: sets.length,
    },
  };
}

/**
 * Renders the samples as a GeoJSON FeatureCollection.
 *
 * @param {object[]} samples
 * @returns {object}
 */
function toGeoJSON(samples) {
  const line = (points, color, extra = {}) => ({
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: points.map((p) => [p.longitude, p.latitude]),
    },
    properties: { stroke: color, "stroke-width": 2, ...extra },
  });
  const features = [
    line(samples.map((s) => s.gps).filter(Boolean), "#2563eb", {
      name: "GPS track",
    }),
  ];
  for (const k of variantKeys(samples)) {
    features.push(
      line(
        samples.map((s) => s[k]?.position).filter(Boolean),
        VARIANT_STYLE[k].color,
        { name: VARIANT_STYLE[k].label },
      ),
    );
  }
  return { type: "FeatureCollection", features };
}

/**
 * Escapes text for embedding in HTML.
 *
 * @param {string} s
 * @returns {string}
 */
function escapeHtml(s) {
  return String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
}

/**
 * Renders a self-contained SVG-based HTML report (tracks + divergence
 * over time). No external resources, works offline.
 *
 * @param {object} report - {meta, samples, summary, hourly}
 * @returns {string} HTML document
 */
function toHtmlReport(report) {
  const { meta, samples, summary, hourly } = report;

  // --- Track plot -------------------------------------------------------
  const keys = variantKeys(samples);
  const pts = [];
  for (const s of samples) {
    if (s.gps) pts.push(s.gps);
    for (const k of keys) if (s[k]?.position) pts.push(s[k].position);
  }
  let latMinV = Infinity;
  let latMaxV = -Infinity;
  let lonMinV = Infinity;
  let lonMaxV = -Infinity;
  for (const p of pts) {
    latMinV = Math.min(latMinV, p.latitude);
    latMaxV = Math.max(latMaxV, p.latitude);
    lonMinV = Math.min(lonMinV, p.longitude);
    lonMaxV = Math.max(lonMaxV, p.longitude);
  }
  const latMin = latMinV;
  const latMax = latMaxV;
  const lonMin = lonMinV;
  const lonMax = lonMaxV;
  const latMid = ((latMin + latMax) / 2) * (Math.PI / 180);
  const xOf = (lon) => (lon - lonMin) * Math.cos(latMid);
  const yOf = (lat) => latMax - lat;
  const spanX = Math.max(1e-9, xOf(lonMax));
  const spanY = Math.max(1e-9, yOf(latMin));
  const W = 900;
  const H = 480;
  const M = 24;
  const scale = Math.min((W - 2 * M) / spanX, (H - 2 * M) / spanY);
  const px = (p) => M + xOf(p.longitude) * scale;
  const py = (p) => M + yOf(p.latitude) * scale;
  const poly = (points) =>
    points
      .filter(Boolean)
      .map((p) => `${px(p).toFixed(1)},${py(p).toFixed(1)}`)
      .join(" ");
  // Downsample for plotting: ~2000 points per line keeps the report
  // light (full-resolution data stays in replay-samples.json).
  const step = Math.max(1, Math.floor(samples.length / 2000));
  const plotted = samples.filter(
    (_, i) => i % step === 0 || i === samples.length - 1,
  );
  const trackSvg = `
  <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${W}" height="${H}" fill="#0b1622"/>
    <polyline points="${poly(plotted.map((s) => s.gps))}" fill="none" stroke="#60a5fa" stroke-width="1.5"/>
    ${keys
      .map(
        (k) =>
          `<polyline points="${poly(plotted.map((s) => s[k]?.position))}" fill="none" stroke="${VARIANT_STYLE[k].color}" stroke-width="1.5"${k === "cold" ? ' stroke-dasharray="4 3"' : ""}/>`,
      )
      .join("\n    ")}
    <circle cx="${px(samples[0].gps)}" cy="${py(samples[0].gps)}" r="4" fill="#fff"/>
    <text x="${px(samples[0].gps) + 8}" y="${py(samples[0].gps) + 4}" fill="#fff" font-size="12">start</text>
    <circle cx="${px(samples[samples.length - 1].gps)}" cy="${py(samples[samples.length - 1].gps)}" r="4" fill="#fff"/>
    <text x="${px(samples[samples.length - 1].gps) + 8}" y="${py(samples[samples.length - 1].gps) + 4}" fill="#fff" font-size="12">end</text>
  </svg>`;

  // --- Divergence chart -------------------------------------------------
  const t0 = samples[0].tMs;
  const t1 = samples[samples.length - 1].tMs;
  const maxDiv = Math.max(
    0.1,
    ...keys.map((k) => maxOf(samples.map((s) => s[k]?.divNm ?? 0))),
  );
  const CW = 900;
  const CH = 200;
  const cx = (s) => M + ((s.tMs - t0) / (t1 - t0)) * (CW - 2 * M);
  const cy = (v) => CH - M - (v / maxDiv) * (CH - 2 * M);
  const divSvg = `
  <svg viewBox="0 0 ${CW} ${CH}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${CW}" height="${CH}" fill="#0b1622"/>
    ${[0.25, 0.5, 0.75, 1].map((f) => `<line x1="${M}" x2="${CW - M}" y1="${cy(maxDiv * f)}" y2="${cy(maxDiv * f)}" stroke="#1e3a5f"/><text x="${M + 4}" y="${cy(maxDiv * f) - 3}" fill="#64748b" font-size="10">${(maxDiv * f).toFixed(1)} nm</text>`).join("")}
    ${keys
      .map(
        (k) =>
          `<polyline points="${plotted.map((s) => `${cx(s).toFixed(1)},${cy(s[k]?.divNm ?? 0).toFixed(1)}`).join(" ")}" fill="none" stroke="${VARIANT_STYLE[k].color}" stroke-width="1.5"/>`,
      )
      .join("\n    ")}
  </svg>`;

  const fmt = (v, digits = 1) => (v == null ? "—" : v.toFixed(digits));
  const tableRows = hourly
    .map((h) => {
      const t = new Date(h.hourKey * 3600000).toISOString().slice(0, 16);
      const cur =
        h.meanSet == null
          ? "—"
          : `${h.meanSet.toFixed(0)}° @ ${fmt(h.meanDrift, 2)} kn`;
      const scud =
        h.scudSet == null
          ? "—"
          : `${h.scudSet.toFixed(0)}° @ ${fmt(h.scudDrift, 2)} kn`;
      return `<tr><td>${t}</td>${keys.map((k) => `<td>${fmt(h.meanDiv[k])}</td>`).join("")}<td>${cur}</td><td>${scud}</td></tr>`;
    })
    .join("\n");
  const c = summary.impliedCurrent;
  const divSummary = keys
    .map(
      (k) =>
        ` · ${VARIANT_STYLE[k].label} <b style="color:${VARIANT_STYLE[k].color}">${fmt(summary.finalDiv[k])}</b> nm (max ${fmt(summary.maxDiv[k])})`,
    )
    .join("");
  const legend = [
    `<span style="color:#60a5fa">— GPS</span>`,
    ...keys.map(
      (k) =>
        `<span style="color:${VARIANT_STYLE[k].color}">${k === "cold" ? "- -" : "—"} ${escapeHtml(VARIANT_STYLE[k].label)}</span>`,
    ),
  ].join(" · ");
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>DR passage replay</title>
<style>
body{background:#0f172a;color:#e2e8f0;font-family:system-ui,sans-serif;margin:2rem;max-width:960px}
h1{font-size:1.3rem}h2{font-size:1rem;margin-top:2rem}
table{border-collapse:collapse;font-size:0.85rem;width:100%}
td,th{border:1px solid #1e3a5f;padding:3px 8px;text-align:right}
td:first-child,th:first-child{text-align:left}
code{color:#93c5fd}
</style></head><body>
<h1>Dead reckoning passage replay</h1>
<p>${escapeHtml(meta.from)} → ${escapeHtml(meta.to)} · ${escapeHtml(meta.url)} · ${samples.length} samples (10s)</p>
<p>GPS run <b>${fmt(summary.runNmGps)}</b> nm${divSummary} · mean implied current ${c.setTrue == null ? "—" : `<b>${c.setTrue.toFixed(0)}° @ ${c.driftKn.toFixed(2)} kn</b>`} (${c.sampleCount} underway samples)</p>
<p>${legend}</p>
${trackSvg}
<h2>Divergence from GPS over time</h2>
${divSvg}
<h2>Hourly</h2>
<table><tr><th>UTC</th>${keys.map((k) => `<th>mean div ${k} (nm)</th>`).join("")}<th>implied current</th><th>SCUD current</th></tr>
${tableRows}</table>
</body></html>`;
}

/**
 * CLI entry point.
 *
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
async function main(argv) {
  const opts = {
    url: "http://192.168.2.105",
    from: "2026-08-13T00:00:00Z",
    to: "2026-08-17T22:00:00Z",
    out: path.join(os.homedir(), "tmp", "dr-replay"),
    train: true,
    scud: true,
    stwScale: null,
    resolutionSec: 10,
    chunkHours: 6,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") opts.url = argv[++i];
    else if (a === "--from") opts.from = argv[++i];
    else if (a === "--to") opts.to = argv[++i];
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--resolution") opts.resolutionSec = Number(argv[++i]);
    else if (a === "--chunk-hours") opts.chunkHours = Number(argv[++i]);
    else if (a === "--no-train") opts.train = false;
    else if (a === "--no-scud") opts.scud = false;
    else if (a === "--stw-scale") opts.stwScale = Number(argv[++i]);
    else {
      console.error(
        `Usage: node tools/replay-passage.js [--url URL] [--from ISO] [--to ISO] [--out DIR] [--no-train] [--no-scud]`,
      );
      process.exitCode = 1;
      return;
    }
  }

  const rows = await fetchHistory({
    baseUrl: opts.url,
    from: opts.from,
    to: opts.to,
    resolutionSec: opts.resolutionSec,
    chunkHours: opts.chunkHours,
  });
  // Test a calibration hypothesis: scale STW as if the paddlewheel had
  // been recalibrated (applies to the DR engine, training and matrix
  // lookup alike, i.e. simulating the fixed sensor end to end).
  if (opts.stwScale != null && Number.isFinite(opts.stwScale)) {
    for (const row of rows) {
      if (typeof row.stwMs === "number") row.stwMs *= opts.stwScale;
    }
    process.stderr.write(
      `applied STW scale ${opts.stwScale} (calibration hypothesis test)\n`,
    );
  }
  process.stderr.write(`${rows.length} filled rows\n`);

  // SCUD current grid over the track box, bracketing the range by a day
  // each side so interpolation has anchors at the edges.
  let scudGrid = null;
  if (opts.scud) {
    const track = rows.map((r) => r.position).filter(Boolean);
    const lats = track.map((p) => p.latitude);
    const lons = track.map((p) => p.longitude);
    const scudFrom = new Date(Date.parse(opts.from) - 86400000).toISOString();
    const scudTo = new Date(Date.parse(opts.to) + 86400000).toISOString();
    try {
      scudGrid = await fetchScudGrid({
        from: scudFrom,
        to: scudTo,
        latMin: Math.min(...lats) - SCUD_BOX_MARGIN_DEG,
        latMax: Math.max(...lats) + SCUD_BOX_MARGIN_DEG,
        lonMin: Math.min(...lons) + 360 - SCUD_BOX_MARGIN_DEG,
        lonMax: Math.max(...lons) + 360 + SCUD_BOX_MARGIN_DEG,
      });
      process.stderr.write(
        `SCUD grid: ${scudGrid.timesMs.length} days (${scudGrid.timesMs
          .map((t) => new Date(t).toISOString().slice(0, 10))
          .join(", ")})\n`,
      );
    } catch (err) {
      process.stderr.write(
        `SCUD fetch failed, continuing without it: ${err.message}\n`,
      );
    }
  }

  const { samples, variants } = runReplay(rows, {
    train: opts.train,
    scudGrid,
  });
  const summary = summarize(samples);
  const hourly = hourlyBuckets(samples);
  const keys = variantKeys(samples);

  console.log("\nHourly divergence (DR vs GPS), nm:");
  console.log(
    `UTC                  | ${keys.map((k) => `${k.padEnd(7)}`).join(" | ")} | implied current      | SCUD current`,
  );
  for (const h of hourly) {
    const t = new Date(h.hourKey * 3600000).toISOString().slice(0, 16);
    const cur =
      h.meanSet == null
        ? "—"
        : `${h.meanSet.toFixed(0).padStart(3)}° @ ${h.meanDrift.toFixed(2)} kn`;
    const scud =
      h.scudSet == null
        ? "—"
        : `${h.scudSet.toFixed(0).padStart(3)}° @ ${h.scudDrift.toFixed(2)} kn`;
    console.log(
      `${t} | ${keys.map((k) => (h.meanDiv[k] != null ? h.meanDiv[k].toFixed(2).padEnd(7) : "—").padEnd(7)).join(" | ")} | ${cur.padEnd(21)} | ${scud}`,
    );
  }
  const c = summary.impliedCurrent;
  console.log(
    `\nSummary: GPS run ${summary.runNmGps.toFixed(1)} nm` +
      keys
        .map(
          (k) =>
            `\n  ${VARIANT_STYLE[k].label}: final ${summary.finalDiv[k]?.toFixed(2)} nm (max ${summary.maxDiv[k].toFixed(2)})`,
        )
        .join("") +
      `\nMean implied current: ${c.setTrue == null ? "—" : `${c.setTrue.toFixed(0)}° @ ${c.driftKn.toFixed(2)} kn`} over ${c.sampleCount} underway samples` +
      (opts.train
        ? `\nLearning variants: ${variants.find((v) => v.key === "learn")?.matrix.count()} bins (zero-current) / ${variants.find((v) => v.key === "scudLearn")?.matrix?.count() ?? "—"} bins (SCUD-current)`
        : ""),
  );

  fs.mkdirSync(opts.out, { recursive: true });
  fs.writeFileSync(
    path.join(opts.out, "replay.geojson"),
    JSON.stringify(toGeoJSON(samples), null, 2),
  );
  fs.writeFileSync(
    path.join(opts.out, "replay-samples.json"),
    JSON.stringify(samples),
  );
  fs.writeFileSync(
    path.join(opts.out, "replay-report.html"),
    toHtmlReport({
      meta: { from: opts.from, to: opts.to, url: opts.url },
      samples,
      summary,
      hourly,
    }),
  );
  console.log(
    `\nWrote replay-report.html, replay.geojson, replay-samples.json to ${opts.out}`,
  );
}

module.exports = {
  historyUrl,
  rowsFromResponse,
  forwardFill,
  fetchHistory,
  fetchScudGrid,
  currentAt,
  runReplay,
  hourlyBuckets,
  summarize,
  toGeoJSON,
  toHtmlReport,
  variantKeys,
  VARIANT_STYLE,
  PATH_SPECS,
};

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
