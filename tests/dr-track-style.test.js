/**
 * Smoketests for DR track prominence on the chart (SPEC §14.1): the
 * ghost track is the plugin's primary output, so it must render as the
 * dominant track — heavier than GPS over a dark casing line. The
 * weight/casing constants live in the pure view-model (STYLE.track);
 * dr-map-view only adapts them to Leaflet.
 *
 * @file dr-track-style.test.js
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const vmPromise = import("../public/dr-viewmodel.js");

const mapSrc = readFileSync(
  fileURLToPath(new URL("../public/dr-map-view.js", import.meta.url)),
  { encoding: "utf8" },
);

test("STYLE.track: DR draws heavier than GPS, over a casing", async () => {
  const vm = await vmPromise;
  const t = vm.STYLE.track;
  assert.ok(
    t.ghostWeight > t.gpsWeight,
    `ghost weight ${t.ghostWeight} must outweigh GPS ${t.gpsWeight}`,
  );
  assert.ok(t.casingWidth > 0, "casing adds width around the track");
  assert.match(
    t.casingColor,
    /^#[0-9a-f]{6}$/i,
    "casing color is a hex literal",
  );
});

test("dr-map-view: casing polyline renders below the heavier ghost track", () => {
  // The dark casing polyline must be added to the ghost layer BEFORE
  // the teal line (SVG insertion order = z-order) so it renders under.
  // Scope to the method body: the DR marker's teal ring also references
  // STYLE.ghostTrack earlier in the file.
  const ghostMethod = mapSrc.slice(
    mapSrc.indexOf("renderGhostTrack(pts, movement = null) {"),
    mapSrc.indexOf("replacePolyline(key, pts, opts)"),
  );
  const casingAt = ghostMethod.indexOf("t.casingColor");
  const trackAt = ghostMethod.indexOf("vm.STYLE.ghostTrack");
  assert.ok(casingAt > -1, "casing color used in the map view");
  assert.ok(trackAt > -1, "ghost track color used in the map view");
  assert.ok(casingAt < trackAt, "casing drawn below the track");
  // Track weights come from the view-model, not ad-hoc pixel values.
  assert.match(ghostMethod, /weight: t\.ghostWeight/);
  assert.match(ghostMethod, /weight: t\.ghostWeight \+ t\.casingWidth/);
  assert.match(mapSrc, /weight: vm\.STYLE\.track\.gpsWeight/);
  // Casing, track, and the course-line label marker are all
  // non-interactive: chart picks and the context menu must keep
  // working on and near the (now wider) track band.
  assert.equal(
    (ghostMethod.match(/interactive: false/g) ?? []).length,
    3,
    "casing, track, and course label all non-interactive",
  );
});

test("dr-map-view: DR marker is the navigator's X, in marker white", () => {
  // Traditional chartwork: a dead reckoned position plots as an X,
  // deliberately NOT a fix symbol. The X stays in the marker white
  // for contrast over the teal track it rides.
  assert.match(mapSrc, /_drIcon\(\)/);
  const drIcon = mapSrc.slice(
    mapSrc.indexOf("_drIcon() {"),
    mapSrc.indexOf("renderArrows(arrows, color, layer)"),
  );
  assert.match(drIcon, /M2 2 L12 12 M12 2 L2 12/, "crossed-strokes X glyph");
  assert.match(drIcon, /vm\.STYLE\.drMarker/, "white from the view-model");
});
