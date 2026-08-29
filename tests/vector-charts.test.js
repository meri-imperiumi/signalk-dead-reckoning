/**
 * Tests for vector (`.pbf`) chart support (work doc #20):
 * chart parsing carries the vector fields through, `maplibreStyleFor`
 * builds a self-contained offline MapLibre style, and the vendored
 * renderer + bridge are wired into the webapp shell.
 * @file vector-charts.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const vmPromise = import("../public/dr-viewmodel.js");

/** Resolves the view-model module (loaded once, shared by all tests). */
async function loadVm() {
  return vmPromise;
}

/** A parsed vector chart as dr-map-view would receive it. */
const VECTOR_CHART = {
  identifier: "passage_cache",
  name: "Passage Cache",
  url: "/signalk/v1/api/resources/charts/passage_cache/{z}/{x}/{y}",
  minZoom: 8,
  maxZoom: 14,
  format: "pbf",
  chartLayers: ["LNDARE", "DEPARE", "DEPCNT", "COALNE", "SOUNDG"],
};

test("parseChartLayers: carries format + vector source layers through", async () => {
  const vm = await loadVm();
  const layers = vm.parseChartLayers({
    a: {
      identifier: "passage_cache",
      name: "Passage",
      tilemapUrl: "/signalk/v1/api/resources/charts/passage_cache/{z}/{x}/{y}",
      minzoom: 8,
      maxzoom: 14,
      format: "PBF", // case-insensitive server value
      chartLayers: ["LNDARE", "SOUNDG", 42, ""], // junk filtered
    },
    b: {
      identifier: "raster",
      name: "Raster",
      tilemapUrl: "http://lan/tiles/{z}/{x}/{y}.png",
    },
  });
  const vector = layers.find((l) => l.identifier === "passage_cache");
  assert.strictEqual(vector.format, "pbf", "format lower-cased");
  assert.deepStrictEqual(vector.chartLayers, ["LNDARE", "SOUNDG"]);
  const raster = layers.find((l) => l.identifier === "raster");
  assert.strictEqual(raster.format, undefined);
  assert.strictEqual(raster.chartLayers, undefined);
});

test("isVectorChart: pbf yes, anything else no", async () => {
  const vm = await loadVm();
  assert.strictEqual(vm.isVectorChart({ format: "pbf" }), true);
  assert.strictEqual(vm.isVectorChart({ format: "png" }), false);
  assert.strictEqual(vm.isVectorChart({}), false);
  assert.strictEqual(vm.isVectorChart(null), false);
  assert.strictEqual(vm.isVectorChart(undefined), false);
});

test("chartAssetsFromManifest: only a manifest with an absolute style URL counts", async () => {
  const vm = await loadVm();
  const style =
    "http://host:3000/plugins/signalk-corridor-tile-downloader/assets/style.json";
  assert.deepStrictEqual(
    vm.chartAssetsFromManifest({ style, fonts: ["Noto Sans Regular"] }),
    { style },
  );
  // No style (older downloader / mirror incomplete) → callers keep the
  // composed-style fallback.
  assert.strictEqual(vm.chartAssetsFromManifest({ fonts: [] }), null);
  assert.strictEqual(
    vm.chartAssetsFromManifest({ style: "/plugins/relative/style.json" }),
    null,
  );
  assert.strictEqual(vm.chartAssetsFromManifest(null), null);
  assert.strictEqual(vm.chartAssetsFromManifest(undefined), null);
  assert.strictEqual(vm.chartAssetsFromManifest("junk"), null);
});

test("maplibreStyleFor: vector source wired to the chart tilemapUrl with zooms", async () => {
  const vm = await loadVm();
  const style = vm.maplibreStyleFor(VECTOR_CHART);
  assert.strictEqual(style.version, 8);
  assert.strictEqual(style.name, "Passage Cache");
  const source = style.sources.passage_cache;
  assert.strictEqual(source.type, "vector");
  assert.deepStrictEqual(source.tiles, [VECTOR_CHART.url]);
  assert.strictEqual(source.minzoom, 8);
  // Native max — MapLibre overzooms vector data beyond it.
  assert.strictEqual(source.maxzoom, 14);
});

