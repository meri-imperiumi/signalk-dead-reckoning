/**
 * Tests for logbook entry composition and the Resources API client
 * (SPEC §9.4, §9.5; logentries resource contract).
 * @file logbook.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  seaStateBeaufort,
  formatBearingTrue,
  observationSources,
  composeFixEntry,
  composeTackEntry,
  composeObservationEntry,
  createLogbookClient,
  probeLogbookProvider,
} = require("../plugin/logbook.js");

// The SI units the logentries contract speaks (mirrored from the module).
const NM_TO_M = 1852;
const KN_TO_MS = 463 / 900;
const DEG_TO_RAD = Math.PI / 180;

/**
 * All telemetry pathvalues for a path (the contract allows duplicates
 * per $source; composition emits one per path).
 */
function pv(entry, path) {
  return (entry.telemetry ?? []).filter((t) => t.path === path);
}

function pv1(entry, path) {
  const all = pv(entry, path);
  assert.strictEqual(all.length, 1, `one ${path} pathvalue`);
  return all[0].value;
}

test("seaStateBeaufort: WMO Douglas→Beaufort correspondence", () => {
  assert.strictEqual(seaStateBeaufort(0), 0);
  assert.strictEqual(seaStateBeaufort(3), 3);
  assert.strictEqual(seaStateBeaufort(5), 6);
  assert.strictEqual(seaStateBeaufort(9), 12);
  assert.strictEqual(seaStateBeaufort(null), null);
  assert.strictEqual(seaStateBeaufort(10), null, "Douglas tops out at 9");
  assert.strictEqual(seaStateBeaufort(2.4), 2, "rounded to the code");
});

test("composeFixEntry: GPS fix maps per SPEC §9.5 (resources schema, SI)", () => {
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
  // Human-confirmed fix the machine writes down: 'agent' (SPEC §9.5).
  assert.strictEqual(body.origin, "agent");
  assert.strictEqual(body.author, "Alice");
  const position = pv1(body, "navigation.position");
  assert.strictEqual(position.source, "GPS");
  assert.strictEqual(position.latitude, 60);
  assert.strictEqual(position.longitude, 24);
  // DR-integrated log in meters (SI), never GPS-derived.
  assert.ok(Math.abs(pv1(body, "navigation.log") - 12.34 * NM_TO_M) < 1e-9);
  assert.ok(
    Math.abs(pv1(body, "navigation.headingTrue") - 190.5 * DEG_TO_RAD) < 1e-12,
  );
  assert.ok(
    Math.abs(pv1(body, "navigation.speedThroughWater") - 5.1 * KN_TO_MS) <
      1e-12,
  );
  assert.strictEqual(pv(body, "navigation.speedOverGround").length, 0);
  // Douglas 3 rides the Beaufort-scale resource path (WMO: force 3).
  assert.strictEqual(pv1(body, "environment.water.seaState"), 3);
  assert.ok(/GPS fix/.test(body.text));
  assert.ok(/0\.5 NM from DR/.test(body.text));
  assert.ok(!/by Alice/.test(body.text), "author stays in metadata, not text");
  assert.ok(
    !/60\.0000/.test(body.text),
    "coordinates stay in the position pathvalue",
  );
  // No stray top-level fields beyond the logentries contract.
  assert.ok(!("ago" in body));
  assert.ok(!("position" in body));
  assert.ok(!("course" in body));
  assert.ok(!("waypoint" in body));
  assert.ok(!("observations" in body));
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
  assert.strictEqual(pv1(body, "navigation.position").source, "Celestial");
  assert.ok(/Celestial fix/.test(body.text));
  assert.ok(!/by Bob/.test(body.text), "author stays in metadata, not text");
  assert.ok(/from 3 sights/.test(body.text));
  assert.ok(/residual 1\.2 NM/.test(body.text));
  assert.ok(
    !/60\.0000/.test(body.text),
    "coordinates stay in the position pathvalue",
  );
});

