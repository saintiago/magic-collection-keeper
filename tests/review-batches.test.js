import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, savePrinting } from "../db.js";
import { createSqliteAdapters } from "../adapters/sqlite.js";
import { createSqliteDocumentStore } from "../adapters/document-store.js";
import { createReviewBatches } from "../application/review-batches.js";
test("UC-SCAN-BATCH: 50 duplicate lines, partial failure, durable retry and owner-scoped receipts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keeper-review-")),
    file = join(dir, "test.sqlite");
  let db = openDatabase(file);
  const card = {
    id: randomUUID(),
    oracle_id: randomUUID(),
    name: "Test card",
    set: "tst",
    collector_number: "1",
    lang: "en",
    finishes: ["nonfoil"],
  };
  savePrinting(db, card);
  const input = {
    batch_id: randomUUID(),
    items: Array.from({ length: 50 }, () => ({
      item_id: randomUUID(),
      printing_id: card.id,
      quantity: 1,
      finish: "nonfoil",
      condition: "NM",
    })),
  };
  let repo = createSqliteAdapters(db).repository,
    commits = 0,
    reads = 0;
  const service = createReviewBatches({
    store: createSqliteDocumentStore(db),
    repository: {
      ...repo,
      list: () => {
        throw Error("No collection reload allowed during batch save");
      },
      getPrinting: (id) => {
        reads++;
        return repo.getPrinting(id);
      },
      commitBatch: (...args) => {
        if (++commits === 2) throw Error("Interrupted after first chunk");
        return repo.commitBatch(...args);
      },
    },
  });
  await assert.rejects(service.addBatch("test", input), /Interrupted/);
  assert.equal(
    (await service.batchStatus("test", input.batch_id)).saved.length,
    25,
  );
  assert.equal(repo.list("test")[0].quantity, 25);
  assert.equal(reads, 1, "Deduplicated canonical lookup");
  db.close();
  db = openDatabase(file);
  repo = createSqliteAdapters(db).repository;
  const resumed = createReviewBatches({
    repository: repo,
    store: createSqliteDocumentStore(db),
  });
  assert.equal((await resumed.addBatch("test", input)).saved.length, 50);
  await resumed.addBatch("test", input);
  assert.equal(repo.list("test")[0].quantity, 50);
  assert.equal(
    (await resumed.batchStatus("other", input.batch_id)).found,
    false,
  );
  await assert.rejects(
    resumed.addBatch("test", {
      ...input,
      items: input.items.map((r) => ({ ...r, quantity: 2 })),
    }),
    /different details/,
  );
  await assert.rejects(
    resumed.addBatch("test", { ...input, owner: "other" }),
    /Review between/,
  );
  // Stable item IDs remain idempotent even when a different batch references them.
  await resumed.addBatch("test", { ...input, batch_id: randomUUID() });
  assert.equal(repo.list("test")[0].quantity, 50);
  db.close();
  assert.ok(dir.startsWith(join(tmpdir(), "keeper-review-")));
  rmSync(dir, { recursive: true });
});
test("UC-SCAN-BATCH: invalid finish creates no inventory; merged quantity overflow rolls back chunk", async () => {
  const db = openDatabase(":memory:"),
    repo = createSqliteAdapters(db).repository;
  const card = {
    id: randomUUID(),
    oracle_id: randomUUID(),
    name: "Test",
    set: "tst",
    collector_number: "1",
    lang: "es",
    finishes: ["foil"],
  };
  savePrinting(db, card);
  const service = createReviewBatches({
    repository: repo,
    store: createSqliteDocumentStore(db),
  });
  const row = {
    item_id: randomUUID(),
    printing_id: card.id,
    quantity: 1,
    finish: "nonfoil",
    condition: "NM",
  };
  await assert.rejects(
    service.addBatch("test", { batch_id: randomUUID(), items: [row] }),
    /finish/,
  );
  assert.equal(repo.list("test").length, 0);
  const input = {
    batch_id: randomUUID(),
    items: [row, { ...row, item_id: randomUUID() }].map((r) => ({
      ...r,
      finish: "foil",
      quantity: 60000,
    })),
  };
  await assert.rejects(service.addBatch("test", input));
  assert.equal(repo.list("test").length, 0);
  assert.deepEqual(
    (await service.batchStatus("test", input.batch_id)).saved,
    [],
  );
  db.close();
});
