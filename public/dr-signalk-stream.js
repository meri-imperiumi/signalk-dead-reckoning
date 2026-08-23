/**
 * Signal K WebSocket stream subscription helper for the DR webapp.
 *
 * Opens a subscription to the dead-reckoning delta paths and forwards
 * updates to any registered listeners. v1 stub: connects but the app shell
 * renders from REST polling for now.
 *
 * @file dr-signalk-stream.js
 */

class DrSignalkStream {
  constructor() {
    /** @type {WebSocket|null} */
    this.ws = null;
    /** @type {Set<(data: object) => void>} */
    this.listeners = new Set();
  }

  /**
   * Connects to the Signal K WebSocket endpoint.
   *
   * @param {string} [url]
   * @returns {void}
   */
  connect(url) {
    const wsUrl =
      url ||
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/signalk/v1/stream`;
    this.ws = new WebSocket(wsUrl);
    this.ws.onopen = () => {
      this.ws?.send(
        JSON.stringify({
          context: "vessels.self",
          subscribe: [
            { path: "navigation.deadReckoning.position", policy: "instant" },
            { path: "navigation.deadReckoning.active", policy: "instant" },
            { path: "navigation.deadReckoning.log", policy: "instant" },
          ],
        }),
      );
    };
    this.ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        for (const fn of this.listeners) fn(data);
      } catch {
        // Ignore non-JSON frames (heartbeats etc.)
      }
    };
  }

  /**
   * Registers a listener for stream updates.
   *
   * @param {(data: object) => void} fn
   * @returns {() => void} unsubscribe
   */
  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Closes the stream.
   *
   * @returns {void}
   */
  close() {
    this.ws?.close();
    this.ws = null;
  }
}

window.drSignalkStream = new DrSignalkStream();
