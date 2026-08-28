/**
 * Pure render-model for the plotter-extension status widget
 * (`public/dr-ext-model.js`) — severity mapping, figure formatting.
 * Loads the browser ESM module directly.
 *
 * @file dr-ext-model.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const modelPromise = import("../public/dr-ext-model.js");

/** Resolves the widget model module (loaded once, shared by all tests). */
async function loadModel() {
  return modelPromise;
}

const M = 1852; // metres per NM

test("fmtNm formats SI metres as nautical miles, absent → em dash", async () => {
  const { fmtNm } = await loadModel();
  assert.equal(fmtNm(M), "1.00 nm");
  assert.equal(fmtNm(0), "0.00 nm");
  assert.equal(fmtNm(null), "—");
  assert.equal(fmtNm(Number.NaN), "—");
});

test("widgetModel maps DR state to severity, mirroring the webapp status line", async () => {
  const { widgetModel } = await loadModel();
  assert.equal(widgetModel({ state: null }).severity, "muted");
  assert.equal(widgetModel().statusWord, "NO DR");

  // Underway and healthy: green.
  assert.equal(widgetModel({ state: { status: "underway" } }).severity, "ok");

  // Tack/gybe in progress: orange, not a fault.
  const maneuver = widgetModel({
    state: { status: "underway", transient: true },
  });
  assert.equal(maneuver.severity, "warn");
  assert.equal(maneuver.statusWord, "MANEUVER");

  // Fouled paddlewheel while integrating: red.
  assert.equal(
    widgetModel({ state: { status: "underway", fouled: true } }).severity,
    "alert",
  );

  // Idle on a moored boat: paused, orange word.
  const idle = widgetModel({ state: { status: "idle" } });
  assert.equal(idle.severity, "warn");
  assert.equal(idle.statusWord, "IDLE");

  // Idle while making way — the dangerous case: red.
  const stale = widgetModel({ state: { status: "idle", moving: true } });
  assert.equal(stale.severity, "alert");
  assert.equal(stale.statusWord, "STALE");

  // Warm (moored, integrating): muted; fouled still alerts.
  assert.equal(widgetModel({ state: { status: "warm" } }).severity, "muted");
  assert.equal(
    widgetModel({ state: { status: "warm", fouled: true } }).severity,
    "alert",
  );
});

test("widgetModel formats figures from the scalar sibling paths", async () => {
  const { widgetModel } = await loadModel();
  const m = widgetModel({
    state: { status: "underway" },
    method: "inertial-paddlewheel",
    active: false,
    divergenceDistance: 777.8, // 0.42 nm
    uncertaintyRadius: 574.1, // 0.31 nm
    elapsedSinceFix: 754, // 12m 34s
  });
  assert.equal(m.divergence, "0.42 nm");
  assert.equal(m.uncertainty, "± 0.31 nm");
  assert.equal(m.method, "STW");
  assert.equal(m.sinceFix, "12m");
  assert.equal(m.override, false);

  // Null divergence (suppressed at anchor / no GPS) and absent uncertainty.
  const sparse = widgetModel({
    state: { status: "underway" },
    divergenceDistance: null,
  });
  assert.equal(sparse.divergence, "—");
  assert.equal(sparse.uncertainty, "—");
});

test("widgetModel flags OVERRIDE engagement", async () => {
  const { widgetModel } = await loadModel();
  assert.equal(widgetModel({ active: true }).override, true);
});
