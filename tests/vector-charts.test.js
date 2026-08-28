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
});
