/**
 * Tests for the Signal K History API client helpers (dr-history.js):
 * v2 URL building, multi-path response parsing, track extraction and
 * the history→live merge used for restart survival of the map tracks.
 * @file dr-history.test.js
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

test("seriesToTrack: {latitude, longitude} object cells (DR positions from the history provider)", async () => {
  const { seriesToTrack } = await loadMod();
  // The history provider emits plugin-published positions (the DR
  // ghost) as {latitude, longitude} objects, not GeoJSON pairs
  // (verified against the live API) — the old array-only parse
  // silently dropped them, so the DR track backfill never rendered.
  const track = seriesToTrack([
    { t: "a", v: { latitude: -18.86, longitude: -159.8 } },
    { t: "b", v: { latitude: -18.87, longitude: -159.81 } },
    { t: "c", v: null },
    { t: "d", v: { latitude: -18.87, longitude: -159.81 } }, // dup → dropped
    { t: "e", v: { latitude: null, longitude: -159.9 } }, // missing lat → dropped
  ]);
  assert.deepStrictEqual(track, [
    [-18.86, -159.8],
    [-18.87, -159.81],
  ]);
});

test("chartWindow: 7-day floor, extended to trip start when the trip is older", async () => {
  const { chartWindow } = await loadMod();
  const now = Date.parse("2026-09-20T12:00:00Z");
  const day = 24 * 3600 * 1000;
  // No trip boundary observed → plain 7-day window.
  let w = chartWindow(now, null);
  assert.strictEqual(w.sinceMs, now - 7 * day);
  assert.strictEqual(w.durationSec, 7 * 24 * 3600);
  // Trip started 2 days ago → the window is still 7 days (the max).
  w = chartWindow(now, now - 2 * day);
  assert.strictEqual(w.sinceMs, now - 7 * day);
  // Trip started 10 days ago → the window extends to the trip start.
  w = chartWindow(now, now - 10 * day);
  assert.strictEqual(w.sinceMs, now - 10 * day);
  assert.strictEqual(w.durationSec, 10 * 24 * 3600);
  // A boundary in the future (bad clock / bad data) is ignored.
  w = chartWindow(now, now + day);
  assert.strictEqual(w.sinceMs, now - 7 * day);
});

test("dr-app wires the history window into its fetches (source smoketest)", async () => {
  const src = readFileSync(
    fileURLToPath(new URL("../public/dr-app.js", import.meta.url)),
    { encoding: "utf8" },
  );
  // Tracks: window duration, 10-minute resolution.
  assert.ok(
    src.includes("chartWindow(Date.now(), this.tripStartMs)"),
    "track history fetch uses the chart window",
  );
  assert.ok(src.includes("resolutionSec: 600"), "10-minute history resolution");
  // Overlays: the window start goes out as `since` (ISO-8601) on
  // every overlay endpoint.
  for (const ep of ["fixes", "observations", "corrections"]) {
    assert.ok(
      src.includes(`/${ep}?limit=`) && src.includes("&since=${" + "since}"),
      `/${ep} carries the window since param`,
    );
  }
  // The trip boundary from /status drives re-fetches on change.
  assert.ok(src.includes("body.tripStartMs"), "/status tripStartMs consumed");
});
