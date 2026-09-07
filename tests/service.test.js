import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createCollectionService } from "../application/collection.js";
import { createSqliteAdapters } from "../adapters/sqlite.js";
import { createScryfallCatalog } from "../adapters/scryfall.js";
import { openDatabase, savePrinting } from "../db.js";
test("retrying the same add operation is idempotent and changed input is rejected", async () => {
  const db = openDatabase(":memory:");
  const card = {
    id: "p1",
    oracle_id: "o1",
    name: "Card",
    set: "one",
    collector_number: "1",
    lang: "en",
    finishes: ["nonfoil"],
  };
  savePrinting(db, card);
  const adapters = createSqliteAdapters(db),
    service = createCollectionService({ ...adapters, catalog: {} });
  const input = {
    printing_id: "p1",
    quantity: 3,
    condition: "NM",
    finish: "nonfoil",
    operation_id: randomUUID(),
  };
  await service.add("owner", input);
  await service.add("owner", input);
  assert.equal((await service.list("owner"))[0].quantity, 3);
  await assert.rejects(
    () => service.add("owner", { ...input, quantity: 4 }),
    /already saved/,
  );
  db.close();
});
test("use cases validate inputs and pass owner identity only to repository", async () => {
  const calls = [];
  const service = createCollectionService({
    repository: {
      list: (owner) => {
        calls.push(owner);
        return [];
      },
      setQuantity: (owner, id, q) => calls.push([owner, id, q]),
    },
    catalog: { search: (q, p) => ({ q, p }) },
  });
  await assert.rejects(() => service.setQuantity("alice", "id", 0));
  await service.setQuantity("alice", "id", 2);
  assert.deepEqual(calls, [["alice", "id", 2], "alice"]);
  await assert.rejects(() => service.search("", 1));
});
test("catalog cache skips network and a 429 pauses the shared limiter", async () => {
  let fetched = 0,
    paused = 0;
  const cached = createScryfallCatalog({
    cache: { get: () => ({ cards: [] }) },
    rateLimit: {},
    fetcher: () => {
      fetched++;
    },
  });
  await cached.search("name", 1);
  assert.equal(fetched, 0);
  const failing = createScryfallCatalog({
    cache: { get: () => null },
    rateLimit: { acquire: () => {}, pause: (n) => (paused = n) },
    fetcher: async () =>
      new Response(JSON.stringify({ details: "Slow down" }), { status: 429 }),
  });
  await assert.rejects(() => failing.search("name", 1), /Slow down/);
  assert.ok(paused >= 60000);
});
