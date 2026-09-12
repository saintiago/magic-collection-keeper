import { test } from "node:test";
import assert from "node:assert/strict";
import { createCollectionLoader } from "../public/collection-loader.js";
import { snapshotKey } from "../public/collection-cache.js";
const rows = (quantity) => [
  {
    id: "a",
    printing_id: "a",
    quantity,
    finish: "nonfoil",
    card: { name: "Example", set: "tst", set_name: "Test", lang: "en" },
  },
];
function fixture() {
  const saved = new Map(),
    pending = [];
  const cache = {
    read: async (key) => saved.get(key),
    write: async (key, value) => saved.set(key, value),
    remove: async (key) => saved.delete(key),
  };
  const loader = createCollectionLoader({
    cache,
    onChange() {},
    now: () => 2000,
    load: () =>
      new Promise((resolve, reject) => pending.push({ resolve, reject })),
  });
  return { loader, saved, pending, cache };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
test("IMPORT-05 invalidation does no I/O until a consumer, coalesces consumers and retries failed refresh", async () => {
  const { loader, pending, saved } = fixture();
  const initial = loader.start("a");
  await tick();
  pending[0].resolve(rows(1));
  await initial;
  loader.invalidate();
  await loader.settled();
  assert.equal(pending.length, 1);
  assert.equal(saved.has("a"), false);
  assert.equal(loader.state.stale, true);
  const first = loader.ensureFresh(),
    second = loader.ensureFresh();
  assert.equal(first, second);
  assert.equal(pending.length, 2);
  pending[1].reject(Error("offline"));
  assert.equal(await first, false);
  const retry = loader.ensureFresh();
  assert.equal(pending.length, 3);
  pending[2].resolve(rows(2));
  assert.equal(await retry, true);
  assert.equal(loader.state.stale, false);
  assert.equal(await loader.ensureFresh(), false);
  assert.equal(pending.length, 3);
  const old = loader.refresh();
  loader.invalidate();
  const current = loader.ensureFresh();
  pending[3].resolve(rows(1));
  assert.equal(await old, false);
  pending[4].resolve(rows(3));
  await current;
  assert.equal(loader.state.rows[0].quantity, 3);
});
test("UC-17 late refresh cannot overwrite a newer refresh or a successful mutation", async () => {
  const { loader, pending, saved } = fixture();
  const first = loader.start("a");
  await tick();
  const second = loader.refresh();
  pending[1].resolve(rows(2));
  await second;
  pending[0].resolve(rows(1));
  await first;
  assert.equal(loader.state.rows[0].quantity, 2);
  const old = loader.refresh();
  loader.replace(rows(3));
  pending[2].resolve(rows(1));
  await old;
  await loader.settled();
  assert.equal(saved.get("a").rows[0].quantity, 3);
});
test("UC-17 account change and logout reject pending responses and clear their cache", async () => {
  const { loader, pending, saved } = fixture();
  const a = snapshotKey({ environment: "cloud", owner: "a" }),
    b = snapshotKey({ environment: "cloud", owner: "b" });
  assert.notEqual(a, b);
  assert.notEqual(a, snapshotKey({ environment: "other", owner: "a" }));
  const old = loader.start(a);
  await tick();
  const next = loader.start(b);
  await tick();
  pending[1].resolve(rows(2));
  await next;
  pending[0].resolve(rows(1));
  await old;
  await loader.settled();
  assert.equal(loader.state.rows[0].quantity, 2);
  assert.equal(saved.has(a), false);
  const late = loader.refresh();
  await loader.stop();
  pending[2].resolve(rows(5));
  await late;
  await loader.settled();
  assert.equal(loader.state.rows, null);
  assert.equal(saved.has(b), false);
});
test("UC-17 corrupt, wrong-schema and denied caches never prevent authoritative loading; invalid response retains snapshot", async () => {
  for (const corrupt of [
    { schema: 0, rows: rows(8), savedAt: 1000 },
    { schema: 1, rows: {}, savedAt: 1000 },
    { schema: 1, rows: rows(8), savedAt: NaN },
  ]) {
    const { loader, pending, saved } = fixture();
    saved.set("a", corrupt);
    const request = loader.start("a");
    await tick();
    assert.equal(loader.state.rows, null);
    pending[0].resolve([]);
    await request;
    assert.deepEqual(loader.state.rows, []);
  }
  const { loader, pending, cache } = fixture();
  cache.read = async () => {
    throw Error("denied");
  };
  cache.write = async () => {
    throw Error("quota");
  };
  const first = loader.start("a");
  await tick();
  pending[0].resolve(rows(7));
  await first;
  await loader.settled();
  const invalid = loader.refresh();
  pending[1].resolve({});
  await invalid;
  assert.equal(loader.state.rows[0].quantity, 7);
  assert.equal(loader.state.status, "error");
});
