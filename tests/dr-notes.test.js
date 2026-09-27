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

test("parseLayerPrefs: malformed storage data falls back per key", async () => {
  const vm = await loadVm();
  assert.deepEqual(vm.parseLayerPrefs(null), { base: null, overlays: {} });
  assert.deepEqual(vm.parseLayerPrefs(""), { base: null, overlays: {} });
  assert.deepEqual(vm.parseLayerPrefs("not json"), {
    base: null,
    overlays: {},
  });
  assert.deepEqual(vm.parseLayerPrefs("42"), { base: null, overlays: {} });
  // Wrong-typed entries dropped individually, valid ones kept.
  assert.deepEqual(
    vm.parseLayerPrefs(
      JSON.stringify({
        base: "__chart_mirror__",
        overlays: { notes: true, ais: "yes", rings: 1, vectors: false },
      }),
    ),
    { base: "__chart_mirror__", overlays: { notes: true, vectors: false } },
  );
  assert.deepEqual(vm.parseLayerPrefs(JSON.stringify({ base: 7 })), {
    base: null,
    overlays: {},
  });
});

test("layer prefs: remembered base + overlay toggles across sessions", () => {
  // Storage key follows the dr-* convention; reads and writes are
  // guarded (localStorage can throw in private modes).
  assert.match(mapSrc, /LAYERS_KEY\(\) \{[\s\S]*?return "dr-layers";/);
  assert.match(mapSrc, /_loadLayerPrefs\(\) \{/);
  assert.match(mapSrc, /_saveLayerPrefs\(prefs\) \{/);
  // Restore: parsed prefs select the base (only when still mounted)
  // and apply per-overlay toggles without disturbing un-flipped keys.
  assert.match(mapSrc, /vm\.parseLayerPrefs\(this\._loadLayerPrefs\(\)\)/);
  assert.match(
    mapSrc,
    /this\.tileLayers\[prefs\.base \?\? ""\] \?\? defaultBase/,
  );
  assert.match(mapSrc, /prefs\.overlays\[key\];/);
  assert.match(mapSrc, /if \(want === undefined\) continue;/);
  // Persist on the layers-control's own events — base picks and
  // overlay add/remove both land in storage.
  assert.match(mapSrc, /this\.map\.on\("baselayerchange"/);
  assert.match(mapSrc, /this\.map\.on\("overlayadd overlayremove"/);
  assert.match(mapSrc, /this\._saveLayerPrefs\(prefs\)/);
});

test("notesViewQuery: Freeboard wire format position=[lon,lat]&distance=m", async () => {
  const vm = await loadVm();
  // A Tonga-area view: position is the view center in [lon, lat]
  // (GeoJSON) order, distance a whole-meter covering radius from the
  // center to the view corner — the request Freeboard-SK sends.
  const view = { west: -175.4, south: -21.4, east: -174.9, north: -20.9 };
  const expectedM = Math.ceil(
    vm.distanceNm([-20.9, -175.4], [-21.15, -175.15]) * 1852,
  );
  assert.equal(
    vm.notesViewQuery(view),
    `position=[-175.15,-21.15]&distance=${expectedM}`,
  );
  // Low-zoom Leaflet views report out-of-range edges; center and
  // corner clamp so the query stays in the valid lat/lon range.
  const wideM = Math.ceil(vm.distanceNm([-90, -180], [0, 0]) * 1852);
  assert.equal(
    vm.notesViewQuery({ west: -260, south: -95, east: 260, north: 95 }),
    `position=[0,0]&distance=${wideM}`,
  );
});

test("notesRefetchNeeded: first fetch, margin containment, pan/zoom out", async () => {
  const vm = await loadVm();
  const view = { west: 24, south: 60, east: 25, north: 60.5 };
  assert.equal(vm.notesRefetchNeeded(view, null), true, "nothing fetched yet");
  // Inside the fetched area (or its 25% margin) — no refetch.
  assert.equal(vm.notesRefetchNeeded(view, view), false);
  assert.equal(
    vm.notesRefetchNeeded(
      { west: 24.2, south: 60.5 - 0.125 - 0.01, east: 24.8, north: 60.5 },
      view,
    ),
    false,
    "slight pan stays within the margin",
  );
  // Panning into unseen water, or zooming out past the fetched area.
  assert.equal(
    vm.notesRefetchNeeded({ ...view, east: 25.5 }, view),
    true,
    "pan past the margin",
  );
  assert.equal(
    vm.notesRefetchNeeded({ west: 10, south: 59, east: 40, north: 62 }, view),
    true,
    "zoomed-out view exceeds the fetched area",
  );
});

test("notes wiring: v2 resources API, layers-control toggle, pick menu integration", () => {
  // Layer toggle.
  assert.match(mapSrc, /notes: \["Notes", this\.layers\.notes\]/);
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
  // Viewport-aware fetching: the map reports view changes, dr-app
  // re-fetches the visible area with Freeboard's position+distance
  // query and merges the result into the cache (providers answer the
  // bare collection query with a provider-shaped area — wider views
  // must fetch for themselves).
  assert.match(mapSrc, /dr-view-changed/);
  assert.match(mapSrc, /getBounds\(\)/);
  assert.match(appSrc, /addEventListener\("dr-view-changed"/);
  assert.match(appSrc, /notesViewQuery\(/);
  assert.match(appSrc, /notesRefetchNeeded\(/);
  assert.match(appSrc, /this\.notesById\.set\(id, note\)/);
  // Panel: quick hazard preset, error surfacing, save dispatch.
  assert.match(panelSrc, /dr-note-hazard/);
  assert.match(panelSrc, /showError\(message\)/);
  assert.match(panelSrc, /vm\.noteResourceFromForm\(/);
  assert.match(panelSrc, /No position/);
});
