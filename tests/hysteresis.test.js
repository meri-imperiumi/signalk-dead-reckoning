/**
 * Tests for the generic flag hysteresis (sensor-health alert debouncing).
 * @file hysteresis.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { createFlagState, flagTick } = require("../plugin/hysteresis.js");

test("flagTick: raw condition must persist sustainS before raising", () => {
  const st = createFlagState();
  const opts = { sustainS: 10, clearS: 10 };
  // 9 seconds of raw true — not yet.
  for (let i = 0; i < 9; i++) {
    assert.strictEqual(flagTick(st, true, 1, opts).transition, null);
    assert.strictEqual(st.active, false);
  }
  // 10th second — raises.
  const out = flagTick(st, true, 1, opts);
  assert.strictEqual(out.transition, "raise");
  assert.strictEqual(out.active, true);
});

test("flagTick: condition must stay false clearS before clearing", () => {
  const st = createFlagState();
  const opts = { sustainS: 1, clearS: 3 };
  assert.strictEqual(flagTick(st, true, 1, opts).transition, "raise");
  // 2 seconds of raw false — still active.
  assert.strictEqual(flagTick(st, false, 1, opts).transition, null);
  assert.strictEqual(st.active, true);
  assert.strictEqual(flagTick(st, false, 1, opts).transition, null);
  // 3rd second — clears.
  const out = flagTick(st, false, 1, opts);
  assert.strictEqual(out.transition, "clear");
  assert.strictEqual(out.active, false);
});

test("flagTick: a jittery tick neither raises nor clears (no flapping)", () => {
  const st = createFlagState();
  const opts = { sustainS: 3, clearS: 3 };
  // Raise first.
  for (let i = 0; i < 3; i++) flagTick(st, true, 1, opts);
  assert.strictEqual(st.active, true);
  // Alternating raw true/false around a threshold: timers reset each
  // side, so no clear transition ever fires and no re-raise flaps.
  for (let i = 0; i < 20; i++) {
    const out = flagTick(st, i % 2 === 0, 1, opts);
    assert.strictEqual(out.transition, null);
  }
  assert.strictEqual(st.active, true);
});

test("flagTick: sub-second ticks accumulate fractionally", () => {
  const st = createFlagState();
  const opts = { sustainS: 0.3, clearS: 0.3 };
  const a = flagTick(st, true, 0.1, opts);
  const b = flagTick(st, true, 0.1, opts);
  assert.strictEqual(a.transition, null);
  assert.strictEqual(b.transition, null);
  assert.strictEqual(flagTick(st, true, 0.1, opts).transition, "raise");
});
