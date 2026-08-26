/**
 * Tests for the configurable position formatter.
 * @file dr-position-format.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const pfPromise = import("../public/dr-position-format.js");

/** Resolves the position-format module (loaded once, shared by all tests). */
async function loadPf() {
  return pfPromise;
}

test("formatCoord: decimal degrees with hemisphere", async () => {
  const pf = await loadPf();
  assert.strictEqual(
    pf.formatCoord(60.5, "lat", { format: "decimal", hemisphere: true }),
    "60.5000 N",
  );
  assert.strictEqual(
    pf.formatCoord(-159.8, "lon", { format: "decimal", hemisphere: true }),
    "159.8000 W",
  );
  // no hemisphere → signed
  assert.strictEqual(
    pf.formatCoord(-159.8, "lon", { format: "decimal", hemisphere: false }),
    "-159.8000",
  );
});

test("formatCoord: DM (degrees + decimal minutes)", async () => {
  const pf = await loadPf();
  // 60°30.000' N (60.5 deg)
  assert.strictEqual(
    pf.formatCoord(60.5, "lat", { format: "dm", hemisphere: true }),
    "60°30.000' N",
  );
  // 159°48.000' W (159.8 deg)
  assert.strictEqual(
    pf.formatCoord(-159.8, "lon", { format: "dm", hemisphere: true }),
    "159°48.000' W",
  );
});

test("formatCoord: DMS (degrees + minutes + seconds)", async () => {
  const pf = await loadPf();
  // 60°30'15.0" N (60.504167 deg)
  const d = 60 + 30 / 60 + 15 / 3600;
  assert.strictEqual(
    pf.formatCoord(d, "lat", { format: "dms", hemisphere: true }),
    "60°30'15.0\" N",
  );
  // 159°48'00.0" W (159.8 deg)
  assert.strictEqual(
    pf.formatCoord(-159.8, "lon", { format: "dms", hemisphere: true }),
    "159°48'00.0\" W",
  );
});

test("formatPosition: pair formatting", async () => {
  const pf = await loadPf();
  const s = pf.formatPosition([60.5, -159.8], {
    format: "dm",
    hemisphere: true,
  });
  assert.ok(s.includes("60°30.000' N"));
  assert.ok(s.includes("159°48.000' W"));
});

test("default format is DMS, setFormat/getFormat change it", async () => {
  const pf = await loadPf();
  assert.strictEqual(pf.getFormat().format, "dms");
  pf.setFormat("dm");
  assert.strictEqual(pf.getFormat().format, "dm");
  assert.strictEqual(pf.fmt(60.5, "lat"), "60°30.000' N");
  pf.setFormat("dms"); // restore default
  assert.strictEqual(pf.fmt(60.5, "lat"), "60°30'00.0\" N");
});

test("fmtPos uses global default", async () => {
  const pf = await loadPf();
  pf.setFormat("decimal");
  assert.strictEqual(pf.fmtPos([60.5, -159.8]), "60.5000 N 159.8000 W");
  pf.setFormat("dms");
});

test("parseCoord: round-trips decimal", async () => {
  const pf = await loadPf();
  assert.strictEqual(pf.parseCoord("60.5 N", "lat"), 60.5);
  assert.strictEqual(pf.parseCoord("159.8 W", "lon"), -159.8);
  assert.strictEqual(pf.parseCoord("-159.8", "lon"), -159.8);
});

test("parseCoord: round-trips DM", async () => {
  const pf = await loadPf();
  const d = pf.parseCoord("60°30.000' N", "lat");
  assert.ok(Math.abs(d - 60.5) < 1e-6, `DM parse: ${d}`);
  const d2 = pf.parseCoord("159°48.000' W", "lon");
  assert.ok(Math.abs(d2 - -159.8) < 1e-6, `DM parse: ${d2}`);
});

test("parseCoord: round-trips DMS", async () => {
  const pf = await loadPf();
  const d = pf.parseCoord("60°30'15.0\" N", "lat");
  assert.ok(Math.abs(d - (60 + 30 / 60 + 15 / 3600)) < 1e-6, `DMS: ${d}`);
});

test("parseCoord: throws on garbage", async () => {
  const pf = await loadPf();
  assert.throws(() => pf.parseCoord("", "lat"), /empty/);
  assert.throws(() => pf.parseCoord("not a coord", "lat"), /cannot parse/);
});

test("parsePosition: pair parsing", async () => {
  const pf = await loadPf();
  const [lat, lon] = pf.parsePosition("60.5 N", "159.8 W");
  assert.strictEqual(lat, 60.5);
  assert.strictEqual(lon, -159.8);
});

test("coordParts: DM split", async () => {
  const pf = await loadPf();
  const p = pf.coordParts(60.5, "lat", "dm");
  assert.deepStrictEqual(p, { deg: 60, min: 30, sec: null, hem: "N" });
  const p2 = pf.coordParts(-159.8, "lon", "dm");
  assert.deepStrictEqual(p2, { deg: 159, min: 48, sec: null, hem: "W" });
});

test("coordParts: DMS split", async () => {
  const pf = await loadPf();
  const d = 60 + 30 / 60 + 15 / 3600;
  const p = pf.coordParts(d, "lat", "dms");
  assert.deepStrictEqual(p, { deg: 60, min: 30, sec: 15, hem: "N" });
});

test("parseParts: round-trips DM and DMS", async () => {
  const pf = await loadPf();
  assert.strictEqual(
    pf.parseParts({ deg: 60, min: 30, sec: null, hem: "N" }),
    60.5,
  );
  assert.strictEqual(
    pf.parseParts({ deg: 159, min: 48, sec: null, hem: "W" }),
    -159.8,
  );
  const d = pf.parseParts({ deg: 60, min: 30, sec: 15, hem: "N" });
  assert.ok(Math.abs(d - (60 + 30 / 60 + 15 / 3600)) < 1e-6, `DMS: ${d}`);
});

test("coordParts uses the global default format when omitted", async () => {
  const pf = await loadPf();
  pf.setFormat("dm");
  const p = pf.coordParts(60.5, "lat");
  assert.deepStrictEqual(p, { deg: 60, min: 30, sec: null, hem: "N" });
  pf.setFormat("dms");
});
