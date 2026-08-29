/**
 * Smoketests for the "follow DR" recenter control relocation: the
 * "Ghost Track" heading above the map was dropped to let the map open
 * higher, and the recenter button moved off that heading into the map
 * view itself — floated over the map's bottom-left corner. The map
 * owns the control now (recenter() is its own method), so dr-app no
 * longer wires it.
 *
 * @file dr-recenter.test.js
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appSrc = readFileSync(
  fileURLToPath(new URL("../public/dr-app.js", import.meta.url)),
  { encoding: "utf8" },
);
const mapSrc = readFileSync(
  fileURLToPath(new URL("../public/dr-map-view.js", import.meta.url)),
  { encoding: "utf8" },
);

test('dr-app: the "Ghost Track" heading is gone and the map card is bare', () => {
  // The heading above the map wasted vertical space — removed so the
  // map opens higher. The map card now holds only <dr-map-view>.
  assert.doesNotMatch(appSrc, /Ghost Track/);
  assert.doesNotMatch(appSrc, /<h2>[^<]*Ghost Track/);
  assert.match(
    appSrc,
    /<section class="sk-card">\s*<dr-map-view id="dr-map"><\/dr-map-view>\s*<\/section>/,
  );
});

test("dr-app: no longer wires the recenter button — the map owns it", () => {
  assert.doesNotMatch(appSrc, /querySelector\("#dr-recenter"\)/);
  // recenter() is still reachable through the map element if needed.
  assert.doesNotMatch(appSrc, /\?\.recenter\(\)/);
});

test("dr-map-view: floats a recenter control wired to recenter()", () => {
  // The control is a floating overlay styled like the divergence chip
  // (bottom-left — the only free corner) and calls recenter() directly.
  assert.match(mapSrc, /\.dr-recenter\s*\{/);
  assert.match(mapSrc, /bottom: 8px;/);
  assert.match(mapSrc, /left: 8px;/);
  assert.match(
    mapSrc,
    /recenterBtn\.addEventListener\("click", \(\) => this\.recenter\(\)\)/,
  );
});

test("dr-map-view: the recenter button reflects the follow flag", () => {
  // Engaged = auto-follow ON. Set on click/recenter(), cleared when the
  // user drags the map (which pauses follow) — so a floating button
  // with no heading still reads its state at a glance.
  assert.match(mapSrc, /className = "dr-recenter engaged"/);
  assert.match(mapSrc, /recenter\(\) \{[\s\S]*?classList\.add\("engaged"\)/);
  assert.match(mapSrc, /dragstart[\s\S]*?classList\.remove\("engaged"\)/);
  // aria-pressed mirrors the visual state for assistive tech.
  assert.match(mapSrc, /setAttribute\("aria-pressed", "true"\)/);
  assert.match(mapSrc, /setAttribute\("aria-pressed", "false"\)/);
});
