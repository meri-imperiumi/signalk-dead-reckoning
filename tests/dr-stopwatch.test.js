/**
 * Tests for the stopwatch sight-time entry ("N min N sec ago"): the
 * pure vm.stopwatchToIso conversion plus smoketests for the sight
 * panel wiring (mode select, offset fields, entry-time conversion,
 * re-hide after submit).
 *
 * @file dr-stopwatch.test.js
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as vm from "../public/dr-viewmodel.js";

const NOW = new Date("2026-08-30T12:00:00.000Z");

test("stopwatchToIso: minutes + seconds before now", () => {
  assert.equal(vm.stopwatchToIso(4, 32, NOW), "2026-08-30T11:55:28.000Z");
});

test("stopwatchToIso: only minutes / only seconds / both blank", () => {
  assert.equal(vm.stopwatchToIso(5, "", NOW), "2026-08-30T11:55:00.000Z");
  assert.equal(vm.stopwatchToIso("", 30, NOW), "2026-08-30T11:59:30.000Z");
  assert.equal(vm.stopwatchToIso("", "", NOW), "2026-08-30T12:00:00.000Z");
});

test("stopwatchToIso: string values, fractional seconds", () => {
  assert.equal(vm.stopwatchToIso("4", "32", NOW), "2026-08-30T11:55:28.000Z");
  assert.equal(vm.stopwatchToIso(0, 0.5, NOW), "2026-08-30T11:59:59.500Z");
});

test("stopwatchToIso: negative offsets are clamped to now", () => {
  assert.equal(vm.stopwatchToIso(-5, -30, NOW), "2026-08-30T12:00:00.000Z");
});

test("stopwatchToIso: minutes may exceed an hour and cross date lines", () => {
  // 13h 20m ago → previous day
  assert.equal(vm.stopwatchToIso(800, 0, NOW), "2026-08-29T22:40:00.000Z");
});

test("sight panel: all three forms carry the stopwatch entry", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../public/dr-sight-panel.js", import.meta.url)),
    { encoding: "utf8" },
  );
  for (const field of [
    '<select name="sight_time_mode">',
    '<input name="sight_ago_min"',
    '<input name="sight_ago_sec"',
  ]) {
    const count = src.split(field).length - 1;
    assert.equal(
      count,
      3,
      `${field} should appear once per form (bearing/vertical/celestial)`,
    );
  }
});

test("sight panel: conversion happens on entry and re-hides after submit", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../public/dr-sight-panel.js", import.meta.url)),
    { encoding: "utf8" },
  );
  // Conversion wired to the input event (per keystroke/commit — at
  // entry, not submit), writes into sight_time, marks it dirty.
  assert.match(src, /addEventListener\("input", convert\)/);
  assert.match(src, /vm\.stopwatchToIso\(minInput\.value, secInput\.value\)/);
  assert.match(src, /timeInput\.dataset\.dirty = "true"/);
  // Both offset fields drive the conversion.
  assert.match(src, /minInput\.addEventListener\("input", convert\)/);
  assert.match(src, /secInput\.addEventListener\("input", convert\)/);
  // form.reset() restores "clock" — the row is re-hidden on submit.
  assert.match(src, /querySelectorAll\("\.sight-ago"\)\) row\.hidden = true/);
});
