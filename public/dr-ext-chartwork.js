/**
 * Pure chartwork render-model for the DR plotter extension (work doc
 * #38): turns the plugin REST rows (GET /observations, /fixes,
 * /corrections) plus the live DR state into GeoJSON features for a
 * Freeboard-SK **data overlay** (`overlays.data`), and decides toolbar
 * button visibility. No DOM, no bus — importable in Node for tests;
 * the geometry conventions are the webapp's own, reused from
 * `dr-viewmodel.js` (dr-map-view.js mirrors this pipeline onto
 * Leaflet).
 *
 * Feature id conventions (stable, so `overlay.setData` upserts and
 * `overlayFeature` actions can address them):
 *
 *   lop:<lop_id>   cpl:<cpl_id>   fix:<fix_id>   snap:<correction id>
 *   ghost          uncertainty    drpos          candidate
 *
 * @file dr-ext-chartwork.js
 */

import * as vm from "./dr-viewmodel.js";

const { STYLE } = vm;

/**
 * Day palette per style layer id — kept beside the module that builds
 * the features so the style JSON and the night recoloring can never
 * drift apart (the runtime `overlay.setLayer`s these on nightMode).
 * Line layers take `line-color`; the fill/symbol/circle layers are
 * recolored through `PAINT_PROPERTY` below (a host draws a layer
 * exactly or not at all, so a wrong property name would skip it).
 */
export const LAYER_COLORS = {
  "dr-ghost-casing": STYLE.track.casingColor,
  "dr-ghost": STYLE.ghostTrack,
  "dr-uncertainty-fill": STYLE.uncertainty,
  "dr-uncertainty-line": STYLE.uncertainty,
  "dr-snap": STYLE.snapVector,
  "dr-lop": STYLE.lop,
  "dr-lop-used": STYLE.lopUsed,
  "dr-cpl": STYLE.cpl,
  "dr-cpl-used": STYLE.cplUsed,
  "dr-candidate": "#c94b4b",
  "dr-candidate-dot": "#c94b4b",
  "dr-error": "#ff5e5e",
  "dr-fix": "#ffffff",
  "dr-pos": STYLE.track.casingColor,
  "dr-labels": "#e8e8ee",
};

/** Non-line palette layers: layer id → the paint property to set. */
export const PAINT_PROPERTY = {
  "dr-uncertainty-fill": "fill-color",
  "dr-labels": "text-color",
  "dr-error": "text-color",
  "dr-candidate": "circle-stroke-color",
  "dr-candidate-dot": "circle-color",
  "dr-pos": "circle-stroke-color",
  "dr-fix": "circle-stroke-color",
};

/**
 * Night palette overrides (nightMode capability): warm, low-blue
 * chartwork so the layer doesn't glow on a dark bridge — the same
 * family hues, shifted toward amber/red as in dr-theme's night mode.
 * Layers absent here keep their day color.
 */
export const LAYER_COLORS_NIGHT = {
  "dr-ghost-casing": "#1a0f08",
  "dr-ghost": "#c97b4f",
  "dr-uncertainty-fill": "#8a6a4a",
  "dr-uncertainty-line": "#8a6a4a",
  "dr-snap": "#7a6a5a",
  "dr-lop": "#d99a4e",
  "dr-lop-used": "#9a6f38",
  "dr-cpl": "#c98f66",
  "dr-cpl-used": "#7a5a44",
  "dr-candidate": "#e06a5a",
  "dr-candidate-dot": "#e06a5a",
  "dr-error": "#e06a5a",
  "dr-fix": "#e8c9a0",
  "dr-pos": "#1a0f08",
  "dr-labels": "#e8c9a0",
};

/** Every layer the palette recolors (line + PAINT_PROPERTY ones). */
export const PALETTE_LAYER_IDS = [
  ...Object.keys(LAYER_COLORS),
  ...Object.keys(PAINT_PROPERTY),
];

