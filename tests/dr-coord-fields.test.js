/**
 * Tests for the shared structured coordinate entry (dr-coord-fields.js)
 * used by both the sight panel's LOP/celestial forms and the fix
 * panel's position fieldset.
 *
 * readCoordData is pure and exercised directly; the DOM builders are
 * covered by text smoketests (panels import the shared module and no
 * free-text coordinate inputs remain).
 *
 * @file dr-coord-fields.test.js
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { COORD_FIELD_CSS, readCoordData } from "../public/dr-coord-fields.js";

test("readCoordData: decimal format reads the single dec field", () => {
  const data = { fix_lat: "60.1234", fix_lon: "-24.9517" };
  assert.equal(readCoordData(data, "fix", "lat", "decimal"), 60.1234);
  assert.equal(readCoordData(data, "fix", "lon", "decimal"), -24.9517);
});

test("readCoordData: decimal format returns null when empty or invalid", () => {
  assert.equal(readCoordData({}, "fix", "lat", "decimal"), null);
  assert.equal(readCoordData({ fix_lat: "" }, "fix", "lat", "decimal"), null);
  assert.equal(
    readCoordData({ fix_lat: "abc" }, "fix", "lat", "decimal"),
    null,
  );
});

test("readCoordData: dm format assembles deg/min/hem", () => {
  const data = { fix_lat_deg: "60", fix_lat_min: "9.3", fix_lat_hem: "N" };
  assert.equal(readCoordData(data, "fix", "lat", "dm"), 60 + 9.3 / 60);
});

test("readCoordData: dms format assembles deg/min/sec/hem", () => {
  const data = {
    fix_lon_deg: "24",
    fix_lon_min: "57",
    fix_lon_sec: "6",
    fix_lon_hem: "W",
  };
  assert.equal(
    readCoordData(data, "fix", "lon", "dms"),
    -(24 + 57 / 60 + 6 / 3600),
  );
});

test("readCoordData: S/W hemispheres make degrees negative", () => {
  assert.equal(
    readCoordData({ a_lat_deg: "10", a_lat_hem: "S" }, "a", "lat", "dms"),
    -10,
  );
  assert.equal(
    readCoordData({ a_lon_deg: "10", a_lon_hem: "W" }, "a", "lon", "dm"),
    -10,
  );
});

test("readCoordData: dm/dms with blank degrees is null (optional blank)", () => {
  assert.equal(
    readCoordData({ a_lat_min: "5", a_lat_hem: "N" }, "a", "lat", "dms"),
    null,
  );
  assert.equal(readCoordData({}, "a", "lon", "dm"), null);
});

test("COORD_FIELD_CSS carries the format show/hide rules", () => {
  for (const fmt of ["decimal", "dm", "dms"]) {
    assert.match(COORD_FIELD_CSS, new RegExp(`data-pos-format="${fmt}"`));
  }
  assert.match(COORD_FIELD_CSS, /\.coord-field\.dec \{ display: flex; \}/);
});

test("both panels share the coordinate fieldset module", () => {
  const read = (f) =>
    readFileSync(fileURLToPath(new URL(`../public/${f}`, import.meta.url)), {
      encoding: "utf8",
    });
  const sight = read("dr-sight-panel.js");
  const fix = read("dr-fix-panel.js");
  for (const src of [sight, fix]) {
    assert.match(src, /dr-coord-fields\.js/);
    assert.match(src, /COORD_FIELD_CSS/);
  }
  // Fix panel: structured fieldset, no free-text coordinate inputs.
  assert.match(fix, /data-prefix="fix"/);
  assert.doesNotMatch(fix, /name="latitude"/);
  assert.doesNotMatch(fix, /name="longitude"/);
  // Sight panel: no leftover private coordinate builders.
  assert.doesNotMatch(sight, /seedCoordForced/);
  assert.doesNotMatch(sight, /buildCoordFields\(/);
});

test("seedCoord selector is well-formed (regression: missing bracket)", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../public/dr-coord-fields.js", import.meta.url)),
    { encoding: "utf8" },
  );
  // The selector template must close its attribute bracket: the
  // original dr-sight-panel seedCoord ended with `}"` (invalid
  // selector — querySelector threw on every assumed-position seed).
  const line = src.split("\n").find((l) => /\[name="\$\{prefix/.test(l));
  assert.ok(line, "selector template line not found");
  assert.match(line.trim(), /\}"\]`,$/);
});
