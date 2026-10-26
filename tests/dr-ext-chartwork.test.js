/**
 * Tests for the plotter-extension chartwork render model
 * (`public/dr-ext-chartwork.js`, work doc #38) and the manifest that
 * wires it (plugin/plotterext.js): feature building from the plugin
 * REST rows, id/name conventions, palette coverage of the style JSON,
 * override button visibility, and manifest structural pins (panel /
 * button / action / overlay references resolve).
 *
 * @file dr-ext-chartwork.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const chartworkPromise = import("../public/dr-ext-chartwork.js");
const vmPromise = import("../public/dr-viewmodel.js");

/** Loads the chartwork + viewmodel modules (shared across tests). */
async function load() {
  const [cw, vm] = await Promise.all([chartworkPromise, vmPromise]);
  return { cw, vm };
}

const M = 1852; // metres per NM

test("diffFeatures upserts only what changed and removes what is gone", async () => {
  const { cw } = await load();
  const a = {
    id: "lop:1",
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: [
        [0, 0],
        [1, 1],
      ],
    },
    properties: {},
  };
  const b = {
    id: "ghost",
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: [
        [0, 0],
        [0, 1],
      ],
    },
    properties: {},
  };

  // First push: everything is new.
  const first = cw.diffFeatures(null, [a, b]);
  assert.deepEqual(first.upsert, [a, b]);
  assert.deepEqual(first.remove, []);

  // Unchanged state → empty diff (the runtime skips the call).
  const base = first.next;
  assert.deepEqual(cw.diffFeatures(base, [a, b]).upsert, []);

  // The ghost tail grew; a feature disappeared.
  const b2 = {
    ...b,
    geometry: {
      type: "LineString",
      coordinates: [
        [0, 0],
        [0, 1],
        [0, 2],
      ],
    },
  };
  const second = cw.diffFeatures(base, [b2]);
  assert.deepEqual(second.upsert, [b2]);
  assert.deepEqual(second.remove, ["lop:1"]);
});

test("clipLineToBounds clips a long line to the box, world-copy-safe", async () => {
  const { cw, vm } = await load();
  // A 60 nm N–S LoP through the vessel — the z16 canvas-precision
  // breaker — clipped to the inflated view bounds.
  const box = [-174.5, -18.7, -174.3, -18.5]; // [w, s, e, n]
  const line = [
    [-174.4, -18.2],
    [-174.4, -19.0],
  ];
  const runs = cw.clipLineToBounds(line, box);
  assert.equal(runs.length, 1);
  for (const [lon, lat] of runs[0]) {
    assert.ok(lon >= box[0] - 1e-9 && lon <= box[2] + 1e-9, `lon ${lon}`);
    assert.ok(lat >= box[1] - 1e-9 && lat <= box[3] + 1e-9, `lat ${lat}`);
  }
  // The clipped line still crosses the box (its lat span is the box's).
  const lats = runs[0].map(([, lat]) => lat);
  assert.ok(Math.min(...lats) <= box[1] + 1e-6);
  assert.ok(Math.max(...lats) >= box[3] - 1e-6);

  // A line entirely outside clips to nothing.
  assert.deepEqual(
    cw.clipLineToBounds(
      [
        [10, 10],
        [10, 11],
      ],
      box,
    ),
    [],
  );
  // The fold regression (sea trial: one LoP changed direction when
  // zoomed in): a diagonal ray whose far end lies WEST of the box's
  // west edge must not fold +360° across the frame — the clipped
  // segment keeps the original LoP's bearing.
  const a = [-174.25, -18.63]; // the tower, east of the box
  const b = [-175.3, -19.13]; // 1° west, 0.5° south — past the west edge
  const folded = cw.clipLineToBounds([a, b], box);
  assert.equal(folded.length, 1);
  const clippedBearing = vm.bearingBetween(
    [folded[0][0][1], folded[0][0][0]],
    [folded[0][1][1], folded[0][1][0]],
  );
  const originalBearing = vm.bearingBetween([a[1], a[0]], [b[1], b[0]]);
  const off = Math.abs(((clippedBearing - originalBearing + 540) % 360) - 180);
  assert.ok(
    off < 1,
    `clipped segment keeps the bearing (${clippedBearing} vs ${originalBearing})`,
  );
  for (const [lon] of folded[0]) {
    assert.ok(lon >= box[0] - 1e-9 && lon <= box[2] + 1e-9, `lon ${lon}`);
  }
  // A fully-inside line keeps BOTH endpoints (the run must not lose
  // its last vertex).
  const inside = cw.clipLineToBounds(
    [
      [-174.42, -18.6],
      [-174.38, -18.62],
    ],
    box,
  );
  assert.equal(inside.length, 1);
  assert.equal(inside[0].length, 2);

  // A line crossing the antimeridian inside a crossing box stays in
  // the view's frame (the clip runs the short way).
  const crossingBox = [179.9, -18.7, -179.9, -18.5]; // w > e: crossing
  const crossingLine = [
    [180.05, -18.2],
    [180.05, -19.0],
  ];
  const crossed = cw.clipLineToBounds(crossingLine, crossingBox);
  assert.equal(crossed.length, 1);
  // The output is normalized to [-180, 180): 180.05 → -179.95.
  for (const [lon] of crossed[0]) {
    assert.ok(Math.abs(Math.abs(lon) - 179.95) < 0.1, `lon ${lon}`);
  }
});