/** Night palette lookup — day color when no override exists. */
export function paletteColor(layerId, night) {
  return night
    ? (LAYER_COLORS_NIGHT[layerId] ?? LAYER_COLORS[layerId])
    : LAYER_COLORS[layerId];
}

/**
 * Unresolved observations the pending list would show — the driver of
 * the *Pending observations* toolbar button (visible only while there
 * is something to work). Same freshness rule as the list itself: used
 * observations are done, and rows older than 24 h are history, not
 * work in progress.
 *
 * @param {object[]} lops - GET /observations rows
 * @param {object[]} cpls - GET /observations rows
 * @param {number} [nowMs]
 * @returns {number}
 */
export function pendingCount(lops, cpls, nowMs = Date.now()) {
  return [...(lops ?? []), ...(cpls ?? [])].filter(
    (r) => r.used_in_fix_id == null && !vm.isPendingStale(r, nowMs),
  ).length;
}

/**
 * Diffs the previous pushed feature set against the next: features
 * whose content changed go to `upsert`, gone ids to `remove`. The
 * runtime pushes this instead of replacing the whole source on every
 * DR tick — a full `data` replacement is a `clear`-and-refill of the
 * host's vector source once a second, which is both wasteful and hard
 * on the renderer (observed as chartwork flickering/vanishing through
 * zoom gestures). The first push is a plain `upsert` of everything.
 *
 * @param {Map<string, object>|null} previous - id → feature as last pushed
 * @param {object[]} next - the new FeatureCollection's features
 * @returns {{upsert: object[], remove: string[], next: Map<string, object>}}
 */
export function diffFeatures(previous, next) {
  const nextById = new Map(next.map((f) => [String(f.id), f]));
  const upsert = [];
  for (const [id, feature] of nextById) {
    const before = previous?.get(id);
    if (!before || JSON.stringify(before) !== JSON.stringify(feature)) {
      upsert.push(feature);
    }
  }
  const remove = [];
  if (previous) {
    for (const id of previous.keys()) {
      if (!nextById.has(id)) remove.push(id);
    }
  }
  return { upsert, remove, next: nextById };
}

/**
 * Great-circle distance in nm (haversine, longitude delta wrapped to
 * the short way — the chart lives near the antimeridian as often as
 * not).
 *
 * @param {[number, number]} from - [lat, lon]
 * @param {[number, number]} to - [lat, lon]
 * @returns {number}
 */
