/**
 * Pure, DOM-free logic for the plotter-extension **host** (work doc
 * #27). Everything here is importable in Node for tests: manifest
 * filtering, the widget-layout model, state-storage key rules, the
 * per-context Signal K path registry, and delta routing. The DOM/bus
 * glue lives in `dr-ext-host.js`; the wire protocol in
 * `vendor/plotterext-bus` (host entry).
 *
 * @file dr-ext-host-core.js
 */

/** Widget-area anchors the webapp offers (work doc #27): grids that
 * flow *below* the host's own top panels — top-left under the entry
 * tools, top-right under the GPS status panel. Extensions never see
 * anchors; placement is host-internal. */
export const AREA_ANCHORS = ["top-left", "top-right"];

/** Grid geometry per area: 2 columns × 2 rows (Plotter Extensions API
 * v1 layout model). */
export const GRID_COLS = 2;
export const GRID_ROWS = 2;

/** Capabilities this host advertises (work doc #27 v1 scope). */
export const HOST_CAPABILITIES = [
  "widgets",
  "panels.iframe",
  "signalk.stream",
  "signalk.put",
];

/** API major version this host implements. */
export const API_VERSION = "1";

/**
 * Parses a widget `size` ("<cols>x<rows>") into cell spans.
 *
 * @param {unknown} size
 * @returns {{cols: number, rows: number}|null} null when malformed or
 *   larger than the 2×2 grid
 */
export function parseSize(size) {
  if (typeof size !== "string") return null;
  const m = /^([12])x([12])$/.exec(size);
  if (!m) return null;
  return { cols: Number(m[1]), rows: Number(m[2]) };
}

/**
 * Is a contribution entry (widget/panel) usable on this host? Checks
 * the entry's own `apiVersion` (contributions may need a newer host
 * API than the manifest baseline — hosts silently omit those) and, for
 * widgets, a valid `size`.
 *
 * @param {object} entry - manifest contribution entry
 * @param {string} kind - "widgets" | "panels"
 * @returns {boolean}
 */
export function contributionUsable(entry, kind) {
  if (!entry || typeof entry !== "object") return false;
  if (typeof entry.id !== "string" || entry.id === "") return false;
  if (typeof entry.url !== "string" || entry.url === "") return false;
  if (entry.apiVersion !== undefined && entry.apiVersion !== API_VERSION) {
    return false;
  }
  if (kind === "widgets" && parseSize(entry.size) == null) return false;
  return true;
}

/**
 * Filters a discovered `plotterExtensions` collection down to the
 * extensions this host can offer: manifest `apiVersion` must match,
 * every `requires` capability must be advertised, and contributions
 * are narrowed to usable widget/panel entries (unknown sections are
 * ignored per the spec).
 *
 * @param {object} collection - `{ [extId]: manifest }`
 * @param {string[]} capabilities
 * @returns {Map<string, {manifest: object, widgets: object[], panels: object[]}>}
 */
export function compatibleExtensions(collection, capabilities) {
  const out = new Map();
  if (!collection || typeof collection !== "object") return out;
  for (const [extId, manifest] of Object.entries(collection)) {
    if (!manifest || typeof manifest !== "object") continue;
    if (manifest.apiVersion !== API_VERSION) continue; // never offer newer
    const requires = Array.isArray(manifest.requires) ? manifest.requires : [];
    if (!requires.every((c) => capabilities.includes(c))) continue;
    const widgets = (Array.isArray(manifest.widgets) ? manifest.widgets : [])
      .filter((w) => contributionUsable(w, "widgets"))
      .map((w) => ({ ...w, size: w.size })); // validated by contributionUsable
    const panels = (
      Array.isArray(manifest.panels) ? manifest.panels : []
    ).filter((p) => contributionUsable(p, "panels"));
    if (widgets.length === 0 && panels.length === 0) continue;
    out.set(extId, { manifest, widgets, panels });
  }
  return out;
}

/**
 * Cells covered by a widget placed at (row, col) with the given size.
 *
 * @param {{cols: number, rows: number}} size
 * @param {number} row
 * @param {number} col
 * @returns {Array<[number, number]>}
 */
export function cellsFor(size, row, col) {
  const cells = [];
  for (let r = 0; r < size.rows; r++) {
    for (let c = 0; c < size.cols; c++) {
      cells.push([row + r, col + c]);
    }
  }
  return cells;
}

/**
 * Does a widget of this size still fit inside the 2×2 grid when
 * anchored at (row, col)?
 *
 * @param {{cols: number, rows: number}} size
 * @param {number} row
 * @param {number} col
 * @returns {boolean}
 */
export function fitsInGrid(size, row, col) {
  return (
    row >= 0 &&
    col >= 0 &&
    row + size.rows <= GRID_ROWS &&
    col + size.cols <= GRID_COLS
  );
}