test("clipPolygonToBounds keeps the inside of a huge circle", async () => {
  const { cw } = await load();
  const box = [-174.5, -18.7, -174.3, -18.5];
  // A 20 nm circle around a point in the box: only the inside survives.
  const ring = cw.circleRing([-18.6, -174.4], 20);
  const clipped = cw.clipPolygonToBounds(ring, box);
  assert.ok(clipped.length > 3, "clipped ring has vertices");
  for (const [lon, lat] of clipped) {
    assert.ok(lon >= box[0] - 1e-6 && lon <= box[2] + 1e-6, `lon ${lon}`);
    assert.ok(lat >= box[1] - 1e-6 && lat <= box[3] + 1e-6, `lat ${lat}`);
  }
  // Closed ring.
  assert.deepEqual(clipped[0], clipped[clipped.length - 1]);
});

test("chartworkFeatures clips line geometry to the view bounds", async () => {
  const { cw } = await load();
  const box = [-174.5, -18.7, -174.3, -18.5];
  const lop = {
    lop_id: 1,
    assumed_lat: -18.6,
    assumed_lon: -174.4,
    azimuth_true: (45 + 90) % 360,
    lop_type: "bearing",
  };
  const clipped = cw.chartworkFeatures({ lops: [lop], clipBounds: box });
  const f = clipped.features.find((x) => x.id === "lop:1");
  assert.ok(f, "lop feature present");
  for (const [lon, lat] of f.geometry.coordinates) {
    assert.ok(lon >= box[0] - 1e-6 && lon <= box[2] + 1e-6, `lon ${lon}`);
    assert.ok(lat >= box[1] - 1e-6 && lat <= box[3] + 1e-6, `lat ${lat}`);
  }
  // Without the clip, the full ±60 nm ray is far outside the box.
  const full = cw.chartworkFeatures({ lops: [lop] });
  const g = full.features.find((x) => x.id === "lop:1").geometry.coordinates;
  assert.ok(
    Math.abs(g[1][1] - -18.6) > 0.5,
    "unclipped geometry extends beyond the box",
  );
});

test("boundsDiagonalNm measures the view, antimeridian-aware", async () => {
  const { cw } = await load();
  // 1° × 1° at the equator ≈ 60√2 nm.
  const diag = cw.boundsDiagonalNm([-0.5, -0.5, 0.5, 0.5]);
  assert.ok(diag > 80 && diag < 90, `diagonal ${diag}`);
  // Crossing box: 179.5 → -179.5 is 1° the short way, not 359°.
  const crossed = cw.boundsDiagonalNm([179.5, -0.5, -179.5, 0.5]);
  assert.ok(crossed > 80 && crossed < 90, `crossed diagonal ${crossed}`);
});

test("inflateBounds floors the clip box so it survives deep zooms", async () => {
  const { cw } = await load();
  // A z17.9-sized view (≈0.15 nm across) still gets a ~2 nm clip box,
  // centered on the view — the clipped chartwork stops churning per
  // zoom and the features stop stranding between renders.
  const tiny = cw.inflateBounds([-174.32, -18.6308, -174.3188, -18.63], 0.5);
  const lonSpan = tiny[2] - tiny[0];
  const latSpan = tiny[3] - tiny[1];
  const nm = (deg) => (deg * 111320) / 1852;
  assert.ok(Math.abs(nm(lonSpan) - 2) < 0.1, `lon span ${nm(lonSpan)} nm`);
  assert.ok(Math.abs(nm(latSpan) - 2) < 0.1, `lat span ${nm(latSpan)} nm`);
  // Centered on the original view.
  assert.ok(Math.abs((tiny[0] + tiny[2]) / 2 - -174.3194) < 1e-6);
  // A large view just inflates by the fraction (0.5 span per side).
  const big = cw.inflateBounds([-1, -1, 1, 1], 0.5);
  assert.equal(big[2] - big[0], 4);
});

test("boundsDiagonalNm measures the view, antimeridian-aware", async () => {
  const { cw } = await load();
  // 1° × 1° at the equator ≈ 60√2 nm.
  const diag = cw.boundsDiagonalNm([-0.5, -0.5, 0.5, 0.5]);
  assert.ok(diag > 80 && diag < 90, `diagonal ${diag}`);
  // Crossing box: 179.5 → -179.5 is 1° the short way, not 359°.
  const crossed = cw.boundsDiagonalNm([179.5, -0.5, -179.5, 0.5]);
  assert.ok(crossed > 80 && crossed < 90, `crossed diagonal ${crossed}`);
});

