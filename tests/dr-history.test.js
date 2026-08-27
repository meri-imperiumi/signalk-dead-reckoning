/**
 * Tests for the Signal K History API client helpers (dr-history.js):
 * v2 URL building, multi-path response parsing, track extraction and
 * the history→live merge used for restart survival of the map tracks.
 * @file dr-history.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const modPromise = import("../public/dr-history.js");

/** Resolves the history module (loaded once, shared by all tests). */
async function loadMod() {
  return modPromise;
}

test("historyValuesUrl: v2 base, duration, multi-path join, resolution", async () => {
  const { historyValuesUrl } = await loadMod();
  const url = historyValuesUrl({
    paths: ["navigation.position", "navigation.deadReckoning.divergence:last"],
    durationSec: 21600,
    resolutionSec: 60,
  });
  assert.ok(
    url.startsWith("/signalk/v2/api/history/values?"),
    "v2 endpoint base",
  );
  assert.ok(
    url.includes(
      "paths=navigation.position%2Cnavigation.deadReckoning.divergence%3Alast",
    ),
    "paths joined and encoded in request order",
  );
  assert.ok(url.includes("duration=21600"));
  assert.ok(url.includes("resolution=60"));
});

test("historyValuesUrl: resolution optional, duration floored at 1s", async () => {
  const { historyValuesUrl } = await loadMod();
  const url = historyValuesUrl({
    paths: ["navigation.position"],
    durationSec: 0,
  });
  assert.ok(url.includes("duration=1"));
  assert.ok(!url.includes("resolution="));
});

test("parseHistoryValues: columns follow values[] order, nulls skipped", async () => {
  const { parseHistoryValues } = await loadMod();
  const series = parseHistoryValues({
    values: [
      { path: "navigation.position", method: "first" },
      { path: "navigation.deadReckoning.divergence", method: "last" },
    ],
    data: [
      ["2026-08-27T10:00:00Z", [-159.8, -18.86], null],
      ["2026-08-27T10:01:00Z", [-159.81, -18.87], { distance_nm: 0.4 }],
      ["2026-08-27T10:02:00Z", [-159.82, -18.88], { distance_nm: 0.7 }],
    ],
  });
  assert.strictEqual(series.length, 2);
  assert.strictEqual(series[0].path, "navigation.position");
  assert.strictEqual(series[1].method, "last");
  // Null cell skipped for the divergence series.
  assert.deepStrictEqual(
    series[1].points.map((p) => p.v.distance_nm),
    [0.4, 0.7],
  );
  assert.strictEqual(series[0].points.length, 3);
});

test("parseHistoryValues: malformed bodies → empty series list", async () => {
  const { parseHistoryValues } = await loadMod();
  assert.deepStrictEqual(parseHistoryValues(null), []);
  assert.deepStrictEqual(parseHistoryValues({}), []);
  assert.deepStrictEqual(parseHistoryValues({ values: [], data: "x" }), []);
});

test("seriesToTrack: [lon,lat] → [lat,lon], dedupes near-identical fixes", async () => {
  const { seriesToTrack } = await loadMod();
  const track = seriesToTrack([
    { t: "a", v: [-159.8, -18.86] },
    { t: "b", v: [-159.81, -18.87] },
    { t: "c", v: null },
    { t: "d", v: [-159.82, -18.88] },
    { t: "e", v: [-159.82, -18.88] }, // dup → dropped
  ]);
  assert.deepStrictEqual(track, [
    [-18.86, -159.8],
    [-18.87, -159.81],
    [-18.88, -159.82],
  ]);
});

test("mergeHistoryTrack: no history → live; history → changed live appended", async () => {
  const { mergeHistoryTrack } = await loadMod();
  const history = [
    [-18.86, -159.8],
    [-18.87, -159.81],
  ];
  const live = [
    [-18.87, -159.81], // unchanged from history tail → not repeated
    [-18.88, -159.82],
    [-18.89, -159.83],
  ];
  assert.deepStrictEqual(mergeHistoryTrack([], live), live);
  assert.deepStrictEqual(mergeHistoryTrack(null, live), live);
  assert.deepStrictEqual(mergeHistoryTrack(history, live), [
    [-18.86, -159.8],
    [-18.87, -159.81],
    [-18.88, -159.82],
    [-18.89, -159.83],
  ]);
});
