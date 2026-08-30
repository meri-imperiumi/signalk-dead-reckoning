/**
 * Smoketests for the passage replay tool (tools/replay-passage.js).
 *
 * The synthetic scenarios feed the replay the same shapes the real
 * History API produces (filled rows) and exercise the two variants:
 *  - no-drift: GPS track equals the water track → DR must stay on it
 *  - current: ground track offset by a known current → divergence must
 *    match the cumulative current displacement
 *  - leeway: ground track rotated +4° off the heading → the learning
 *    variant must absorb it while the cold variant walks off
 *
 * @file tests/replay-passage.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  historyUrl,
  rowsFromResponse,
  forwardFill,
  runReplay,
  summarize,
  currentAt,
  PATH_SPECS,
} = require("../tools/replay-passage.js");
const {
  destinationPoint,
  degToRad,
  knotsToMs,
  msToKnots,
} = require("../plugin/geo.js");

const STW_KN = 5;
const DT_S = 10;

/**
 * Builds synthetic filled history rows from a GPS track generator.
 *
 * @param {number} n - number of rows
 * @param {(i: number, prev: {latitude:number, longitude:number}) =>
 *   {latitude:number, longitude:number}} gpsAt - ground position per row
 * @param {object} [sensors] - constant sensor values
 * @returns {object[]} rows
 */
function syntheticRows(n, gpsAt, sensors = {}) {
  const rows = [];
  let pos = { latitude: -17.0, longitude: -152.0 };
  for (let i = 0; i < n; i++) {
    pos = gpsAt(i, pos);
    rows.push({
      tMs: Date.parse("2026-08-14T00:00:00Z") + i * DT_S * 1000,
      position: { ...pos },
      stwMs: sensors.stwMs ?? knotsToMs(STW_KN),
      headingTrueRad: sensors.headingTrueRad ?? degToRad(90),
      awaRad: sensors.awaRad ?? degToRad(90),
      awsMs: sensors.awsMs ?? knotsToMs(12),
      navState: "sailing",
      propulsionState: "stopped",
      rollRad: sensors.rollRad ?? 0,
    });
  }
  return rows;
}

test("historyUrl builds a chunked-range history values URL", () => {
  const url = historyUrl(
    "http://192.168.2.105/",
    "2026-08-14T00:00:00Z",
    "2026-08-14T01:00:00Z",
    10,
  );
  assert.equal(
    url,
    "http://192.168.2.105/signalk/v2/api/history/values" +
      "?from=2026-08-14T00%3A00%3A00Z&to=2026-08-14T01%3A00%3A00Z" +
      "&resolution=10&paths=" +
      encodeURIComponent(PATH_SPECS.join(",")),
  );
});

test("rowsFromResponse parses columns in path order and sorts by time", () => {
  const rows = rowsFromResponse({
    data: [
      [
        "2026-08-14T00:00:10.000Z",
        [-152.0, -17.0],
        2.5,
        1.6,
        1.5,
        6,
        "sailing",
        "stopped",
      ],
      [
        "2026-08-14T00:00:00.000Z",
        [-152.0001, -17.0001],
        null,
        null,
        null,
        null,
        null,
        null,
      ],
      [
        "2026-08-14T00:00:05.000Z",
        [-152.00005, -17.00005],
        2.4,
        1.55,
        1.4,
        5,
        null,
        null,
      ],
    ],
  });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].tMs, Date.parse("2026-08-14T00:00:00.000Z"));
  assert.deepEqual(rows[0].position, {
    latitude: -17.0001,
    longitude: -152.0001,
  });
  assert.equal(rows[1].position.latitude, -17.00005);
  assert.equal(rows[2].stwMs, 2.5);
  assert.equal(rows[2].headingTrueRad, 1.6);
});

test("forwardFill holds last values, drops positionless rows, unwraps AWA", () => {
  const t0 = Date.parse("2026-08-14T00:00:00Z");
  const rows = rowsFromResponse({
    data: [
      [
        new Date(t0).toISOString(),
        [-152.0, -17.0],
        2.5,
        1.6,
        1.5,
        6,
        "sailing",
        null,
        0.05,
      ],
      [
        new Date(t0 + 10000).toISOString(),
        [-152.001, -17.0],
        null,
        null,
        null,
        null,
        null,
        null,
      ],
      // Row without a position is dropped entirely.
      [
        new Date(t0 + 20000).toISOString(),
        null,
        2.6,
        1.7,
        null,
        null,
        null,
        null,
      ],
      [
        new Date(t0 + 30000).toISOString(),
        [-152.002, -17.0],
        2.7,
        1.8,
        1.45,
        5,
        null,
        null,
      ],
    ],
  });
  const filled = forwardFill(rows);
  assert.equal(filled.length, 3);
  assert.equal(filled[1].stwMs, 2.5); // held
  assert.equal(filled[1].navState, "sailing"); // held
  assert.equal(filled[1].rollRad, 0.05); // held
  assert.equal(filled[2].awaRad, 1.45);
  assert.equal(filled[2].navState, "sailing"); // held across the gap
  assert.equal(filled[2].propulsionState, null); // never seen, stays null

  // AWA wrap: +3.10 rad then -3.10 rad (a flip through ±π) must read
  // as continuity, not a 6.2 rad jump.
  const wrapped = forwardFill(
    rowsFromResponse({
      data: [
        [
          new Date(t0).toISOString(),
          [-152.0, -17.0],
          2.5,
          1.6,
          3.1,
          6,
          "sailing",
          "stopped",
        ],
        [
          new Date(t0 + 10000).toISOString(),
          [-152.001, -17.0],
          2.5,
          1.6,
          -3.1,
          6,
          null,
          null,
        ],
      ],
    }),
  );
  assert.ok(
    Math.abs(wrapped[1].awaUnwrappedRad - (3.1 + (2 * Math.PI - 6.2))) < 1e-9,
  );
});