test("errorFeature draws the transient note at the DR position", async () => {
  const { cw } = await load();
  const f = cw.errorFeature("nothing to confirm", [60, 25]);
  assert.equal(f.id, "error");
  assert.equal(f.properties.kind, "error");
  assert.equal(f.properties.label, "nothing to confirm");
  assert.deepEqual(f.geometry.coordinates, [25, 60]);
  assert.equal(cw.errorFeature("", [60, 25]), null);
  assert.equal(cw.errorFeature("msg", null), null);
  // Rides the collection when set, absent when not.
  const fc = cw.chartworkFeatures({ drPosition: [60, 25], error: f });
  assert.ok(fc.features.some((x) => x.id === "error"));
  const fc2 = cw.chartworkFeatures({ drPosition: [60, 25] });
  assert.ok(!fc2.features.some((x) => x.id === "error"));
});

test("toolbarVisibility mirrors engine state and fix flow", async () => {
  const { cw } = await load();
  assert.deepEqual(
    cw.toolbarVisibility({
      active: false,
      hasCandidate: false,
      hasFixes: true,
      hasPending: false,
      hasGnss: true,
    }),
    {
      buttons: [
        { ids: ["override-engage"], visible: true },
        { ids: ["override-release"], visible: false },
        { ids: ["confirm-fix"], visible: false },
        { ids: ["open-pending"], visible: false },
        { ids: ["confirm-gnss"], visible: true },
      ],
      actions: [{ ids: ["resolve-from"], visible: true }],
    },
  );
  // Override engaged + a candidate pending + observations to work: the
  // confirm and pending buttons are the surfaced actions; resolve
  // disappears with the last fix; GNSS gone with the position.
  assert.deepEqual(
    cw.toolbarVisibility({
      active: true,
      hasCandidate: true,
      hasFixes: false,
      hasPending: true,
      hasGnss: false,
    }),
    {
      buttons: [
        { ids: ["override-engage"], visible: false },
        { ids: ["override-release"], visible: true },
        { ids: ["confirm-fix"], visible: true },
        { ids: ["open-pending"], visible: true },
        { ids: ["confirm-gnss"], visible: false },
      ],
      actions: [{ ids: ["resolve-from"], visible: false }],
    },
  );
});

test("pendingCount counts unresolved, fresh observations only", async () => {
  const { cw } = await load();
  const now = Date.now();
  const fresh = {
    used_in_fix_id: null,
    timestamp: new Date(now - 3600e3).toISOString(),
  };
  const used = {
    used_in_fix_id: 9,
    timestamp: new Date(now - 3600e3).toISOString(),
  };
  const stale = {
    used_in_fix_id: null,
    timestamp: new Date(now - 25 * 3600e3).toISOString(),
  };
  assert.equal(cw.pendingCount([fresh, used, stale], [fresh], now), 2);
  assert.equal(cw.pendingCount([], [], now), 0);
});

test("circleRing returns a closed ring of lon/lat vertices", async () => {
  const { cw } = await load();
  const ring = cw.circleRing([60.1, 25.0], 4);
  assert.equal(ring.length, 49);
  assert.deepEqual(ring[0], ring[48]);
  // [lon, lat] order — the ring hugs the center's longitude band
  // (25°) in the first coordinate and latitude (60°) in the second.
  for (const [lon, lat] of ring) {
    assert.ok(lon > 24 && lon < 26, `lon ${lon} near 25`);
    assert.ok(lat > 59 && lat < 61, `lat ${lat} near 60`);
  }
});

test("lopFeature builds the bearing ray with object anchor and azimuth name", async () => {
  const { cw, vm } = await load();
  const object = [59.9, 24.9]; // [lat, lon] — charted object
  const bearing = 42.4;
  const lop = {
    lop_id: 12,
    assumed_lat: object[0],
    assumed_lon: object[1],
    // Bearing rows store the line's NORMAL (bearing + 90, engine
    // convention — see bearingLopBody).
    azimuth_true: (bearing + 90) % 360,
    intercept_nm: 0,
    lop_type: "bearing",
    body_or_object: "Lighthouse",
    used_in_fix_id: null,
  };
  const f = cw.lopFeature(lop);
  assert.equal(f.id, "lop:12");
  assert.equal(f.properties.kind, "lop");
  assert.equal(f.properties.name, "Lighthouse LOP");
  assert.equal(f.properties.used, false);
  assert.equal(f.geometry.coordinates.length, 2);
  // The ray starts at the observed object (bearing LOPs anchor there)
  // — [lon, lat] GeoJSON order, rounding-tolerant.
  const [ax, ay] = f.geometry.coordinates[0];
  assert.ok(Math.abs(ax - object[1]) < 1e-9, `anchor lon ${ax}`);
  assert.ok(Math.abs(ay - object[0]) < 1e-9, `anchor lat ${ay}`);
  // And extends along the measured bearing's reciprocal — toward the
  // navigator, never through/past the mark.
  const [, b] = f.geometry.coordinates;
  const rayBearing = vm.bearingBetween(object, [b[1], b[0]]);
  const off = Math.abs(((rayBearing - (bearing + 180) + 540) % 360) - 180);
  assert.ok(off < 1, `reciprocal ray expected, got ${rayBearing}`);
  // Fresh unresolved observations are resolvable; stale (24 h+) and
  // used ones are flagged so the manifest's static `match` can keep
  // resolve-from off them.
  assert.equal(f.properties.stale, false);
  const staleLop = {
    ...lop,
    lop_id: 14,
    timestamp: new Date(Date.now() - 25 * 3600e3).toISOString(),
  };
  assert.equal(cw.lopFeature(staleLop).properties.stale, true);
  const usedLop = {
    ...lop,
    lop_id: 15,
    used_in_fix_id: 3,
    timestamp: new Date(Date.now() - 25 * 3600e3).toISOString(),
  };
  assert.equal(cw.lopFeature(usedLop).properties.stale, false);
});

