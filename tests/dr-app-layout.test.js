/**
 * Smoketests for the plotter layout (work doc #26): the chart fills
 * the viewport and the DR controls float over it as translucent
 * overlays. Corner assignment: top-left = bearings & fixes (plus the
 * pending box when it has rows), top-right = GPS status & override,
 * bottom-right = water-track readout, bottom-left = map controls.
 * These pin the structural pieces so a refactor can't silently
 * regress to the old card-stack page, swallow the chart behind
 * pointer-hungry overlay containers, or drift off the corner map.
 *
 * @file dr-app-layout.test.js
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { THEME_CSS } from "../public/dr-theme.js";

const read = (f) =>
  readFileSync(fileURLToPath(new URL(`../public/${f}`, import.meta.url)), {
    encoding: "utf8",
  });
const appSrc = read("dr-app.js");
const mapSrc = read("dr-map-view.js");

const section = (cls) =>
  appSrc.match(
    new RegExp(
      `<section class="[^"]*\\b${cls}\\b[^"]*">[\\s\\S]*?<\\/section>`,
    ),
  );

test("dr-app: the host is the viewport — no page scroll", () => {
  const host = appSrc.match(/:host \{[^}]+\}/);
  assert.ok(host, ":host rule exists");
  assert.match(host[0], /height: 100dvh/, "host fills the dynamic viewport");
  assert.match(host[0], /height: 100vh/, "pre-dvh fallback declared");
  assert.match(host[0], /overflow: hidden/, "no page scroll");
  // The old card-stack sizing must be gone from the app template.
  assert.doesNotMatch(appSrc, /padding: 1rem/, "no document padding");
});

test("dr-app: the map fills the viewport, controls float above it", () => {
  // Map: absolute, edge-to-edge, below the overlay layer.
  assert.match(appSrc, /#dr-map \{[^}]*position: absolute/s);
  assert.match(appSrc, /#dr-map \{[^}]*inset: 0/s);
  // Overlay layer: pointer-transparent, z-above the map — the chart
  // stays draggable in every gap between the floating panels.
  assert.match(appSrc, /\.dr-overlay \{[^}]*pointer-events: none/s);
  assert.match(appSrc, /\.dr-overlay \{[^}]*z-index: 1100/s);
  // …with the panels themselves re-enabled.
  assert.match(
    appSrc,
    /\.dr-tools,\s*\.dr-gps,\s*\.dr-readout,\s*\.dr-drawer \{[^}]*pointer-events: auto/s,
    "all four floating panels re-enable pointer events",
  );
  // The map is no longer wrapped in a scrolling card stack.
  assert.doesNotMatch(
    appSrc,
    /<section class="sk-card">\s*<dr-map-view/,
    "no card-wrapped map",
  );
});

test("dr-app: corners — top-left entry tools (bearings & fixes)", () => {
  const tools = section("dr-tools");
  assert.ok(tools, "dr-tools panel exists");
  assert.match(tools[0], /id="btn-sight"/, "sight/LOP entry in top-left");
  assert.match(
    tools[0],
    /id="btn-coord-fix"/,
    "fix-at-coordinates entry in top-left",
  );
  assert.doesNotMatch(
    tools[0],
    /id="btn-current"/,
    "current entry lives with its figure, not here",
  );
  assert.doesNotMatch(
    tools[0],
    /dr-override/,
    "failover is not in the tools panel",
  );
});

test("dr-app: corners — top-right GPS status & override", () => {
  const gps = section("dr-gps");
  assert.ok(gps, "dr-gps panel exists");
  assert.match(
    gps[0],
    /id="dr-status-panel"/,
    "engine status badge in top-right",
  );
  // SPEC §14.1: the override is prominent, always human-initiated —
  // its own panel, never buried in a menu or the collapsible drawer.
  assert.match(gps[0], /id="dr-override-btn"/, "override button in top-right");
  assert.match(
    gps[0],
    /id="dr-override-state"/,
    "override state label in top-right",
  );
  const drawer = appSrc.match(
    /<aside[\s\S]*?id="dr-pending-drawer"[\s\S]*?<\/aside>/,
  );
  assert.ok(drawer, "pending drawer exists");
  assert.doesNotMatch(
    drawer[0],
    /dr-override/,
    "override not buried in the drawer",
  );
});

test("dr-app: corners — bottom-right water-track readout", () => {
  const readout = section("dr-readout");
  assert.ok(readout, "dr-readout panel exists");
  for (const id of [
    "dr-log",
    "dr-elapsed",
    "dr-divergence",
    "dr-current",
    "dr-method",
  ]) {
    assert.match(
      readout[0],
      new RegExp(`id="${id}"`),
      `${id} figure in readout`,
    );
  }
  // Trend sparkline rides beside the divergence figure (SPEC §14.1) —
  // ported from the map's old bottom-right chip.
  assert.match(
    readout[0],
    /<canvas id="dr-spark"/,
    "sparkline canvas in divergence figure",
  );
  assert.match(
    appSrc,
    /renderSparkline\(\)/,
    "sparkline drawing lives in dr-app",
  );
  // Manual current entry sits next to the set/drift figure it edits.
  assert.match(
    readout[0],
    /id="btn-current"/,
    "current entry beside its figure",
  );
  // Readout is docked bottom-right; status badge no longer lives here.
  assert.match(appSrc, /\.dr-bottom \{[^}]*justify-content: flex-end/s);
  assert.doesNotMatch(
    readout[0],
    /dr-status-panel/,
    "status badge moved to the GPS panel",
  );
});

test("dr-app: pending box only appears when there are observations", () => {
  assert.match(appSrc, /id="dr-pending-drawer"/, "drawer aside exists");
  assert.match(
    appSrc,
    /id="btn-pending"[^>]*aria-expanded="false"[^>]*aria-controls="dr-pending-drawer"[^>]*hidden/,
    "toggle carries aria wiring and starts hidden",
  );
  // Visibility driven by the row count after each refresh.
  assert.match(appSrc, /async refreshPending\(\)/);
  assert.match(
    appSrc,
    /rows\?\.length \?\? 0\)/,
    "visibility keyed on pending row count",
  );
  assert.match(
    appSrc,
    /this\.drawerToggle\?\.toggleAttribute\("hidden", !has\)/,
    "toggle hidden while the list is empty",
  );
  assert.match(
    appSrc,
    /this\.drawer\?\.toggleAttribute\("hidden", !has\)/,
    "drawer hidden while the list is empty",
  );
  assert.match(appSrc, /id="btn-pending-close"/, "in-drawer close button");
  // Hidden state is the mechanism (display: none rule + toggleAttribute).
  assert.match(appSrc, /\.dr-drawer\[hidden\] \{ display: none; \}/);
  assert.match(appSrc, /toggleAttribute\("hidden", !this\.drawerOpen\)/);
  // First row arriving opens the drawer on wide screens only.
  assert.match(
    appSrc,
    /if \(has && !this\._hadPending\) \{[\s\S]*?matchMedia\("\(max-width: 600px\)"\)/,
  );
  // Drawer docks left, under the entry tools.
  assert.match(appSrc, /\.dr-pane \{[^}]*justify-content: flex-start/s);
});

test("dr-app: phones collapse to full-width bands", () => {
  const media = appSrc.match(/@media \(max-width: 600px\) \{[\s\S]*?\n {4}\}/);
  assert.ok(media, "phone media query exists");
  assert.match(
    media[0],
    /#dr-log-fig,\s*#dr-method-fig \{[^}]*display: none/s,
    "non-critical figures hidden",
  );
  assert.match(media[0], /flex-direction: column/, "top row stacks");
  assert.match(media[0], /max-height: 50vh/, "drawer docks as a bottom sheet");
  assert.match(
    media[0],
    /\.dr-bottom \{[^}]*justify-content: stretch/s,
    "readout band full-width",
  );
});

test("dr-map-view: host fills its parent instead of computing viewport height", () => {
  const host = mapSrc.match(/:host \{[^}]+\}/);
  assert.ok(host, ":host rule exists");
  assert.match(host[0], /height: 100%/, "fills the host app's box");
  assert.doesNotMatch(host[0], /50vh/, "old scroll-page sizing gone");
  assert.doesNotMatch(host[0], /100vh - 260px/);
});

test("dr-map-view: Leaflet controls relocated to the bottom-left stack", () => {
  // Top corners + bottom-right belong to the floating overlays — zoom
  // and the chart layers control stack above the re-center button at
  // bottom-left, the only corner the map still owns.
  assert.match(mapSrc, /zoomControl: false/, "default top-left zoom disabled");
  assert.match(mapSrc, /L\.control\.zoom\(\{ position: "bottomleft" \}\)/);
  assert.match(
    mapSrc,
    /\{ collapsed: true, position: "bottomleft" \}/,
    "layers control bottom-left",
  );
  // The control container must clear the (non-Leaflet) re-center
  // button it now shares the corner with.
  assert.match(
    mapSrc,
    /\.leaflet-bottom\.leaflet-left \{[^}]*margin-bottom: calc\(64px/s,
  );
});

test("dr-map-view: the divergence chip is gone — readout owns that corner", () => {
  assert.doesNotMatch(mapSrc, /dr-chip/, "chip element and CSS removed");
  assert.doesNotMatch(mapSrc, /renderDivergence/, "chip rendering removed");
});

test("dr-app: phone fit — map controls ride above the bottom bands", () => {
  // On phones the full-width readout band (and the open pending
  // sheet) own the bottom edge; dr-app measures them and exports the
  // offset to the map as a custom property (it pierces the shadow
  // boundary). Desktop keeps 0 — the panels are corner-docked there.
  assert.match(appSrc, /--dr-map-bottom-offset/);
  assert.match(appSrc, /new ResizeObserver\(syncMapOffset\)/);
  // The drawer open/close flip is a display:none toggle — re-sync
  // explicitly so the stack never sits behind the sheet.
  assert.match(appSrc, /this\._syncMapOffset\?\.\(\)/);
});

test("dr-map-view: control stack consumes the offset; phones pinch-zoom", () => {
  assert.match(
    mapSrc,
    /margin-bottom: calc\(64px \+ var\(--dr-map-bottom-offset, 0px\)\)/,
    "zoom/layers stack rides above the bottom bands",
  );
  assert.match(
    mapSrc,
    /\.dr-recenter \{[^}]*bottom: calc\(8px \+ var\(--dr-map-bottom-offset, 0px\)\)/s,
    "re-center rides above the bottom bands",
  );
  // Touch devices pinch-zoom — the button stack would poke into the
  // top control bands when the pending sheet is open.
  assert.match(
    mapSrc,
    /@media \(max-width: 600px\) \{\s*\.leaflet-control-zoom \{ display: none; \}/,
    "zoom bar hidden on phones",
  );
});

test("dr-theme: floating overlay panels are translucent but themed", () => {
  assert.match(THEME_CSS, /\.sk-floating[,{ ]/, ".sk-floating exists");
  const floating = THEME_CSS.match(/\.sk-floating \{[\s\S]*?\}/);
  assert.ok(floating);
  assert.match(
    floating[0],
    /color-mix\(in srgb, var\(--bg-panel[^;]*transparent\)/,
    "translucent background via color-mix",
  );
  // Solid fallback first so non-color-mix browsers stay opaque, not blank.
  assert.ok(
    floating[0].indexOf("color-mix") > floating[0].indexOf("var(--bg-panel"),
    "solid background precedes the color-mix line",
  );
  // Same flat geometry + mounting brackets as sk-card.
  assert.match(THEME_CSS, /\.sk-floating::before/, "brackets preserved");
  assert.match(THEME_CSS, /\.sk-floating::after/);
  const radii = THEME_CSS.match(/border-radius:\s*[^;]+;/g) ?? [];
  for (const r of radii) assert.match(r, /border-radius:\s*0/);
  assert.doesNotMatch(THEME_CSS, /box-shadow/, "still no drop shadows");
});

test("dr-theme: focus outlines are solid, not dashed", () => {
  const focus = THEME_CSS.match(/:focus-visible \{[^}]*\}/);
  assert.ok(focus, ":focus-visible rule exists");
  assert.match(focus[0], /outline: 1px solid/);
  assert.doesNotMatch(focus[0], /dashed/);
});