test("absoluteTileUrl: root-relative urls gain the page origin", async () => {
  const vm = await loadVm();
  const realLocation = globalThis.location;
  globalThis.location = { origin: "http://localhost:3000" };
  try {
    assert.strictEqual(
      vm.absoluteTileUrl("/signalk/v1/api/resources/charts/x/{z}/{x}/{y}"),
      "http://localhost:3000/signalk/v1/api/resources/charts/x/{z}/{x}/{y}",
    );
    // Absolute URLs pass through untouched.
    assert.strictEqual(
      vm.absoluteTileUrl("http://lan:81/tiles/{z}/{x}/{y}.pbf"),
      "http://lan:81/tiles/{z}/{x}/{y}.pbf",
    );
    // Placeholders must survive verbatim — URL() would percent-encode
    // {z} to %7Bz%7D and MapLibre's substitution would miss it.
    assert.ok(!vm.absoluteTileUrl("/a/{z}").includes("%7B"));
  } finally {
    if (realLocation === undefined) delete globalThis.location;
    else globalThis.location = realLocation;
  }
});

test("maplibreStyleFor: tile urls are absolute in a browser context", async () => {
  const vm = await loadVm();
  const realLocation = globalThis.location;
  globalThis.location = { origin: "http://localhost:3000" };
  try {
    const style = vm.maplibreStyleFor(VECTOR_CHART);
    const source = style.sources.passage_cache;
    assert.deepStrictEqual(source.tiles, [
      `http://localhost:3000${VECTOR_CHART.url}`,
    ]);
  } finally {
    if (realLocation === undefined) delete globalThis.location;
    else globalThis.location = realLocation;
  }
});

test("maplibreStyleFor: background first, no symbol layers (no glyphs endpoint)", async () => {
  const vm = await loadVm();
  const style = vm.maplibreStyleFor(VECTOR_CHART);
  assert.strictEqual(style.layers[0].type, "background");
  // Geometry-only contract: nothing ever asks for glyphs/sprites.
  assert.ok(
    style.layers.every((l) => l.type !== "symbol"),
    "no symbol layers",
  );
  assert.ok(!("glyphs" in style), "no glyphs endpoint");
  assert.ok(!("sprite" in style), "no sprite endpoint");
});

test("maplibreStyleFor: S-57 source layers get their family styling", async () => {
  const vm = await loadVm();
  const style = vm.maplibreStyleFor(VECTOR_CHART);
  const byId = Object.fromEntries(style.layers.map((l) => [l.id, l]));
  const land = byId["passage_cache-LNDARE-fill"];
  assert.ok(land, "land area fill exists");
  assert.strictEqual(land["source-layer"], "LNDARE");
  assert.strictEqual(land.source, "passage_cache");
  assert.strictEqual(land.paint["fill-color"], "#2a3a2e");
  const coast = byId["passage_cache-COALNE-line"];
  assert.ok(coast, "coastline line exists");
  assert.strictEqual(coast.paint["line-color"], "#7fa3b0");
  const sounding = byId["passage_cache-SOUNDG-circle"];
  assert.ok(sounding, "soundings circle exists");
  // Fill families draw fills only, line families lines only.
  assert.ok(!byId["passage_cache-COALNE-fill"], "no coastline fill");
  assert.ok(!byId["passage_cache-SOUNDG-line"], "no sounding line");
});

test("maplibreStyleFor: OSM-marine source layers get themed styling", async () => {
  const vm = await loadVm();
  // The layer names the corridor downloader's OSM-derived tiles carry
  // (as seen on the live server's passage_cache) — none of these may
  // fall through to the neutral default, or the chart renders blank-ish.
  const style = vm.maplibreStyleFor({
    ...VECTOR_CHART,
    chartLayers: [
      "land",
      "light",
      "sea_area",
      "seamark",
      "water",
      "waterway",
      "wetland",
    ],
  });
  const byId = Object.fromEntries(style.layers.map((l) => [l.id, l]));
  // sea_area rides the water family.
  assert.strictEqual(
    byId["passage_cache-sea_area-fill"].paint["fill-color"],
    "#102a3d",
  );
  // seamark: teal circle + line, distinct from the neutral gray default.
  assert.strictEqual(
    byId["passage_cache-seamark-circle"].paint["circle-color"],
    "#9fd6d9",
  );
  assert.strictEqual(
    byId["passage_cache-waterway-line"].paint["line-color"],
    "#2f6a80",
  );
  assert.strictEqual(
    byId["passage_cache-wetland-fill"].paint["fill-color"],
    "#233830",
  );
  // lights are amber dots.
  assert.strictEqual(
    byId["passage_cache-light-circle"].paint["circle-color"],
    "#e0b458",
  );
  // None of them keep the neutral default colors.
  for (const id of [
    "passage_cache-seamark-fill",
    "passage_cache-waterway-fill",
    "passage_cache-wetland-fill",
  ]) {
    assert.notStrictEqual(byId[id].paint["fill-color"], "#1c2830");
  }
});