/**
 * Occupied-cell map for an anchor's placements (1-based? no — 0-based
 * [row, col] keys). Malformed stored entries are skipped rather than
 * throwing — layout is localStorage data, not gospel.
 *
 * @param {Array<object>} placements
 * @returns {Set<string>} "r,c" keys
 */
export function occupiedCells(placements) {
  const occ = new Set();
  for (const p of placements ?? []) {
    const size = parseSize(p?.size);
    if (!size || !fitsInGrid(size, p.row, p.col)) continue;
    for (const [r, c] of cellsFor(size, p.row, p.col)) occ.add(`${r},${c}`);
  }
  return occ;
}

/**
 * First position (packing from the grid origin, row-major) where a
 * widget of this size fits without overlapping existing placements.
 *
 * @param {Array<object>} placements - the anchor's current placements
 * @param {string} size
 * @returns {{row: number, col: number}|null}
 */
export function firstFreeSlot(placements, size) {
  const parsed = parseSize(size);
  if (!parsed) return null;
  const occ = occupiedCells(placements);
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (!fitsInGrid(parsed, r, c)) continue;
      const clash = cellsFor(parsed, r, c).some(([rr, cc]) =>
        occ.has(`${rr},${cc}`),
      );
      if (!clash) return { row: r, col: c };
    }
  }
  return null;
}

/**
 * Validates/repairs a persisted layout blob. Returns a clean layout
 * (`{version, areas}`) or null when unparseable.
 *
 * @param {unknown} raw
 * @returns {{version: number, areas: Record<string, Array<object>>}|null}
 */
export function layoutFromJSON(raw) {
  if (!raw || typeof raw !== "object") return null;
  const areas = {};
  const src = raw.areas ?? {};
  for (const anchor of AREA_ANCHORS) {
    const list = src[anchor];
    areas[anchor] = Array.isArray(list) ? list.filter(validPlacement) : [];
  }
  return { version: 1, areas };
}

/**
 * @param {unknown} p
 * @returns {boolean}
 */
function validPlacement(p) {
  return (
    p &&
    typeof p === "object" &&
    typeof p.extensionId === "string" &&
    typeof p.widgetId === "string" &&
    typeof p.instanceId === "string" &&
    p.instanceId !== "" &&
    parseSize(p.size) != null &&
    Number.isInteger(p.row) &&
    Number.isInteger(p.col) &&
    fitsInGrid(parseSize(p.size), p.row, p.col)
  );
}

/**
 * Drops placements whose extension/widget is no longer offered (plugin
 * disabled, uninstalled, or filtered by capability) — presence in the
 * collection is the enablement signal, so a stale placement has
 * nothing to attach to. Also re-slots placements that would now
 * overlap (e.g. after hand-edited storage): kept in row-major order.
 *
 * @param {{version: number, areas: Record<string, Array<object>>}} layout
 * @param {Map<string, {manifest: object, widgets: object[], panels: object[]}>} compatible
 * @returns {{layout: object, changed: boolean}}
 */
export function pruneLayout(layout, compatible) {
  let changed = false;
  const areas = {};
  for (const anchor of AREA_ANCHORS) {
    const kept = [];
    const occ = new Set();
    for (const p of layout.areas[anchor] ?? []) {
      const ext = compatible.get(p.extensionId);
      const widget = ext?.widgets.find((w) => w.id === p.widgetId);
      if (!widget) {
        changed = true;
        continue;
      }
      const size = parseSize(widget.size);
      const cells = cellsFor(size, p.row, p.col);
      const clash = cells.some(([r, c]) => occ.has(`${r},${c}`));
      if (clash || cells.length === 0) {
        changed = true;
        continue; // orphaned overlap: drop rather than trust stale data
      }
      for (const [r, c] of cells) occ.add(`${r},${c}`);
      kept.push({ ...p, size: widget.size });
    }
    areas[anchor] = kept;
  }
  return { layout: { version: 1, areas }, changed };
}

/**
 * localStorage key for the widget layout (work doc #27).
 *
 * @param {string} [prefix]
 * @returns {string}
 */
export function layoutKey(prefix = "dr.plotterext") {
  return `${prefix}.layout.v1`;
}

/**
 * localStorage key for an extension's state scope. Extension scope is
 * shared across contexts; instance scope is keyed by the placement's
 * stable instance id.
 *
 * @param {string} extId
 * @param {string|null|undefined} instanceId - null → extension scope
 * @param {string} [prefix]
 * @returns {string}
 */
export function stateKey(extId, instanceId, prefix = "dr.plotterext") {
  return instanceId
    ? `${prefix}.state.${extId}.${instanceId}`
    : `${prefix}.state.${extId}`;
}

/**
 * Reads/writes a state scope as one JSON object. Storage is injected
 * so Node tests can pass a fake.
 */