test("currentAt interpolates SCUD grids in time and space", () => {
  const t0 = Date.parse("2026-08-14T00:00:00Z");
  const day = 86400000;
  const grid = {
    timesMs: [t0, t0 + 2 * day], // a one-day hole in between
    lats: [-18, -17.75],
    lons: [206, 206.25],
    u: [
      [
        [0.1, 0.1],
        [0.2, 0.2],
      ],
      [
        [0.3, 0.3],
        [0.4, 0.4],
      ],
    ],
    v: [
      [
        [0, 0],
        [0, 0],
      ],
      [
        [0, 0],
        [0, 0],
      ],
    ],
  };

  // Start of the range: first day's value.
  const a = currentAt(grid, t0, -18.1, -154.0); // lon -154 → 206 E
  assert.ok(Math.abs(a.drift - msToKnots(0.1)) < 1e-9, `drift ${a.drift}`);
  assert.equal(a.setTrue, 90); // due east (u>0, v=0)

  // Midway through the hole: u interpolated between 0.1 and 0.3 → 0.2
  const m = currentAt(grid, t0 + day, -18.1, -154.0);
  assert.ok(Math.abs(m.drift - 0.2 * 1.943844) < 1e-3, `drift ${m.drift}`);
  assert.equal(m.setTrue, 90);

  // After the last day: nearest end held.
  const z = currentAt(grid, t0 + 5 * day, -17.8, -153.9);
  assert.ok(Math.abs(z.drift - 0.4 * 1.943844) < 1e-3, `drift ${z.drift}`);

  // Nearest-cell spatial lookup: -17.7 is nearer -17.75 than -18.
  const s = currentAt(grid, t0, -17.7, -154.0);
  assert.ok(Math.abs(s.drift - 0.2 * 1.943844) < 1e-3, `drift ${s.drift}`);
});

test("no-drift synthetic: DR follows the GPS track exactly", () => {
  const rows = syntheticRows(360, (_i, prev) =>
    destinationPoint(prev, 90, (STW_KN * DT_S) / 3600),
  );
  const { samples } = runReplay(rows, { train: false });
  const last = samples[samples.length - 1];
  assert.ok(last.cold.divNm < 0.01, `div ${last.cold.divNm}`);
  assert.equal(samples.length, 359);
});

test("known-current synthetic: divergence matches the current displacement", () => {
  const rows = syntheticRows(360, (_i, prev) =>
    destinationPoint(
      destinationPoint(prev, 90, (STW_KN * DT_S) / 3600),
      180,
      (1 * DT_S) / 3600, // 1 kn of southerly set
    ),
  );
  const { samples } = runReplay(rows, { train: false });
  const last = samples[samples.length - 1];
  // After one hour: DR sits on the water track, GPS is 1 nm south of it.
  assert.ok(Math.abs(last.cold.divNm - 1) < 0.05, `div ${last.cold.divNm}`);
  const summary = summarize(samples);
  assert.ok(summary.impliedCurrent.driftKn > 0.9);
  assert.ok(summary.impliedCurrent.driftKn < 1.1);
  assert.ok(
    Math.abs(summary.impliedCurrent.setTrue - 180) < 5,
    `set ${summary.impliedCurrent.setTrue}`,
  );
});

test("leeway synthetic: the learning variant absorbs a 4° course offset", () => {
  // Ground track runs heading + 4° (as if a steady leeway angle went
  // uncorrected): the cold variant walks off cross-track, the learning
  // variant must lock onto the ground track within minutes. A constant
  // 10° heel rides along so the roll → heelDeg → bin path is exercised.
  const rows = syntheticRows(
    720,
    (_i, prev) => destinationPoint(prev, 94, (STW_KN * DT_S) / 3600),
    { rollRad: degToRad(10) },
  );
  const { samples } = runReplay(rows, { train: true });
  const last = samples[samples.length - 1];
  const expectedCrossTrack = STW_KN * Math.sin((4 * Math.PI) / 180); // nm per hour × 2h
  assert.ok(
    last.cold.divNm > expectedCrossTrack * 1.5,
    `cold div ${last.cold.divNm}`,
  );
  assert.ok(
    last.learn.divNm < expectedCrossTrack * 0.2,
    `learn div ${last.learn.divNm}`,
  );
});