test("lopFeature anchors a celestial LOP at the intercept point and marks used rows", async () => {
  const { cw, vm } = await load();
  const lop = {
    lop_id: 13,
    assumed_lat: 60.0,
    assumed_lon: 25.0,
    azimuth_true: 90,
    intercept_nm: 3,
    lop_type: "celestial",
    used_in_fix_id: 5,
  };
  const f = cw.lopFeature(lop);
  assert.equal(f.properties.used, true);
  const expected = vm.destinationPoint([60.0, 25.0], 90, 3);
  // A celestial LOP draws symmetric ±length around the intercept
  // point — the anchor is the MIDPOINT of the two endpoints.
  const [[ax, ay], [bx, by]] = f.geometry.coordinates;
  const midLon = (ax + bx) / 2;
  const midLat = (ay + by) / 2;
  assert.ok(Math.abs(midLon - expected[1]) < 1e-6, `intercept lon ${midLon}`);
  assert.ok(Math.abs(midLat - expected[0]) < 1e-6, `intercept lat ${midLat}`);
});

test("cplFeature draws the arc toward the DR position, full circle without it", async () => {
  const { cw } = await load();
  const cpl = {
    cpl_id: 7,
    center_lat: 60.0,
    center_lon: 25.0,
    radius_nm: 4.2,
    used_in_fix_id: null,
  };
  const arc = cw.cplFeature(cpl, [59.95, 25.05]);
  assert.equal(arc.id, "cpl:7");
  assert.equal(arc.properties.name, "CPL r=4.2 nm");
  // Arc: ~45 vertices, open polyline.
  assert.ok(arc.geometry.coordinates.length >= 9);
  assert.notDeepEqual(
    arc.geometry.coordinates[0],
    arc.geometry.coordinates[arc.geometry.coordinates.length - 1],
  );

  const circle = cw.cplFeature(cpl, null);
  // Full circle: closed 48-gon.
  assert.equal(circle.geometry.coordinates.length, 49);
  assert.deepEqual(
    circle.geometry.coordinates[0],
    circle.geometry.coordinates[48],
  );
});

test("fixFeature colors per source type and labels with fix time", async () => {
  const { cw, vm } = await load();
  // fixTimeLabel switches to a dated label once a fix is over 24 h old, so
  // the fixtures are built relative to the wall clock to stay deterministic.
  const base = {
    source_type: "celestial",
    latitude: 60.123,
    longitude: 24.567,
  };
  const fresh = cw.fixFeature({
    ...base,
    fix_id: 21,
    timestamp: new Date(Date.now() - 3600 * 1000).toISOString(),
  });
  assert.equal(fresh.id, "fix:21");
  assert.equal(fresh.properties.color, vm.STYLE.fix.celestial);
  assert.match(fresh.properties.label, /^Fix \d\d:\d\dZ$/);
  assert.deepEqual(fresh.geometry.coordinates, [24.567, 60.123]);

  const old = cw.fixFeature({
    ...base,
    fix_id: 22,
    timestamp: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
  });
  assert.equal(old.id, "fix:22");
  assert.match(old.properties.label, /^Fix \d{1,2}\.\d{1,2}\. \d\d:\d\dZ$/);
});

test("snapFeature builds the dashed correction vector", async () => {
  const { cw } = await load();
  const f = cw.snapFeature({
    correction_id: 3,
    dr_lat: 60.0,
    dr_lon: 25.0,
    fix_lat: 60.05,
    fix_lon: 25.05,
    deviation_nm: 3.21,
    deviation_bearing: 45,
  });
  assert.equal(f.id, "snap:3");
  assert.equal(f.properties.kind, "snap");
  assert.deepEqual(f.geometry.coordinates, [
    [25.0, 60.0],
    [25.05, 60.05],
  ]);
});

test("ghostFeature converts TrackLog points and rejects short tracks", async () => {
  const { cw } = await load();
  assert.equal(cw.ghostFeature([[60, 25, 1]]), null);
  const f = cw.ghostFeature([
    [60, 25, 1],
    [60.01, 25.01, 2],
  ]);
  assert.equal(f.id, "ghost");
  assert.deepEqual(f.geometry.coordinates, [
    [25, 60],
    [25.01, 60.01],
  ]);
});

