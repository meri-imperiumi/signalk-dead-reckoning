/**
 * Status Tiles example-set provider (work doc #22): the shipped JSON is
 * structurally copy-clean and the resource provider honours the
 * read-only / running-gated / idempotent-restart contract from
 * signalk-status-tiles' sharing guide.
 *
 * @file statustilesexamples.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");

const {
  registerStatusTileExamples,
  EXAMPLES,
} = require("../plugin/statustilesexamples.js");
const { FakeSignalKApp } = require("./fake-app.js");

const PLUGIN_ID = "signalk-dead-reckoning";
const ID_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

// The set is pure config loaded from disk — assert it round-trips the
// exact file (no require-time mutation).
const fromDisk = JSON.parse(
  readFileSync(
    require("node:path").join(__dirname, "..", "status-tiles-examples.json"),
  ),
);
assert.deepEqual(EXAMPLES, fromDisk);

test("the examples file is structurally copy-clean", () => {
  assert.equal(typeof EXAMPLES.name, "string");
  assert.ok(EXAMPLES.name.length > 0);
  assert.ok(Array.isArray(EXAMPLES.sets));
  assert.ok(EXAMPLES.sets.length > 0);

  for (const set of EXAMPLES.sets) {
    assert.match(set.id, ID_RE, `set id "${set.id}" must be stable-shaped`);
    assert.equal(typeof set.name, "string");
    assert.ok(set.name.length > 0);
    assert.ok(Array.isArray(set.tiles));
    assert.ok(set.tiles.length > 0);
    // Coverage is a panel-wide setting, never per-set.
    assert.equal(set.coverage, undefined);

    const ctxIds = new Set();
    for (const ctx of set.contexts ?? []) {
      assert.match(ctx.id, ID_RE);
      assert.ok(ctx.predicate, `context "${ctx.id}" needs a predicate`);
      ctxIds.add(ctx.id);
    }

    const tileIds = new Set();
    for (const tile of set.tiles) {
      assert.match(tile.id, ID_RE);
      assert.equal(typeof tile.label, "string");
      assert.ok(tile.label.length > 0);
      assert.ok(Array.isArray(tile.checks));
      assert.ok(tile.checks.length > 0);
      // A tile context reference must resolve inside the same set.
      if (tile.context) {
        assert.ok(
          ctxIds.has(tile.context),
          `tile "${tile.id}" points at unknown context "${tile.context}"`,
        );
      }
      tileIds.add(tile.id);
    }

    // At most one display check per tile (SPEC §3.4).
    for (const tile of set.tiles) {
      const displays = tile.checks.filter((c) => c.display).length;
      assert.ok(displays <= 1, `tile "${tile.id}" has ${displays} displays`);
    }

    // No id collisions within the set.
    assert.equal(tileIds.size, set.tiles.length, "duplicate tile ids");
    assert.equal(ctxIds.size, (set.contexts ?? []).length, "duplicate ctx ids");
  }
});

test("ids are prefixed with the plugin domain to avoid cross-plugin collisions", () => {
  for (const set of EXAMPLES.sets) {
    assert.ok(
      set.id.startsWith("dr-") || set.id.startsWith("dr"),
      `set id "${set.id}" should be domain-prefixed`,
    );
    for (const c of set.contexts ?? []) {
      assert.ok(
        c.id.startsWith("dr"),
        `context id "${c.id}" should be domain-prefixed`,
      );
    }
    for (const t of set.tiles) {
      assert.ok(
        t.id.startsWith("dr"),
        `tile id "${t.id}" should be domain-prefixed`,
      );
    }
  }
});

test("registration mounts a single read-only statusTileExamples provider", async () => {
  const app = new FakeSignalKApp();
  const teardown = registerStatusTileExamples(app, { id: PLUGIN_ID });

  assert.equal(app.resourceProviders.length, 1);
  const [provider] = app.resourceProviders;
  assert.equal(provider.type, "statusTileExamples");

  const listed = await provider.methods.listResources();
  assert.deepEqual(Object.keys(listed), [PLUGIN_ID]);
  assert.equal(listed[PLUGIN_ID], EXAMPLES);

  assert.equal(await provider.methods.getResource(PLUGIN_ID), EXAMPLES);
  await assert.rejects(
    provider.methods.getResource("someone-else"),
    /No such statusTileExamples resource/,
  );
  await assert.rejects(provider.methods.setResource("x", {}), /read-only/);
  await assert.rejects(provider.methods.deleteResource("x"), /read-only/);

  teardown();
});

test("teardown empties the listing so a stopped plugin contributes nothing", async () => {
  const app = new FakeSignalKApp();
  const teardown = registerStatusTileExamples(app, { id: PLUGIN_ID });
  const { methods } = app.resourceProviders[0];

  teardown();

  assert.deepEqual(await methods.listResources(), {});
  await assert.rejects(methods.getResource(PLUGIN_ID), /No such/);
});

test("a re-start reuses the single registration and flips running back on", async () => {
  // First start.
  const app = new FakeSignalKApp();
  const stop1 = registerStatusTileExamples(app, { id: PLUGIN_ID });
  assert.equal(app.resourceProviders.length, 1);
  const [provider] = app.resourceProviders;

  // stop() then start() (config save): must NOT register a second provider.
  stop1();
  const stop2 = registerStatusTileExamples(app, { id: PLUGIN_ID });
  assert.equal(app.resourceProviders.length, 1);
  assert.equal(app.resourceProviders[0], provider);

  // The reused provider lists the set again (running flipped back on).
  const listed = await provider.methods.listResources();
  assert.deepEqual(Object.keys(listed), [PLUGIN_ID]);

  stop2();
  assert.deepEqual(await provider.methods.listResources(), {});
});

test("on a server without a resource registry it logs once and continues", () => {
  const app = new FakeSignalKApp();
  // Simulate a server without the resource provider registry: the
  // method is absent (older server). Shadow the prototype method.
  app.registerResourceProvider = undefined;

  const teardown = registerStatusTileExamples(app, { id: PLUGIN_ID });
  assert.equal(app.resourceProviders.length, 0);
  assert.equal(app.errors.length, 1);
  assert.match(app.errors[0], /no resource provider registry/);

  // Idempotent: a re-start does not log a second time.
  teardown();
  registerStatusTileExamples(app, { id: PLUGIN_ID });
  assert.equal(app.errors.length, 1);
});
