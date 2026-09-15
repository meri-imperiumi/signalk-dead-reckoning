/**
 * Publish throttling for the DR tick's bus output.
 *
 * The integration loop runs every `tickIntervalMs` (default 1 s), but a
 * Signal K server pays for every published delta in fanout: each one is
 * routed through the delta cache and serialized to every websocket
 * client and logging plugin subscribed to the context. Most of the DR
 * output is slow-moving (log, trip log, current vector, uncertainty
 * radius — nobody needs those at 1 Hz), so publishing them every tick
 * taxes the whole server for no consumer's benefit. The plugin cannot
 * know who is listening, so it must simply be frugal by default.
 *
 * The gate batches the tick's values into one publish every
 * `everyTicks` integration ticks, with one carve-out: a *notable*
 * change publishes immediately, within the tick that observed it.
 * Notable means a discrete value flipped (method, state, active), a
 * path appeared or disappeared, or a value crossed to/from null —
 * transitions consumers must not learn an interval late (a tack
 * transient starting, DR going idle, a stale divergence figure being
 * nulled). Continuous drift between flushes is not notable: consumers
 * see the latest values at the next scheduled flush.
 *
 * Tick-counted, not wall-clocked: the tick *is* the cadence unit, so
 * the throttle scales with the configured integration interval
 * (default everyTicks=2 → one delta every 2 s at the 1 s default tick)
 * and stays deterministic under test.
 *
 * @file publish-gate.js
 */

/**
 * Creates a publish gate.
 *
 * @param {object} [opts]
 * @param {number} [opts.everyTicks=1] publish at most once per this
 *        many `shouldFlush` calls (1 = every call, no throttling)
 * @returns {{shouldFlush: (values: Record<string, unknown>, notableKeys?: string[]) => boolean}}
 */
function createPublishGate(opts = {}) {
  const every = Math.max(1, Math.floor(opts.everyTicks ?? 1));
  /** Calls since the last flush, counting the flush itself (so the
   * Nth call after a flush is due again); Infinity flushes call #1. */
  let callsSinceFlush = Number.POSITIVE_INFINITY;
  /**
   * Comparison snapshot of the last *published* values, or null
   * pre-flush. Only flushes update it: a skipped call must not extend
   * the interval by resetting the baseline.
   * @type {{notable: Record<string, string>, nullness: Record<string, boolean>, keys: string[]}|null}
   */
  let lastPublished = null;

  /**
   * Canonical comparison form for a value (stable for the flat objects
   * and scalars the tick publishes — field order is fixed at the single
   * construction site).
   *
   * @param {unknown} v
   * @returns {string}
   */
  const canonical = (v) => JSON.stringify(v) ?? "undefined";

  /**
   * Whether the values differ from the last published snapshot in a
   * way that must surface immediately.
   *
   * @param {Record<string, unknown>} values
   * @param {string[]} notableKeys
   * @returns {boolean}
   */
  function notableChange(values, notableKeys) {
    if (!lastPublished) return true;
    const keys = Object.keys(values);
    const prevKeys = new Set(lastPublished.keys);
    // A path appearing or vanishing is itself a transition (the STW
    // echo dropping when the polar fallback takes over, the uncertainty
    // object appearing when idle-but-moving starts).
    if (keys.length !== lastPublished.keys.length) return true;
    for (const k of keys) {
      if (!prevKeys.has(k)) return true;
      // null ↔ value: consumers drop stale figures on null — that must
      // not wait out the interval.
      if (lastPublished.nullness[k] !== (values[k] == null)) return true;
    }
    for (const k of notableKeys) {
      if (k in values && canonical(values[k]) !== lastPublished.notable[k]) {
        return true;
      }
    }
    return false;
  }

  return {
    /**
     * Whether the caller should publish these values now. Records the
     * snapshot on flush; a skipped call records nothing.
     *
     * @param {Record<string, unknown>} values
     * @param {string[]} [notableKeys] paths whose value changes publish
     *        immediately instead of waiting for the interval
     * @returns {boolean}
     */
    shouldFlush(values, notableKeys = []) {
      const due = callsSinceFlush >= every;
      if (due || notableChange(values, notableKeys)) {
        const notable = {};
        const nullness = {};
        for (const k of new Set([...notableKeys, ...Object.keys(values)])) {
          notable[k] = canonical(values[k]);
          nullness[k] = values[k] == null;
        }
        lastPublished = { notable, nullness, keys: Object.keys(values) };
        callsSinceFlush = 1;
        return true;
      }
      callsSinceFlush += 1;
      return false;
    },
  };
}

module.exports = { createPublishGate };