test("composeFixEntry: running fix names the fix it advanced from", () => {
  const body = composeFixEntry({
    datetime: "2026-08-24T12:00:00.000Z",
    source_type: "celestial",
    latitude: 60,
    longitude: 24,
    residual_nm: 2.4,
    derived_from_fix_id: 7,
    observations: [
      { kind: "lop", lop_type: "celestial", body_or_object: "Sun LL" },
    ],
  });
  assert.ok(
    /Celestial fix from Sun LL sight \(running fix, advanced from fix #7\)/.test(
      body.text,
    ),
    body.text,
  );
  assert.ok(/residual 2\.4 NM/.test(body.text));
  // Without derived_from_fix_id there is no running-fix clause.
  const plain = composeFixEntry({
    datetime: "2026-08-24T12:00:00.000Z",
    source_type: "celestial",
    latitude: 60,
    longitude: 24,
    residual_nm: 2.4,
    observations: [
      { kind: "lop", lop_type: "celestial", body_or_object: "Sun LL" },
    ],
  });
  assert.ok(!/running fix/.test(plain.text), plain.text);
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

test("composeFixEntry: unknown sea_state emits no seaState pathvalue", () => {
  const body = composeFixEntry({
    datetime: "2026-08-24T12:00:00.000Z",
    source_type: "gps",
    latitude: 0,
    longitude: 0,
    sea_state: null,
  });
  assert.strictEqual(pv(body, "environment.water.seaState").length, 0);
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
  assert.strictEqual(pv1(body, "navigation.position").source, "Backfill");
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
  // Pure automation, no human in the loop: 'auto'.
  assert.strictEqual(tack.origin, "auto");
  assert.strictEqual(tack.telemetry, undefined);

  const gybe = composeTackEntry({
    direction: "gybe",
    newHeadingDeg: 190,
    datetime: "2026-08-24T12:00:00.000Z",
    sea_state: 2,
  });
  assert.strictEqual(gybe.text, "Gybe to 190°");
  assert.strictEqual(pv1(gybe, "environment.water.seaState"), 2);
});

test("createLogbookClient: setResource under a fresh UUID, resolves {id}", async () => {
  const calls = [];
  const client = createLogbookClient({
    resourcesApi: {
      async setResource(type, id, value) {
        calls.push({ type, id, value });
      },
    },
  });
  const body = { datetime: "2026-08-24T12:00:00Z", text: "t" };
  const ref = await client.createEntry(body);
  assert.match(
    ref.id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "resource id is a v4 UUID",
  );
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].type, "logentries");
  assert.strictEqual(calls[0].id, ref.id);
  assert.strictEqual(calls[0].value, body, "the composed entry, verbatim");
});

test("createLogbookClient: provider rejection → null (degrade, never throw)", async () => {
  const client = createLogbookClient({
    resourcesApi: {
      async setResource() {
        throw new Error("no logentries provider registered");
      },
    },
  });
  assert.strictEqual(await client.createEntry({ text: "t" }), null);
});

test("probeLogbookProvider: resolves when the provider answers, rejects otherwise", async () => {
  await probeLogbookProvider({
    async listResources(type, query) {
      assert.strictEqual(type, "logentries");
      // `limit` alone is a complete window under the contract's
      // "no silent windows" rule.
      assert.deepStrictEqual(query, { limit: 1 });
      return {};
    },
  });

  await assert.rejects(
    probeLogbookProvider({
      async listResources() {
        throw new Error("Unknown resource type");
      },
    }),
  );
  await assert.rejects(probeLogbookProvider(undefined));
  await assert.rejects(probeLogbookProvider({}));
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
  // Watchkeeper-entered observation the machine writes down: 'agent'.
  assert.strictEqual(body.origin, "agent");
  assert.strictEqual(body.author, "Alice");
  assert.match(body.text, /Sun sight/);
  assert.doesNotMatch(
    body.text,
    /by Alice/,
    "author stays in metadata, not text",
  );
  assert.match(body.text, /Zn 180\.0/);
  assert.match(body.text, /intercept 2\.50 NM toward/);
  assert.strictEqual(pv1(body, "navigation.position").source, "Celestial");
  assert.strictEqual(pv1(body, "environment.water.seaState"), 3);
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
  assert.strictEqual(pv1(body, "navigation.position").source, "DR");
});

test("composeObservationEntry: coordinates stay in the position pathvalue, not text", () => {
  const body = composeObservationEntry({
    kind: "bearing",
    datetime: "2026-01-01T12:00:00Z",
    body_or_object: "Vessel COULD BE WORSE",
    azimuth_true: 90,
    latitude: -18.8651,
    longitude: -159.8008,
  });
  assert.strictEqual(body.text, "Vessel COULD BE WORSE bearing 090°T");
  const position = pv1(body, "navigation.position");
  assert.strictEqual(position.latitude, -18.8651);
  assert.strictEqual(position.longitude, -159.8008);
  assert.strictEqual(position.source, "DR");
});

test("composeObservationEntry: vertical-angle CPL carries its radius", () => {
  const body = composeObservationEntry({
    kind: "vertical",
    datetime: "2026-01-01T12:00:00Z",
    body_or_object: "lighthouse",
    radius_nm: 0.42,
  });
  assert.match(body.text, /lighthouse CPL 0.4 NM/);
  assert.strictEqual(body.telemetry, undefined);
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
