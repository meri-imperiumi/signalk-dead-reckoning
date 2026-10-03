/**
 * Logbook integration: write-through to `signalk-logbook` (SPEC §9.4, §9.5).
 *
 * `fixes` remains the canonical record; logbook entries are formatted
 * exports. Entries are written through the Signal K v2 Resources API
 * (`app.resourcesApi.setResource('logentries', …)`) — the in-process
 * provider interface the logbook plugin registers. No REST, no tokens:
 * the server gates in-process plugin access at nothing, so the whole
 * access-request/token apparatus the v1 plugin routes forced is gone.
 * Entries always carry an explicit `datetime` (confirmations can lag a
 * DR reset by more than the enrichment buffer window) and are composed
 * to the `logentries` resource schema: logbook fields at the top level,
 * everything addressable as a Signal K path as delta-shaped telemetry
 * pathvalues in SI units.
 *
 * `origin` semantics per the logentries contract: 'agent' = machine
 * writing on behalf of a human — confirmed fixes and observations the
 * watchkeeper entered (SPEC §9.5's intent, previously sent as 'auto');
 * 'auto' = trigger/automation with no human in the loop — tack/gybe
 * detection (§9.4).
 *
 * A failed write is queued in the plugin DB and retried with backoff
 * (index.js); the write path itself never throws — `logged_to_logbook`
 * stays 0 in `fixes`, visible there.
 *
 * @file logbook.js
 */

const { randomUUID } = require("node:crypto");

/** Signal K SI unit conversions (the logentries contract speaks SI). */
const NM_TO_M = 1852;
const KN_TO_MS = 463 / 900; // 1 kn = 1852 m/h exactly
const DEG_TO_RAD = Math.PI / 180;

/**
 * WMO correspondence between the Douglas sea state code (what the
 * logbook watch flow publishes and this plugin's `sea_state` carries)
 * and the Beaufort force the `environment.water.seaState` resource path
 * carries — mirrored from the logbook's own resources boundary mapping.
 */
const DOUGLAS_TO_BEAUFORT = [0, 1, 2, 3, 5, 6, 8, 9, 10, 12];

/**
 * Douglas sea state code (0-9) → Beaufort force (0-12), or null when
 * out of range / non-numeric.
 *
 * @param {number|null|undefined} sea_state
 * @returns {number|null}
 */
function seaStateBeaufort(sea_state) {
  // Number(null) is 0 — reject nullish before coercion ("unknown" is
  // null here, never a legitimate Douglas 0).
  if (sea_state == null || sea_state === "") return null;
  const n = Number(sea_state);
  if (!Number.isFinite(n)) return null;
  const code = Math.round(n);
  if (code < 0 || code >= DOUGLAS_TO_BEAUFORT.length) {
    return null;
  }
  return DOUGLAS_TO_BEAUFORT[code];
}

/**
 * Human-facing `position.source` string per fix source_type.
 */
const POSITION_SOURCE = {
  gps: "GPS",
  celestial: "Celestial",
  bearing: "Bearing",
  manual: "DR",
  backfill: "Backfill",
};

/**
 * Builds a delta-shaped telemetry pathvalue for the `telemetry` array.
 *
 * @param {string} path
 * @param {unknown} value
 * @returns {{path: string, value: unknown}}
 */
function pathvalue(path, value) {
  return { path, value };
}

/**
 * Rounds a number to `places` decimals, returning null for non-finite.
 *
 * @param {number|null|undefined} n
 * @param {number} places
 * @returns {number|null}
 */
function round(n, places) {
  return Number.isFinite(n) ? Number(n.toFixed(places)) : null;
}

/**
 * Composes a `logentries`-shaped entry body for a confirmed fix (SPEC
 * §9.5 mapping, resources schema). Structured data rides the SI
 * telemetry pathvalues; the free-text `text` carries only what those
 * lack — the fix's *sources* (the observations that resolved into it)
 * and the DR-vs-fix deviation — since the position pathvalue already
 * holds the coordinates and `author` the watchkeeper.
 *
 * @param {object} f
 * @param {string} f.datetime - ISO timestamp of the fix
 * @param {string} f.source_type - 'gps' | 'celestial' | 'bearing' | 'manual' | 'backfill'
 * @param {number} f.latitude
 * @param {number} f.longitude
 * @param {string|null} [f.confirmed_by] - crew name
 * @param {number|null} [f.deviation_nm] - DR-vs-fix deviation
 * @param {number|null} [f.deviation_bearing] - true bearing from prior DR origin to the fix (deg)
 * @param {number|null} [f.dr_log_nm] - DR-integrated distance since last fix (§10.3)
 * @param {number|null} [f.residual_nm] - LOP/CPL residual (cocked-hat size)
 * @param {number|null} [f.observation_count] - number of LOPs/CPLs resolved
 *   (fallback when `observations` rows aren't supplied)
 * @param {Array<object>|null} [f.observations] - hydrated LOP/CPL rows that
 *   resolved into the fix, shaped as {kind, lop_type|cpl_type,
 *   body_or_object|source_object, azimuth_true?, radius_nm?}; named per-source
 *   in `text` so the logbook records what produced the fix
 * @param {number|null} [f.stw_kn]
 * @param {number|null} [f.sog_kn]
 * @param {number|null} [f.heading_deg]
 * @param {number|null} [f.course_deg]
 * @param {number|null} [f.sea_state] - WMO sea state code 0-9
 * @param {"decimal"|"dm"|"dms"} [f.positionFormat="decimal"] - notation
 *   for the position in entry text (mirrors the webapp preference)
 * @returns {object} POST /logs body
 */
