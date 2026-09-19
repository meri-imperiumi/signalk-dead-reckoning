#!/usr/bin/env node
/**
 * Regenerates the webapp screenshot scenario (tools/
 * webapp-screenshot-harness.html) from a REAL sail in the Signal K
 * History API — real GPS track with real tacks and wander, instead of
 * synthetic straight legs.
 *
 * The DR side stays synthetic-but-plausible: the ghost re-anchors at
 * three fixes (departure manual → GPS → sun-and-bearing observation)
 * and follows the boat's real water motion (ground displacement minus
 * a 0.35 kn current setting 200°), so the divergence sawtooths from 0
 * at each fix. Charted sight targets come from OSM seamarks (Oxhornen
 * light carries the pending bearing + vertical-angle pair).
 *
 * Usage:
 *   node tools/webapp-screenshot-scenario.js \
 *     [--url http://192.168.2.105] [--from 2022-06-28T08:30:00Z] \
 *     [--to 2022-06-28T14:40:00Z] [--now-min 315]
 *
 * Rewrites the `window.__SCENARIO = …` payload inside the harness in
 * place. Then regenerate the PNGs per the harness header's usage.
 *
 * @file webapp-screenshot-scenario.js
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const URL_BASE = arg("url", "http://192.168.2.105");
const FROM = arg("from", "2022-06-28T08:30:00Z");
const TO = arg("to", "2022-06-28T14:40:00Z");
const NOW_MIN = Number(arg("now-min", "315")); // screenshot "now" (min after FROM)

const RAD = Math.PI / 180;
const dest = (lat, lon, brg, nm) => {
  const d = nm / 3440.065;
  const f1 = lat * RAD, l1 = lon * RAD, t = brg * RAD;
  const f2 = Math.asin(Math.sin(f1) * Math.cos(d) + Math.cos(f1) * Math.sin(d) * Math.cos(t));
  const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(f1), Math.cos(d) - Math.sin(f1) * Math.sin(f2));
  return [f2 / RAD, l2 / RAD];
};
const dist = (a, b) => {
  const [f1, l1] = [a[0] * RAD, a[1] * RAD], [f2, l2] = [b[0] * RAD, b[1] * RAD];
  return Math.acos(Math.min(1, Math.max(-1, Math.sin(f1) * Math.sin(f2) + Math.cos(f1) * Math.cos(f2) * Math.cos(l2 - l1)))) * 3440.065;
};
const brg = (a, b) => {
  const [f1, l1] = [a[0] * RAD, a[1] * RAD], [f2, l2] = [b[0] * RAD, b[1] * RAD];
  const y = Math.sin(l2 - l1) * Math.cos(f2);
  const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(l2 - l1);
  return (Math.atan2(y, x) / RAD + 360) % 360;
};

const SIGHT_MIN = NOW_MIN - 12; // pending sights taken 12 min before now
const FIXES_AT = [25, 135, 245]; // departure manual → GPS → observation
const CURRENT = { set: 200, drift: 0.35 };
// Real charted objects (OSM seamarks near the 2022-06-28 anchorage)
const OXHORNEN = [59.9607, 24.2741]; // named minor light — sight target
const LIGHT_W = [59.9623, 23.8503];
const LIGHT_SW = [59.9546, 23.8415];

async function main() {
  const url = `${URL_BASE}/signalk/v2/api/history/values?${new URLSearchParams({
    from: FROM, to: TO, resolution: "60", paths: "navigation.position",
  })}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`history API ${res.status} at ${URL_BASE}`);
  const sail = await res.json();

  const pts = [];
  for (const row of sail.data ?? []) {
    if (Array.isArray(row?.[1])) pts.push({ t: Date.parse(row[0]), p: [row[1][1], row[1][0]] });
  }
  if (pts.length < 60) throw new Error(`only ${pts.length} position samples — wrong day?`);
  const byMin = new Map();
  for (const p of pts) byMin.set(Math.round((p.t - pts[0].t) / 60000), p);
  const track = [];
  for (let m = 0; m <= NOW_MIN; m++) if (byMin.has(m)) track.push(byMin.get(m));

  const pos = (m) => (byMin.get(m) ?? track[track.length - 1]).p;
  const fixPos = FIXES_AT.map(pos);
  // Ghost: re-anchored at a fix, then following the boat's REAL water
  // motion (ground displacement per minute minus the current vector).
  const ghostFrom = (anchorMin, m) => {
    let p = [...pos(anchorMin)];
    for (let x = anchorMin + 1; x <= m; x++) {
      const a = pos(x - 1), b = pos(x);
      p = dest(p[0], p[1], brg(a, b), Math.max(0, dist(a, b) - CURRENT.drift / 60));
    }
    return p;
  };
  const ghost = (m) => {
    let fi = 0;
    for (let i = 0; i < FIXES_AT.length; i++) if (m >= FIXES_AT[i]) fi = i;
    return ghostFrom(FIXES_AT[fi], m);
  };
  const ghostPreSnap = (i) =>
    i === 0 ? pos(FIXES_AT[0]) : ghostFrom(FIXES_AT[i - 1], FIXES_AT[i]);

  const iso = (m) => new Date(track[0].t + m * 60000).toISOString();
  const histData = [];
  for (const { t, p } of track) {
    const m = Math.round((t - track[0].t) / 60000);
    const g = ghost(m);
    histData.push([iso(m), [p[1], p[0]], [g[1], g[0]], { distance_nm: dist(g, p), bearing_true: brg(g, p) }]);
  }
  const fixRow = (i, source, err, by) => ({
    fix_id: i + 1, timestamp: iso(FIXES_AT[i]), latitude: fixPos[i][0], longitude: fixPos[i][1],
    source_type: source, error_radius_m: err, confirmed_by: by,
  });
  const FIXES = [fixRow(0, "manual", 350, "henri"), fixRow(1, "gps", 8, null), fixRow(2, "observation", 130, "henri")];
  const CORRECTIONS = FIXES.map((f, i) => {
    const g = ghostPreSnap(i);
    return {
      fix_id: f.fix_id, timestamp: f.timestamp,
      dr_lat: g[0], dr_lon: g[1], fix_lat: f.latitude, fix_lon: f.longitude,
      deviation_nm: dist(g, [f.latitude, f.longitude]),
      deviation_bearing: brg(g, [f.latitude, f.longitude]),
    };
  });
  const now = pos(NOW_MIN);
  const sightPos = pos(SIGHT_MIN);
  const LOPS = [
    { lop_id: 11, lop_type: "bearing", assumed_lat: OXHORNEN[0], assumed_lon: OXHORNEN[1], azimuth_true: (brg(fixPos[2], OXHORNEN) + 90) % 360, intercept_nm: 0, timestamp: iso(FIXES_AT[2] - 3), body_or_object: "Oxhornen light", used_in_fix_id: 3 },
    { lop_id: 12, lop_type: "bearing", assumed_lat: LIGHT_W[0], assumed_lon: LIGHT_W[1], azimuth_true: (brg(fixPos[2], LIGHT_W) + 90) % 360, intercept_nm: 0, timestamp: iso(FIXES_AT[2] - 2), body_or_object: "W light", used_in_fix_id: 3 },
    { lop_id: 13, lop_type: "bearing", assumed_lat: OXHORNEN[0], assumed_lon: OXHORNEN[1], azimuth_true: (brg(sightPos, OXHORNEN) + 90) % 360, intercept_nm: 0, timestamp: iso(SIGHT_MIN), body_or_object: "Oxhornen light", used_in_fix_id: null },
  ];
  const CPLS = [
    { cpl_id: 21, cpl_type: "vertical-angle", center_lat: OXHORNEN[0], center_lon: OXHORNEN[1], radius_nm: dist(sightPos, OXHORNEN), timestamp: iso(SIGHT_MIN + 1), source_object: "Oxhornen light", used_in_fix_id: null },
  ];
  const gNow = ghost(NOW_MIN);
  const aisBase = (lat, lon, cog, sog, name, mmsi) => ({
    name, mmsi,
    navigation: {
      position: { value: { latitude: lat, longitude: lon }, timestamp: iso(NOW_MIN) },
      courseOverGroundTrue: { value: cog * RAD },
      speedOverGround: { value: sog / 1.944 },
    },
  });

  const scenario = {
    generatedNote: `${FROM}→${TO} from ${URL_BASE} history (real GPS); ghost/corrections synthetic (0.35 kn set 200)`,
    histData, fixes: FIXES, corrections: CORRECTIONS, lops: LOPS, cpls: CPLS,
    live: {
      gps: now, dr: gNow,
      uncertainty: { radius_m: Math.round(dist(gNow, now) * 1852 + 450), method: "dr_matrix" },
      divergence: { distance_m: Math.round(dist(gNow, now) * 1852), bearing_true: brg(gNow, now) },
      elapsedSinceFix: (NOW_MIN - FIXES_AT[2]) * 60,
      log: 46100, method: "inertial-polar",
      current: { setTrue: CURRENT.set, drift: CURRENT.drift, source: "weather" },
      pickObject: OXHORNEN,
    },
    ais: {
      "vessels.urn:mrn:imo:mmsi:230123000": aisBase(59.995, 23.96, 267, 16.5, "Baltic Queen", "230123000"),
      "vessels.urn:mrn:imo:mmsi:230999888": aisBase(59.948, 23.99, 45, 5.8, "Meriloki", "230999888"),
    },
    aisDeltas: [
      { ctx: "vessels.urn:mrn:imo:mmsi:230123000", lat: 59.995, lon: 23.96, cog: 267, sog: 16.5 },
      { ctx: "vessels.urn:mrn:imo:mmsi:230999888", lat: 59.948, lon: 23.99, cog: 45, sog: 5.8 },
    ],
    timestampNow: iso(NOW_MIN),
  };

  const harnessPath = path.join(__dirname, "webapp-screenshot-harness.html");
  const src = fs.readFileSync(harnessPath, "utf8");
  const re = /window\.__SCENARIO = \{[\s\S]*?\};/;
  if (!re.test(src)) throw new Error("window.__SCENARIO payload not found in harness");
  fs.writeFileSync(harnessPath, src.replace(re, `window.__SCENARIO = ${JSON.stringify(scenario)};`));
  console.log(
    `baked ${histData.length} history rows (${pts.length} real samples, ${track.length} kept) into ${path.relative(process.cwd(), harnessPath)}`,
  );
  console.log(
    `divergence now ${(dist(gNow, now)).toFixed(2)} nm · cpl radius ${CPLS[0].radius_nm.toFixed(1)} nm · corrections ${CORRECTIONS.map((c) => c.deviation_nm.toFixed(2)).join("/")}`,
  );
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
