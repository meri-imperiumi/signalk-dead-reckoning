/**
 * Tests for logbook entry composition and clients (SPEC §9.4, §9.5).
 * @file logbook.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  formatPosition,
  formatBearingTrue,
  observationSources,
  composeFixEntry,
  composeTackEntry,
  composeObservationEntry,
  createLogbookClient,
  createAccessRequestClient,
  newClientId,
} = require("../plugin/logbook.js");

test("formatPosition renders decimal/dm/dms like the webapp", () => {
  assert.strictEqual(formatPosition(60, 24, "decimal"), "60.0000 N 24.0000 E");
  assert.strictEqual(
    formatPosition(-33.5, -71.25, "decimal"),
    "33.5000 S 71.2500 W",
  );
  assert.strictEqual(
    formatPosition(60.0, 24.5, "dm"),
    "60°00.000' N 24°30.000' E",
  );
  assert.strictEqual(
    formatPosition(-18.8651, -159.8008, "dms"),
    "18°51'54.4\" S 159°48'02.9\" W",
  );
  // Default stays decimal for callers that don't pass a preference.
  assert.strictEqual(formatPosition(60, 24), "60.0000 N 24.0000 E");
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
  assert.strictEqual(body.origin, "auto");
  assert.strictEqual(body.author, "Alice");
  assert.strictEqual(body.position.source, "GPS");
  assert.strictEqual(body.position.latitude, 60);
  assert.strictEqual(body.log, 12.3);
  assert.strictEqual(body.heading, 190.5);
  assert.strictEqual(body.speed.stw, 5.1);
  assert.strictEqual(body.speed.sog, undefined);
  assert.deepStrictEqual(body.observations, { seaState: 3 });
  assert.ok(/GPS fix/.test(body.text));
  assert.ok(/0\.5 NM from DR/.test(body.text));
  assert.ok(!/by Alice/.test(body.text), "author stays in metadata, not text");
  assert.ok(
    !/60\.0000/.test(body.text),
    "coordinates stay in the position field",
  );
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
  assert.ok(/Celestial fix/.test(body.text));
  assert.ok(!/by Bob/.test(body.text), "author stays in metadata, not text");
  assert.ok(/from 3 sights/.test(body.text));
  assert.ok(/residual 1\.2 NM/.test(body.text));
  assert.ok(
    !/60\.0000/.test(body.text),
    "coordinates stay in the position field",
  );
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
  assert.strictEqual(body.text, "Manual fix");
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

test("formatBearingTrue: zero-padded, normalized to 0-359, true notation", () => {
  assert.strictEqual(formatBearingTrue(0), "000°T");
  assert.strictEqual(formatBearingTrue(9.4), "009°T");
  assert.strictEqual(formatBearingTrue(47.2), "047°T");
  assert.strictEqual(formatBearingTrue(360), "000°T");
  assert.strictEqual(formatBearingTrue(370), "010°T");
  assert.strictEqual(formatBearingTrue(-90), "270°T");
});

test("observationSources: shapes bearing LOPs, celestial sights, CPLs", () => {
  const out = observationSources([
    {
      kind: "lop",
      lop_type: "bearing",
      body_or_object: "Aitutaki Atoll",
      azimuth_true: 123,
    },
    { kind: "lop", lop_type: "celestial", body_or_object: "Sun" },
    {
      kind: "cpl",
      cpl_type: "vertical-angle",
      source_object: "lighthouse",
      radius_nm: 0.42,
    },
  ]);
  assert.deepStrictEqual(out, [
    "Aitutaki Atoll bearing 123°T",
    "Sun sight",
    "lighthouse CPL 0.4 NM",
  ]);
  assert.deepStrictEqual(observationSources(null), []);
  assert.deepStrictEqual(observationSources(undefined), []);
});

test("composeFixEntry: manual fix from bearing observations lists the sources", () => {
  const body = composeFixEntry({
    datetime: "2026-08-29T07:16:51.000Z",
    source_type: "manual",
    latitude: -18.8651,
    longitude: -159.8008,
    confirmed_by: "bergie",
    deviation_nm: 0.12,
    deviation_bearing: 45,
    observations: [
      {
        kind: "lop",
        lop_type: "bearing",
        body_or_object: "Aitutaki Atoll",
        azimuth_true: 123,
      },
      {
        kind: "lop",
        lop_type: "bearing",
        body_or_object: "Vessel Foo",
        azimuth_true: 321,
      },
    ],
    positionFormat: "dms",
  });
  assert.strictEqual(body.author, "bergie");
  // Sources named, coordinates & author kept out of the text.
  assert.ok(
    /Manual fix from Aitutaki Atoll bearing 123°T, Vessel Foo bearing 321°T/.test(
      body.text,
    ),
  );
  assert.ok(!/bergie/.test(body.text));
  assert.ok(!/18°/.test(body.text));
  // Deviation carries distance + direction, in NM (not nm).
  assert.ok(/0\.1 NM at 045°T from DR/.test(body.text));
});

test("composeFixEntry: deviation clause carries bearing direction in NM", () => {
  const body = composeFixEntry({
    datetime: "2026-08-24T12:00:00.000Z",
    source_type: "gps",
    latitude: 60,
    longitude: 24,
    deviation_nm: 0.52,
    deviation_bearing: 90,
  });
  assert.ok(/0\.5 NM at 090°T from DR/.test(body.text));
  assert.ok(!/ nm /.test(body.text), "no lowercase nm (nanometers)");
});

test("composeFixEntry: backfill fix gets its own label, not Manual", () => {
  const body = composeFixEntry({
    datetime: "2026-08-24T12:00:00.000Z",
    source_type: "backfill",
    latitude: 60,
    longitude: 24,
    deviation_nm: 1.0,
    deviation_bearing: 180,
  });
  assert.strictEqual(body.position.source, "Backfill");
  assert.ok(/^Backfill fix, 1\.0 NM at 180°T from DR$/.test(body.text));
});

test("composeTackEntry: text, category, origin; heading zero-padded", () => {
  const tack = composeTackEntry({
    direction: "tack",
    newHeadingDeg: 45,
    datetime: "2026-08-24T12:00:00.000Z",
  });
  assert.strictEqual(tack.text, "Tack to 045°");
  assert.strictEqual(tack.category, "navigation");
  assert.strictEqual(tack.origin, "auto");

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

test("access request client: transport failure → 'unreachable' (distinct from open server)", async () => {
  const access = createAccessRequestClient({
    baseUrl: "http://x",
    fetchImpl: async () => {
      throw new Error("connect ECONNREFUSED");
    },
  });
  assert.strictEqual(
    await access.request({ clientId: "u", description: "d" }),
    "unreachable",
  );
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

test("composeObservationEntry: celestial sight with reduction", () => {
  const body = composeObservationEntry({
    kind: "celestial",
    datetime: "2026-01-01T12:00:00Z",
    body_or_object: "Sun",
    confirmed_by: "Alice",
    latitude: 60,
    longitude: 24,
    reduction: { azimuth_true: 180, intercept_nm: 2.5 },
    sea_state: 3,
  });
  assert.strictEqual(body.category, "navigation");
  assert.strictEqual(body.origin, "auto");
  assert.strictEqual(body.author, "Alice");
  assert.match(body.text, /Sun sight/);
  assert.doesNotMatch(
    body.text,
    /by Alice/,
    "author stays in metadata, not text",
  );
  assert.match(body.text, /Zn 180\.0/);
  assert.match(body.text, /intercept 2\.50 NM toward/);
  assert.strictEqual(body.position.source, "Celestial");
  assert.strictEqual(body.observations.seaState, 3);
});

test("composeObservationEntry: bearing LOP names the object and the bearing", () => {
  const body = composeObservationEntry({
    kind: "bearing",
    datetime: "2026-01-01T12:00:00Z",
    body_or_object: "lighthouse",
    azimuth_true: 47.2,
    confirmed_by: null,
    latitude: 60,
    longitude: 24,
  });
  assert.match(body.text, /lighthouse bearing 047°T/);
  assert.strictEqual(body.author, undefined);
  assert.strictEqual(body.position.source, "DR");
});

test("composeObservationEntry: coordinates stay in the position field, not text", () => {
  const body = composeObservationEntry({
    kind: "bearing",
    datetime: "2026-01-01T12:00:00Z",
    body_or_object: "Vessel COULD BE WORSE",
    azimuth_true: 90,
    latitude: -18.8651,
    longitude: -159.8008,
  });
  assert.strictEqual(body.text, "Vessel COULD BE WORSE bearing 090°T");
  assert.strictEqual(body.position.latitude, -18.8651);
  assert.strictEqual(body.position.longitude, -159.8008);
  assert.strictEqual(body.position.source, "DR");
});

test("composeObservationEntry: vertical-angle CPL carries its radius", () => {
  const body = composeObservationEntry({
    kind: "vertical",
    datetime: "2026-01-01T12:00:00Z",
    body_or_object: "lighthouse",
    radius_nm: 0.42,
  });
  assert.match(body.text, /lighthouse CPL 0.4 NM/);
  assert.strictEqual(body.position, undefined);
});

test("composeObservationEntry: intercept away when negative", () => {
  const body = composeObservationEntry({
    kind: "celestial",
    datetime: "2026-01-01T12:00:00Z",
    body_or_object: "Polaris",
    reduction: { azimuth_true: 0, intercept_nm: -1.2 },
  });
  assert.match(body.text, /intercept 1\.20 NM away/);
});
