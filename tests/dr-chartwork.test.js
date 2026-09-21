/**
 * Tests for traditional chartwork position-line marking (SPEC §14.1):
 * - bearing PL → single arrowhead at the outer end
 * - astronomical PL → single arrowheads at both ends
 * - transferred (running-fix) PL → double arrowheads at both ends
 * - range CPL → arc around the navigator with single arrowheads at
 *   both arc ends (full circle fallback when no DR position)
 *
 * @file dr-chartwork.test.js
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as vm from "../public/dr-viewmodel.js";

const mapSrc = readFileSync(
  fileURLToPath(new URL("../public/dr-map-view.js", import.meta.url)),
  { encoding: "utf8" },
);

const RAD = Math.PI / 180;

/** Great-circle distance in nm (test-side, independent of the vm). */
function distNm(a, b) {
  const [φ1, λ1] = [a[0] * RAD, a[1] * RAD];
  const [φ2, λ2] = [b[0] * RAD, b[1] * RAD];
  const δ = Math.acos(
    Math.min(
      1,
      Math.max(
        -1,
        Math.sin(φ1) * Math.sin(φ2) +
          Math.cos(φ1) * Math.cos(φ2) * Math.cos(λ2 - λ1),
      ),
    ),
  );
  return δ * 3440.065;
}

