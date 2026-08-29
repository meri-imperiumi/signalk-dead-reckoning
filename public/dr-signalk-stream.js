/**
 * Signal K WebSocket stream subscription helper for the DR webapp.
 *
 * Follows the established pattern from signalk-status-tiles' st-stream.js:
 * connects to `/signalk/v1/stream?subscribe=none&sendMeta=all`, sends an
 * explicit subscribe message with `policy: "instant"` + `minPeriod: 1000`
 * (1 Hz throttle), auto-reconnects on link loss, and forwards only delta
 * frames (skipping hello/ack). Link-state transitions are reported so the
 * UI can show "link lost" immediately. A second subscribe message scoped
 * to `vessels.*` (work doc #23) feeds the AIS target layer; the Hello
 * frame's self context is captured so consumers can route own-vessel vs.
 * target deltas.
 *
 * @file dr-signalk-stream.js
 */

/** Reconnect retry interval (ms) — fixed, not backed off. */
const RETRY_MS = 5000;

class DrSignalkStream {
  constructor() {
    /** @type {WebSocket|null} */
    this.ws = null;
    /** @type {Array<string>} */
    this.paths = [
      "navigation.deadReckoning.position",
      "navigation.deadReckoning.active",
      "navigation.deadReckoning.log",
      "navigation.position",
      "navigation.magneticVariation",
    ];
    /**
     * AIS target path set (work doc #23), subscribed on the SAME socket
     * under `vessels.*` — the Signal K stream protocol scopes each
     * subscribe message to its context, so the self and AIS
     * subscriptions coexist (this is how Freeboard-SK feeds its AIS
     * layer). Empty until subscribeAis() is called.
     * @type {Array<string>}
     */
    this.aisPaths = [];
    /**
     * The server's self context from the stream Hello frame (e.g.
     * `vessels.urn:mrn:signalk:uuid:…`) — deltas arrive with their REAL
     * contexts, so consumers need this to tell own-vessel deltas from
     * AIS targets (Freeboard's isSelf does the same).
     * @type {string|null}
     */
    this.selfContext = null;
    /** @type {Set<(data: object) => void>} */
    this.listeners = new Set();
    /** @type {Set<(status: {state: string}) => void>} */
    this.statusListeners = new Set();
    /** @type {number|null} */
    this.reconnectTimer = null;
    /** @type {boolean} */
    this.closed = false;
    /** @type {number} delay before next reconnect */
    this.retryMs = RETRY_MS;
  }

  /**
   * Builds the stream URL from window.location.
   *
   * @returns {string}
   */
  url() {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${window.location.host}/signalk/v1/stream?subscribe=none&sendMeta=all`;
  }

  /**
   * Connects to the Signal K WebSocket endpoint. Auto-reconnects on
   * close unless `close()` was called.
   *
   * @returns {void}
   */
  connect() {
    if (this.closed) return;
    this.retryMs = RETRY_MS;
    this.emitStatus("connecting");
    const ws = new WebSocket(this.url());
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.emitStatus("open");
      this.sendSubscription();
    });

    ws.addEventListener("message", (ev) => {
      let data;
      try {
        data = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (data.errorMessage) {
        console.error("[dr] stream error:", data.errorMessage);
      }
      // Hello carries the server's self context — needed to route
      // deltas once a vessels.* (AIS) subscription is active.
      if (typeof data.self === "string") {
        this.selfContext = data.self;
      }
      // Forward only delta frames (hello/ack have no updates).
      if (data.updates) {
        for (const fn of this.listeners) fn(data);
      }
    });

    ws.addEventListener("close", () => {
      if (this.closed) return;
      this.emitStatus("retrying");
      this.reconnectTimer = setTimeout(() => this.connect(), this.retryMs);
    });

    ws.addEventListener("error", () => {
      // error carries no actionable detail; close() drives the reconnect.
      ws.close();
    });
  }

  /**
   * Sends the subscription for the current path set (no-op when the
   * socket isn't open). The AIS path set (work doc #23) rides the same
   * socket as a second subscribe message scoped to `vessels.*`; its
   * minPeriod is looser than the self subscription — AIS position
   * reports are 2–30 s apart (Class A) and up to 3 min (Class B), so a
   * 2 s throttle per path loses nothing while keeping busy-water
   * traffic from flooding the link.
   *
   * @returns {void}
   */
  sendSubscription() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    if (this.paths.length > 0) {
      this.ws.send(
        JSON.stringify({
          context: "vessels.self",
          subscribe: this.paths.map((path) => ({
            path,
            policy: "instant",
            minPeriod: 1000,
          })),
        }),
      );
    }
    if (this.aisPaths.length > 0) {
      this.ws.send(
        JSON.stringify({
          context: "vessels.*",
          subscribe: this.aisPaths.map((path) => ({
            path,
            policy: "instant",
            minPeriod: 2000,
          })),
        }),
      );
    }
  }

  /**
   * Sets the subscription path set and reconnects immediately so the new
   * paths take effect at once (a deliberate re-subscribe, not a failure).
   *
   * @param {Array<string>} paths
   * @returns {void}
   */
  subscribe(paths) {
    this.paths = paths;
    this.retryMs = 0;
    this.ws?.close();
  }

  /**
   * Sets the AIS target path set (work doc #23) and re-sends the
   * subscriptions on the open socket (no reconnect needed — a second
   * subscribe message is additive on the same connection).
   *
   * @param {Array<string>} paths
   * @returns {void}
   */
  subscribeAis(paths) {
    this.aisPaths = paths;
    this.sendSubscription();
  }

  /**
   * Registers a listener for stream delta updates.
   *
   * @param {(data: object) => void} fn
   * @returns {() => void} unsubscribe
   */
  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Registers a listener for link-state transitions.
   *
   * @param {(status: {state: "connecting"|"open"|"retrying"}) => void} fn
   * @returns {() => void}
   */
  onStatus(fn) {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  /**
   * @param {"connecting"|"open"|"retrying"} state
   * @returns {void}
   */
  emitStatus(state) {
    for (const fn of this.statusListeners) fn({ state });
  }

  /**
   * Connects on first page load when running in a browser.
   *
   * @returns {void}
   */
  start() {
    if (typeof window !== "undefined" && !this.ws && !this.closed) {
      this.connect();
    }
  }

  /**
   * Permanently closes the stream; no further reconnects are scheduled.
   *
   * @returns {void}
   */
  close() {
    this.closed = true;
    if (this.reconnectTimer != null) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }
}

window.drSignalkStream = new DrSignalkStream();
window.addEventListener("DOMContentLoaded", () => {
  window.drSignalkStream.start();
});