test("maplibreStyleFor: paint order — fills before lines before circles", async () => {
  const vm = await loadVm();
  const style = vm.maplibreStyleFor(VECTOR_CHART);
  const types = style.layers.slice(1).map((l) => l.type);
  const firstLine = types.indexOf("line");
  const firstCircle = types.indexOf("circle");
  const lastFill = types.lastIndexOf("fill");
  assert.ok(types.slice(0, firstLine).every((t) => t === "fill"));
  assert.ok(lastFill < firstCircle, "all fills under the circles");
  assert.ok(firstLine < firstCircle, "lines under circles");
});

test("maplibreStyleFor: unknown layers fall back to the neutral trio", async () => {
  const vm = await loadVm();
  const style = vm.maplibreStyleFor({
    ...VECTOR_CHART,
    identifier: "weird set!", // also exercises the id sanitizer
    chartLayers: ["mystery_layer"],
  });
  assert.ok(style.sources.weird_set_, "identifier sanitized for source id");
  for (const suffix of ["fill", "line", "circle"]) {
    const layer = style.layers.find(
      (l) => l.id === `weird_set_-mystery_layer-${suffix}`,
    );
    assert.ok(layer, `default ${suffix} exists`);
    assert.strictEqual(layer["source-layer"], "mystery_layer");
  }
});

test("maplibreStyleFor: missing chartLayers falls back to identifier as source-layer", async () => {
  const vm = await loadVm();
  const style = vm.maplibreStyleFor({
    identifier: "notilespec",
    name: "No Tile Spec",
    url: "/signalk/v1/api/resources/charts/notilespec/{z}/{x}/{y}",
    minZoom: 0,
    maxZoom: 12,
    format: "pbf",
  });
  const data = style.layers.filter((l) => l.type !== "background");
  assert.ok(data.length >= 3, "default trio emitted");
  assert.ok(
    data.every((l) => l["source-layer"] === "notilespec"),
    "identifier used as source-layer",
  );
});

test("maplibreStyleFor: layer ids stay unique (dedup-safe source layers)", async () => {
  const vm = await loadVm();
  const style = vm.maplibreStyleFor({
    ...VECTOR_CHART,
    chartLayers: ["water", "water"],
  });
  const ids = style.layers.map((l) => l.id);
  assert.strictEqual(new Set(ids).size, ids.length);
});

// A feature shaped like what MapLibre's queryRenderedFeatures hands
// back: layer.type selects the renderer bucket, properties hold the
// charted label fields (name, and for lights the `light` characteristic),
// geometry.type is the source feature's shape (Point for a light,
// Polygon for a labelled area like a nature reserve).
const hit = (properties, geometryType, layerType = "symbol") => ({
  layer: { type: layerType },
  properties,
  geometry: geometryType ? { type: geometryType } : undefined,
});

test("pickSymbolNameFromHits: prefers the point light over an area label", async () => {
  const vm = await loadVm();
  // Right-click on a light inside the 100 NM Marae Moana reserve: the
  // reserve's text label spans the catchment, but its source geometry is
  // a polygon. Render order may put the area label first — the point
  // light must still win.
  const hits = [
    hit({ name: "Marae Moana" }, "Polygon"),
    hit({ name: "Rangitahua Light" }, "Point"),
  ];
  assert.strictEqual(vm.pickSymbolNameFromHits(hits), "Rangitahua Light");
});

test("pickSymbolNameFromHits: point wins regardless of render order", async () => {
  const vm = await loadVm();
  const hits = [
    hit({ name: "Rangitahua Light" }, "Point"),
    hit({ name: "Marae Moana" }, "Polygon"),
  ];
  assert.strictEqual(vm.pickSymbolNameFromHits(hits), "Rangitahua Light");
});

test("pickSymbolNameFromHits: nameless light resolves to its `light` characteristic", async () => {
  const vm = await loadVm();
  // Most lights carry an empty `name`; their charted label is the
  // `light` characteristic (e.g. Fl.G.3s), which is how the Open Waters
  // `lights-label` layer renders them. The characteristic must win over
  // a surrounding sea-area label so the sight form carries the object,
  // not the reserve.
  const hits = [
    hit({ name: "Marae Moana" }, "Polygon"),
    hit({ name: "", light: "Fl.G.3s" }, "Point"),
  ];
  assert.strictEqual(vm.pickSymbolNameFromHits(hits), "Fl.G.3s");
});

