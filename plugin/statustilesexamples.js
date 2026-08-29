/**
 * Status Tiles example-set provider (work doc #22).
 *
 * Ships a ready-made Status Tiles set so a boat owner running
 * signalk-dead-reckoning can copy the DR position tile into their
 * panel with one tap — no JSON editing, no hand-authoring predicates.
 * The set is pure config (no code, no assets); it is discovered by
 * the Status Tiles webapp through the standard resources API as a
 * read-only `statusTileExamples` provider
 * (signalk-status-tiles/doc/sharing-example-tile-sets.md).
 *
 * Idempotency contract (the sharing doc's checklist): a restart
 * within the same plugin instance — the server calls `stop()` then
 * `start()` on a config save — must not double-register. The
 * registration is therefore held at module scope, keyed by the
 * server `app` + plugin id: the first `start()` registers one
 * provider whose methods close over a shared `running` flag; a later
 * `start()` reuses it and flips `running` back on; `stop()` flips it
 * off so the provider lists `{}` (a disabled plugin contributes no
 * stale sets). The server has no unregister, so the registration
 * itself is reused rather than torn down — mirroring signalk-status-
 * tiles' own `registerExamplesProvider`.
 *
 * @file statustilesexamples.js
 */

const { readFileSync } = require("node:fs");
const { join } = require("node:path");

/** The example sets, loaded once at require time (pure config). */
const EXAMPLES = JSON.parse(
  readFileSync(join(__dirname, "..", "status-tiles-examples.json"), "utf8"),
);

/**
 * Per-app registration state, so a re-start reuses the one provider
 * instead of stacking a second. WeakMap so an app garbage-collected
 * (server teardown) takes its entry with it.
 * @type {WeakMap<object, Map<string, {running: boolean, registered: boolean, declined: boolean}>>}
 */
const states = new WeakMap();

/**
 * Registers the read-only `statusTileExamples` resource provider,
 * idempotently per plugin instance. Returns a teardown that flips
 * `running` off (the registration stays for reuse; the server has no
 * unregister).
 *
 * @param {import("@signalk/server-api").ServerAPI} app - Signal K server API
 * @param {{id: string}} opts - plugin id (the resource key under which
 *   the webapp labels this set's source)
 * @returns {() => void} teardown — empties the provider's listing
 */
function registerStatusTileExamples(app, opts) {
  const { id } = opts;

  if (!states.has(app)) states.set(app, new Map());
  const perApp = states.get(app);
  let state = perApp.get(id);
  if (!state) {
    state = { running: true, registered: false, declined: false };
    perApp.set(id, state);
  } else {
    // Re-start: reuse the existing registration, flip back on.
    state.running = true;
  }

  if (!state.registered) {
    if (typeof app.registerResourceProvider !== "function") {
      if (!state.declined) {
        app.error(
          `${id}: server has no resource provider registry; status-tiles examples disabled`,
        );
        state.declined = true;
      }
    } else {
      app.registerResourceProvider({
        type: "statusTileExamples",
        methods: {
          listResources: async () => (state.running ? { [id]: EXAMPLES } : {}),
          getResource: async (resourceId) => {
            if (!state.running || resourceId !== id) {
              throw new Error(
                `No such statusTileExamples resource: ${resourceId}`,
              );
            }
            return EXAMPLES;
          },
          setResource: async () => {
            throw new Error(`${id} is a read-only provider`);
          },
          deleteResource: async () => {
            throw new Error(`${id} is a read-only provider`);
          },
        },
      });
      state.registered = true;
    }
  }

  return () => {
    state.running = false;
  };
}

module.exports = {
  registerStatusTileExamples,
  EXAMPLES,
};
