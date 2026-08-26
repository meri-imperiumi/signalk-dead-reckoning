/**
 * Logbook integration: write-through to `signalk-logbook` (SPEC §9.4, §9.5).
 *
 * `fixes` remains the canonical record; logbook entries are formatted
 * exports. Entries are POSTed to the logbook plugin's REST API
 * (`/plugins/signalk-logbook/logs`) from the main thread, always with an
 * explicit `datetime` (confirmations can lag a DR reset by more than the
 * 15-minute `ago` cap).
 *
 * Verified against the logbook plugin source (v0.2.0):
 *  - With explicit `datetime`, the server auto-captures nothing — the
 *    entry contains exactly the fields POSTed, which is what SPEC §9.5's
 *    mapping assigns this plugin anyway (position, log, speed, heading,
 *    observations all composed here).
 *  - `origin` accepts 'manual' | 'auto' | 'agent'; this plugin uses
 *    'agent' for entries generated from human-confirmed fixes and for
 *    auto-detected maneuvers (§9.4: no human judgment in "a tack
 *    happened").
 *  - `body.author` overrides the JWT-derived author (delegation), so
 *    `confirmed_by` flows through as the entry author.
 *  - Auth: the server's auth gate reads the Authorization Bearer header;
 *    the logbook plugin reads the author from the JAUTHENTICATION cookie.
 *    Send both (the signalk-dsc pattern).
 *
 * No retries: a failed write is logged and dropped — `logged_to_logbook`
 * stays 0 in `fixes`, visible there (SPEC explicitly avoids retry and
 * idempotency assumptions).
 *
 * @file logbook.js
 */

const { randomUUID } = require("node:crypto");

/**
 * Human-facing `position.source` string per fix source_type.
 */
const POSITION_SOURCE = {
  gps: "GPS",
  celestial: "Celestial",
  bearing: "Bearing",
  manual: "DR",
};

/**
 * Formats a latitude/longitude as "60.0000°N 24.0000°E" for entry text.
 *
 * @param {number} latitude
 * @param {number} longitude
 * @returns {string}
 */