export function distanceNm(from, to) {
  const dLat = ((to[0] - from[0]) * Math.PI) / 180;
  const dLon =
    (((((to[1] - from[1]) % 360) + 540) % 360) - 180) * (Math.PI / 180);
  const φ1 = (from[0] * Math.PI) / 180;
  const φ2 = (to[0] * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(dLon / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * The diagonal of a `[west, south, east, north]` bounds in nm — the
 * yardstick chartwork geometry is clipped against (a line longer than
 * the diagonal cannot cross the view without also ending inside it).
 *
 * @param {[number, number, number, number]} bounds
 * @returns {number}
 */
export function boundsDiagonalNm(bounds) {
  const [w, s, e, n] = bounds;
  return distanceNm([s, w], [n, e]);
}

/**
 * Inflates a `[w, s, e, n]` bounds by `fraction` of its own span on
 * every side (antimeridian-aware), giving the clip box chartwork is
 * drawn against: geometry stays within ~1.5 view diagonals of the
 * viewport, far inside the canvas precision range at every zoom.
 *
 * @param {[number, number, number, number]} bounds
 * @param {number} [fraction=0.5]
 * @returns {[number, number, number, number]}
 */
export function inflateBounds(bounds, fraction = 0.5, minSpanNm = 2) {
  const [w, s, e, n] = bounds;
  const lonSpan = e >= w ? e - w : e - w + 360;
  const latSpan = n - s;
  // The floor keeps the clip box (and the clipped chartwork) stable
  // across deep zooms: below it the box would shrink to a sliver and
  // the clipped geometry would churn on every view change, stranding
  // features between renders. The floor is still far inside the canvas
  // precision range at plotter zooms (2 nm ≈ 26,000 px at z20).
  const minSpanDeg = (minSpanNm * vm.METRES_PER_NM) / 111320;
  const lonCenter = w + lonSpan / 2;
  const latCenter = (s + n) / 2;
  const outLonSpan = Math.max(lonSpan * (1 + 2 * fraction), minSpanDeg);
  const outLatSpan = Math.max(latSpan * (1 + 2 * fraction), minSpanDeg);
  return [
    lonCenter - outLonSpan / 2,
    latCenter - outLatSpan / 2,
    lonCenter - outLonSpan / 2 + outLonSpan,
    latCenter + outLatSpan / 2,
  ];
}

/**
 * Wraps a longitude into the frame `[baseLon, baseLon + 360)` — clip
 * math needs every coordinate on one side of the antimeridian, and the
 * view's frame is whichever copy of the world the user is looking at.
 *
 * @param {number} lon
 * @param {number} baseLon
 * @returns {number}
 */
function lonInFrame(lon, baseLon) {
  return ((((lon - baseLon) % 360) + 360) % 360) + baseLon;
}

/**
 * Unwraps a polyline's longitudes onto a continuous strip: every vertex
 * after the first shifts by ±360° onto the previous vertex's strip, so
 * an antimeridian crossing stays a short segment in the emitted
 * geometry. A host renderer projects unwrapped longitudes onto the
 * neighbouring world copy — MapLibre on Freeboard-SK, Leaflet in the
 * webapp (`vm.worldCopies`) — instead of joining the seam the long way
 * around the planet. Takes GeoJSON `[lon, lat]` points; the input list
 * is untouched.
 *
 * @param {Array<[number, number]>} coords
 * @returns {Array<[number, number]>} unwrapped copy
 */
function unwrapLongitudes(coords) {
  const out = [];
  for (const [lon, lat] of coords) {
    let l = lon;
    if (out.length > 0) {
      const prev = out[out.length - 1][0];
      while (l - prev > 180) l -= 360;
      while (l - prev < -180) l += 360;
    }
    out.push([l, lat]);
  }
  return out;
}

/**
 * Clips a polyline (GeoJSON coordinates, `[lon, lat]`) to a lon/lat
 * box, one or more runs — a track that leaves and re-enters the box
 * comes back as a MultiLineString's runs. Longitudes are unwrapped
 * into the box's frame (the view's world copy) and STAY there: a leg
 * crossing ±180° comes out continuous (179.99 → 180.01), which the
 * host renders as the short hop over the seam. Normalizing back to
 * `[-180, 180)` — the first cut did — re-folds the seam into the
 * coordinates and the track drew itself around the globe.
 *
 * Cohen–Sutherland-style segment clipping against a convex box.
 *
 * @param {Array<[number, number]>} coords
 * @param {[number, number, number, number]} bounds - [w, s, e, n]
 * @returns {Array<Array<[number, number]>>} non-empty runs
 */
export function clipLineToBounds(coords, bounds) {
  const [w, s, e, n] = bounds;
  const frame = w; // the box's west edge, its own frame
  const boxW = frame;
  const boxE = frame + (e >= w ? e - w : e - w + 360);
  if (boxE - boxW >= 360 - 1e-9) {
    // The whole world is in view — nothing to clip away, and the
    // frame's own ±180° edges would only cut a seam crossing apart.
    return [unwrapLongitudes(coords)];
  }
  const inLat = (lat) => lat >= s && lat <= n;
  const inLon = (lon) => lon >= boxW && lon <= boxE;
  const runs = [];
  let run = null;
  const push = (p) => {
    // Skip a repeat of the just-pushed vertex: each segment start is
    // pushed, and an interior vertex inside both of its segments would
    // otherwise land twice in the run.
    if (
      run &&
      run[run.length - 1][0] === p[0] &&
      run[run.length - 1][1] === p[1]
    ) {
      return;
    }
    if (!run) {
      run = [];
      runs.push(run);
    }
    run.push(p);
  };
  const endRun = () => {
    run = null;
  };
  /** Segment clip against the box; null when entirely outside. */
  const clipSegment = ([x1, y1], [x2, y2]) => {
    // Liang–Barsky in the box frame; lat first, then the (wrapped) lon.
    let t0 = 0;
    let t1 = 1;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const edges = [
      [-dx, x1 - boxW],
      [dx, boxE - x1],
      [-dy, y1 - s],
      [dy, n - y1],
    ];
    for (const [p, q] of edges) {
      if (p === 0) {
        if (q < 0) return null;
        continue;
      }
      const t = q / p;
      if (p < 0) {
        if (t > t1) return null;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return null;
        if (t < t1) t1 = t;
      }
    }
    return [
      [x1 + t0 * dx, y1 + t0 * dy],
      [x1 + t1 * dx, y1 + t1 * dy],
    ];
  };
  const unwrapped = [];
  let prev = null;
  for (const [lon, lat] of coords) {
    // Unwrap relative to the PREVIOUS vertex, not the box frame: a ray
    // whose far end lies west of the box's west edge must not fold
    // +360° across the frame — the folded segment clips at a different
    // angle and the LoP changes direction on screen.
    const l =
      prev == null
        ? lonInFrame(lon, frame)
        : prev + (((((lon - prev) % 360) + 540) % 360) - 180);
    unwrapped.push([l, lat]);
    prev = l;
  }
  for (let i = 0; i < unwrapped.length - 1; i++) {
    const a = unwrapped[i];
    const b = unwrapped[i + 1];
    const aIn = inLon(a[0]) && inLat(a[1]);
    const bIn = inLon(b[0]) && inLat(b[1]);
    if (aIn) push(a);
    const seg = clipSegment(a, b);
    if (seg) {
      // Emit only the part of the segment inside the box: the entry
      // point when the segment starts outside, and the end point (the
      // vertex itself when inside, the exit point when it leaves).
      const [p, q] = seg;
      if (!aIn) push(p);
      push(q);
    }
    if (!bIn) endRun();
  }
  return runs.filter((r) => r.length >= 2);
}

/**
 * Clips a polygon ring (GeoJSON coordinates, `[lon, lat]`) to a lon/lat
 * box — Sutherland–Hodgman, one convex box against one ring, so the
 * result is a single closed ring (possibly empty). Longitudes are
 * unwrapped into the box's frame and stay there — the same seam
 * continuity as `clipLineToBounds` — so a dateline-crossing uncertainty
 * circle fills the short way instead of smearing around the globe.
 *
 * @param {Array<[number, number]>} ring - open or closed ring
 * @param {[number, number, number, number]} bounds - [w, s, e, n]
 * @returns {Array<[number, number]>} closed clipped ring ([] when
 *   entirely outside)
 */
export function clipPolygonToBounds(ring, bounds) {
  const [w, s, e, n] = bounds;
  const frame = w;
  const boxW = frame;
  const boxE = frame + (e >= w ? e - w : e - w + 360);
  if (boxE - boxW >= 360 - 1e-9) {
    // Whole world in view — nothing to clip away; the unwrapped ring
    // is the answer. The closure vertex unwraps identically, so the
    // ring stays closed.
    return unwrapLongitudes(ring);
  }
  let poly = [];
  {
    // Unwrap sequentially around the ring (the closure edge stays
    // consistent) — the same fold hazard as the line clip.
    let prev = null;
    for (const [lon, lat] of ring) {
      const l =
        prev == null
          ? lonInFrame(lon, frame)
          : prev + (((((lon - prev) % 360) + 540) % 360) - 180);
      poly.push([l, lat]);
      prev = l;
    }
  }
  if (
    poly.length > 1 &&
    poly[0][0] === poly[poly.length - 1][0] &&
    poly[0][1] === poly[poly.length - 1][1]
  ) {
    poly = poly.slice(0, -1);
  }
  /** One edge pass: keep the inside, add box-edge intersections. */
  const clipEdge = (pts, inside, intersect) => {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const aIn = inside(a);
      const bIn = inside(b);
      if (bIn) {
        if (!aIn) out.push(intersect(a, b));
        out.push(b);
      } else if (aIn) {
        out.push(intersect(a, b));
      }
    }
    return out;
  };
  const lerp = (a, b, t) => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
  ];
  const tAt = (a, b, at, axis) => (at - a[axis]) / (b[axis] - a[axis]);
  for (const [axis, at, keep] of [
    [0, boxW, (p) => p[0] >= boxW],
    [0, boxE, (p) => p[0] <= boxE],
    [1, s, (p) => p[1] >= s],
    [1, n, (p) => p[1] <= n],
  ]) {
    poly = clipEdge(poly, keep, (a, b) => lerp(a, b, tAt(a, b, at, axis)));
    if (poly.length === 0) return [];
  }
  poly.push([poly[0][0], poly[0][1]]);
  return poly;
}

/**
 * Toolbar visibility from the engine state — **buttons** and
 * **actions** in one snapshot, each entry one `setVisibility` call
 * (`{ ids, visible }` — the host methods take a single object, not a
 * batch; an array here is `params must be object`). Like OVERRIDE,
 * confirmation is a decision the watchkeeper must be able to take from
 * the plotter directly, so while a resolved candidate fix is pending
 * its button is on the toolbar (and the candidate ring on the chart
 * confirms with a tap). The pending window button only earns its slot
 * while there ARE unresolved observations to work (the same 24 h
 * freshness the pending list itself applies). The **Confirm GNSS fix**
 * button — the DR origin's bootstrap — shows while a GNSS position is
 * available. The chart-driven
 * one-observation resolve ("Resolve fix from this") is an *action* —
 * gated on a previous confirmed fix existing to advance from (running
 * fix); per-observation staleness is the feature's own `stale`
 * property, matched statically in the manifest.
 *
 * Every entry is always listed so the calls fully describe the set — a
 * host without the capability ignores visibility, and every button's
 * action stays well-defined either way (the confirm topic no-ops
 * without a candidate).
 *
 * @param {object} s
 * @param {boolean} s.active - engine.active (OVERRIDE engaged)
 * @param {boolean} s.hasCandidate - a resolved candidate fix is pending
 * @param {boolean} s.hasFixes - a previous confirmed fix exists
 * @param {boolean} [s.hasPending] - unresolved observations to work
 * @param {boolean} [s.hasGnss] - a GNSS position is available
 * @returns {{buttons: Array<{ids: string[], visible: boolean}>,
 *   actions: Array<{ids: string[], visible: boolean}>}}
 */
export function toolbarVisibility(s) {
  return {
    buttons: [
      { ids: ["override-engage"], visible: !s.active },
      { ids: ["override-release"], visible: !!s.active },
      { ids: ["confirm-fix"], visible: !!s.hasCandidate },
      { ids: ["open-pending"], visible: !!s.hasPending },
      { ids: ["confirm-gnss"], visible: !!s.hasGnss },
    ],
    actions: [{ ids: ["resolve-from"], visible: !!s.hasFixes }],
  };
}

/**
 * A ring of `[lon, lat]` vertices around a WGS84 center — the polygon
 * approximation of the uncertainty circle (the style has no native
 * circle geometry; a 48-gon is smooth at chartwork scales). The
 * view-model's `destinationPoint` speaks [lat, lon], so the ring is
 * built in that order and flipped for GeoJSON.
 *
 * @param {[number, number]} center - [lat, lon]
 * @param {number} radiusNm
 * @param {number} [steps=48]
 * @returns {Array<[number, number]>} closed ring of [lon, lat]
 */
export function circleRing(center, radiusNm, steps = 48) {
  const ring = [];
  for (let i = 0; i < steps; i++) {
    const [lat, lon] = vm.destinationPoint(center, (360 * i) / steps, radiusNm);
    ring.push([lon, lat]);
  }
  ring.push(ring[0]);
  return ring;
}

/** Wraps geometry + properties into a GeoJSON feature. */
function feature(id, kind, geometry, props) {
  return {
    id,
    type: "Feature",
    geometry,
    properties: { kind, ...props },
  };
}

/** GeoJSON helpers — coordinates are [lon, lat] everywhere. */
const lineString = (coords) => ({ type: "LineString", coordinates: coords });
const multiLineString = (runs) => ({
  type: "MultiLineString",
  coordinates: runs,
});
const polygon = (ring) => ({ type: "Polygon", coordinates: [ring] });
const point = (coord) => ({ type: "Point", coordinates: coord });

/**
 * One bearing/celestial LOP → line feature. Geometry is the webapp's
 * own: `vm.lopLineSpec` + `vm.extendLineSpec` (a bearing draws as the
 * ray from the charted object toward the navigator; anything else as
 * the symmetric position line).
 *
 * @param {object} lop - db row from GET /observations
 * @param {[number, number, number, number]|null} [clip] - lon/lat box
 *   the geometry is clipped to (the inflated view bounds), keeping
 *   every path coordinate inside the canvas precision range
 * @returns {object|null} feature, or null when the row is malformed
 */
export function lopFeature(lop, clip = null) {
  if (
    typeof lop?.assumed_lat !== "number" ||
    typeof lop?.azimuth_true !== "number"
  ) {
    return null;
  }
  const spec = vm.lopLineSpec(lop);
  const [a, b] = vm.extendLineSpec(spec);
  // The webapp's tooltip convention: the sighted object's name, or
  // the observation type. (Bearing rows store the line's *normal* in
  // azimuth_true — the measured bearing is azimuth_true − 90 — so an
  // azimuth figure would mislead.)
  const name = `${lop.body_or_object ?? lop.lop_type ?? "position"} LOP`;
  const runs = clip
    ? clipLineToBounds(
        [
          [a[1], a[0]],
          [b[1], b[0]],
        ],
        clip,
      )
    : [
        [
          [a[1], a[0]],
          [b[1], b[0]],
        ],
      ];
  if (runs.length === 0) return null;
  return feature(
    `lop:${lop.lop_id}`,
    "lop",
    runs.length === 1 ? lineString(runs[0]) : multiLineString(runs),
    {
      name,
      used: spec.used,
      // Unresolved AND older than the pending list's own 24 h rule:
      // history, not a constraint to resolve — the manifest's static
      // action `match` reads this to keep resolve-from off a
      // month-old position line.
      stale: lop.used_in_fix_id == null && vm.isPendingStale(lop),
      lopType: spec.lopType,
    },
  );
}

/**
 * One circular position line → arc or full-circle line feature. The
 * webapp draws the arc aimed at the current DR position (with a
 * full-circle fallback when no DR position is known) — same here.
 *
 * @param {object} cpl - db row from GET /observations
 * @param {[number, number]|null} drPosition - [lat, lon] or null
 * @param {[number, number, number, number]|null} [clip] - lon/lat box
 *   the arc is clipped to (the inflated view bounds)
 * @returns {object|null}
 */
export function cplFeature(cpl, drPosition, clip = null) {
  if (
    typeof cpl?.center_lat !== "number" ||
    typeof cpl?.radius_nm !== "number"
  ) {
    return null;
  }
  const spec = vm.cplCircleSpec(cpl);
  const arc = drPosition ? vm.cplArcSpec(cpl, drPosition) : null;
  // The view-model speaks [lat, lon] (arc points); GeoJSON wants
  // [lon, lat] — circleRing already emits that order.
  const toLonLat = ([lat, lon]) => [lon, lat];
  const coords = arc
    ? arc.points.map(toLonLat)
    : circleRing(spec.center, spec.radiusNm);
  const runs = clip ? clipLineToBounds(coords, clip) : [coords];
  if (runs.length === 0) return null;
  return feature(
    `cpl:${cpl.cpl_id}`,
    "cpl",
    runs.length === 1 ? lineString(runs[0]) : multiLineString(runs),
    {
      name: `CPL r=${spec.radiusNm.toFixed(1)} nm`,
      used: spec.used,
      stale: cpl.used_in_fix_id == null && vm.isPendingStale(cpl),
    },
  );
}

/**
 * One confirmed fix → point feature, colored per source type (the
 * style paints `circle-color` from the feature's `color` property).
 *
 * @param {object} fix - db row from GET /fixes
 * @returns {object|null}
 */
export function fixFeature(fix) {
  if (typeof fix?.latitude !== "number") return null;
  const spec = vm.fixPointSpec(fix);
  const t = Date.parse(fix.timestamp);
  const label = Number.isFinite(t) ? vm.fixTimeLabel(fix.timestamp) : "Fix";
  return feature(
    `fix:${fix.fix_id}`,
    "fix",
    point([spec.position[1], spec.position[0]]),
    {
      name: label,
      label,
      color: spec.color,
      sourceType: fix.source_type,
    },
  );
}

/**
 * One snap-to-fix correction → dashed vector feature.
 *
 * @param {object} c - db row from GET /corrections
 * @returns {object|null}
 */
export function snapFeature(c) {
  if (typeof c?.dr_lat !== "number" || typeof c?.fix_lat !== "number") {
    return null;
  }
  const spec = vm.correctionSegmentSpec(c);
  const id = c.correction_id ?? `${c.timestamp ?? ""}`;
  return feature(
    `snap:${id}`,
    "snap",
    lineString(
      unwrapLongitudes([
        [spec.from[1], spec.from[0]],
        [spec.to[1], spec.to[0]],
      ]),
    ),
    {
      name: `Snap ${spec.deviationNm?.toFixed(2) ?? "?"} nm`,
    },
  );
}

/**
 * The DR ghost track → line feature from TrackLog points
 * (`[lat, lon, tMs]`, as merged from the History API backfill and the
 * live session buffer).
 *
 * @param {Array<[number, number, number]>} points
 * @returns {object|null}
 */
export function ghostFeature(points, clip = null) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const coords = points.map((p) => [p[1], p[0]]);
  const runs = clip
    ? clipLineToBounds(coords, clip)
    : [unwrapLongitudes(coords)];
  if (runs.length === 0) return null;
  return feature(
    "ghost",
    "ghost",
    runs.length === 1 ? lineString(runs[0]) : multiLineString(runs),
    {
      name: "DR track",
    },
  );
}

