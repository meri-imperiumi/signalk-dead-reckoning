/**
 * Logbook integration: write-through to the `logentries` resource provider
 * (e.g. `signalk-logbook`; SPEC §9.4, §9.5).
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
 *   body_or_object|source_object, azimuth_true?, bearing_raw_deg?,
 *   bearing_ref?, variation_deg?, radius_nm?, raw_angle_deg?}; named
 *   per-source in `text` so the logbook records what produced the fix —
 *   bearing rows log the entered reading + reference (+ variation when
 *   magnetic), falling back to the stored line normal − 90° when the
 *   entered value is absent; horizontal-angle CPLs log the measured angle)
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
 * Formats a bearing as a zero-padded "090°T" / "090°M" string — the
 * standard nautical abbreviations ("T" for true, "M" for magnetic
 * compass reading). The suffix follows the bearing's own reference, so
 * the log records what the navigator actually read.
 *
 * @param {number} deg
 * @param {"true"|"mag"} [ref="true"]
 * @returns {string}
 */
function formatBearing(deg, ref = "true") {
  const b = ((Math.round(deg) % 360) + 360) % 360;
  return `${String(b).padStart(3, "0")}°${ref === "mag" ? "M" : "T"}`;
}

/**
 * Formats magnetic variation as a "var 4°E" / "var 3.5°W" note — the
 * conventional logbook shorthand, east/west per the sign convention
 * (east positive) used at submission.
 *
 * @param {number} deg - signed variation, east positive
 * @returns {string}
 */
function formatVariation(deg) {
  const mag = Math.abs(deg);
  const value = Number.isInteger(mag) ? String(mag) : mag.toFixed(1);
  return `var ${value}°${deg < 0 ? "W" : "E"}`;
}

/**
 * Measured bearing from a bearing LOP's stored `azimuth_true`. Bearing
 * rows keep the line's *normal* in `azimuth_true` — the engine's LOP
 * convention is a line through the anchor perpendicular to the azimuth,
 * so the webapp submits bearing + 90° (celestial Zn is stored
 * unrotated). The angle the navigator read off the compass is the
 * stored value − 90°; logging the stored value would put a bearing
 * 90° off into the book while the chart draws the LoP correctly.
 *
 * @param {number} azimuthTrue - stored line normal, deg true
 * @returns {number} measured true bearing, deg 0–360
 */
function bearingFromNormal(azimuthTrue) {
  return (((azimuthTrue - 90) % 360) + 360) % 360;
}

/**
 * The " bearing …" fragment for a bearing observation. Logs what the
 * navigator actually entered — the compass reading and its reference,
 * plus the variation used when the entry was magnetic — rather than
 * only the derived true bearing. Falls back to the stored line normal
 * (azimuth_true − 90°, degrees true) for rows recorded before the
 * entered-bearing provenance columns existed.
 *
 * @param {object} o - observation (submission or hydrated LOP row)
 * @param {number|null} [o.bearing_raw_deg] - bearing as entered, deg
 * @param {"true"|"mag"} [o.bearing_ref] - reference of the entered bearing
 * @param {number|null} [o.variation_deg] - variation applied to a magnetic
 *   entry, east positive
 * @param {number|null} [o.azimuth_true] - stored line normal, deg true
 * @returns {string} " 047°T"-style suffix, or "" when nothing is known
 */
function bearingEntrySuffix(o) {
  if (Number.isFinite(o.bearing_raw_deg)) {
    const ref = o.bearing_ref === "mag" ? "mag" : "true";
    let suffix = ` ${formatBearing(o.bearing_raw_deg, ref)}`;
    if (ref === "mag" && Number.isFinite(o.variation_deg)) {
      suffix += ` (${formatVariation(o.variation_deg)})`;
    }
    return suffix;
  }
  if (Number.isFinite(o.azimuth_true)) {
    return ` ${formatBearing(bearingFromNormal(o.azimuth_true))}`;
  }
  return "";
}

/**
 * Shapes the observations that resolved into a fix into short "source"
 * fragments for the entry text — the navigable context the structured
 * `position` field can't carry (it holds only the fix's own coordinates).
 * One fragment per observation:
 *   - bearing LOP:   "Aitutaki Atoll bearing 116°M (var 4°E)"
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
    // A horizontal-angle CPL's observation is the sextant angle — the
    // radius is derived from it, so the measured angle is what the
    // source list names (mirrors the per-entry text).
    if (o.cpl_type === "horizontal-angle" && Number.isFinite(o.raw_angle_deg)) {
      return `${obj} angle ${o.raw_angle_deg.toFixed(1)}°`;
    }
    const r = Number.isFinite(o.radius_nm)
      ? ` ${o.radius_nm.toFixed(1)} NM`
      : "";
    return `${obj} CPL${r}`;
  }
  if (o.lop_type === "celestial") {
    return `${o.body_or_object ?? "Body"} sight`;
  }
  const obj = o.body_or_object ?? "object";
  return `${obj} bearing${bearingEntrySuffix(o)}`;
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
    ? ` at ${formatBearing(f.deviation_bearing)}`
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
 * @param {number} t.newHeadingDeg - stabilized post-maneuver heading, deg
 *   true (logged with the °T reference, like every other angle in the book)
 * @param {string} t.datetime - ISO timestamp of the maneuver completion
 * @param {number|null} [t.sea_state] - Douglas sea state code 0-9
 * @returns {object} setResource body
 */