function composeFixEntry(f) {
  const telemetry = [
    pathvalue("navigation.position", {
      latitude: f.latitude,
      longitude: f.longitude,
      source: POSITION_SOURCE[f.source_type] ?? "DR",
    }),
  ];
  if (Number.isFinite(f.dr_log_nm)) {
    telemetry.push(pathvalue("navigation.log", f.dr_log_nm * NM_TO_M));
  }
  if (Number.isFinite(f.heading_deg)) {
    telemetry.push(
      pathvalue("navigation.headingTrue", f.heading_deg * DEG_TO_RAD),
    );
  }
  if (Number.isFinite(f.course_deg)) {
    telemetry.push(
      pathvalue("navigation.courseOverGroundTrue", f.course_deg * DEG_TO_RAD),
    );
  }
  if (Number.isFinite(f.stw_kn)) {
    telemetry.push(
      pathvalue("navigation.speedThroughWater", f.stw_kn * KN_TO_MS),
    );
  }
  if (Number.isFinite(f.sog_kn)) {
    telemetry.push(
      pathvalue("navigation.speedOverGround", f.sog_kn * KN_TO_MS),
    );
  }
  const beaufort = seaStateBeaufort(f.sea_state);
  if (beaufort != null) {
    telemetry.push(pathvalue("environment.water.seaState", beaufort));
  }
  const body = {
    datetime: f.datetime,
    text: composeFixText(f),
    category: "navigation",
    // Human-confirmed fix the machine writes down (SPEC §9.5): 'agent',
    // not 'auto' — there was a human judgment in the loop.
    origin: "agent",
    telemetry,
  };
  if (f.confirmed_by) body.author = f.confirmed_by;
  return body;
}

/**
 * Formats a true bearing as a zero-padded "090°T" string — the standard
 * nautical abbreviation ("T" for true; "M" for magnetic). Bearings are
 * stored degrees-true and no magnetic-variation source is subscribed, so
 * only true bearings are emitted.
 *
 * @param {number} deg
 * @returns {string}
 */
function formatBearingTrue(deg) {
  const b = ((Math.round(deg) % 360) + 360) % 360;
  return `${String(b).padStart(3, "0")}°T`;
}

/**
 * Shapes the observations that resolved into a fix into short "source"
 * fragments for the entry text — the navigable context the structured
 * `position` field can't carry (it holds only the fix's own coordinates).
 * One fragment per observation:
 *   - bearing LOP:   "Aitutaki Atoll bearing 123°T"
 *   - celestial LOP: "Sun sight"
 *   - vertical CPL:  "lighthouse CPL 0.4 NM"
 *
 * @param {Array<object>|null|undefined} observations - hydrated LOP/CPL rows
 * @returns {string[]} empty when no observation details were supplied
 */
function observationSources(observations) {
  if (!Array.isArray(observations)) return [];
  return observations.map(observationSourceLabel);
}

/**
 * One observation's source label. Mirrors the per-entry text in
 * {@link composeObservationEntry} but compact, for listing inside a fix.
 */
function observationSourceLabel(o) {
  if (o.kind === "cpl") {
    const obj = o.source_object ?? "object";
    const r = Number.isFinite(o.radius_nm)
      ? ` ${o.radius_nm.toFixed(1)} NM`
      : "";
    return `${obj} CPL${r}`;
  }
  if (o.lop_type === "celestial") {
    return `${o.body_or_object ?? "Body"} sight`;
  }
  const obj = o.body_or_object ?? "object";
  const b = Number.isFinite(o.azimuth_true)
    ? ` bearing ${formatBearingTrue(o.azimuth_true)}`
    : "";
  return `${obj}${b}`;
}

/**
 * Composes the free-text summary for a fix entry, templated per
 * source_type (SPEC §9.5: celestial/bearing specifics go into `text` —
 * no structured fields exist for them). Coordinates stay in the
 * structured `position` field and the watchkeeper in `author`, so `text`
 * carries only what those lack: the fix's sources (for LOP/CPL fixes)
 * and the DR-vs-fix deviation.
 */