/**
 * The DR uncertainty circle → transparent-fill feature.
 *
 * @param {[number, number]} drPosition - [lat, lon]
 * @param {{radius_m: number, method?: string}|null} uncertainty
 * @returns {object|null}
 */
export function uncertaintyFeature(drPosition, uncertainty, clip = null) {
  if (!drPosition) return null;
  const spec = vm.uncertaintySpec(drPosition, uncertainty);
  if (!(spec.radiusNm > 0)) return null;
  // Unwrap before clipping: a circle centered near ±180° comes out of
  // circleRing with its longitudes normalized, i.e. with a seam jump —
  // unwrapped it fills across the dateline instead of around the globe
  // (clipPolygonToBounds re-unwraps, idempotently, into its frame).
  let ring = unwrapLongitudes(circleRing(spec.center, spec.radiusNm));
  if (clip) {
    ring = clipPolygonToBounds(ring, clip);
    if (ring.length === 0) return null;
  }
  return feature("uncertainty", "uncertainty", polygon(ring), {
    name: `Uncertainty ±${spec.radiusNm.toFixed(2)} nm`,
  });
}

/**
 * The live DR position → point feature ("the navigator's X").
 *
 * @param {[number, number]|null} drPosition - [lat, lon]
 * @param {number|null} tMs - position timestamp (epoch ms)
 * @returns {object|null}
 */