const closeTo = (actual, expected, tol, msg) =>
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${msg}: ${actual} vs ${expected} (±${tol})`,
  );

test("lopArrowheads: bearing PL — one single arrowhead at the object end", () => {
  // Object bears 045° from the navigator: extendLineSpec draws the
  // ray from the charted object itself (no stub on the away side —
  // the line must stop AT the object) toward the navigator (135°
  // side). The single arrowhead sits at the object end, pointing
  // INTO the object (back along the measured bearing, 315° here) —
  // the traditional marking identifying what was sighted.
  const spec = {
    anchor: [60, 24],
    azimuthDeg: 45,
    lopType: "bearing",
  };
  const line = vm.extendLineSpec(spec, 60);
  // The ray starts exactly at the object — no 1 nm stub past it.
  closeTo(line[0][0], 60, 0.001, "ray starts at the object (lat)");
  closeTo(line[0][1], 24, 0.001, "ray starts at the object (lon)");
  const arrows = vm.lopArrowheads(line, 45, "bearing");
  assert.equal(arrows.length, 1, "single arrowhead at one end only");
  assert.equal(arrows[0].double, false, "single, not double");
  // At the object end, pointing into it (measured-bearing direction).
  closeTo(arrows[0].at[0], 60, 0.05, "arrow at the object (lat)");
  closeTo(arrows[0].at[1], 24, 0.05, "arrow at the object (lon)");
  closeTo(arrows[0].rotationDeg, 315, 2, "chevron points into the object");
});

test("lopArrowheads: celestial PL — single arrowheads at both ends", () => {
  // Body due north: symmetric east-west line, arrows at both ends
  // pointing outward (east end → 090°, west end → 270°).
  const line = vm.extendLineSpec(
    { anchor: [60, 24], azimuthDeg: 0, lopType: "celestial" },
    60,
  );
  const arrows = vm.lopArrowheads(line, 0, "celestial");
  assert.equal(arrows.length, 2, "arrowhead at both ends");
  assert.ok(
    arrows.every((a) => a.double === false),
    "both single",
  );
  const byLon = [...arrows].sort((a, b) => a.at[1] - b.at[1]);
  closeTo(byLon[0].rotationDeg, 270, 2, "west-end chevron points west");
  closeTo(byLon[1].rotationDeg, 90, 2, "east-end chevron points east");
});

test("lopArrowheads: transferred PL — double arrowheads at both ends", () => {
  const line = vm.extendLineSpec(
    { anchor: [60, 24], azimuthDeg: 0, lopType: "celestial" },
    40,
  );
  const arrows = vm.lopArrowheads(line, 0, "celestial", true);
  assert.equal(arrows.length, 2, "arrowhead at both ends");
  assert.ok(
    arrows.every((a) => a.double === true),
    "both double",
  );
});

test("lopArrowheads: degenerate line → no arrows", () => {
  assert.deepEqual(vm.lopArrowheads([[60, 24]], 0, "celestial"), []);
  assert.deepEqual(vm.lopArrowheads(null, 0, "celestial"), []);
});

test("cplArcSpec: null without a toward-position (full circle fallback)", () => {
  const cpl = { center_lat: 60, center_lon: 24, radius_nm: 10 };
  assert.equal(vm.cplArcSpec(cpl, null), null);
  assert.equal(vm.cplArcSpec(cpl, undefined), null);
});

test("cplArcSpec: arc sweeps ±45° toward the navigator, on the circle", () => {
  const cpl = { center_lat: 60, center_lon: 24, radius_nm: 10 };
  // Navigator due east of the observed object.
  const arc = vm.cplArcSpec(cpl, [60, 26]);
  assert.ok(arc, "arc produced");
  assert.ok(arc.points.length >= 9, "arc sampled densely enough");
  // Every point sits on the circle of equal distance (10 nm).
  for (const p of arc.points) {
    closeTo(distNm([60, 24], p), 10, 0.05, "point on circle");
  }
  // Ends at bearings 045° and 135° from the object.
  closeTo(vm.bearingBetween([60, 24], arc.points[0]), 45, 1, "start bearing");
  closeTo(
    vm.bearingBetween([60, 24], arc.points[arc.points.length - 1]),
    135,
    1,
    "end bearing",
  );
  // Single arrowheads at both arc ends, tangential, pointing away
  // from the arc (arc drawn clockwise: start → −90°, end → +90°).
  const [a, b] = arc.arrowheads;
  assert.equal(a.double, false);
  assert.equal(b.double, false);
  closeTo(a.rotationDeg, 315, 1, "start chevron tangent");
  closeTo(b.rotationDeg, 225, 1, "end chevron tangent");
});

test("cplArcSpec: arc stays on the navigator's side across the antimeridian", () => {
  const cpl = { center_lat: 10, center_lon: 179.9, radius_nm: 30 };
  // Navigator due east — the arc must wrap across 180° cleanly.
  const arc = vm.cplArcSpec(cpl, [10, 182]);
  assert.ok(arc, "arc produced");
  for (const p of arc.points) {
    closeTo(distNm([10, 179.9], p), 30, 0.15, "point on circle");
  }
});

test("dr-map-view: wires the traditional markings into the overlays", () => {
  // renderLops adds arrowheads from the view-model geometry.
  assert.match(
    mapSrc,
    /vm\.lopArrowheads\(line, spec\.azimuthDeg, spec\.lopType\)/,
  );
  // The transferred line in the advancement layer passes transferred=true.
  assert.match(
    mapSrc,
    /vm\.lopArrowheads\(line, spec\.azimuthDeg, lopType, true\)/,
  );
  // Range CPLs draw the traditional arc (with its arrowheads) over
  // the faded full circle.
  assert.match(
    mapSrc,
    /vm\.cplArcSpec\(cpl, drPosition \?\? this\.lastDrPosition\)/,
  );
  assert.match(
    mapSrc,
    /this\.renderArrows\(arc\.arrowheads, color, this\.layers\.cpls\)/,
  );
  // Arrowhead markers are decorative: non-interactive, keyboard-off.
  assert.match(
    mapSrc,
    /icon: this\._arrowIcon\(a\.rotationDeg, color, a\.double\)/,
  );
  assert.match(mapSrc, /keyboard: false/);
  // The divIcon drops Leaflet's default white box.
  assert.match(mapSrc, /\.dr-arrow,/);
});

test("fixSymbolType: GPS → triangle, everything else → circle", () => {
  assert.equal(vm.fixSymbolType("gps"), "triangle");
  assert.equal(vm.fixSymbolType("bearing"), "circle");
  assert.equal(vm.fixSymbolType("celestial"), "circle");
  assert.equal(vm.fixSymbolType("manual"), "circle");
  assert.equal(vm.fixSymbolType("backfill"), "circle");
  assert.equal(vm.fixSymbolType("whatever"), "circle");
});

test("dr-map-view: fixes plot as outlined triangle/circle with a dot", () => {
  const fixes = mapSrc.slice(
    mapSrc.indexOf("renderFixes(fixes, vm) {"),
    mapSrc.indexOf("renderLops(lops, vm, highlight)"),
  );
  assert.match(
    fixes,
    /icon: this\._fixIcon\(vm\.fixSymbolType\(f\.source_type\), spec\.color\)/,
  );
  const fixIcon = mapSrc.slice(
    mapSrc.indexOf("_fixIcon(shape, color) {"),
    mapSrc.indexOf("_drIcon() {"),
  );
  // Outlined shapes with a center dot, stroked in the source color.
  assert.match(fixIcon, /<polygon points="12,3\.5 21\.5,19\.5 2\.5,19\.5"/);
  assert.match(fixIcon, /<circle cx="12" cy="12" r="8\.5"/);
  assert.match(fixIcon, /<circle cx="12" cy="12" r="2" fill="\$\{color\}" \/>/);
});

test("chartwork labels: times are always Z", () => {
  // 2026-09-17T02:30:00Z → "02:30". The fix label's age test needs a
  // pinned clock (the default is the real one), so the “today” case
  // stays deterministic.
  const now = Date.UTC(2026, 8, 17, 12, 0);
  assert.equal(vm.clockTextZ(Date.UTC(2026, 8, 17, 2, 30)), "02:30");
  assert.equal(vm.fixTimeLabel("2026-09-17T02:30:00.000Z", now), "Fix 02:30Z");
  assert.equal(vm.fixTimeLabel(null, now), "");
  assert.equal(vm.fixTimeLabel("not-a-date", now), "");
  // A local-time-looking timestamp still renders as its Z value:
  // 2026-09-17T05:30+03:00 === 02:30Z.
  assert.equal(vm.fixTimeLabel("2026-09-17T05:30:00+03:00", now), "Fix 02:30Z");
  assert.equal(vm.drTimeLabel(Date.UTC(2026, 8, 17, 2, 50)), "DR 02:50Z");
  assert.equal(vm.drTimeLabel(null), "");
  assert.equal(vm.drTimeLabel(Number.NaN), "");
});

test("chartwork labels: fixes over a day old carry their date", () => {
  const now = Date.UTC(2026, 8, 21, 12, 0);
  // Exactly 24h old — still same-day rendering boundary… over it:
  assert.equal(
    vm.fixTimeLabel("2026-09-19T12:00:00.000Z", now),
    "Fix 19.9. 12:00Z",
  );
  // Two days ago, and a date-rendering case with single-digit day/month.
  assert.equal(
    vm.fixTimeLabel("2026-09-18T02:36:00.000Z", now),
    "Fix 18.9. 02:36Z",
  );
  assert.equal(
    vm.fixTimeLabel("2026-01-02T02:36:00.000Z", now),
    "Fix 2.1. 02:36Z",
  );
  // Under a day → time only.
  assert.equal(vm.fixTimeLabel("2026-09-21T02:36:00.000Z", now), "Fix 02:36Z");
  // Future timestamp (bad clock) → time only, not a bogus date.
  assert.equal(vm.fixTimeLabel("2026-09-22T02:36:00.000Z", now), "Fix 02:36Z");
});

test("courseText: traditional course-line label", () => {
  assert.equal(
    vm.courseText({ courseDeg: 290, speedKn: 6.14 }),
    "C 290° S 6.1",
  );
  assert.equal(vm.courseText({ courseDeg: 5, speedKn: 12 }), "C 005° S 12.0");
  assert.equal(
    vm.courseText({ courseDeg: 290, speedKn: undefined }),
    "C 290° S —",
  );
  assert.equal(vm.courseText(null), "");
});

test("TrackLog.recentMovement: course & speed over the trailing window", () => {
  const log = new vm.TrackLog();
  // 6 nm north in 1 h → course 000°, 6 kn.
  log.push(60, 24, Date.UTC(2026, 8, 17, 2, 0, 0));
  log.push(60.1, 24, Date.UTC(2026, 8, 17, 3, 0, 0));
  const m = log.recentMovement();
  assert.ok(m, "movement detected");
  closeTo(m.courseDeg, 0, 1, "due north");
  closeTo(m.speedKn, 6, 0.1, "6 kn");
  assert.equal(m.atMs, Date.UTC(2026, 8, 17, 3, 0, 0));

  // Stationary log → no movement → no label.
  const moored = new vm.TrackLog();
  moored.push(60, 24, 0);
  moored.push(60, 24.0, 30_000);
  assert.equal(moored.recentMovement(), null);

  // Single point → null.
  assert.equal(new vm.TrackLog().recentMovement(), null);
});

test("dr-map-view: positions carry permanent labels, track its course", () => {
  // Fixes and the DR X carry always-on time labels (always Z).
  const fixes = mapSrc.slice(
    mapSrc.indexOf("renderFixes(fixes, vm) {"),
    mapSrc.indexOf("renderLops(lops, vm, highlight)"),
  );
  assert.match(fixes, /vm\.fixTimeLabel\(f\.timestamp\)/);
  assert.match(fixes, /permanent: true/);
  assert.match(mapSrc, /vm\.drTimeLabel\(snap\.drTimeMs\)/);
  // The ghost track renders the course-line label beside the line.
  const ghost = mapSrc.slice(
    mapSrc.indexOf("renderGhostTrack(pts, movement = null) {"),
    mapSrc.indexOf("replacePolyline(key, pts, opts)"),
  );
  assert.match(ghost, /vm\.courseText\(movement\)/);
  assert.match(ghost, /className: "dr-course-label"/);
});
