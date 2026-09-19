/**
 * Smoketests for the webapp's form submission wiring: Enter and the
 * submit button must share ONE path through the app's own submit
 * flow. Found via Safari (2026-09-19): the submit buttons were
 * type="button" with click handlers, so the forms had no submit
 * button — pressing Enter fell into Safari's implicit-submission
 * constraint validation, which tripped over hidden-but-required
 * coordinate sub-fields (empty in the active position format) and
 * surfaced its own "The string did not match the expected pattern."
 * bubble without ever reaching the app's submit.
 *
 * The fix: real type="submit" buttons, novalidate on the forms
 * (the panels validate themselves via requiredMissing + the shapers,
 * with the app's own error styling), and submit-event wiring.
 *
 * @file dr-form-submit.test.js
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const read = (f) =>
  readFileSync(fileURLToPath(new URL(`../public/${f}`, import.meta.url)), {
    encoding: "utf8",
  });
const sightSrc = read("dr-sight-panel.js");
const fixSrc = read("dr-fix-panel.js");
const currentSrc = read("dr-current-panel.js");
const appSrc = read("dr-app.js");

test("sight panel: every form is novalidate with a real submit button", () => {
  for (const id of ["form-bearing", "form-vertical", "form-celestial"]) {
    assert.match(
      sightSrc,
      new RegExp(`<form class="form" id="${id}"[^>]*novalidate`),
    );
  }
  // The old type="button" pattern is gone for the three entries.
  assert.doesNotMatch(sightSrc, /type="button" class="primary"/);
});

test("sight panel: submit wired on the form submit event, not button clicks", () => {
  assert.match(
    sightSrc,
    /for \(const form of root\.querySelectorAll\("form\.form"\)\) \{[\s\S]*?addEventListener\("submit"/,
    "submit listeners on the forms",
  );
  assert.match(sightSrc, /e\.preventDefault\(\)/, "no page navigation");
  assert.match(
    sightSrc,
    /this\.submit\(form\.id\.slice\("form-"\.length\)\)/,
    "same submit() path for Enter and click",
  );
});

test("sight panel: requiredMissing replaces native validation, format-aware", () => {
  assert.match(sightSrc, /requiredMissing\(form\)/, "checked in submit()");
  assert.match(
    sightSrc,
    /if \(missing\) \{[\s\S]*?showError\(`\$\{missing\} — required`\)/,
    "missing fields explain themselves in the app's error element",
  );
  // Hidden coordinate sub-fields must not block: decimal field is
  // invisible in DM/DMS, seconds in DM, deg/min/sec/hem in decimal.
  assert.match(sightSrc, /format === "decimal" && part !== "dec"/);
  assert.match(sightSrc, /format !== "decimal" && part === "dec"/);
  assert.match(sightSrc, /format === "dm" && part === "sec"/);
});

test("sight panel: sight time is seeded when the dialog opens", () => {
  // The field is required but only self-seeded after a submit — the
  // app seeds empty inputs on open so a first sight isn't blocked.
  assert.match(
    appSrc,
    /const openSight = \(\) => \{[\s\S]*?this\.sight\?\.seedSightTime\(\)/,
  );
});

test("fix panel: Enter and click share the confirm path", () => {
  assert.match(fixSrc, /<form class="form" id="form-fix" novalidate>/);
  assert.match(fixSrc, /type="submit" class="primary" id="confirm-btn"/);
  assert.match(
    fixSrc,
    /this\.form\?\.addEventListener\("submit", \(e\) => \{[\s\S]*?this\.confirm\(\)/,
  );
});

test("current panel: Enter submits the override, not the destructive clear", () => {
  assert.match(currentSrc, /<form class="form" id="form-current" novalidate>/);
  assert.match(currentSrc, /type="submit" class="primary" id="set-btn"/);
  assert.match(
    currentSrc,
    /this\.form\?\.addEventListener\("submit", \(e\) => \{[\s\S]*?this\.setOverride\(\)/,
  );
  // Clear stays a plain button — Enter must never fire it.
  assert.match(currentSrc, /type="button" class="danger" id="clear-btn"/);
});
