/**
 * Tests for the plotter-extension host's stream multiplexing (work
 * doc #27): the DR socket carries the app's own paths plus
 * ref-counted shared (extension) paths, reconciled with incremental
 * subscribe/unsubscribe messages while the socket is open — widgets
 * come and go without reconnect churn.
 *
 * @file dr-signalk-stream.test.js
 */

import assert from "node:assert/strict";
import test from "node:test";
import { DrSignalkStream } from "../public/dr-signalk-stream.js";

const OPEN = 1; // WebSocket.OPEN

/** Capturing fake socket. */
class FakeWebSocket {
  /** @type {Array<{type: string, fn: Function}>} */
  listeners = [];
  /** @type {Array<object>} */
  sent = [];
  readyState = 0;

  addEventListener(type, fn) {
    this.listeners.push({ type, fn });
  }

  removeEventListener() {}

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.readyState = 3;
    this.listeners
      .filter((l) => l.type === "close")
      .forEach((l) => {
        l.fn();
      });
  }

  open() {
    this.readyState = OPEN;
    this.listeners
      .filter((l) => l.type === "open")
      .forEach((l) => {
        l.fn();
      });
  }

  hello() {
    this.listeners
      .filter((l) => l.type === "message")
      .forEach((l) => {
        l.fn({
          data: JSON.stringify({ self: "vessels.urn:mrn:signalk:uuid:x" }),
        });
      });
  }
}

/**
 * Builds a stream with a fake socket, connected and helloed.
 *
 * @param {Array<string>} [basePaths]
 * @returns {{stream: DrSignalkStream, ws: FakeWebSocket}}
 */
function connected(basePaths) {
  const ws = new FakeWebSocket();
  const stream = new DrSignalkStream({ socketFactory: () => ws });
  if (basePaths) stream.paths = basePaths;
  stream.connect();
  ws.open();
  ws.hello();
  return { stream, ws };
}

test("shared paths join the self subscription on connect", () => {
  const { stream, ws } = connected(["app.one"]);
  stream.subscribeShared(["ext.one", "app.one"]);
  // The initial connect message carried only app.one; the shared refs
  // reconcile incrementally — one subscribe for the path the server
  // doesn't hold yet (app.one is deduplicated).
  const subs = ws.sent.filter((m) => m.subscribe);
  assert.equal(subs.length, 2); // initial + reconcile
  assert.deepEqual(
    subs[1].subscribe.map((s) => s.path),
    ["ext.one"],
  );
  assert.equal(stream.desiredSelfPaths().length, 2);
});

test("unsubscribe only fires when the last reference drops", () => {
  const { stream, ws } = connected(["app.one"]);
  stream.subscribeShared(["ext.path"]);
  stream.subscribeShared(["ext.path"]); // second context holds it
  const n = ws.sent.length;
  stream.unsubscribeShared(["ext.path"]); // still one holder
  assert.equal(ws.sent.length, n, "no wire traffic while held");
  stream.unsubscribeShared(["ext.path"]); // last holder gone
  const unsubs = ws.sent.filter((m) => m.unsubscribe);
  assert.equal(unsubs.length, 1);
  assert.deepEqual(unsubs[0], {
    context: "vessels.self",
    unsubscribe: [{ path: "ext.path" }],
  });
  assert.deepEqual(stream.desiredSelfPaths(), ["app.one"]);
});

test("reconcile batches add and remove into single messages", () => {
  const { stream, ws } = connected(["app.one", "app.two"]);
  stream.subscribeShared(["ext.a", "ext.b"]); // one add batch
  stream.unsubscribeShared(["ext.a", "ext.b"]); // one remove batch
  const subs = ws.sent.filter((m) => m.subscribe);
  const unsubs = ws.sent.filter((m) => m.unsubscribe);
  assert.deepEqual(
    subs.at(-1).subscribe.map((s) => s.path),
    ["ext.a", "ext.b"],
  );
  assert.deepEqual(
    unsubs.at(-1).unsubscribe.map((u) => u.path),
    ["ext.a", "ext.b"],
  );
  // The app's own paths were never in the shared layer and must stay
  // subscribed — extensions cannot steal them.
  assert.deepEqual(stream.desiredSelfPaths().sort(), ["app.one", "app.two"]);
  stream.unsubscribeShared(["app.one"]);
  assert.equal(
    ws.sent.filter((m) => m.unsubscribe).length,
    1,
    "app paths ignore unsubscribeShared",
  );
});

test("reconnect replays the full union (shared refs survive)", () => {
  const { stream, ws } = connected(["app.one"]);
  stream.subscribeShared(["ext.one"]);
  const ws2 = new FakeWebSocket();
  // Simulate reconnect by forcing a new socket from the factory.
  stream.socketFactory = () => ws2;
  stream.retryMs = 0;
  ws.close(); // triggers reconnect schedule
  return new Promise((done) => {
    setTimeout(() => {
      ws2.open();
      const subs = ws2.sent.filter((m) => m.subscribe);
      assert.deepEqual(subs[0].subscribe.map((s) => s.path).sort(), [
        "app.one",
        "ext.one",
      ]);
      stream.close();
      done();
    }, 20);
  });
});

test("closed socket: no wire traffic, union applied on next connect", () => {
  const ws = new FakeWebSocket();
  const stream = new DrSignalkStream({ socketFactory: () => ws });
  stream.paths = ["app.one"];
  stream.subscribeShared(["ext.one"]); // not open — no-op on the wire
  assert.equal(ws.sent.length, 0);
  stream.connect();
  ws.open();
  const subs = ws.sent.filter((m) => m.subscribe);
  assert.deepEqual(subs[0].subscribe.map((s) => s.path).sort(), [
    "app.one",
    "ext.one",
  ]);
});