export function drPosFeature(drPosition, tMs) {
  if (!drPosition) return null;
  const label = vm.drTimeLabel(Number.isFinite(tMs) ? tMs : Date.now());
  return feature("drpos", "drpos", point([drPosition[1], drPosition[0]]), {
    name: label,
    label,
  });
}

/**
 * A resolved-but-unconfirmed candidate fix → hollow ring feature
 * (dr-map-view's renderCandidate, as overlay geometry).
 *
 * @param {object|null} candidate - POST /fix/resolve response object
 * @returns {object|null}
 */
export function candidateFeature(candidate) {
  if (!candidate || typeof candidate.latitude !== "number") return null;
  const residual =
    typeof candidate.residual_nm === "number"
      ? ` (residual ${candidate.residual_nm.toFixed(2)} nm)`
      : "";
  return feature(
    "candidate",
    "candidate",
    point([candidate.longitude, candidate.latitude]),
    {
      name: `candidate${residual}`,
      label: `candidate${residual}`,
      warn: vm.hasUnadvanced(candidate.advancements) === true,
    },
  );
}

/**
 * A transient failure note, drawn on the chart at the DR position —
 * the surface chart-driven errors need when no panel window is open:
 * a confirm that the server rejected, a resolve without coverage, must
 * be visible where the watchkeeper is looking, not only in a console.
 *
 * @param {string} message
 * @param {[number, number]|null} drPosition - [lat, lon]
 * @returns {object|null}
 */
