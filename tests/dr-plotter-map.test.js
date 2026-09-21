/**
 * Structural smoketests for the chartplotter UX map features (work
 * doc #30): own-ship boat glyphs, predictor vectors, the nautical
 * scale bar, and range rings. Geometry lives in the pure view-model
 * (tests/dr-plotter.test.js); these pin the Leaflet adapter wiring.
 * @file dr-plotter-map.test.js
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const mapSrc = readFileSync(
  fileURLToPath(new URL("../public/dr-map-view.js", import.meta.url)),
  { encoding: "utf8" },
);
const appSrc = readFileSync(
  fileURLToPath(new URL("../public/dr-app.js", import.meta.url)),
  { encoding: "utf8" },
);

test("own-ship glyphs: boat shapes rotated to course, screen-constant", () => {
  // GPS glyph rotates to COG, falls back to a dot without one.
  const gpsIcon = mapSrc.slice(
    mapSrc.indexOf("_gpsIcon(cogDeg) {"),
    mapSrc.indexOf("_drIcon(courseDeg) {"),
  );
  assert.match(gpsIcon, /_boatIcon\(cogDeg/, "rotated boat when COG known");
  assert.match(gpsIcon, /vm\.STYLE\.gpsTrack/, "GPS family color");
  assert.match(gpsIcon, /circle cx="5" cy="5" r="4"/, "dot fallback");
  // DR glyph rotates to the DR course with the X detail.
  assert.match(
    mapSrc,
    /_boatIcon\(courseDeg, vm\.STYLE\.drMarker, \{ x: true \}\)/,
  );
  // Glyphs ride divIcons (screen-constant size), like the AIS glyphs.
  const boatIcon = mapSrc.slice(
    mapSrc.indexOf("_boatIcon(rotationDeg, color, opts = {}) {"),
    mapSrc.indexOf("_gpsIcon(cogDeg) {"),
  );
  assert.match(boatIcon, /iconSize: \[size, size\]/);
});

test("predictor vectors: separate layer, both references, tick marks", () => {
  const renderVectors = mapSrc.slice(
    mapSrc.indexOf("renderVectors(snap) {"),
    mapSrc.indexOf("renderRangeRings(snap) {"),
  );
  // GPS reference along COG/SOG, DR reference along drCourse.
  assert.match(renderVectors, /snap\.gpsCogDeg/);
  assert.match(renderVectors, /snap\.gpsSogKn/);
  assert.match(renderVectors, /snap\.drCourse\?\.courseDeg/);
  assert.match(renderVectors, /vm\.STYLE\.vector\.gps/);
  assert.match(renderVectors, /vm\.STYLE\.vector\.dr/);
  assert.match(renderVectors, /vm\.predictorVector\(/);
  assert.match(renderVectors, /dashArray: "4 4"/, "dashed line");
  assert.match(renderVectors, /v\.ticks/, "tick marks drawn");
  // The layer exists and is registered as a layers-control overlay.
  assert.match(mapSrc, /vectors: null/);
  assert.match(appSrc, /"navigation\.courseOverGroundTrue"/);
  assert.match(appSrc, /"navigation\.speedOverGround"/);
});

test("layers control: vectors and range rings are toggleable overlays", () => {
  const controlStart = mapSrc.indexOf(".layers(");
  const control = mapSrc.slice(
    controlStart,
    mapSrc.indexOf(".addTo(this.map);", controlStart),
  );
  assert.match(control, /Vectors: this\.layers\.vectors/);
  assert.match(control, /"Range rings": this\.layers\.rings/);
  // Toggleable layers start detached (unchecked) — not in the
  // always-on addTo loop.
  assert.match(mapSrc, /toggleableLayers\.has\(key\)/);
});

test("nautical scale bar: custom control, ladder from the view-model", () => {
  assert.match(mapSrc, /class NauticalScaleControl extends L\.Control/);
  assert.match(mapSrc, /vm\.scaleBarSpec\(/);
  assert.match(mapSrc, /vm\.metersPerPixel\(/);
  // Re-measures on zoom AND pan (mpp depends on latitude).
  assert.match(mapSrc, /zoomend moveend/);
});

test("range rings: GPS-centered, zoom-respaced, layer wiring", () => {
  const renderRings = mapSrc.slice(
    mapSrc.indexOf("renderRangeRings(snap) {"),
    mapSrc.indexOf("renderArrows(arrows, color, layer) {"),
  );
  assert.match(renderRings, /gpsPosition/, "centered on GPS");
  assert.match(renderRings, /vm\.rangeRingSpacingNm\(/);
  assert.match(renderRings, /this\.map\.getZoom\(\)/, "spacing from zoom");
  assert.match(renderRings, /bindTooltip\(`/, "ring ranges labeled");
  // Re-spaced after a zoom even without a fresh snapshot.
  assert.match(mapSrc, /this\.renderRangeRings\(\);/);
});

test("pick menu: DR/GPS bearing rows and CPA readouts for both references", () => {
  const menu = mapSrc.slice(
    mapSrc.indexOf("showPickMenu(latlng, containerPoint, preset = null) {"),
    mapSrc.indexOf("hidePickMenu() {"),
  );
  // Both own-ship references, per-source rows.
  assert.match(menu, /vm\.ownBearingRows\(/);
  assert.match(menu, /dr: this\._lastSnap\?\.drPosition/);
  assert.match(menu, /gps: this\._lastSnap\?\.gpsPosition/);
  // Target details (Freeboard-SK field set).
  assert.match(menu, /vm\.aisShipTypeName\(/);
  assert.match(menu, /vm\.flagForCountry\(/);
  assert.match(menu, /vm\.etaLabel\(/);
  assert.match(menu, /"Destination"/);
  // CPA/TCPA for BOTH references, labeled by source.
  assert.match(menu, /vm\.cpaTcpa\(/);
  assert.match(menu, /CPA \(\$\{source\}\)/);
  assert.match(menu, /"DR"/);
  assert.match(menu, /"GPS"/);
});

test("measure tool: pick-menu start, click legs, Esc/dblclick/right-click end", () => {
  assert.match(mapSrc, /" Measure from here…"/);
  const measure = mapSrc.slice(
    mapSrc.indexOf("startMeasure(first) {"),
    mapSrc.indexOf("/**\n   * Renders a full view-model snapshot"),
  );
  assert.match(measure, /vm\.bearingBetween\(/, "leg bearings");
  assert.match(measure, /vm\.distanceNm\(/, "leg distances");
  assert.match(measure, /Σ/, "running total");
  assert.match(measure, /Escape/, "Esc ends");
  assert.match(measure, /dblclick|_addMeasureLeg/, "double-click ends");
  // Right-click ends (measured guard before the pick menu).
  assert.match(mapSrc, /_measurePts[\s\S]{0,80}endMeasure\(\);\s+return;/);
  // Keyboard listener cleaned up on end.
  assert.match(measure, /removeEventListener\("keydown"/);
});

test("laylines: toggleable layer, DR origin, sailing-gated, zoom-relative", () => {
  const control = mapSrc.slice(
    mapSrc.indexOf(".layers("),
    mapSrc.indexOf(".addTo(this.map);", mapSrc.indexOf(".layers(")),
  );
  assert.match(control, /Laylines: this\.layers\.laylines/);
  assert.match(mapSrc, /"laylines"/, "toggleable registration");
  const render = mapSrc.slice(
    mapSrc.indexOf("renderLaylines(snap) {"),
    mapSrc.indexOf("renderRangeRings(snap) {"),
  );
  // DR vessel only — the through-water picture.
  assert.match(render, /s\?\.drPosition/);
  assert.match(render, /!s\.sailing/, "renders only when sailing");
  assert.match(render, /vm\.laylineSpec\(/);
  // Fixed screen-relative length: derived from the viewport at the
  // current zoom, re-rendered on zoomend.
  assert.match(render, /getSize\(\)/);
  assert.match(render, /metersPerPixel\(/);
  assert.match(
    mapSrc,
    /this\.renderLaylines\(\);\s*\n\s*\}\);/,
    "zoomend re-render",
  );
  // Tack colors follow the navigation-light convention.
  assert.match(mapSrc, /vm\.STYLE\.laylinePort|ray\.color/);
  // Data wiring: wind + polar angles subscribed, sailing state in snap.
  assert.match(appSrc, /"environment\.wind\.directionTrue"/);
  assert.match(appSrc, /"performance\.beatAngle"/);
  assert.match(appSrc, /"performance\.gybeAngle"/);
  assert.match(appSrc, /this\.snap\.sailing = value === "sailing"/);
});

test("contextmenu handler: AIS target lookup declared before use (regression)", () => {
  // The measure-end guard edit once dropped the declaration, leaving
  // `target` referenced but never defined — every right-click threw
  // (sea trial 2026-09-21). Pin the declaration inside the handler.
  const handler = mapSrc.slice(
    mapSrc.indexOf('this.map.on("contextmenu", (e) => {'),
    mapSrc.indexOf('this.map.on("mousemove"'),
  );
  assert.match(
    handler,
    /const target = this\._aisTargetAt\(e\.containerPoint\);/,
  );
  assert.ok(
    handler.indexOf("const target = this._aisTargetAt") <
      handler.indexOf("if (target) {"),
    "declared before the AIS branch uses it",
  );
});

test("measure tool: rubber-band preview and no leaked menu click (regression)", () => {
  const measure = mapSrc.slice(
    mapSrc.indexOf("startMeasure(first) {"),
    mapSrc.indexOf("/**\n   * Renders a full view-model snapshot"),
  );
  // The working leg follows the cursor (chartplotter convention).
  assert.match(measure, /"mousemove"/, "rubber-band mousemove handler");
  assert.match(measure, /_renderMeasure\(\[e\.latlng\.lat/);
  assert.match(measure, /this\.map\.off\("mousemove"/, "cleaned up on end");
  // The preview leg renders fainter and the readout counts it live.
  assert.match(mapSrc, /_renderMeasure\(preview = null\) \{/);
  assert.match(
    mapSrc,
    /const measured = preview \? \[\.\.\.pts, preview\] : pts;/,
  );
  // Menu buttons stop propagation — the activating click must never
  // reach Leaflet's container handler (it used to add a phantom
  // measure vertex and stray map clicks behind dialogs).
  const menu = mapSrc.slice(
    mapSrc.indexOf("showPickMenu(latlng, containerPoint, preset = null) {"),
    mapSrc.indexOf("hidePickMenu() {"),
  );
  assert.match(menu, /ev\.stopPropagation\(\);/);
});

test("measure readout: positions below the top control band (regression)", () => {
  // The overlay layer paints above the map, so a naive top: 8px put
  // the readout UNDER the GPS status panel — overlapping and
  // unreadable (sea trial 2026-09-21). dr-app measures the top band
  // and exports it; the readout consumes it.
  assert.match(mapSrc, /top: calc\(8px \+ var\(--dr-map-top-offset, 0px\)\)/);
  assert.match(appSrc, /--dr-map-top-offset/);
  assert.match(appSrc, /querySelector\("\.dr-top"\)/);
  assert.match(appSrc, /ro\.observe\(topBand\)/);
});