function composeTackEntry(t) {
  const text =
    t.direction === "gybe"
      ? `Gybe to ${formatBearing(t.newHeadingDeg)}`
      : `Tack to ${formatBearing(t.newHeadingDeg)}`;
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
 * (SPEC §9.5): a bearing LOP, a vertical-angle CPL, a radar range
 * (work doc #33), or a celestial sight. Logged when the observation
 * is recorded — independent of whether it ever resolves into a fix —
 * because taking the sight is itself a navigational event. The
 * vessel's position (DR at the time of the sight) rides the
 * `navigation.position` telemetry pathvalue — the logbook UI renders
 * it separately, so it stays out of `text`; `text` carries only what
 * was observed (object, bearing/radius/reduction).
 *
 * @param {object} o
 * @param {"bearing"|"vertical"|"radar"|"hangle"|"celestial"} o.kind
 * @param {string} [o.body_or_object] - body name (celestial), object label,
 *   or "A / B" (horizontal-angle CPLs)
 * @param {string} o.datetime - ISO timestamp
 * @param {string|null} [o.confirmed_by] - watchkeeper (author)
 * @param {number} [o.latitude] - vessel position to anchor the entry
 * @param {number} [o.longitude]
 * @param {object} [o.reduction] - celestial reduction (Hc/Ho/Zn/intercept)
 * @param {number|null} [o.hs_deg] - raw sextant altitude, deg (celestial —
 *   the reading is the observation; the reduction is reconstruction)
 * @param {number|null} [o.index_correction_deg] - index correction applied
 *   to Hs, deg (celestial — noted so the correction stays auditable)
 * @param {number|null} [o.height_m] - charted object height the vertical
 *   angle was measured over, m (vertical-angle CPLs)
 * @param {number|null} [o.bearing_raw_deg] - bearing as the navigator entered
 *   it, deg — logged in preference to the derived true bearing (the
 *   observation is the event; the conversion is reconstruction)
 * @param {"true"|"mag"} [o.bearing_ref] - reference of the entered bearing
 * @param {number|null} [o.variation_deg] - variation applied to a magnetic
 *   entry, east positive (noted in text so the conversion stays auditable)
 * @param {number|null} [o.azimuth_true] - bearing LOP's stored line
 *   normal, deg true — fallback for rows without the entered value (the
 *   measured true bearing is that − 90°, see {@link bearingFromNormal})
 * @param {number|null} [o.radius_nm] - CPL radius, nm (vertical-angle / radar
 *   range CPLs)
 * @param {number|null} [o.angle_deg] - measured horizontal angle, deg
 *   (horizontal-angle CPLs, work doc #35)
 * @param {number|null} [o.sea_state] - Douglas sea state code 0-9
 * @returns {object} setResource body
 */
function composeObservationEntry(o) {
  const hasPosition =
    Number.isFinite(o.latitude) && Number.isFinite(o.longitude);
  let text;
  if (o.kind === "celestial") {
    const r = o.reduction ?? {};
    // The sextant reading is the observation — Zn and the intercept are
    // derived from it, so the raw Hs (with the index correction applied
    // to it) leads the specifics. A zero intercept (meridian altitude /
    // noon sight) has no direction to state and is left out.
    const ic =
      Number.isFinite(o.index_correction_deg) && o.index_correction_deg !== 0
        ? ` (IC ${o.index_correction_deg >= 0 ? "+" : "-"}${Math.abs(
            o.index_correction_deg,
          ).toFixed(1)}°)`
        : "";
    const hs = Number.isFinite(o.hs_deg)
      ? `, Hs ${o.hs_deg.toFixed(1)}°${ic}`
      : "";
    const zn = Number.isFinite(r.azimuth_true)
      ? `, Zn ${r.azimuth_true.toFixed(1)}°`
      : "";
    const intercept =
      Number.isFinite(r.intercept_nm) && Math.abs(r.intercept_nm) >= 0.005
        ? `, intercept ${Math.abs(r.intercept_nm).toFixed(2)} NM ${
            r.intercept_nm >= 0 ? "toward" : "away"
          }`
        : "";
    text = `${o.body_or_object ?? "Body"} sight${hs}${zn}${intercept}`;
  } else if (o.kind === "vertical") {
    const r = Number.isFinite(o.radius_nm)
      ? ` ${o.radius_nm.toFixed(1)} NM`
      : "";
    // The sextant angle over the object's charted height is what was
    // measured — the distance is derived from it (height / tan angle) —
    // so both measured inputs ride along with the radius.
    const measured = Number.isFinite(o.angle_deg)
      ? ` (angle ${o.angle_deg.toFixed(1)}°${
          Number.isFinite(o.height_m) ? ` on ${o.height_m} m` : ""
        })`
      : "";
    text = `${o.body_or_object ?? "object"} CPL${r}${measured}`;
  } else if (o.kind === "radar") {
    const r = Number.isFinite(o.radius_nm)
      ? ` ${o.radius_nm.toFixed(1)} NM`
      : "";
    text = `${o.body_or_object ?? "object"} radar range${r}`;
  } else if (o.kind === "hangle") {
    const a = Number.isFinite(o.angle_deg) ? ` ${o.angle_deg.toFixed(1)}°` : "";
    text = `${o.body_or_object ?? "objects"} horizontal angle${a}`;
  } else {
    // The observed angle is the event — a bearing entry without it
    // isn't navigable after the fact. Log what was entered (reading +
    // reference, variation for a magnetic entry) via the shared
    // suffix helper; it falls back to the stored line normal − 90°
    // for legacy rows.
    text = `${o.body_or_object ?? "object"} bearing${bearingEntrySuffix(o)}`;
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
 * the in-process `app.resourcesApi` interface, against whatever plugin
 * registers a `logentries` resource provider (signalk-logbook is the
 * reference implementation, not a requirement). No REST, no tokens, no
 * auth of any kind: in-process plugin access passes no security
 * middleware.
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
  formatBearing,
  observationSources,
  composeFixEntry,
  composeFixText,
  composeTackEntry,
  composeObservationEntry,
  createLogbookClient,
  probeLogbookProvider,
};