export function errorFeature(message, drPosition) {
  if (!message || !drPosition) return null;
  return feature("error", "error", point([drPosition[1], drPosition[0]]), {
    label: message,
  });
}

/**
 * Builds the whole chartwork FeatureCollection from one snapshot of
 * the data. Order matters only for human debugging — the style's
 * filters route each feature to its layers.
 *
 * @param {object} d
 * @param {object[]} [d.lops] - GET /observations rows
 * @param {object[]} [d.cpls] - GET /observations rows
 * @param {object[]} [d.fixes] - GET /fixes rows
 * @param {object[]} [d.corrections] - GET /corrections rows
 * @param {Array<[number, number, number]>} [d.ghostTrack]
 * @param {[number, number]|null} d.drPosition - [lat, lon]
 * @param {number|null} [d.drTimeMs]
 * @param {{radius_m: number}|null} [d.uncertainty]
 * @param {object|null} [d.candidate]
 * @param {object|null} [d.error] - transient failure note (errorFeature)
 * @param {[number, number, number, number]|null} [d.clipBounds] - the
 *   inflated view bounds chartwork lines/arcs/polygons are clipped to;
 *   null draws full geometry (the standalone webapp's own renderer
 *   clips fine, and Node tests pass null)
 * @returns {{type: "FeatureCollection", features: object[]}}
 */
export function chartworkFeatures(d) {
  const features = [];
  const push = (f) => {
    if (f) features.push(f);
  };
  const dr = d.drPosition ?? null;
  const clip = d.clipBounds ?? null;
  push(ghostFeature(d.ghostTrack, clip));
  push(uncertaintyFeature(dr, d.uncertainty, clip));
  for (const c of d.corrections ?? []) push(snapFeature(c));
  for (const l of d.lops ?? []) push(lopFeature(l, clip));
  for (const c of d.cpls ?? []) push(cplFeature(c, dr, clip));
  for (const f of d.fixes ?? []) push(fixFeature(f));
  push(candidateFeature(d.candidate));
  push(drPosFeature(dr, d.drTimeMs));
  push(errorFeature(d.error, dr));
  return { type: "FeatureCollection", features };
}