function formatPosition(latitude, longitude) {
  const lat = `${Math.abs(latitude).toFixed(4)}°${latitude >= 0 ? "N" : "S"}`;
  const lon = `${Math.abs(longitude).toFixed(4)}°${longitude >= 0 ? "E" : "W"}`;
  return `${lat} ${lon}`;
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
 * Composes the `NewEntry`-shaped body for a confirmed fix (SPEC §9.5
 * mapping). Only schema-defined fields are emitted (`additionalProperties:
 * false` on both NewEntry and Observations).
 *
 * @param {object} f
 * @param {string} f.datetime - ISO timestamp of the fix
 * @param {string} f.source_type - 'gps' | 'celestial' | 'bearing' | 'manual'
 * @param {number} f.latitude
 * @param {number} f.longitude
 * @param {string|null} [f.confirmed_by] - crew name
 * @param {number|null} [f.deviation_nm] - DR-vs-fix deviation
 * @param {number|null} [f.dr_log_nm] - DR-integrated distance since last fix (§10.3)
 * @param {number|null} [f.residual_nm] - LOP/CPL residual (cocked-hat size)
 * @param {number|null} [f.observation_count] - number of LOPs/CPLs resolved
 * @param {number|null} [f.stw_kn]
 * @param {number|null} [f.sog_kn]
 * @param {number|null} [f.heading_deg]
 * @param {number|null} [f.course_deg]
 * @param {number|null} [f.sea_state] - WMO sea state code 0-9
 * @returns {object} POST /logs body
 */
function composeFixEntry(f) {
  const body = {
    datetime: f.datetime,
    text: composeFixText(f),
    category: "navigation",
    origin: "agent",
    position: {
      latitude: f.latitude,
      longitude: f.longitude,
      source: POSITION_SOURCE[f.source_type] ?? "DR",
    },
  };
  if (f.confirmed_by) body.author = f.confirmed_by;
  if (Number.isFinite(f.dr_log_nm)) body.log = round(f.dr_log_nm, 1) ?? 0;
  if (Number.isFinite(f.heading_deg)) body.heading = round(f.heading_deg, 1);
  if (Number.isFinite(f.course_deg)) body.course = round(f.course_deg, 1);
  const speed = {};
  if (Number.isFinite(f.sog_kn)) speed.sog = round(f.sog_kn, 1);
  if (Number.isFinite(f.stw_kn)) speed.stw = round(f.stw_kn, 1);
  if (speed.sog != null || speed.stw != null) body.speed = speed;
  // Observations: schema allows only seaState/cloudCoverage/visibility;
  // emit the object only when we actually have one.
  if (Number.isFinite(f.sea_state)) {
    body.observations = { seaState: Math.round(f.sea_state) };
  }
  return body;
}

/**
 * Composes the free-text summary for a fix entry, templated per
 * source_type (SPEC §9.5: celestial/bearing specifics go into `text` —
 * no structured fields exist for them).
 */
function composeFixText(f) {
  const where = formatPosition(f.latitude, f.longitude);
  const by = f.confirmed_by ? ` by ${f.confirmed_by}` : "";
  switch (f.source_type) {
    case "celestial": {
      const n = f.observation_count ?? 1;
      const res = Number.isFinite(f.residual_nm)
        ? `, residual ${f.residual_nm.toFixed(1)} nm`
        : "";
      return `Celestial fix${by}: ${where}, from ${n} sight${n > 1 ? "s" : ""}${res}`;
    }
    case "bearing": {
      const n = f.observation_count ?? 1;
      const res = Number.isFinite(f.residual_nm)
        ? `, residual ${f.residual_nm.toFixed(1)} nm`
        : "";
      return `Bearing fix${by}: ${where}, from ${n} bearing${n > 1 ? "s" : ""}${res}`;
    }
    case "gps":
      return `GPS fix confirmed${by}: ${where}${deviationClause(f)}`;
    default:
      return `Manual fix${by}: ${where}${deviationClause(f)}`;
  }
}

/**
 * The "0.5 nm from DR" clause, when a deviation is known.
 */
function deviationClause(f) {
  return Number.isFinite(f.deviation_nm)
    ? `, ${f.deviation_nm.toFixed(1)} nm from DR`
    : "";
}

/**
 * Composes the `NewEntry`-shaped body for an auto-detected completed
 * tack/gybe (SPEC §9.4). No confirmation step — written directly.
 *
 * @param {object} t
 * @param {"tack"|"gybe"} t.direction
 * @param {number} t.newHeadingDeg - stabilized post-maneuver heading
 * @param {string} t.datetime - ISO timestamp of the maneuver completion
 * @param {number|null} [t.sea_state] - WMO sea state code 0-9
 * @returns {object} POST /logs body
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
    origin: "agent",
  };
  if (Number.isFinite(t.sea_state)) {
    body.observations = { seaState: Math.round(t.sea_state) };
  }
  return body;
}

/**
 * Composes a `NewEntry`-shaped body for a standalone observation
 * (SPEC §9.5): a bearing LOP, a vertical-angle CPL, or a celestial
 * sight. Logged when the observation is recorded — independent of
 * whether it ever resolves into a fix — because taking the sight is
 * itself a navigational event. The `position` is the relevant charted/
 * assumed/object position; `text` describes what was observed.
 *
 * @param {object} o
 * @param {"bearing"|"vertical"|"celestial"} o.kind
 * @param {string} [o.body_or_object] - body name (celestial) or object label
 * @param {string} o.datetime - ISO timestamp
 * @param {string|null} [o.confirmed_by] - watchkeeper (author)
 * @param {number} [o.latitude] - position to anchor the entry
 * @param {number} [o.longitude]
 * @param {object} [o.reduction] - celestial reduction (Hc/Ho/Zn/intercept)
 * @param {number|null} [o.sea_state] - WMO sea state code 0-9
 * @returns {object} POST /logs body
 */
function composeObservationEntry(o) {
  const where =
    Number.isFinite(o.latitude) && Number.isFinite(o.longitude)
      ? formatPosition(o.latitude, o.longitude)
      : null;
  let text;
  if (o.kind === "celestial") {
    const r = o.reduction ?? {};
    const ic = Number.isFinite(r.intercept_nm)
      ? `, intercept ${Math.abs(r.intercept_nm).toFixed(2)} nm ${
          r.intercept_nm >= 0 ? "toward" : "away"
        }`
      : "";
    const zn = Number.isFinite(r.azimuth_true)
      ? `, Zn ${r.azimuth_true.toFixed(1)}°`
      : "";
    text = `${o.body_or_object ?? "Body"} sight${zn}${ic}`;
  } else if (o.kind === "vertical") {
    text = `${o.body_or_object ?? "object"} CPL`;
  } else {
    text = `${o.body_or_object ?? "object"} bearing`;
  }
  if (where) text += ` (${where})`;
  const body = {
    datetime: o.datetime,
    text,
    category: "navigation",
    origin: "agent",
  };
  if (o.confirmed_by) body.author = o.confirmed_by;
  if (where) {
    body.position = {
      latitude: o.latitude,
      longitude: o.longitude,
      source: o.kind === "celestial" ? "Celestial" : "DR",
    };
  }
  if (Number.isFinite(o.sea_state)) {
    body.observations = { seaState: Math.round(o.sea_state) };
  }
  return body;
}

/**
 * Creates a logbook REST client (the signalk-dsc transport pattern).
 *
 * @param {object} opts
 * @param {string} opts.url - POST endpoint, typically
 *   http://localhost:3000/plugins/signalk-logbook/logs
 * @param {string} [opts.token] - Signal K access token; sent as both the
 *   Authorization Bearer header (server auth gate) and the
 *   JAUTHENTICATION cookie (logbook author read)
 * @param {Function} [opts.fetchImpl] - injectable for tests; defaults to
 *   the global fetch
 * @returns {{createEntry: (body: object) => Promise<string|null>}} the
 *   created entry's datetime key on success, null on failure
 */
function createLogbookClient(opts) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const headers = { "Content-Type": "application/json" };
  if (opts.token) {
    headers.Authorization = `Bearer ${opts.token}`;
    headers.Cookie = `JAUTHENTICATION=${opts.token}`;
  }

  return {
    /**
     * POSTs an entry. Resolves the entry's datetime key (the logbook's
     * identity for an entry) on 2xx. Resolves `"unauthorized"` on 401/403
     * (token expired/revoked — caller should resubmit an access request),
     * null on any other failure. Never rejects; callers degrade
     * gracefully.
     *
     * @param {object} body - NewEntry-shaped
     * @returns {Promise<string|null|"unauthorized">}
     */
    async createEntry(body) {
      try {
        const res = await fetchImpl(opts.url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        if (res.status === 401 || res.status === 403) {
          return "unauthorized";
        }
        if (!res.ok) return null;
        return body.datetime;
      } catch {
        return null;
      }
    },
  };
}

/**
 * Creates a Signal K Access Requests client (per the REST API spec):
 * a device (this plugin) asks the server for access, an administrator
 * approves, and the device receives a bearer token. Pure transport —
 * lifecycle state (clientId, stored token, polling cadence) lives with
 * the caller.
 *
 * @param {object} opts
 * @param {string} opts.baseUrl - server origin, e.g. http://localhost:3000
 * @param {Function} [opts.fetchImpl] - injectable for tests
 */
function createAccessRequestClient(opts) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    /**
     * Submits a new access request. `permissions` may be requested
     * explicitly ('readonly' | 'readwrite' | 'admin') — plugin REST routes
     * (where signalk-logbook lives) are admin-gated by the server, so
     * logbook writes need 'admin'. The requested level is surfaced to the
     * approving administrator and granted verbatim on approval.
     *
     * Resolves the poll href, or null when the server doesn't implement
     * access requests (501/404 — open server, writes need no token) or on
     * transport failure.
     *
     * @param {{clientId: string, description: string, permissions?: string}} req
     * @returns {Promise<string|null>}
     */
    async request(req) {
      try {
        const res = await fetchImpl(
          `${opts.baseUrl}/signalk/v1/access/requests`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(req),
          },
        );
        if (res.status === 501 || res.status === 404) return null;
        if (!res.ok) return null;
        const body = await res.json();
        return body?.href ?? null;
      } catch {
        return null;
      }
    },

    /**
     * Polls a pending access request once. Resolves null while PENDING
     * or on failure; 'DENIED' when the administrator denied access;
     * `{token, expirationTime}` when approved.
     *
     * @param {string} href
     * @returns {Promise<null|"DENIED"|{token: string, expirationTime: string|null}>}
     */
    async poll(href) {
      try {
        const res = await fetchImpl(`${opts.baseUrl}${href}`);
        if (!res.ok) return null;
        const body = await res.json();
        if (body?.state !== "COMPLETED") return null;
        const access = body.accessRequest;
        if (access?.permission === "APPROVED") {
          return {
            token: access.token,
            expirationTime: access.expirationTime ?? null,
          };
        }
        return "DENIED";
      } catch {
        return null;
      }
    },
  };
}

/**
 * Generates a fresh v4 UUID client id (persist it — the spec requires the
 * same clientId for every request).
 *
 * @returns {string}
 */
function newClientId() {
  return randomUUID();
}

module.exports = {
  POSITION_SOURCE,
  formatPosition,
  composeFixEntry,
  composeFixText,
  composeTackEntry,
  composeObservationEntry,
  createLogbookClient,
  createAccessRequestClient,
  newClientId,
};