test("uncertaintyFeature scales the radius and skips empty ones", async () => {
  const { cw } = await load();
  assert.equal(cw.uncertaintyFeature([60, 25], { radius_m: 0 }), null);
  const f = cw.uncertaintyFeature([60, 25], { radius_m: 2 * M });
  assert.equal(f.properties.kind, "uncertainty");
  assert.equal(f.geometry.type, "Polygon");
  assert.match(f.properties.name, /±2\.00 nm/);
});

test("drPosFeature carries the DR time label", async () => {
  const { cw } = await load();
  const f = cw.drPosFeature([60, 25], Date.UTC(2026, 9, 21, 2, 50));
  assert.equal(f.id, "drpos");
  assert.equal(f.properties.label, "DR 02:50Z");
  assert.equal(cw.drPosFeature(null, null), null);
});

test("candidateFeature reports residual and unadvanced warnings", async () => {
  const { cw, vm } = await load();
  const f = cw.candidateFeature({
    latitude: 60.1,
    longitude: 25.1,
    residual_nm: 0.42,
    advancements: [],
  });
  assert.equal(f.id, "candidate");
  assert.equal(f.properties.name, "candidate (residual 0.42 nm)");
  assert.equal(f.properties.warn, false);
  // An advancement list with un-advanced entries flags the warning.
  const g = cw.candidateFeature({
    latitude: 60.1,
    longitude: 25.1,
    advancements: [{ advanced: false }],
  });
  assert.equal(g.properties.warn, vm.hasUnadvanced([{ advanced: false }]));
  assert.equal(cw.candidateFeature(null), null);
});

test("chartworkFeatures assembles the collection and skips malformed rows", async () => {
  const { cw } = await load();
  const fc = cw.chartworkFeatures({
    lops: [
      {
        lop_id: 1,
        assumed_lat: 60,
        assumed_lon: 25,
        azimuth_true: 10,
        lop_type: "bearing",
      },
      { lop_id: 2 },
    ],
    cpls: [],
    fixes: [
      {
        fix_id: 1,
        latitude: 60,
        longitude: 25,
        source_type: "gps",
        timestamp: "2026-10-21T00:00:00Z",
      },
    ],
    corrections: [],
    ghostTrack: [
      [60, 25, 1],
      [60, 25.001, 2],
    ],
    drPosition: [60, 25],
    drTimeMs: Date.UTC(2026, 9, 21, 5, 0),
    uncertainty: { radius_m: M },
    candidate: null,
  });
  const kinds = fc.features.map((f) => f.properties.kind);
  assert.deepEqual(kinds, ["ghost", "uncertainty", "lop", "fix", "drpos"]);
});

test("palette covers every layer of the style JSON, day and night", async () => {
  const { cw } = await load();
  const style = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "..", "public", "dr-ext-overlay-style.json"),
      "utf8",
    ),
  );
  const styleLayerIds = style.layers.map((l) => l.id);
  for (const id of styleLayerIds) {
    assert.ok(
      cw.PALETTE_LAYER_IDS.includes(id),
      `style layer ${id} missing from the palette`,
    );
    assert.ok(cw.paletteColor(id, false), `no day color for ${id}`);
  }
  // Line layers recolor through line-color; others declare their own.
  for (const id of Object.keys(cw.LAYER_COLORS)) {
    assert.ok(styleLayerIds.includes(id), `palette layer ${id} not in style`);
  }
  for (const [id, prop] of Object.entries(cw.PAINT_PROPERTY)) {
    const layer = style.layers.find((l) => l.id === id);
    assert.ok(layer, `PAINT_PROPERTY layer ${id} not in style`);
    assert.ok(
      prop === "fill-color"
        ? "fill-color" in layer.paint
        : prop === "text-color"
          ? "text-color" in layer.paint
          : prop in layer.paint,
      `${id} style paint lacks ${prop}`,
    );
  }
});

// --- manifest structural pins -------------------------------------------

const manifest = require("../plugin/plotterext.js").buildManifest(
  "/dr-assets",
  "0.0.0-test",
);

test("manifest keeps the 3.0-compatible requires surface", () => {
  for (const cap of [
    "widgets",
    "panels.iframe",
    "signalk.stream",
    "buttons",
    "background.iframe",
  ]) {
    assert.ok(manifest.requires.includes(cap), `requires ${cap}`);
  }
  // Everything probeable stays optional so old hosts still offer the
  // widget/panel/buttons and the runtime guards at runtime.
  for (const cap of [
    "overlays.data",
    "actions",
    "map.pick",
    "windows",
    "buttons.visibility",
  ]) {
    assert.ok(manifest.optional.includes(cap), `optional ${cap}`);
    assert.ok(!manifest.requires.includes(cap));
  }
});

