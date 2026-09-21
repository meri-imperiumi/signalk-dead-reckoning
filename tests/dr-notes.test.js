/**
 * Tests for Signal K notes on the chart (work doc #30): collection
 * shaping (position-less entries skipped), resource building, safe
 * body rendering per mimeType, and the map/app wiring smoketests.
 * @file dr-notes.test.js
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const vmPromise = import("../public/dr-viewmodel.js");

async function loadVm() {
  return vmPromise;
}

const mapSrc = readFileSync(
  fileURLToPath(new URL("../public/dr-map-view.js", import.meta.url)),
  { encoding: "utf8" },
);
const appSrc = readFileSync(
  fileURLToPath(new URL("../public/dr-app.js", import.meta.url)),
  { encoding: "utf8" },
);
const panelSrc = readFileSync(
  fileURLToPath(new URL("../public/dr-note-panel.js", import.meta.url)),
  { encoding: "utf8" },
);

test("notesRenderSpecs: positioned notes shape, position-less skipped", async () => {
  const vm = await loadVm();
  const specs = vm.notesRenderSpecs({
    "urn:sk:note-1": {
      title: "Rocks",
      body: "Shoal patch",
      position: { latitude: 60.1, longitude: 24.2 },
    },
    "urn:sk:note-2": {
      title: "Region-only",
      body: "No point",
      region: "urn:sk:region-9",
    },
    "urn:sk:note-3": { title: "Half", position: { latitude: 60.3 } },
    notAnObject: null,
  });
  assert.equal(specs.length, 1);
  assert.equal(specs[0].id, "urn:sk:note-1");
  assert.deepEqual(specs[0].position, [60.1, 24.2]);
  assert.equal(specs[0].title, "Rocks");
  assert.deepEqual(vm.notesRenderSpecs(null), []);
  // Untitled notes don't crash the chart label.
  const untitled = vm.notesRenderSpecs({
    x: { position: { latitude: 1, longitude: 2 } },
  });
  assert.equal(untitled[0].title, "Note");
});

test("noteResourceFromForm: trims title, defaults, position object", async () => {
  const vm = await loadVm();
  const r = vm.noteResourceFromForm({
    title: "  Hazard  ",
    body: "Rocks at low water",
    position: [60.1, 24.2],
  });
  assert.deepEqual(r, {
    title: "Hazard",
    body: "Rocks at low water",
    position: { latitude: 60.1, longitude: 24.2 },
  });
  const bare = vm.noteResourceFromForm({
    title: "",
    body: "",
    position: [1, 2],
  });
  assert.equal(bare.title, "Note", "empty title falls back");
  const md = vm.noteResourceFromForm({
    title: "T",
    body: "b",
    mimeType: "text/markdown",
    position: [1, 2],
  });
  assert.equal(md.mimeType, "text/markdown");
});

test("renderNoteBody: plain text renders pre-wrap, escaped", async () => {
  const vm = await loadVm();
  const html = vm.renderNoteBody("Line one\n<b>not html</b>  spaced", null);
  assert.match(html, /<p class="dr-note-plain">/);
  assert.match(html, /&lt;b&gt;not html&lt;\/b&gt;/, "input is escaped");
  assert.match(html, /Line one\n/);
});

test("renderNoteBody: markdown gets minimal structure, still escaped", async () => {
  const vm = await loadVm();
  const html = vm.renderNoteBody(
    "# Heading\nSome **bold** and *ital* and `code`.\n- item one\n- item two\n<script>alert(1)</script>",
    "text/markdown",
  );
  assert.match(html, /<strong>Heading<\/strong>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>ital<\/em>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<ul>/, "list wrapped");
  assert.match(html, /<li>item one<\/li>/);
  assert.match(html, /&lt;script&gt;/, "script text never renders as HTML");
  assert.doesNotMatch(html, /<script>/);
  // Links render but are forced safe.
  const link = vm.renderNoteBody(
    "See [chart](https://example.com) thanks",
    "text/markdown",
  );
  assert.match(
    link,
    /<a href="https:\/\/example\.com" target="_blank" rel="noopener">chart<\/a>/,
  );
});

test("notes wiring: v2 resources API, layers-control toggle, pick menu integration", () => {
  // Layer toggle.
  assert.match(mapSrc, /Notes: this\.layers\.notes/);
  assert.match(mapSrc, /"notes"/);
  // Markers + detail surface.
  assert.match(mapSrc, /renderNotes\(specs, resourcesById\) \{/);
  assert.match(mapSrc, /_noteIcon\(\)/);
  assert.match(mapSrc, /vm\.renderNoteBody\(/);
  assert.match(mapSrc, /"dr-note-new"/);
  assert.match(mapSrc, /"dr-note-edit"/);
  assert.match(mapSrc, /"dr-note-delete"/);
  // App REST wiring: v2 resources API, POST/PUT/DELETE, refetch on reconnect.
  assert.match(appSrc, /\/signalk\/v2\/api\/resources\/notes/);
  assert.match(appSrc, /method: id \? "PUT" : "POST"/);
  assert.match(appSrc, /method: "DELETE"/);
  assert.match(
    appSrc,
    /renderLinkStatus\(status\) \{[\s\S]*this\.fetchNotes\(\);/,
  );
  // Panel: quick hazard preset, error surfacing, save dispatch.
  assert.match(panelSrc, /dr-note-hazard/);
  assert.match(panelSrc, /showError\(message\)/);
  assert.match(panelSrc, /vm\.noteResourceFromForm\(/);
  assert.match(panelSrc, /No position/);
});
