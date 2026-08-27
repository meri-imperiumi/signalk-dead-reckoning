/**
 * Tests for the header set/drift readout and manual override: the pure
 * vm.currentFigure shaping plus smoketests for the dr-app wiring and
 * the <dr-current-panel> component. REST behavior is covered in
 * plugin.test.js; resolveCurrent precedence in current.test.js.
 *
 * @file dr-current.test.js
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as vm from "../public/dr-viewmodel.js";

const NOW = Date.parse("2026-08-30T12:00:00.000Z");

test("currentFigure: manual source shows TTL and orange theme", () => {
  const f = vm.currentFigure(
    { setTrue: 67.4, drift: 1.24, source: "manual" },
    { validUntilMs: NOW + 12.5 * 60_000 },
    NOW,
  );
  assert.equal(f.value, "067° · 1.2 kn");
  assert.equal(f.label, "Current · manual (13m)");
  assert.equal(f.theme, "theme-orange");
});

test("currentFigure: weather and pilot-chart sources are teal", () => {
  for (const source of ["weather-api", "pilot-chart"]) {
    const f = vm.currentFigure({ setTrue: 45, drift: 0.5, source }, null, NOW);
    assert.equal(f.theme, "theme-teal", source);
  }
  const f = vm.currentFigure(
    { setTrue: 45, drift: 0.5, source: "weather-api" },
    null,
    NOW,
  );
  assert.equal(f.label, "Current · weather");
});

test("currentFigure: none (zero vector) is offline-themed; null vector is blank", () => {
  const none = vm.currentFigure({ setTrue: 0, drift: 0, source: "none" });
  assert.equal(none.value, "000° · 0.0 kn");
  assert.equal(none.label, "Current · none");
  assert.equal(none.theme, "theme-offline");

  const blank = vm.currentFigure(null);
  assert.equal(blank.value, "—");
  assert.equal(blank.theme, null);
});

test("currentFigure: expired manual TTL counts down to 0m", () => {
  const f = vm.currentFigure(
    { setTrue: 10, drift: 0.4, source: "manual" },
    { validUntilMs: NOW - 1000 },
    NOW,
  );
  assert.equal(f.label, "Current · manual (0m)");
});

test("dr-app: header figure, button, dialog and stream subscription wired", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../public/dr-app.js", import.meta.url)),
    { encoding: "utf8" },
  );
  assert.match(src, /id="dr-current-fig"/);
  assert.match(src, /id="dr-current"/);
  assert.match(src, /id="btn-current"/);
  assert.match(src, /dr-current-panel/);
  assert.match(src, /"environment\.current"/);
  assert.match(src, /renderCurrent\(\)/);
  // Changes from the panel re-read /status (works while idle too).
  assert.match(src, /dr-current-changed/);
  assert.match(src, /fetchStatus\(\)/);
});

test("dr-current-panel: PUT/DELETE wiring and close behavior", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../public/dr-current-panel.js", import.meta.url)),
    { encoding: "utf8" },
  );
  assert.match(src, /\/current\/manual/);
  assert.match(src, /method: "PUT"/);
  assert.match(src, /method: "DELETE"/);
  assert.match(src, /dr-current-changed/);
  assert.match(src, /dr-close/);
});