test("manifest contribution references resolve", () => {
  const panelIds = new Set(manifest.panels.map((p) => p.id));
  const runtimeIds = new Set(manifest.background.map((b) => b.id));
  assert.ok(panelIds.has("sight"));
  assert.ok(panelIds.has("pending"));
  assert.ok(panelIds.has("current"));
  assert.ok(runtimeIds.has("chartwork"));
  const widgetIds = new Set(manifest.widgets.map((w) => w.id));
  assert.ok(widgetIds.has("dr-status"));
  assert.ok(widgetIds.has("current"));

  for (const btn of manifest.buttons) {
    if (btn.action.panel) {
      assert.ok(panelIds.has(btn.action.panel), `button ${btn.id} panel`);
    }
    if (btn.action.type === "publish") {
      assert.ok(
        [
          "signalk-dead-reckoning.override",
          "signalk-dead-reckoning.confirm",
          "signalk-dead-reckoning.confirm-gnss",
        ].includes(btn.action.topic),
        `button ${btn.id} topic`,
      );
    }
  }
  // The engage/release pair is visibility-switched, so both exist and
  // start on opposite sides of the engine state; confirm and the
  // pending window start hidden (nothing pending on load).
  const engage = manifest.buttons.find((b) => b.id === "override-engage");
  const release = manifest.buttons.find((b) => b.id === "override-release");
  const confirmBtn = manifest.buttons.find((b) => b.id === "confirm-fix");
  const pendingBtn = manifest.buttons.find((b) => b.id === "open-pending");
  assert.equal(engage.visible, true);
  assert.equal(release.visible, false);
  assert.equal(confirmBtn.visible, false);
  assert.equal(pendingBtn.visible, false);
  // The split: pending is its own panel, mounted from the same page.
  const pendingPanel = manifest.panels.find((p) => p.id === "pending");
  assert.match(pendingPanel.url, /dr-ext-panel\.html\?view=pending$/);
  // Current set & drift: own window button (always visible), own view.
  const currentBtn = manifest.buttons.find((b) => b.id === "open-current");
  assert.ok(currentBtn);
  assert.equal(currentBtn.visible, true);
  assert.equal(currentBtn.action.panel, "current");

  for (const action of manifest.actions) {
    if (action.action.type === "openWindow") {
      assert.ok(panelIds.has(action.action.panel), `action ${action.id} panel`);
    }
  }
  // Overlay feature targets reference this manifest's overlay.
  const overlayIds = new Set(manifest.overlays.map((o) => o.id));
  for (const action of manifest.actions) {
    for (const t of action.targets) {
      if (typeof t === "object" && t.kind === "overlayFeature") {
        for (const o of t.overlays ?? []) {
          assert.ok(overlayIds.has(o), `target overlay ${o}`);
        }
      }
    }
  }
});