test("pickSymbolNameFromHits: prefers `name` over `light` when both exist", async () => {
  const vm = await loadVm();
  const hits = [hit({ name: "Rangitahua Light", light: "Fl.W.3s" }, "Point")];
  assert.strictEqual(vm.pickSymbolNameFromHits(hits), "Rangitahua Light");
});

test("pickSymbolNameFromHits: area labels are not used (bearings are to points)", async () => {
  const vm = await loadVm();
  // Picking open water near the reserve's label: no point object under
  // the cursor. A bearing "to Marae Moana" is meaningless, so the pick
  // stays unnamed rather than attributing the sight to the reserve.
  const hits = [hit({ name: "Marae Moana" }, "Polygon")];
  assert.strictEqual(vm.pickSymbolNameFromHits(hits), null);
});

test("pickSymbolNameFromHits: skips non-symbol layers, empty names, and area labels", async () => {
  const vm = await loadVm();
  const hits = [
    // Non-symbol layer ignored even when named.
    hit({ name: "Marae Moana" }, "Polygon", "fill"),
    // Empty-name point with no `light` skipped.
    hit({ name: "", light: "" }, "Point"),
    // Named polygon label ignored (not a point object).
    hit({ name: "Marae Moana" }, "Polygon"),
  ];
  assert.strictEqual(vm.pickSymbolNameFromHits(hits), null);
});

test("pickSymbolNameFromHits: null/empty hits yield null", async () => {
  const vm = await loadVm();
  assert.strictEqual(vm.pickSymbolNameFromHits(null), null);
  assert.strictEqual(vm.pickSymbolNameFromHits([]), null);
  assert.strictEqual(vm.pickSymbolNameFromHits(undefined), null);
});

test("isBearingablePointHit: true over a named point (light, peak, cape)", async () => {
  const vm = await loadVm();
  const hits = [hit({ name: "Rangitahua Light" }, "Point")];
  assert.strictEqual(vm.isBearingablePointHit(hits), true);
});

test("isBearingablePointHit: true over an UNNAMED point (a buoy you can see)", async () => {
  const vm = await loadVm();
  // A buoy with no charted name is still something you can take a
  // bearing to — the cursor signals it even though the sight form
  // leaves the object field blank for the user to type.
  const hits = [hit({ name: "", light: "" }, "Point")];
  assert.strictEqual(vm.isBearingablePointHit(hits), true);
});

test("isBearingablePointHit: false over an area/line label only", async () => {
  const vm = await loadVm();
  // The 100 NM reserve label alone — no point object under the cursor —
  // is not bearing-able, so no crosshair.
  assert.strictEqual(
    vm.isBearingablePointHit([hit({ name: "Marae Moana" }, "Polygon")]),
    false,
  );
  assert.strictEqual(
    vm.isBearingablePointHit([hit({ name: "Shipping Lane" }, "LineString")]),
    false,
  );
});

test("isBearingablePointHit: ignores non-symbol layers", async () => {
  const vm = await loadVm();
  const hits = [hit({ name: "Marae Moana" }, "Polygon", "fill")];
  assert.strictEqual(vm.isBearingablePointHit(hits), false);
});

test("isBearingablePointHit: null/empty hits yield false", async () => {
  const vm = await loadVm();
  assert.strictEqual(vm.isBearingablePointHit(null), false);
  assert.strictEqual(vm.isBearingablePointHit([]), false);
  assert.strictEqual(vm.isBearingablePointHit(undefined), false);
});

test("firstPointSymbolHit: returns the first point symbol feature itself", async () => {
  const vm = await loadVm();
  // The map view's closest-point pick iterates catchment radii and
  // needs the feature (not just its name) to resolve name vs `light`.
  const light = hit({ name: "", light: "Fl.G.3s" }, "Point");
  assert.strictEqual(
    vm.firstPointSymbolHit([hit({ name: "Marae Moana" }, "Polygon"), light]),
    light,
  );
  assert.strictEqual(
    vm.firstPointSymbolHit([hit({ name: "Marae Moana" }, "Polygon")]),
    null,
  );
  assert.strictEqual(vm.firstPointSymbolHit(null), null);
});

test("pointSymbolName: name beats `light`, `light` beats empty, null feature", async () => {
  const vm = await loadVm();
  assert.strictEqual(
    vm.pointSymbolName(hit({ name: "Raoul Peak", light: "Fl.W.3s" }, "Point")),
    "Raoul Peak",
  );
  assert.strictEqual(
    vm.pointSymbolName(hit({ name: "", light: "Fl.G.3s" }, "Point")),
    "Fl.G.3s",
  );
  assert.strictEqual(
    vm.pointSymbolName(hit({ name: "", light: "" }, "Point")),
    null,
  );
  assert.strictEqual(vm.pointSymbolName(null), null);
});

