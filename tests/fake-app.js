/**
 * Shared test fakes: a mock Signal K app and Express-style router matching
 * the patterns used by the history-sqlite / energy-predictor test suites.
 *
 * @file fake-app.js
 */

const { EventEmitter } = require("node:events");

/**
 * Minimal Signal K app fake with subscriptionmanager + handleMessage +
 * setPluginStatus + getDataDirPath. The data path is set per-test to a
 * temp directory.
 */
class FakeSignalKApp extends EventEmitter {
  constructor() {
    super();
    this.selfId = "urn:mrn:imo:mmsi:123456789";
    this.subscriptionmanager = {
      subscriptions: [],
      subscribe(subscription, unsubscribes, onError, onDelta) {
        this.subscriptions.push({ subscription, onDelta });
        unsubscribes.push(() => {
          const idx = this.subscriptions.findIndex(
            (s) => s.subscription === subscription,
          );
          if (idx >= 0) this.subscriptions.splice(idx, 1);
        });
      },
    };
    this.dataPath = null;
    this.statusMessages = [];
    this.handledMessages = [];
    this.errors = [];
  }

  getDataDirPath() {
    return this.dataPath;
  }

  setPluginStatus(msg) {
    this.statusMessages.push(msg);
  }

  setProviderStatus(msg) {
    this.statusMessages.push(msg);
  }

  handleMessage(source, message) {
    this.handledMessages.push({ source, message });
  }

  debug() {}

  error(msg) {
    this.errors.push(msg);
  }

  /**
   * Emits a delta into the subscriptionmanager's registered handlers, for
   * tests that want to feed sensor values.
   *
   * @param {object} delta
   * @returns {void}
   */
  emitDelta(delta) {
    for (const { onDelta } of this.subscriptionmanager.subscriptions) {
      onDelta(delta);
    }
  }
}

/**
 * Minimal Express-style router fake that records routes and can dispatch.
 */
class FakeRouter {
  constructor() {
    this.routes = [];
  }

  _add(method, path, handler) {
    this.routes.push({ method, path, handler });
  }

  get(path, handler) {
    this._add("get", path, handler);
  }
  post(path, handler) {
    this._add("post", path, handler);
  }
  put(path, handler) {
    this._add("put", path, handler);
  }

  /**
   * Finds a registered route and invokes it with stub req/res.
   *
   * @param {string} method
   * @param {string} path
   * @param {object} [reqBody]
   * @returns {{status: number, body: unknown}}
   */
  invoke(method, path, reqBody) {
    const route = this.routes.find(
      (r) => r.method === method && r.path === path,
    );
    if (!route) throw new Error(`no ${method.toUpperCase()} ${path} route`);
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
      },
    };
    route.handler({ body: reqBody }, res);
    return { status: res.statusCode, body: res.body };
  }
}

module.exports = { FakeSignalKApp, FakeRouter };