test("chart-driven confirm and resolve actions agree with the runtime", () => {
  const byId = new Map(manifest.actions.map((a) => [a.id, a]));

  // The candidate ring carries two actions: right-click/menu confirms
  // (publish topic); its default — a primary select — goes back to the
  // fix-resolution window.
  const confirmAction = byId.get("confirm-fix");
  assert.equal(confirmAction.default, undefined);
  assert.equal(confirmAction.action.topic, "signalk-dead-reckoning.confirm");
  assert.match(JSON.stringify(confirmAction.targets), /\^candidate\$/);
  const reviewAction = byId.get("review-fix");
  assert.equal(reviewAction.default, true);
  assert.equal(reviewAction.action.panel, "pending");
  assert.equal(reviewAction.action.single, true);
  assert.equal(reviewAction.action.restoreKey, "pending-v2");
  assert.match(JSON.stringify(reviewAction.targets), /\^candidate\$/);

  // Resolve-from targets only unresolved, fresh LoPs/CPLs.
  const resolveAction = byId.get("resolve-from");
  assert.equal(resolveAction.action.topic, "signalk-dead-reckoning.resolve");
  const resolveMatch = JSON.stringify(resolveAction.targets);
  assert.match(resolveMatch, /\^\(lop\|cpl\):/);
  assert.match(resolveMatch, /properties\\?\.used/);
  assert.match(resolveMatch, /properties\\?\.stale/);

  // The candidate layer must be interactive for a tap to reach the
  // default action, and the runtime must handle the topics — confirm,
  // resolve and the LoP-toolbar delete.
  const overlay = manifest.overlays.find((o) => o.id === "chartwork");
  assert.ok(overlay.interactiveLayers.includes("dr-candidate"));
  const runtime = fs.readFileSync(
    path.join(__dirname, "..", "public", "dr-ext-runtime.js"),
    "utf8",
  );
  assert.match(runtime, /signalk-dead-reckoning\.confirm/);
  assert.match(runtime, /signalk-dead-reckoning\.resolve/);
  const deleteAction = byId.get("delete-observation");
  assert.equal(deleteAction.action.topic, "signalk-dead-reckoning.delete");
  assert.match(JSON.stringify(deleteAction.targets), /\^\(lop\|cpl\):/);
  assert.match(runtime, /signalk-dead-reckoning\.delete/);
  // The candidate ring's default action has a runtime-side fallback:
  // the host's openWindow is belt-and-braced by the runtime reacting
  // to action.invoked itself (single:true keeps it idempotent).
  assert.match(runtime, /"action\.invoked"/);
  assert.match(runtime, /actionId === "review-fix"/);
  // Chart-driven failures are drawn on the chart, not only logged.
  assert.match(runtime, /errorFeature\(message, drPosition\)/);
  // Rejections speak: the response body's message (sanity caps,
  // coverage, …) reaches the note, not a bare status code.
  assert.match(runtime, /body\?\.message/);
  // Chart-driven failures surface honestly: the runtime reports them
  // on an error topic, the panels render it in both views.
  assert.match(runtime, /signalk-dead-reckoning\.error/);
  const panel = fs.readFileSync(
    path.join(__dirname, "..", "public", "dr-ext-panel.js"),
    "utf8",
  );
  assert.match(panel, /signalk-dead-reckoning\.error/);
  const panelHtml = fs.readFileSync(
    path.join(__dirname, "..", "public", "dr-ext-panel.html"),
    "utf8",
  );
  assert.match(panelHtml, /id="ext-error"/);
  // The running-fix gate must match the server's: all-time latest
  // fix, not the windowed display list.
  assert.match(runtime, /fixes\?limit=1/);
  // The visibility bug the console caught: one `{ ids, visible }`
  // object per call — buttons and actions on their own surfaces.
  assert.match(runtime, /for \(const entry of visibility\.buttons\)/);
  assert.match(runtime, /buttons\.setVisibility", entry/);
  assert.match(runtime, /actions\.setVisibility", entry/);
  // Overlay pushes diff against what the host holds — no full-source
  // clear-and-refill on every DR tick (it churned the host's vector
  // source: chartwork flickered out of view through zoom gestures).
  assert.match(runtime, /diffFeatures\(\s*pushedFeatures/);
  assert.ok(
    !/source: SOURCE_ID, data:/.test(runtime),
    "no whole-source pushes",
  );
  // Chartwork geometry is clipped to the view (the z16 canvas-
  // precision fix): the runtime tracks the view and feeds the clip box.
  assert.match(runtime, /updateClipBounds/);
  assert.match(runtime, /clipBounds,/);
  assert.match(runtime, /"map\.view"/);
  // The candidate event detail IS the candidate (dr-app parity).
  assert.match(panel, /candidate: e\.detail \?\? null/);
});

test("runtime window-filters chartwork like the webapp overlay loader", () => {
  const runtime = fs.readFileSync(
    path.join(__dirname, "..", "public", "dr-ext-runtime.js"),
    "utf8",
  );
  // The September-LoPs bug: REST fetches must carry the same
  // max(7 days, trip) window the webapp applies — /status tripStartMs
  // anchors it, chartWindow computes it, all three endpoints filter.
  assert.match(runtime, /chartWindow\(Date\.now\(\), tripStartMs\)/);
  assert.match(runtime, /tripStartMs = status\.tripStartMs/);
  assert.match(runtime, /since=\$\{encodeURIComponent\(since\)\}/);
  for (const endpoint of ["observations", "fixes", "corrections"]) {
    assert.ok(
      runtime.includes(`\${API}/${endpoint}\${q}`),
      `${endpoint} fetch carries the since window`,
    );
  }
});

test("sight action windows are tall, single and mode-scoped", () => {
  for (const id of [
    "sight-bearing",
    "sight-vertical",
    "sight-radar",
    "sight-hangle",
    "sight-edit",
  ]) {
    const action = manifest.actions.find((a) => a.id === id);
    assert.ok(action, id);
    assert.equal(action.action.single, true, `${id} reuses the open window`);
    assert.equal(
      action.action.geometry.height,
      "90%",
      `${id} takes most of the vertical space`,
    );
    assert.match(
      action.action.restoreKey,
      /^sight/,
      `${id} remembers its geometry`,
    );
    if (id !== "sight-edit") {
      assert.match(
        action.action.params.mode,
        /^(bearing|vertical|radar|hangle)$/,
      );
    }
  }
});

test("overlay declaration and style JSON agree", () => {
  const overlay = manifest.overlays.find((o) => o.id === "chartwork");
  assert.equal(overlay.type, "data");
  assert.equal(overlay.band, "aboveResources");
  const style = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "..", "public", "dr-ext-overlay-style.json"),
      "utf8",
    ),
  );
  assert.equal(overlay.style.endsWith("/dr-ext-overlay-style.json"), true);
  const layerIds = new Set(style.layers.map((l) => l.id));
  for (const id of overlay.interactiveLayers) {
    assert.ok(layerIds.has(id), `interactive layer ${id}`);
  }
  assert.ok(style.sources.dr, "chartwork source");
  // The runtime pushes at this source id; the style must declare it.
  assert.match(
    fs.readFileSync(
      path.join(__dirname, "..", "public", "dr-ext-runtime.js"),
      "utf8",
    ),
    /SOURCE_ID = "dr"/,
  );
});

