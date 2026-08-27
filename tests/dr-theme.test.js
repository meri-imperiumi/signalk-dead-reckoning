/**
 * Smoketests for the shared "tactical sci-fi" UI theme (dr-theme.js +
 * styles.css). These pin the spec-mandated pieces so a refactor can't
 * silently drop the token system, the theme classes, the corner
 * brackets, or the ≥48px touch targets.
 *
 * @file dr-theme.test.js
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { THEME_CSS } from "../public/dr-theme.js";

const stylesCss = readFileSync(
  fileURLToPath(new URL("../public/styles.css", import.meta.url)),
  "utf8",
);

test("THEME_CSS exposes the five semantic theme classes", () => {
  for (const name of [
    "theme-green",
    "theme-teal",
    "theme-orange",
    "theme-red",
    "theme-offline",
  ]) {
    assert.match(THEME_CSS, new RegExp(`\\.${name}[,{ ]`), name);
  }
  // Each theme swaps both the color and its RGB triplet (for tints).
  assert.match(THEME_CSS, /--theme-color:/);
  assert.match(THEME_CSS, /--theme-color-rgb:/);
});

test("THEME_CSS panels use corner brackets and flat geometry", () => {
  assert.match(THEME_CSS, /\.sk-card::before/);
  assert.match(THEME_CSS, /\.sk-card::after/);
  assert.match(THEME_CSS, /border: 2px solid var\(--theme-color\)/);
  // Flat: every border-radius occurrence must be 0.
  const radii = THEME_CSS.match(/border-radius:\s*[^;]+;/g) ?? [];
  assert.ok(radii.length > 0, "expected at least one border-radius rule");
  for (const r of radii) assert.match(r, /border-radius:\s*0/);
  // No drop shadows anywhere.
  assert.doesNotMatch(THEME_CSS, /box-shadow/);
});

test("THEME_CSS controls respect 48px touch targets", () => {
  assert.match(THEME_CSS, /button[\s,{][^}]*min-height: 48px/s);
  assert.match(THEME_CSS, /input[\s,{][^}]*min-height: 48px/s);
});

test("THEME_CSS inputs are hardware-style: bottom rule + monospace", () => {
  assert.match(THEME_CSS, /border-bottom: 2px solid var\(--color-grey/);
  assert.match(
    THEME_CSS,
    /input:focus[^}]*border-bottom-color: var\(--theme-color\)/,
  );
  assert.match(THEME_CSS, /font-family: ui-monospace/);
});

test("styles.css declares the exact spec token palette", () => {
  const exact = {
    "--bg-base": "#080a0c",
    "--bg-panel": "#111414",
    "--bg-panel-muted": "#0a0c0c",
    "--color-green": "#6b9e78",
    "--color-teal": "#4b8b99",
    "--color-orange": "#c77b28",
    "--color-red": "#c94b4b",
    "--color-grey": "#444444",
    "--text-main": "#ffffff",
    "--text-muted": "#888899",
  };
  for (const [token, value] of Object.entries(exact)) {
    assert.match(
      stylesCss,
      new RegExp(`${token}:\\s*${value.replace("#", "#")};`),
      token,
    );
  }
  // Day/night mode hook lives on the <html> data-mode attribute.
  assert.match(stylesCss, /html\[data-mode="day"\]/);
});

test("dr-app subscribes to environment.mode and drives data-mode", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../public/dr-app.js", import.meta.url)),
    "utf8",
  );
  assert.match(src, /"environment\.mode"/);
  assert.match(src, /data-mode/);
});