export class StateStore {
  /**
   * @param {{getItem: (k: string) => string|null,
   *           setItem: (k: string, v: string) => void}} storage
   */
  constructor(storage) {
    this.storage = storage;
  }

  /**
   * @param {string} extId
   * @param {string|null|undefined} instanceId
   * @returns {object}
   */
  readAll(extId, instanceId) {
    try {
      const raw = this.storage.getItem(stateKey(extId, instanceId));
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  /**
   * @param {string} extId
   * @param {string|null|undefined} instanceId
   * @param {object} values merged over the current scope
   * @returns {string[]} keys written
   */
  write(extId, instanceId, values) {
    const all = this.readAll(extId, instanceId);
    const keys = [];
    for (const [k, v] of Object.entries(values ?? {})) {
      if (typeof k !== "string" || k === "") continue;
      all[k] = v;
      keys.push(k);
    }
    this.storage.setItem(stateKey(extId, instanceId), JSON.stringify(all));
    return keys;
  }

  /**
   * @param {string} extId
   * @param {string|null|undefined} instanceId
   * @param {string[]|undefined} keys
   * @returns {object}
   */
  get(extId, instanceId, keys) {
    const all = this.readAll(extId, instanceId);
    if (!keys) return all;
    const out = {};
    for (const k of keys) {
      if (k in all) out[k] = all[k];
    }
    return out;
  }
}

/**
 * Registry of Signal K literal path subscriptions per extension
 * context: subscription ids → (context, paths). The host keeps one
 * upstream stream (which does its own per-path refcounting); this
 * registry decides who a delta belongs to (routing) and what a
 * context held when it goes away (teardown).
 */
export class PathRefRegistry {
  constructor() {
    /** @type {Map<string, {ctx: object, paths: string[]}>} subId → sub */
    this.subs = new Map();
    this.seq = 0;
  }

  /**
   * Registers a subscription for a context.
   *
   * @param {object} ctx - opaque context handle (the HostConnection)
   * @param {string[]} paths
   * @returns {string} subscriptionId
   */
  subscribe(ctx, paths) {
    const subId = `sks-${++this.seq}`;
    this.subs.set(subId, { ctx, paths: [...paths] });
    return subId;
  }

  /**
   * Drops a subscription, returning its paths (for the caller to
   * decrement elsewhere) or null when unknown.
   *
   * @param {string} subId
   * @returns {string[]|null}
   */
  unsubscribe(subId) {
    const sub = this.subs.get(subId);
    if (!sub) return null;
    this.subs.delete(subId);
    return sub.paths;
  }

  /**
   * Drops every subscription belonging to a context (context teardown).
   *
   * @param {object} ctx
   * @returns {string[]} all paths that were held
   */
  dropContext(ctx) {
    const held = [];
    for (const [subId, sub] of [...this.subs]) {
      if (sub.ctx === ctx) {
        this.subs.delete(subId);
        held.push(...sub.paths);
      }
    }
    return held;
  }

  /** Paths currently held (union of live subscriptions). */
  activePaths() {
    const all = new Set();
    for (const sub of this.subs.values()) {
      for (const p of sub.paths) all.add(p);
    }
    return [...all];
  }

  /**
   * Live contexts currently holding a path (delta routing: publish
   * `sk.<path>` to exactly these).
   *
   * @param {string} path
   * @returns {Set<object>}
   */
  contextsForPath(path) {
    const out = new Set();
    for (const sub of this.subs.values()) {
      if (sub.paths.includes(path)) out.add(sub.ctx);
    }
    return out;
  }
}

/**
 * Extracts own-vessel value updates from a stream delta frame as
 * `sk.<path>` event payloads. Only `updates[].values` count — meta
 * frames (`updates[].meta`, sent because the app socket uses
 * `sendMeta=all`) are path *metadata*, not path values, and other
 * vessels' deltas (AIS) are not part of the v1 relay.
 *
 * @param {object} delta - stream frame with `context`/`updates`
 * @param {string|null} selfContext - the Hello frame's self context
 * @returns {Array<{path: string, value: unknown, timestamp: string|null,
 *   $source: string|null}>}
 */
export function selfDeltaValues(delta, selfContext) {
  const ctx = delta?.context;
  if (ctx !== "vessels.self" && ctx !== selfContext) return [];
  const out = [];
  for (const update of delta?.updates ?? []) {
    for (const v of update?.values ?? []) {
      if (typeof v?.path !== "string" || v.path === "") continue;
      out.push({
        path: v.path,
        value: v.value,
        timestamp: update.timestamp ?? null,
        $source: update.$source ?? update.source?.label ?? null,
      });
    }
  }
  return out;
}

/**
 * Instance-id generator. `crypto.randomUUID` needs a secure context —
 * plain http on the boat LAN is not one — so fall back to a v4-shaped
 * id from `crypto.getRandomValues` (available everywhere).
 *
 * @returns {string}
 */
export function newInstanceId() {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
