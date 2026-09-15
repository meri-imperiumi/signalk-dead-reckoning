const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createPublishGate } = require("../plugin/publish-gate.js");

/** Call the gate `n` times with the same values, returning flush verdicts. */
function calls(gate, values, n, notableKeys) {
  return Array.from({ length: n }, () => gate.shouldFlush(values, notableKeys));
}

test("first call always flushes", () => {
  const g = createPublishGate({ everyTicks: 5 });
  assert.strictEqual(g.shouldFlush({ a: 1 }), true);
});

test("steady values flush only every Nth call", () => {
  const g = createPublishGate({ everyTicks: 3 });
  assert.deepStrictEqual(calls(g, { a: 1 }, 7), [
    true,
    false,
    false,
    true,
    false,
    false,
    true,
  ]);
});

test("continuously drifting values do not extend the interval", () => {
  // The tick's continuous figures (elapsedSinceFix, log, radius) change
  // every call — that alone must not reset the flush cadence.
  const g = createPublishGate({ everyTicks: 3 });
  const verdicts = [];
  for (let i = 0; i < 6; i++) {
    verdicts.push(g.shouldFlush({ elapsed: i, log: i * 0.1 }));
  }
  assert.deepStrictEqual(verdicts, [true, false, false, true, false, false]);
});

test("notable change flushes immediately between intervals", () => {
  const g = createPublishGate({ everyTicks: 10 });
  g.shouldFlush({ method: "inertial-paddlewheel", log: 1 }, ["method"]);
  // Continuous drift alone: quiet.
  assert.strictEqual(
    g.shouldFlush({ method: "inertial-paddlewheel", log: 2 }, ["method"]),
    false,
  );
  // The method flips (polar fallback takes over): immediate flush.
  assert.strictEqual(
    g.shouldFlush({ method: "inertial-polar", log: 3 }, ["method"]),
    true,
  );
});

test("null ↔ value transition flushes immediately", () => {
  // Consumers drop stale figures on null — that must not wait out the
  // interval (the divergence readout's contract).
  const g = createPublishGate({ everyTicks: 10 });
  g.shouldFlush({ divergence: { distance_m: 12 } });
  assert.strictEqual(g.shouldFlush({ divergence: { distance_m: 14 } }), false);
  assert.strictEqual(g.shouldFlush({ divergence: null }), true);
  assert.strictEqual(g.shouldFlush({ divergence: null }), false);
  assert.strictEqual(g.shouldFlush({ divergence: { distance_m: 1 } }), true);
});

test("a path appearing or disappearing flushes immediately", () => {
  const g = createPublishGate({ everyTicks: 10 });
  g.shouldFlush({ position: { latitude: 60 }, active: true });
  // Same key set, values drift: quiet.
  assert.strictEqual(
    g.shouldFlush({ position: { latitude: 60.001 }, active: true }),
    false,
  );
  // The STW echo drops off when the polar fallback takes over: flush.
  assert.strictEqual(g.shouldFlush({ position: { latitude: 60.002 } }), true);
  assert.strictEqual(g.shouldFlush({ position: { latitude: 60.003 } }), false);
  // A new path appearing: flush.
  assert.strictEqual(
    g.shouldFlush({ position: { latitude: 60.004 }, stw: 5 }),
    true,
  );
});

test("everyTicks=1 disables throttling", () => {
  const g = createPublishGate({ everyTicks: 1 });
  assert.deepStrictEqual(calls(g, { a: 1 }, 4), [true, true, true, true]);
});

test("everyTicks below 1 clamps to 1 (every call)", () => {
  const g = createPublishGate({ everyTicks: 0 });
  assert.deepStrictEqual(calls(g, { a: 1 }, 3), [true, true, true]);
  const h = createPublishGate({ everyTicks: -7 });
  assert.deepStrictEqual(calls(h, { a: 1 }, 3), [true, true, true]);
});

test("skipped notable-quiescent calls keep the interval anchored to the last flush", () => {
  // Regression guard: a skipped call must not record a snapshot, or
  // cadence would drift one call per skip.
  const g = createPublishGate({ everyTicks: 3 });
  const verdicts = [];
  for (let i = 0; i < 6; i++) {
    verdicts.push(g.shouldFlush({ log: i }, ["method"]));
  }
  assert.deepStrictEqual(verdicts, [true, false, false, true, false, false]);
});