function composeFixText(f) {
  const dev = deviationClause(f);
  const res = Number.isFinite(f.residual_nm)
    ? `, residual ${f.residual_nm.toFixed(1)} NM`
    : "";
  const sources = observationSources(f.observations);
  const fromSources = sources.length
    ? ` from ${sources.join(", ")}`
    : countFrom(f);
  // Single-observation running fix: name the fix it was advanced from,
  // so the entry reads as a chain (fix #3 → this fix) rather than a
  // free-standing one-sight "fix".
  const run = Number.isFinite(f.derived_from_fix_id)
    ? ` (running fix, advanced from fix #${f.derived_from_fix_id})`
    : "";

  switch (f.source_type) {
    case "celestial":
      return `Celestial fix${fromSources}${run}${res}${dev}`;
    case "bearing":
      return `Bearing fix${fromSources}${run}${res}${dev}`;
    case "gps":
      return `GPS fix${dev}`;
    case "backfill":
      return `Backfill fix${dev}`;
    default:
      return `Manual fix${fromSources}${run}${res}${dev}`;
  }
}

/**
 * Count-based "from N sights/bearings" fallback, used only when the
 * caller supplied an `observation_count` but not the hydrated
 * `observations` rows.
 */
function countFrom(f) {
  const n = f.observation_count ?? 0;
  if (!n) return "";
  if (f.source_type === "celestial")
    return ` from ${n} sight${n > 1 ? "s" : ""}`;
  if (f.source_type === "bearing")
    return ` from ${n} bearing${n > 1 ? "s" : ""}`;
  return ` from ${n} observation${n > 1 ? "s" : ""}`;
}

/**
 * The ", 0.5 NM at 090°T from DR" clause, when a deviation is known.
 * Direction is the true bearing from the prior DR origin to the fix —
 * "the fix is 0.5 NM away, bearing 090°T from where DR put us". "NM"
 * (Nautical Miles), not "nm" (nanometers).
 */
function deviationClause(f) {
  if (!Number.isFinite(f.deviation_nm)) return "";
  const dist = f.deviation_nm.toFixed(1);
  const at = Number.isFinite(f.deviation_bearing)
    ? ` at ${formatBearingTrue(f.deviation_bearing)}`
    : "";
  return `, ${dist} NM${at} from DR`;
}

/**
 * Composes a `logentries`-shaped entry body for an auto-detected
 * completed tack/gybe (SPEC §9.4). No confirmation step — written
 * directly, `origin: 'auto'` (pure automation, no human in the loop).
 *
 * @param {object} t
 * @param {"tack"|"gybe"} t.direction
 * @param {number} t.newHeadingDeg - stabilized post-maneuver heading
 * @param {string} t.datetime - ISO timestamp of the maneuver completion
 * @param {number|null} [t.sea_state] - Douglas sea state code 0-9
 * @returns {object} setResource body
 */
function composeTackEntry(t) {
  const heading = round(t.newHeadingDeg, 0);
  const text =
    t.direction === "gybe"
      ? `Gybe to ${String(heading).padStart(3, "0")}°`
      : `Tack to ${String(heading).padStart(3, "0")}°`;
  const body = {
    datetime: t.datetime,
    text,
    category: "navigation",
    origin: "auto",
  };
  const beaufort = seaStateBeaufort(t.sea_state);
  if (beaufort != null) {
    body.telemetry = [pathvalue("environment.water.seaState", beaufort)];
  }
  return body;
}

/**
 * Composes a `NewEntry`-shaped body for a standalone observation
 * (SPEC §9.5): a bearing LOP, a vertical-angle CPL, or a celestial
 * sight. Logged when the observation is recorded — independent of
 * whether it ever resolves into a fix — because taking the sight is
 * itself a navigational event. The vessel's position (DR at the time
 * of the sight) rides the `navigation.position` telemetry pathvalue —
 * the logbook UI renders it separately, so it stays out of `text`;
 * `text` carries only what was observed (object, bearing/radius/
 * reduction).
 *
 * @param {object} o
 * @param {"bearing"|"vertical"|"celestial"} o.kind
 * @param {string} [o.body_or_object] - body name (celestial) or object label
 * @param {string} o.datetime - ISO timestamp
 * @param {string|null} [o.confirmed_by] - watchkeeper (author)
 * @param {number} [o.latitude] - vessel position to anchor the entry
 * @param {number} [o.longitude]
 * @param {object} [o.reduction] - celestial reduction (Hc/Ho/Zn/intercept)
 * @param {number|null} [o.azimuth_true] - true bearing to the object, deg
 *   (bearing LOPs — the observed angle is the event, it belongs in text)
 * @param {number|null} [o.radius_nm] - CPL radius, nm (vertical-angle CPLs)
 * @param {number|null} [o.sea_state] - Douglas sea state code 0-9
 * @returns {object} setResource body
 */
