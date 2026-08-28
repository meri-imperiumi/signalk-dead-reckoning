/**
 * Plotter-extension integration (work doc #19): manifest shape, resource
 * provider behaviour, asset mounting, and the pure widget render-model.
 *
 * @file plotterext.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  buildManifest,
  registerPlotterExtension,
  staticAssetHandler,
} = require("../plugin/plotterext.js");
const { FakeSignalKApp } = require("./fake-app.js");

const PLUGIN_ID = "signalk-dead-reckoning";
const ASSET_BASE = `/plotterext/${PLUGIN_ID}`;
const PUBLIC_DIR = path.join(__dirname, "..", "public");

/** The manifest a started plugin registers. */
function startedManifest() {
  const app = new FakeSignalKApp();
  registerPlotterExtension(app, { id: PLUGIN_ID });
  return app.resourceProviders[0].methods;
}

test("manifest targets plotter extension API v1", () => {
  const m = buildManifest(ASSET_BASE, "0.3.0");
  assert.equal(m.apiVersion, "1");
  assert.equal(m.name, "Dead Reckoning");
  assert.equal(m.version, "0.3.0");
  assert.ok(m.description.length > 0);
});

test("manifest requires the widget grid and the SK relay", () => {
  const m = buildManifest(ASSET_BASE, "0.3.0");
  assert.ok(m.requires.includes("widgets"));
  assert.ok(m.requires.includes("signalk.stream"));
  // Anything used-but-optional must be in `optional`, not assumed.
  for (const cap of m.optional ?? []) {
    assert.ok(!m.requires.includes(cap));
  }
});

test("manifest contributes a valid 2x1 status widget", () => {
  const m = buildManifest(ASSET_BASE, "0.3.0");
  assert.equal(m.widgets.length, 1);
  const [w] = m.widgets;
  assert.equal(w.id, "dr-status");
  assert.equal(w.type, "iframe");
  assert.equal(w.size, "2x1");
  assert.ok(["1x1", "2x1", "1x2", "2x2"].includes(w.size));
  assert.equal(w.lifecycle, "whileEnabled");
  assert.ok(w.url.startsWith(`${ASSET_BASE}/`));
});

test("widget asset entry page and its imports exist on disk", () => {
  const m = buildManifest(ASSET_BASE, "0.3.0");
  const page = path.join(PUBLIC_DIR, path.basename(m.widgets[0].url));
  assert.ok(fs.existsSync(page), `${page} missing`);
  const html = fs.readFileSync(page, "utf8");
  // Entry page must load the widget module relatively so it resolves
  // under the /plotterext/<id>/ mount of the same public/ directory.
  assert.match(html, /src="\.\/dr-ext-widget\.js"/);
  for (const mod of [
    "dr-ext-widget.js",
    "dr-ext-model.js",
    "dr-viewmodel.js",
    "dr-theme.js",
    "vendor/plotterext-bus/extension.js",
    "vendor/plotterext-bus/chunk-7XRFPDQL.js",
    "vendor/plotterext-bus/chunk-4W6N34SD.js",
    "vendor/plotterext-bus/LICENSE",
  ]) {
    assert.ok(
      fs.existsSync(path.join(PUBLIC_DIR, mod)),
      `${mod} missing (vendored/bus or module import)`,
    );
  }
});

test("registration mounts the provider and the public asset route", () => {
  const app = new FakeSignalKApp();
  const teardown = registerPlotterExtension(app, { id: PLUGIN_ID });

  assert.equal(app.resourceProviders.length, 1);
  assert.equal(app.resourceProviders[0].type, "plotterExtensions");

  assert.equal(app.middleware.length, 1);
  assert.equal(app.middleware[0].path, ASSET_BASE);

  teardown();
});

test("provider lists the manifest keyed by plugin id, read-only", async () => {
  const methods = startedManifest();

  const listed = await methods.listResources();
  assert.deepEqual(Object.keys(listed), [PLUGIN_ID]);
  assert.equal(listed[PLUGIN_ID].apiVersion, "1");

  const got = await methods.getResource(PLUGIN_ID);
  assert.equal(got, listed[PLUGIN_ID]);

  await assert.rejects(methods.getResource("someone-else"), /No such/);
  await assert.rejects(methods.setResource({}), /read-only/);
  await assert.rejects(methods.deleteResource("x"), /read-only/);
});

test("teardown empties the listing so hosts unload the extension", async () => {
  const app = new FakeSignalKApp();
  const teardown = registerPlotterExtension(app, { id: PLUGIN_ID });
  const methods = app.resourceProviders[0].methods;

  teardown();

  assert.deepEqual(await methods.listResources(), {});
  await assert.rejects(methods.getResource(PLUGIN_ID), /No such/);
});

/**
 * Invokes the static handler with a fake req/res pair.
 *
 * @param {Function} handler
 * @param {string} urlPath
 * @returns {Promise<{status: number, body: Buffer|null, type: string,
 *   fellThrough: boolean}>}
 */
function serve(handler, urlPath) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      headers: {},
      body: null,
      setHeader(k, v) {
        this.headers[k] = v;
      },
      end(data) {
        this.body = data ?? null;
        resolve({
          status: this.statusCode,
          body: this.body,
          type: this.headers["Content-Type"] ?? "",
          fellThrough: false,
        });
      },
    };
    handler({ path: urlPath, url: urlPath }, res, () =>
      resolve({ status: 0, body: null, type: "", fellThrough: true }),
    );
  });
}

test("asset handler serves the widget entry page with a content type", async () => {
  const handler = staticAssetHandler(PUBLIC_DIR, ASSET_BASE);
  const res = await serve(handler, `${ASSET_BASE}/dr-ext-widget.html`);
  assert.equal(res.fellThrough, false);
  assert.equal(res.status, 200);
  assert.match(res.type, /text\/html/);
  assert.ok(String(res.body).includes("dr-ext-widget.js"));

  // Prefix already stripped by the host (Express mount semantics).
  const stripped = await serve(handler, "/dr-ext-widget.html");
  assert.equal(stripped.status, 200);
});

test("asset handler falls through for missing files and traversal", async () => {
  const handler = staticAssetHandler(PUBLIC_DIR, ASSET_BASE);

  const missing = await serve(handler, `${ASSET_BASE}/no-such-file.js`);
  assert.equal(missing.fellThrough, true);

  // Encoded ../ escaping the public dir must not resolve outside root.
  const traversal = await serve(
    handler,
    `${ASSET_BASE}/%2e%2e/plugin/plotterext.js`,
  );
  assert.equal(traversal.fellThrough, true);

  // The standalone webapp's index must not be served as the extension
  // prefix root (no directory index).
  const index = await serve(handler, `${ASSET_BASE}/`);
  assert.equal(index.fellThrough, true);
});
