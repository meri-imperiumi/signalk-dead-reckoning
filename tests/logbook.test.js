/**
 * Tests for logbook entry composition and clients (SPEC §9.4, §9.5).
 * @file logbook.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  formatPosition,
  composeFixEntry,
  composeTackEntry,
  createLogbookClient,
  createAccessRequestClient,
  newClientId,
} = require("../plugin/logbook.js");

test("formatPosition renders N/S E/W with 4 decimals", () => {
  assert.strictEqual(formatPosition(60, 24), "60.0000°N 24.0000°E");
  assert.strictEqual(formatPosition(-33.5, -71.25), "33.5000°S 71.2500°W");
});

test("composeFixEntry: GPS fix maps per SPEC §9.5", () => {
  const body = composeFixEntry({
    datetime: "2026-08-24T12:00:00.000Z",
    source_type: "gps",
    latitude: 60,
    longitude: 24,
    confirmed_by: "Alice",
    deviation_nm: 0.52,
    dr_log_nm: 12.34,
    stw_kn: 5.1,
    heading_deg: 190.5,
    sea_state: 3,
  });
  assert.strictEqual(body.datetime, "2026-08-24T12:00:00.000Z");
  assert.strictEqual(body.category, "navigation");
  assert.strictEqual(body.origin, "agent");
  assert.strictEqual(body.author, "Alice");
  assert.strictEqual(body.position.source, "GPS");
  assert.strictEqual(body.position.latitude, 60);
  assert.strictEqual(body.log, 12.3);
  assert.strictEqual(body.heading, 190.5);
  assert.strictEqual(body.speed.stw, 5.1);
  assert.strictEqual(body.speed.sog, undefined);
  assert.deepStrictEqual(body.observations, { seaState: 3 });
  assert.ok(/GPS fix confirmed by Alice/.test(body.text));
  assert.ok(/0\.5 nm from DR/.test(body.text));
  // Closed-schema discipline: no stray fields.
  assert.ok(!("ago" in body));
  assert.ok(!("course" in body));
  assert.ok(!("waypoint" in body));
});

test("composeFixEntry: celestial fix composes sights + residual into text", () => {
  const body = composeFixEntry({
    datetime: "2026-08-24T12:00:00.000Z",
    source_type: "celestial",
    latitude: 60,
    longitude: 24,
    confirmed_by: "Bob",
    residual_nm: 1.2,
    observation_count: 3,
  });
  assert.strictEqual(body.position.source, "Celestial");
  assert.ok(/Celestial fix by Bob/.test(body.text));
  assert.ok(/from 3 sights/.test(body.text));
  assert.ok(/residual 1\.2 nm/.test(body.text));
});

test("composeFixEntry: unattributed fix omits author and deviation clause when unknown", () => {
  const body = composeFixEntry({
    datetime: "2026-08-24T12:00:00.000Z",
    source_type: "manual",
    latitude: 60,
    longitude: 24,
    confirmed_by: null,
    deviation_nm: null,
  });
  assert.ok(!("author" in body));
  assert.ok(/Manual fix: /.test(body.text));
  assert.ok(!/from DR/.test(body.text));
});

test("composeFixEntry: unknown sea_state emits no observations", () => {
  const body = composeFixEntry({
    datetime: "2026-08-24T12:00:00.000Z",
    source_type: "gps",
    latitude: 0,
    longitude: 0,
    sea_state: null,
  });
  assert.ok(!("observations" in body));
});

test("composeTackEntry: text, category, origin; heading zero-padded", () => {
  const tack = composeTackEntry({
    direction: "tack",
    newHeadingDeg: 45,
    datetime: "2026-08-24T12:00:00.000Z",
  });
  assert.strictEqual(tack.text, "Tack to 045°");
  assert.strictEqual(tack.category, "navigation");
  assert.strictEqual(tack.origin, "agent");

  const gybe = composeTackEntry({
    direction: "gybe",
    newHeadingDeg: 190,
    datetime: "2026-08-24T12:00:00.000Z",
    sea_state: 2,
  });
  assert.strictEqual(gybe.text, "Gybe to 190°");
  assert.deepStrictEqual(gybe.observations, { seaState: 2 });
});

test("createLogbookClient: sends auth both ways, returns datetime on 2xx", async () => {
  const calls = [];
  const client = createLogbookClient({
    url: "http://x/logs",
    token: "tok",
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, status: 201 };
    },
  });
  const ref = await client.createEntry({
    datetime: "2026-08-24T12:00:00Z",
    text: "t",
  });
  assert.strictEqual(ref, "2026-08-24T12:00:00Z");
  assert.strictEqual(calls[0].opts.method, "POST");
  assert.strictEqual(calls[0].opts.headers.Authorization, "Bearer tok");
  assert.strictEqual(calls[0].opts.headers.Cookie, "JAUTHENTICATION=tok");
  assert.strictEqual(calls[0].opts.headers["Content-Type"], "application/json");
  assert.ok(calls[0].url.endsWith("/logs"));
});

test("createLogbookClient: no token omits auth headers; 403 → 'unauthorized'; other failures → null", async () => {
  const noAuth = createLogbookClient({
    url: "http://x/logs",
    fetchImpl: async (_url, opts) => {
      assert.ok(!("Authorization" in opts.headers));
      return { ok: false, status: 500 };
    },
  });
  assert.strictEqual(
    await noAuth.createEntry({ datetime: "x", text: "t" }),
    null,
  );

  const forbidden = createLogbookClient({
    url: "http://x/logs",
    fetchImpl: async () => ({ ok: false, status: 403 }),
  });
  assert.strictEqual(
    await forbidden.createEntry({ datetime: "x", text: "t" }),
    "unauthorized",
  );

  const throwing = createLogbookClient({
    url: "http://x/logs",
    fetchImpl: async () => {
      throw new Error("network down");
    },
  });
  assert.strictEqual(
    await throwing.createEntry({ datetime: "x", text: "t" }),
    null,
  );
});

test("access request client: request posts clientId/description/permissions, returns href", async () => {
  const seen = [];
  const access = createAccessRequestClient({
    baseUrl: "http://x",
    fetchImpl: async (url, opts) => {
      seen.push({ url, body: JSON.parse(opts.body) });
      return {
        ok: true,
        status: 202,
        json: async () => ({
          state: "PENDING",
          href: "/signalk/v1/requests/abc",
        }),
      };
    },
  });
  const href = await access.request({
    clientId: "uuid-1",
    description: "desc",
    permissions: "admin",
  });
  assert.strictEqual(href, "/signalk/v1/requests/abc");
  assert.ok(seen[0].url.includes("/signalk/v1/access/requests"));
  assert.strictEqual(seen[0].body.permissions, "admin");
});

test("access request client: 501/404 → null (open server)", async () => {
  for (const status of [501, 404]) {
    const access = createAccessRequestClient({
      baseUrl: "http://x",
      fetchImpl: async () => ({ ok: false, status }),
    });
    assert.strictEqual(
      await access.request({ clientId: "u", description: "d" }),
      null,
    );
  }
});

test("access request client: poll states — pending null, approved token, denied", async () => {
  const mk = (body) =>
    createAccessRequestClient({
      baseUrl: "http://x",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => body,
      }),
    });
  assert.strictEqual(await mk({ state: "PENDING" }).poll("/href"), null);
  assert.deepStrictEqual(
    await mk({
      state: "COMPLETED",
      statusCode: 200,
      accessRequest: {
        permission: "APPROVED",
        token: "t1",
        expirationTime: "2027-01-01T00:00:00Z",
      },
    }).poll("/href"),
    { token: "t1", expirationTime: "2027-01-01T00:00:00Z" },
  );
  assert.strictEqual(
    await mk({
      state: "COMPLETED",
      statusCode: 200,
      accessRequest: { permission: "DENIED" },
    }).poll("/href"),
    "DENIED",
  );
});

test("newClientId returns distinct v4 UUIDs", () => {
  const a = newClientId();
  const b = newClientId();
  assert.notStrictEqual(a, b);
  assert.match(
    a,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});