test("panel and runtime pages exist and reference shipped modules", () => {
  const publicDir = path.join(__dirname, "..", "public");
  for (const f of [
    "dr-ext-panel.html",
    "dr-ext-panel.js",
    "dr-ext-runtime.html",
    "dr-ext-runtime.js",
    "dr-ext-chartwork.js",
    "dr-ext-overlay-style.json",
    "dr-current-widget.html",
    "dr-current-widget.js",
  ]) {
    assert.ok(fs.existsSync(path.join(publicDir, f)), f);
  }
  // The panel page loads the webapp's own components (reuse, not a port).
  const panel = fs.readFileSync(
    path.join(publicDir, "dr-ext-panel.js"),
    "utf8",
  );
  for (const component of [
    "dr-pending-list.js",
    "dr-sight-panel.js",
    "dr-fix-panel.js",
  ]) {
    assert.ok(panel.includes(component), `panel imports ${component}`);
  }
  // Action-launched windows pin the panel to one method: the shared
  // component gains a single-tab attribute, the wrapper a single mode.
  const sightPanel = fs.readFileSync(
    path.join(publicDir, "dr-sight-panel.js"),
    "utf8",
  );
  assert.match(sightPanel, /observedAttributes[\s\S]*?single-tab/);
  assert.match(sightPanel, /\.tabs\[hidden\]/);
  assert.match(panel, /single-tab/);
  assert.match(panel, /applyMode/);
  const panelHtml = fs.readFileSync(
    path.join(publicDir, "dr-ext-panel.html"),
    "utf8",
  );
  assert.match(panelHtml, /body\.single \.optional/);
  // The current view (`?view=current`): only the manual override panel.
  assert.match(panelHtml, /body\.view-current #sight-section/);
  assert.match(panelHtml, /dr-current-panel id="current" embedded/);
  assert.match(panel, /view-current/);
  assert.match(panel, /CURRENT_VIEW/);
  // The split: pending lives in its own ?view=pending mount, never in
  // the Sight/Fix window; the view hides sight + fixat + pick header.
  assert.match(panelHtml, /#pending-section/);
  assert.match(panelHtml, /body\.view-pending #sight-section/);
  assert.match(panel, /PENDING_VIEW/);
  assert.match(panel, /view-pending/);
  // Deletion must not rely on window.confirm — extension iframes are
  // sandboxed without allow-modals, where it silently returns false.
  const pendingList = fs.readFileSync(
    path.join(publicDir, "dr-pending-list.js"),
    "utf8",
  );
  assert.ok(!pendingList.includes("window.confirm"), "no native confirm");
  assert.match(pendingList, /Sure\?/);
  assert.match(pendingList, /button\.danger/);
  // Preview rides the selection (debounced auto-preview); the
  // deliberate step is confirming.
  assert.ok(!pendingList.includes("preview-btn"), "no preview button");
  assert.match(pendingList, /schedulePreview/);
  assert.match(pendingList, /previewSeq/);
  assert.match(pendingList, /track_coverage/);
  // The per-fieldset ⊙ Pick: the sight panel dispatches pick requests
  // when the embedder opts in (`pick` attribute); the wrapper listens
  // and seeds the requesting fieldset.
  const sightPanelSrc = fs.readFileSync(
    path.join(publicDir, "dr-sight-panel.js"),
    "utf8",
  );
  assert.match(sightPanelSrc, /dr-pick-request/);
  assert.match(panel, /dr-pick-request/);
  assert.match(panelHtml, /dr-sight-panel id="sight" embedded pick/);
  assert.ok(!panelHtml.includes("pick-btn"), "header pick button gone");
  // The GNSS-fix bootstrap button and its runtime wiring.
  const gnssBtn = manifest.buttons.find((b) => b.id === "confirm-gnss");
  assert.ok(gnssBtn, "confirm-gnss button");
  assert.equal(gnssBtn.action.topic, "signalk-dead-reckoning.confirm-gnss");
  const runtimeSrc = fs.readFileSync(
    path.join(publicDir, "dr-ext-runtime.js"),
    "utf8",
  );
  assert.match(runtimeSrc, /confirm-gnss/);
  assert.match(runtimeSrc, /navigation\.position/);
  // The components' shared THEME_CSS hangs off the webapp's token set
  // (styles.css :root) — the page must carry it or primary buttons
  // render unstyled; sight times must default to now (openSight's
  // seedSightTime, called by the wrapper at start and per mode).
  assert.match(panelHtml, /--color-teal: #4b8b99/);
  assert.match(panelHtml, /--theme-color: var\(--color-teal\)/);
  assert.match(panel, /seedSightTime/);
  // Inside host windows the components' own heading rows (title +
  // close X) are hidden — Freeboard supplies both decorations.
  assert.match(panelHtml, /dr-sight-panel id="sight" embedded/);
  assert.match(panelHtml, /dr-fix-panel id="fixat" embedded/);
  for (const f of ["dr-sight-panel.js", "dr-fix-panel.js"]) {
    assert.match(
      fs.readFileSync(path.join(publicDir, f), "utf8"),
      /:host\(\[embedded\]\) h2/,
      `${f} embedded chrome rule`,
    );
  }
  assert.ok(!panelHtml.includes("<h1"), "no page title — host supplies it");
});