test("vendor wiring: renderer, bridge and licenses vendored and referenced", () => {
  const vendor = path.join(__dirname, "..", "public", "vendor", "maplibre-gl");
  for (const file of [
    "maplibre-gl.js",
    "maplibre-gl.css",
    "leaflet-maplibre-gl.js",
    "LICENSE-maplibre-gl.txt",
    "LICENSE-leaflet-maplibre-gl.txt",
  ]) {
    const stat = fs.statSync(path.join(vendor, file));
    assert.ok(stat.size > 500, `${file} vendored non-empty`);
  }

  // index.html loads leaflet → maplibre → bridge, in that order: the
  // bridge needs both globals at parse time.
  const html = fs.readFileSync(
    path.join(__dirname, "..", "public", "index.html"),
    "utf8",
  );
  const iLeaflet = html.indexOf("./vendor/leaflet/leaflet.js");
  const iMaplibre = html.indexOf("./vendor/maplibre-gl/maplibre-gl.js");
  const iBridge = html.indexOf("./vendor/maplibre-gl/leaflet-maplibre-gl.js");
  assert.ok(iLeaflet >= 0, "leaflet script present");
  assert.ok(iMaplibre > iLeaflet, "maplibre after leaflet");
  assert.ok(iBridge > iMaplibre, "bridge after maplibre");

  // The map view scopes MapLibre's CSS inside its shadow root (the
  // document-level link can't reach .maplibregl-* there) and mounts
  // vector charts via the bridge.
  const mapView = fs.readFileSync(
    path.join(__dirname, "..", "public", "dr-map-view.js"),
    "utf8",
  );
  assert.match(mapView, /vendor\/maplibre-gl\/maplibre-gl\.css/);
  assert.match(mapView, /isVectorChart/);
  assert.match(mapView, /L\.maplibreGL/);
  // Mirror-first discovery: the downloader's asset manifest, when it
  // carries a style URL, replaces the composed styles wholesale.
  assert.match(
    mapView,
    /signalk-corridor-tile-downloader\/assets\/manifest\.json/,
  );
  assert.match(mapView, /chartAssetsFromManifest/);
  assert.match(mapView, /__chart_mirror__/);
  // Terrarium DEM (webp) stores are mirror internals, never overlays.
  assert.match(mapView, /format !== "webp"/);
  // Picks resolve charted symbol names (lights, marks, peaks) so
  // bearings are taken to identified objects. The closest-point pick
  // (iterative catchment 0→5→10 px) is delegated to the pure vm helpers
  // (firstPointSymbolHit, pointSymbolName) so a point symbol under the
  // cursor wins over an area label (light vs. 100 NM reserve).
  assert.match(mapView, /pickSymbolName/);
  assert.match(mapView, /_pickClosestPointSymbol/);
  assert.match(mapView, /\[0,\s*5,\s*10\]/);
  assert.match(mapView, /vm\.pointSymbolName/);
  assert.match(mapView, /vm\.firstPointSymbolHit/);
  // CRITICAL: queryRenderedFeatures geometry MUST be an array —
  // `[x, y]` for a point, `[[..],[..]]` for a box. A plain
  // `{left, top, right, bottom}` is neither a Point nor an Array, so
  // MapLibre silently falls back to the WHOLE viewport and the pick
  // resolves to the first point feature anywhere on screen (1–100 NM
  // from the click). Lock the array form in and the object form out.
  assert.match(mapView, /queryRenderedFeatures\(\[/);
  assert.doesNotMatch(mapView, /queryRenderedFeatures\(\s*\{\s*left\s*:/);
  // Hover cursor: the map view turns the cursor crosshair over a
  // bearing-able chart object (vm.isBearingablePointHit), reset on
  // mouseout, and re-queries on mousemove via a rAF throttle.
  assert.match(mapView, /isBearingableAt/);
  assert.match(mapView, /vm\.isBearingablePointHit/);
  assert.match(mapView, /mousemove/);
  assert.match(mapView, /mouseout/);
  assert.match(mapView, /crosshair/);
  assert.match(mapView, /requestAnimationFrame/);
  assert.match(mapView, /cancelAnimationFrame/);
  const sightPanel = fs.readFileSync(
    path.join(__dirname, "..", "public", "dr-sight-panel.js"),
    "utf8",
  );
  assert.match(sightPanel, /seedObjectPosition\(lat, lon, mode, label\)/);
  assert.match(sightPanel, /input\[name="object"\]/);
});