function composeObservationEntry(o) {
  const hasPosition =
    Number.isFinite(o.latitude) && Number.isFinite(o.longitude);
  let text;
  if (o.kind === "celestial") {
    const r = o.reduction ?? {};
    const ic = Number.isFinite(r.intercept_nm)
      ? `, intercept ${Math.abs(r.intercept_nm).toFixed(2)} NM ${
          r.intercept_nm >= 0 ? "toward" : "away"
        }`
      : "";
    const zn = Number.isFinite(r.azimuth_true)
      ? `, Zn ${r.azimuth_true.toFixed(1)}°`
      : "";
    text = `${o.body_or_object ?? "Body"} sight${zn}${ic}`;
  } else if (o.kind === "vertical") {
    const r = Number.isFinite(o.radius_nm)
      ? ` ${o.radius_nm.toFixed(1)} NM`
      : "";
    text = `${o.body_or_object ?? "object"} CPL${r}`;
  } else {
    // The observed angle is the event — a bearing entry without it
    // isn't navigable after the fact. Zero-padded like the tack text;
    // "°T" is the standard nautical abbreviation for true (bearings are
    // stored degrees-true — magnetic entries are converted at submit).
    const b = Number.isFinite(o.azimuth_true)
      ? ` ${String(((Math.round(o.azimuth_true) % 360) + 360) % 360).padStart(3, "0")}°T`
      : "";
    text = `${o.body_or_object ?? "object"} bearing${b}`;
  }
  const body = {
    datetime: o.datetime,
    text,
    category: "navigation",
    // Watchkeeper-entered observation the machine writes down: 'agent'.
    origin: "agent",
  };
  const telemetry = [];
  if (hasPosition) {
    telemetry.push(
      pathvalue("navigation.position", {
        latitude: o.latitude,
        longitude: o.longitude,
        source: o.kind === "celestial" ? "Celestial" : "DR",
      }),
    );
  }
  const beaufort = seaStateBeaufort(o.sea_state);
  if (beaufort != null) {
    telemetry.push(pathvalue("environment.water.seaState", beaufort));
  }
  if (telemetry.length > 0) body.telemetry = telemetry;
  if (o.confirmed_by) body.author = o.confirmed_by;
  return body;
}

/**
 * Creates a logbook write client over the Signal K v2 Resources API —
 * the in-process `app.resourcesApi` interface, with the `logentries`
 * provider registered by signalk-logbook. No REST, no tokens, no auth
 * of any kind: in-process plugin access passes no security middleware.
 *
 * @param {object} opts
 * @param {object} opts.resourcesApi - the server's resources API
 * @returns {{createEntry: (body: object) => Promise<{id: string}|null>}}
 *   the created entry's resource id (a UUID, the entry's stable
 *   identity) on success, null on provider failure
 */
function createLogbookClient(opts) {
  const resourcesApi = opts.resourcesApi;
  return {
    /**
     * Writes an entry under a fresh UUID (PUT-style upsert — the
     * resources API's create path; idempotent per id, unlike POST).
     * Resolves `{id}` on success, null when the provider rejects (e.g.
     * the logbook plugin is absent — no `logentries` provider — or a
     * validation error). Never rejects; callers degrade gracefully.
     *
     * @param {object} body - logentries-shaped entry
     * @returns {Promise<{id: string}|null>}
     */
    async createEntry(body) {
      try {
        const id = randomUUID();
        await resourcesApi.setResource("logentries", id, body);
        return { id };
      } catch {
        return null;
      }
    },
  };
}

/**
 * Probes for a registered `logentries` resource provider: resolves when
 * one answers, rejects when the Resources API is unavailable (older
 * server) or no provider for the type is registered (logbook plugin
 * absent, or not yet started — start order between plugins isn't
 * guaranteed). A minimal listing is the cheap, complete-window query
 * the contract's "no silent windows" rule allows.
 *
 * @param {object|undefined} resourcesApi - the server's resources API
 * @returns {Promise<void>}
 */
async function probeLogbookProvider(resourcesApi) {
  if (!resourcesApi || typeof resourcesApi.listResources !== "function") {
    throw new Error("resourcesApi unavailable");
  }
  await resourcesApi.listResources("logentries", { limit: 1 });
}

module.exports = {
  POSITION_SOURCE,
  seaStateBeaufort,
  formatBearingTrue,
  observationSources,
  composeFixEntry,
  composeFixText,
  composeTackEntry,
  composeObservationEntry,
  createLogbookClient,
  probeLogbookProvider,
};
