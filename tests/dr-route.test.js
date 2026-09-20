/**
 * Tests for the active-route layer's pure helpers: resource-href
 * parsing (Freeboard-SK's discovery pattern — the trailing segment of
 * `navigation.course.activeRoute.href`), the course→active-route
 * state reducer, the route-resource → map render-spec shaping
 * (GeoJSON [lon, lat] → Leaflet [lat, lon], name fallbacks, target
 * waypoint index), and waypoint labeling from coordinatesMeta.
 * Loads the browser ESM module directly, like dr-ais.test.js.
 * @file dr-route.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const vmPromise = import("../public/dr-viewmodel.js");

async function loadVm() {
  return vmPromise;
}

const ROUTE_RESOURCE = {
  name: "Summer cruise",
  feature: {
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: [
        [24.9, 60.1],
        [24.8, 60.2],
        [24.7, 60.3],
      ],
    },
    properties: {
      coordinatesMeta: [{ name: "Helsinki" }, { name: "Porkkala" }, {}],
    },
  },
};

test("resourceIdFromHref extracts the trailing segment", async () => {
  const vm = await loadVm();
  assert.equal(
    vm.resourceIdFromHref(
      "/resources/routes/9d4e6a1c-1111-2222-3333-444455556666",
    ),
    "9d4e6a1c-1111-2222-3333-444455556666",
  );
  assert.equal(vm.resourceIdFromHref("resources/routes/abc"), "abc");
  assert.equal(vm.resourceIdFromHref("/resources/waypoints/w1"), "w1");
});

test("resourceIdFromHref rejects non-hrefs", async () => {
  const vm = await loadVm();
  assert.equal(vm.resourceIdFromHref(null), null);
  assert.equal(vm.resourceIdFromHref(undefined), null);
  assert.equal(vm.resourceIdFromHref(""), null);
  assert.equal(vm.resourceIdFromHref(42), null);
});

test("activeRouteFromCourse parses href and pointIndex", async () => {
  const vm = await loadVm();
  const active = vm.activeRouteFromCourse({
    activeRoute: {
      href: "/resources/routes/rte-1",
      pointIndex: 2,
      reverse: false,
    },
  });
  assert.deepEqual(active, { id: "rte-1", pointIndex: 2 });
});

test("activeRouteFromCourse tolerates a null pointIndex", async () => {
  const vm = await loadVm();
  const active = vm.activeRouteFromCourse({
    activeRoute: { href: "/resources/routes/rte-1", pointIndex: null },
  });
  assert.deepEqual(active, { id: "rte-1", pointIndex: -1 });
});

test("activeRouteFromCourse unwraps REST {value} nodes", async () => {
  const vm = await loadVm();
  const active = vm.activeRouteFromCourse({
    activeRoute: {
      href: { value: "/resources/routes/rte-1", $source: "course.provider" },
      pointIndex: { value: 1 },
    },
  });
  assert.deepEqual(active, { id: "rte-1", pointIndex: 1 });
});

test("activeRouteFromCourse parses the wire delta object (whole activeRoute as one value)", async () => {
  const vm = await loadVm();
  // Verbatim shape observed on the stream: the course provider emits
  // the whole activeRoute object as one delta value at
  // `navigation.course.activeRoute`.
  const active = vm.activeRouteFromCourse({
    activeRoute: {
      href: "/resources/routes/7e59b216-d65f-4fca-a215-04e31de2ea1c",
      name: "Orca route",
      reverse: false,
      pointIndex: 0,
      pointTotal: 14,
    },
  });
  assert.deepEqual(active, {
    id: "7e59b216-d65f-4fca-a215-04e31de2ea1c",
    pointIndex: 0,
  });
  // A whole-node REST wrap also parses.
  const wrapped = vm.activeRouteFromCourse({
    activeRoute: {
      value: { href: "/resources/routes/rte-1", pointIndex: 2 },
      $source: "course.provider",
    },
  });
  assert.deepEqual(wrapped, { id: "rte-1", pointIndex: 2 });
});

test("activeRouteFromCourse returns null without a route", async () => {
  const vm = await loadVm();
  assert.equal(vm.activeRouteFromCourse(null), null);
  assert.equal(vm.activeRouteFromCourse({}), null);
  assert.equal(
    vm.activeRouteFromCourse({
      nextPoint: { position: { latitude: 60, longitude: 25 } },
    }),
    null,
  );
  // A single-waypoint destination is not a route.
  assert.equal(
    vm.activeRouteFromCourse({
      nextPoint: { href: "/resources/waypoints/w1" },
    }),
    null,
  );
});

test("routeRenderSpec swaps GeoJSON order to Leaflet [lat, lon]", async () => {
  const vm = await loadVm();
  const spec = vm.routeRenderSpec(ROUTE_RESOURCE, "rte-1", 1);
  assert.deepEqual(spec.points, [
    [60.1, 24.9],
    [60.2, 24.8],
    [60.3, 24.7],
  ]);
  assert.equal(spec.name, "Summer cruise");
  assert.equal(spec.targetIndex, 1);
});

test("routeRenderSpec falls back to properties.name then short-id label", async () => {
  const vm = await loadVm();
  const noName = {
    feature: {
      geometry: {
        coordinates: [
          [25, 60],
          [25.1, 60.1],
        ],
      },
      properties: { name: "From properties" },
    },
  };
  assert.equal(vm.routeRenderSpec(noName, "rte-2").name, "From properties");
  const bare = {
    feature: {
      geometry: {
        coordinates: [
          [25, 60],
          [25.1, 60.1],
        ],
      },
    },
  };
  assert.equal(vm.routeRenderSpec(bare, "9d4e6a1c").name, "Route 4e6a1c");
});

test("routeRenderSpec clamps an out-of-range target index", async () => {
  const vm = await loadVm();
  assert.equal(vm.routeRenderSpec(ROUTE_RESOURCE, "rte-1", 99).targetIndex, -1);
  assert.equal(vm.routeRenderSpec(ROUTE_RESOURCE, "rte-1", -5).targetIndex, -1);
  assert.equal(
    vm.routeRenderSpec(ROUTE_RESOURCE, "rte-1", null).targetIndex,
    -1,
  );
});

test("routeRenderSpec returns null without usable geometry", async () => {
  const vm = await loadVm();
  assert.equal(vm.routeRenderSpec(null, "rte-1"), null);
  assert.equal(vm.routeRenderSpec({}, "rte-1"), null);
  assert.equal(
    vm.routeRenderSpec({ feature: { geometry: { coordinates: [] } } }, "rte-1"),
    null,
  );
  // A single point is a line that isn't there yet.
  assert.equal(
    vm.routeRenderSpec(
      { feature: { geometry: { coordinates: [[25, 60]] } } },
      "rte-1",
    ),
    null,
  );
});

test("routeWaypointLabels uses coordinatesMeta names, 1-based WP fallback", async () => {
  const vm = await loadVm();
  assert.deepEqual(vm.routeWaypointLabels(ROUTE_RESOURCE, 3), [
    "Helsinki",
    "Porkkala",
    "WP 3",
  ]);
  assert.deepEqual(vm.routeWaypointLabels(null, 2), ["WP 1", "WP 2"]);
  assert.deepEqual(vm.routeWaypointLabels({}, 1), ["WP 1"]);
});
