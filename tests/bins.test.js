/**
 * Tests for bin quantization (SPEC §4.1).
 * @file bins.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  quantize,
  quantizeStw,
  quantizeAwa,
  quantizeHeel,
  STW_BIN_WIDTH,
  AWA_BIN_WIDTH,
  HEEL_BIN_WIDTH,
} = require("../plugin/bins.js");

test("quantize rounds to nearest bin width", () => {
  assert.strictEqual(quantize(0.2, 0.5), 0);
  assert.strictEqual(quantize(0.3, 0.5), 0.5);
  assert.strictEqual(quantize(0.7, 0.5), 0.5);
  assert.strictEqual(quantize(1.2, 0.5), 1);
});

test("quantize rejects non-positive width", () => {
  assert.throws(() => quantize(1, 0), RangeError);
  assert.throws(() => quantize(1, -1), RangeError);
});

test("quantizeStw rounds to nearest 0.5kt", () => {
  assert.strictEqual(quantizeStw(5.2), 5);
  assert.strictEqual(quantizeStw(5.3), 5.5);
  assert.strictEqual(quantizeStw(0), 0);
  assert.strictEqual(STW_BIN_WIDTH, 0.5);
});

test("quantizeAwa keeps sign for tack distinction, rounds to 5deg", () => {
  assert.strictEqual(quantizeAwa(42), 40);
  assert.strictEqual(quantizeAwa(43), 45);
  // Negative AWA (port tack) keeps its sign — opposite tacks never
  // share a bin, since their learned leeway signs are opposite.
  assert.strictEqual(quantizeAwa(-42), -40);
  assert.strictEqual(quantizeAwa(-43), -45);
  // Inputs beyond ±180 wrap, not clamp: 190° apparent is 170° port.
  assert.strictEqual(quantizeAwa(190), -170);
  assert.strictEqual(quantizeAwa(-190), 170);
  assert.strictEqual(AWA_BIN_WIDTH, 5);
});

test("quantizeAwa separates tacks at light-air heel (regression)", () => {
  // Both tacks at sub-bin heel share heel_bin 0 (=== : -0 and 0 are the
  // same SQLite key); only the AWA sign keeps their bins — and their
  // opposite-sign leeway — apart.
  const stbd = quantizeAwa(32);
  const port = quantizeAwa(-32);
  assert.ok(quantizeHeel(0.4) === 0 && quantizeHeel(-0.4) === 0);
  assert.notStrictEqual(stbd, port);
  assert.strictEqual(stbd, 30);
  assert.strictEqual(port, -30);
});

test("quantizeHeel preserves sign for tack distinction", () => {
  assert.strictEqual(quantizeHeel(10), 10);
  assert.strictEqual(quantizeHeel(-10), -10);
  assert.strictEqual(quantizeHeel(11), 12);
  assert.strictEqual(quantizeHeel(12), 12);
  assert.strictEqual(HEEL_BIN_WIDTH, 2);
});
