/**
 * Tests for CPA/TCPA math and the AIS target details folding (work
 * doc #30): both own-ship references, stationary/diverging edge cases,
 * ship-type names, flag emoji, and the alarm cue.
 * @file dr-cpa.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const vmPromise = import("../public/dr-viewmodel.js");

async function loadVm() {
  return vmPromise;
}

const closeTo = (actual, expected, tol, msg) =>
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${msg}: ${actual} vs ${expected} (±${tol})`,
  );

test("cpaTcpa: head-on closing targets compute CPA distance and time", async () => {
  const vm = await loadVm();
  // Own at origin heading north at 6 kn; target 10 nm north heading
  // south at 6 kn. Closing at 12 kn → CPA at 5 minutes, range 0.
  const cpa = vm.cpaTcpa([60, 24], 0, 6, [60.16667, 24], 180, 6);
  assert.ok(cpa, "cpa computed");
  closeTo(cpa.cpaNm, 0, 0.02, "head-on CPA is zero");
  closeTo(cpa.tcpaMin, 50, 0.2, "10 nm closing at 12 kn = 50 min");
});

test("cpaTcpa: parallel courses keep the beam distance", async () => {
  const vm = await loadVm();
  // Both heading north at 6 kn, 2 nm apart east-west: CPA = 2 nm.
  const cpa = vm.cpaTcpa([60, 24], 0, 6, [60, 24.0667], 0, 6);
  closeTo(cpa.cpaNm, 2, 0.05, "parallel tracks");
  assert.ok(cpa.tcpaMin == null || cpa.tcpaMin >= 0, "tcpa sane");
});

test("cpaTcpa: diverging pair reports CPA now, no TCPA", async () => {
  const vm = await loadVm();
  // Target already opening: heading away north while we head south.
  const cpa = vm.cpaTcpa([60, 24], 180, 6, [60.05, 24], 0, 6);
  assert.equal(cpa.tcpaMin, null, "no future CPA");
  closeTo(cpa.cpaNm, vm.distanceNm([60, 24], [60.05, 24]), 0.001, "range now");
});

test("cpaTcpa: stationary own ship, crossing target still has a CPA", async () => {
  const vm = await loadVm();
  // We are stopped; target 3 nm south and 1.5 nm west crossing east at
  // 6 kn → passes abeam 15 minutes from now at 3 nm.
  const cpa = vm.cpaTcpa([60, 24], null, null, [59.95, 23.95], 90, 6);
  assert.ok(cpa, "cpa");
  closeTo(cpa.cpaNm, 3, 0.05, "abeam distance");
  closeTo(cpa.tcpaMin, 15, 0.2, "1.5 nm east at 6 kn = 15 min");
});

test("cpaTcpa: no motion anywhere → CPA is the present range", async () => {
  const vm = await loadVm();
  const cpa = vm.cpaTcpa([60, 24], null, null, [60.05, 24], null, null);
  closeTo(cpa.cpaNm, 3, 0.01, "range");
  assert.equal(cpa.tcpaMin, null);
  assert.equal(vm.cpaTcpa(null, 0, 5, [60, 24], 0, 5), null);
});

test("aisShipTypeName: exact codes and classed families", async () => {
  const vm = await loadVm();
  assert.equal(vm.aisShipTypeName(36), "Sailing");
  assert.equal(vm.aisShipTypeName(30), "Fishing");
  assert.equal(vm.aisShipTypeName(70), "Cargo");
  assert.equal(vm.aisShipTypeName(80), "Tanker");
  assert.equal(vm.aisShipTypeName(60), "Passenger");
  assert.equal(vm.aisShipTypeName(52), "Tug");
  assert.equal(vm.aisShipTypeName(44), "High-speed craft");
  assert.equal(vm.aisShipTypeName(99), "Other");
  assert.equal(vm.aisShipTypeName(null), null);
  assert.equal(vm.aisShipTypeName(17), null, "unassigned range hides");
});

test("flagForCountry: emoji from ISO code, junk rejected", async () => {
  const vm = await loadVm();
  assert.equal(vm.flagForCountry("fi"), "🇫🇮 FI");
  assert.equal(vm.flagForCountry("SE"), "🇸🇪 SE");
  assert.equal(vm.flagForCountry(null), null);
  assert.equal(vm.flagForCountry("FIN"), null, "not alpha-2");
  assert.equal(vm.flagForCountry(""), null);
});

test("applyAisDelta: static details fold from leaf and root paths", async () => {
  const vm = await loadVm();
  const store = new Map();
  vm.applyAisDelta(store, {
    context: "vessels.230123456",
    updates: [
      {
        values: [
          { path: "design.length.overall", value: 12.5 },
          { path: "design.beam", value: 4.1 },
          { path: "registrations.country", value: "FI" },
          { path: "aisShipType", value: 37 },
        ],
      },
    ],
  });
  let t = store.get("vessels.230123456");
  assert.equal(t.lengthM, 12.5);
  assert.equal(t.beamM, 4.1);
  assert.equal(t.country, "FI");
  assert.equal(t.shipType, 37);

  vm.applyAisDelta(store, {
    context: "vessels.230123456",
    updates: [
      {
        values: [
          { path: "design.length", value: { overall: { value: 13 } } },
          { path: "navigation.destination", value: "Helsinki" },
          { path: "navigation.destination.eta", value: "2026-09-22T14:30:00Z" },
        ],
      },
    ],
  });
  t = store.get("vessels.230123456");
  assert.equal(t.lengthM, 13, "object design.length unwraps overall");
  assert.equal(t.destination, "Helsinki");
  assert.equal(t.destinationEtaMs, Date.parse("2026-09-22T14:30:00Z"));

  // Root-value folding (providers that publish the whole vessel object).
  vm.applyAisDelta(store, {
    context: "vessels.230123456",
    updates: [
      {
        values: [
          {
            path: "",
            value: {
              design: { length: { overall: 14 }, beam: { value: 4.4 } },
              registrations: { country: "SE" },
              type: "Sailing",
              navigation: { destination: "Mariehamn" },
            },
          },
        ],
      },
    ],
  });
  t = store.get("vessels.230123456");
  assert.equal(t.lengthM, 14);
  assert.equal(t.beamM, 4.4);
  assert.equal(t.country, "SE");
  assert.equal(t.typeName, "Sailing");
  assert.equal(t.destination, "Mariehamn");
});

test("seedAisFromSnapshot: static details arrive from the REST snapshot", async () => {
  const vm = await loadVm();
  const store = new Map();
  vm.seedAisFromSnapshot(
    store,
    {
      vessels: {
        "vessels.230123456": {
          name: "ARCTIC",
          mmsi: "230123456",
          design: {
            length: { overall: { value: 15.2 } },
            beam: { value: 4.6 },
          },
          registrations: { country: { value: "FI" } },
          aisShipType: { value: 37 },
          navigation: { destination: { value: "Hanko" } },
        },
      },
    },
    {},
  );
  const t = store.get("vessels.230123456");
  assert.equal(t.lengthM, 15.2);
  assert.equal(t.beamM, 4.6);
  assert.equal(t.country, "FI");
  assert.equal(t.shipType, 37);
  assert.equal(t.destination, "Hanko");
});

test("aisMarkerSpec: CPA in tooltip, alarm color inside the watch limits", async () => {
  const vm = await loadVm();
  const T0 = Date.now();
  // Own heading north at 6 kn; target 1 nm north heading south 6 kn:
  // head-on, CPA ~0 in ~5 min — well inside the watch limits.
  const target = {
    context: "vessels.230123456",
    mmsi: "230123456",
    lat: 60.01666,
    lon: 24,
    cogRad: Math.PI,
    sogMs: 6 / vm.msToKn(1),
    tMs: T0,
    receivedMs: T0,
  };
  const spec = vm.aisMarkerSpec(target, T0, [60, 24], {
    ownCourseDeg: 0,
    ownSpeedKn: 6,
  });
  assert.ok(spec, "spec");
  assert.ok(spec.alarm, "head-on close pass alarms");
  assert.equal(spec.color, vm.STYLE.aisAlarm);
  assert.match(spec.tooltip, /CPA/, "CPA rides the tooltip");
  assert.ok(spec.cpaNm < 0.1, `CPA tiny: ${spec.cpaNm}`);
  assert.ok(spec.tcpaMin > 0 && spec.tcpaMin < 10);

  // Same geometry but diverging: no alarm.
  target.cogRad = 0; // target also heads north, same speed
  const calm = vm.aisMarkerSpec(target, T0, [60, 24], {
    ownCourseDeg: 0,
    ownSpeedKn: 6,
  });
  assert.equal(calm.alarm, false, "parallel targets don't alarm");
  assert.equal(calm.color, vm.STYLE.ais);
});

test("aisMarkerSpec: no CPA figures without own motion", async () => {
  const vm = await loadVm();
  const T0 = Date.now();
  const target = {
    context: "vessels.230123456",
    lat: 60,
    lon: 24,
    tMs: T0,
    receivedMs: T0,
  };
  const spec = vm.aisMarkerSpec(target, T0, [60.01, 24], {});
  assert.equal(spec.cpaNm, null);
  assert.equal(spec.tcpaMin, null);
  assert.equal(spec.alarm, false);
});

test("ownBearingRows: DR and GPS rows, missing source hidden", async () => {
  const vm = await loadVm();
  const rows = vm.ownBearingRows(
    { dr: [60, 24], gps: [60.01, 24] },
    [60.05, 24],
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].source, "DR");
  closeTo(rows[0].bearingDeg, 0, 0.1, "due north");
  closeTo(rows[0].distNm, 3, 0.01, "DR range");
  assert.equal(rows[1].source, "GPS");

  assert.deepEqual(
    vm
      .ownBearingRows({ dr: null, gps: [60, 24] }, [60.05, 24])
      .map((r) => r.source),
    ["GPS"],
    "absent DR position → no DR row",
  );
  assert.deepEqual(vm.ownBearingRows({}, [60.05, 24]), []);
});

test("etaLabel: Zulu, same-day time only, date when older", async () => {
  const vm = await loadVm();
  const now = Date.parse("2026-09-22T12:00:00Z");
  assert.equal(vm.etaLabel(Date.parse("2026-09-22T14:30:00Z"), now), "14:30Z");
  assert.equal(
    vm.etaLabel(Date.parse("2026-09-25T14:30:00Z"), now),
    "25.9. 14:30Z",
  );
  assert.equal(vm.etaLabel(null, now), "");
});
