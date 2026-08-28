/**
 * Plotter-extension host integration (Freeboard-SK and any Plotter
 * Extensions API v1 chart plotter).
 *
 * Two server-side responsibilities (see freeboard-sk
 * docs/api/plotter_extension_provider_plugins.md):
 *
 * 1. Register a read-only `plotterExtensions` resource provider whose
 *    single entry is this plugin's manifest — the host discovers the
 *    extension there. Presence in the collection *is* the enablement
 *    signal: hosts must not add a second per-extension gate, and the
 *    provider goes empty on plugin stop so the host tears the contexts
 *    down.
 * 2. Serve the extension's iframe assets at a publicly readable,
 *    non-admin-gated route. `/plugins/*` is admin-only on the server, so
 *    the manifest URLs point at a self-mounted namespaced prefix instead.
 *    The assets are inert UI code — all data flows over the host bus.
 *    Served by a minimal in-repo static handler rather than
 *    `express.static`: the plugin is zero-dependency by design (SPEC §2)
 *    and `express` is not resolvable from a plugin's own tree — only
 *    from inside the server. The handler only needs to serve the small,
 *    known-good set of files under `public/`.
 *
 * @file plotterext.js
 */

const path = require("node:path");
const fs = require("node:fs");
const pkg = require("../package.json");

/**
 * Directory holding the extension's iframe assets. The same `public/`
 * the standalone webapp is served from (the webapp keyword mounts it at
 * the package path); the extension entry pages live alongside the ES
 * modules they import, so relative imports keep working under either
 * mount.
 */
const PUBLIC_DIR = path.join(__dirname, "..", "public");

/** Content types for the extension's asset kinds (inert UI code). */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Builds the extension manifest.
 *
 * `requires` lists only what the tile genuinely cannot run without: the
 * widget grid and the Signal K relay (a status tile with no data is dead
 * weight). Night mode is used when present and guarded with
 * `hasCapability` at runtime.
 *
 * @param {string} assetBase - server-relative URL prefix for assets
 * @param {string} version - plugin version for display metadata
 * @returns {object} manifest per the Plotter Extensions API v1
 */
function buildManifest(assetBase, version) {
  return {
    name: "Dead Reckoning",
    description:
      "Dead reckoning status tile: GPS↔DR divergence, uncertainty radius and DR health at a glance.",
    version,
    apiVersion: "1",
    requires: ["widgets", "signalk.stream"],
    optional: ["nightMode"],
    widgets: [
      {
        id: "dr-status",
        title: "Dead Reckoning",
        type: "iframe",
        url: `${assetBase}/dr-ext-widget.html`,
        size: "2x1",
        lifecycle: "whileEnabled",
      },
    ],
  };
}

/**
 * Minimal static-asset middleware for the extension's files. Not a
 * general file server: only regular files directly under `root` are
 * served (directory indexes and anything escaping `root` fall through).
 *
 * @param {string} root - absolute directory to serve
 * @param {string} assetBase - mount prefix, stripped when the host did
 *   not already strip it (Express strips it for `app.use(path, fn)`;
 *   other hosts may pass the full path)
 * @returns {(req: object, res: object, next: Function) => void}
 */
function staticAssetHandler(root, assetBase) {
  const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;
  return (req, res, next) => {
    let urlPath = req.path ?? req.url ?? "/";
    const q = urlPath.indexOf("?");
    if (q >= 0) urlPath = urlPath.slice(0, q);
    if (urlPath.startsWith(assetBase)) {
      urlPath = urlPath.slice(assetBase.length);
    }
    if (!urlPath.startsWith("/")) urlPath = `/${urlPath}`;

    let resolved;
    try {
      resolved = path.normalize(
        path.join(rootPrefix, decodeURIComponent(urlPath)),
      );
    } catch {
      next(); // malformed percent-encoding
      return;
    }
    // Traversal guard: the resolved path must stay inside root.
    if (!resolved.startsWith(rootPrefix)) {
      next();
      return;
    }

    fs.stat(resolved, (err, st) => {
      if (err || !st.isFile()) {
        next();
        return;
      }
      res.statusCode = 200;
      res.setHeader(
        "Content-Type",
        MIME[path.extname(resolved)] ?? "application/octet-stream",
      );
      res.setHeader("Cache-Control", "public, max-age=3600");
      fs.readFile(resolved, (readErr, data) => {
        if (readErr) {
          next();
          return;
        }
        res.end(data);
      });
    });
  };
}

/**
 * Registers the plotter-extension provider and mounts the asset route.
 *
 * @param {import("@signalk/server-api").ServerAPI} app - Signal K server API
 * @param {{id: string, version?: string}} opts - plugin id (manifest key)
 *   and optional version override (defaults to the package version)
 * @returns {() => void} teardown — empties the provider's listing so
 *   hosts unload the extension's contexts. The static asset mount stays
 *   (Express has no unmount, and the files are inert); that matches the
 *   webapp keyword's behaviour for a disabled plugin.
 */
function registerPlotterExtension(app, opts) {
  const { id } = opts;
  const version = opts.version ?? pkg.version;
  const assetBase = `/plotterext/${id}`;
  const manifest = buildManifest(assetBase, version);
  let running = true;

  app.registerResourceProvider({
    type: "plotterExtensions",
    methods: {
      listResources: async () => (running ? { [id]: manifest } : {}),
      getResource: async (resourceId) => {
        if (!running || resourceId !== id) {
          throw new Error(`No such plotterExtensions resource: ${resourceId}`);
        }
        return manifest;
      },
      setResource: async () => {
        throw new Error(`${id} is a read-only provider`);
      },
      deleteResource: async () => {
        throw new Error(`${id} is a read-only provider`);
      },
    },
  });

  app.use(assetBase, staticAssetHandler(PUBLIC_DIR, assetBase));

  return () => {
    running = false;
  };
}

module.exports = {
  buildManifest,
  registerPlotterExtension,
  staticAssetHandler,
};
