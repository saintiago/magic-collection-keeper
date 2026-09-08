import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, savePrinting } from "../db.js";
import { createSqliteAdapters } from "../adapters/sqlite.js";
import { createSqliteDocumentStore } from "../adapters/document-store.js";
import { createCollectionService } from "../application/collection.js";
import { createTaggedCollection } from "../application/tagged-collection.js";
import { createImportDraftService } from "../application/import-drafts.js";
import { IMPORT_PENDING_TAG, moxfieldSource } from "../domain/import-draft.js";
import {
  createMoxfieldProvider,
  parseMoxfieldDeck,
} from "../adapters/moxfield.js";
import { createScryfallCatalog } from "../adapters/scryfall.js";
const card = {
  id: "11111111-1111-4111-8111-111111111111",
  oracle_id: "22222222-2222-4222-8222-222222222222",
  name: "Test Card",
  set: "tst",
  collector_number: "1",
  lang: "en",
  finishes: ["nonfoil", "foil"],
  games: ["paper"],
};
const alternate = {
  ...card,
  id: "33333333-3333-4333-8333-333333333333",
  collector_number: "2",
};
const url = "https://moxfield.com/decks/keeper_pending_test_01";
const source = (count = 1) => ({
  ...moxfieldSource(url),
  name: "Test draft <source>",
  retrieved_at: "2026-09-08T00:00:00Z",
  excluded: [{ section: "sideboard", quantity: 2 }],
  rows: Array.from({ length: count }, (_, index) => ({
    source_line: `mainboard:${index}`,
    section: "mainboard",
    name: card.name,
    quantity: 1,
    printing_id: card.id,
    finish: "nonfoil",
    set: "tst",
    collector_number: "1",
    language: "en",
  })),
});
function setup({ count = 1, storeWrapper = (s) => s, path = ":memory:" } = {}) {
  const db = openDatabase(path);
  [card, alternate].forEach((c) => savePrinting(db, c));
  const { repository } = createSqliteAdapters(db),
    raw = createSqliteDocumentStore(db),
    store = storeWrapper(raw);
  const collection = createTaggedCollection({
    collection: createCollectionService({ repository, catalog: {} }),
    repository,
    store,
    newId: randomUUID,
    hash: (s) => createHash("sha256").update(s).digest("hex"),
  });
  let failing = false;
  const service = createImportDraftService({
    store,
    repository,
    collection,
    newId: randomUUID,
    catalog: { resolve: async () => [card] },
    provider: {
      fetchDeck: async () => {
        if (failing) throw Error("provider failed");
        return source(count);
      },
    },
  });
  return {
    db,
    raw,
    store,
    collection,
    service,
    failProvider: () => (failing = true),
  };
}
const input = (view) => ({ id: view.draft.id, version: view.draft.version });
test("UC-22 Clear winning during Add rolls back every ownership write; draft revisions survive a database restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "keeper-draft-"));
  const path = join(directory, "test.sqlite");
  let reached, release;
  const prepared = new Promise((resolve) => (reached = resolve));
  const resume = new Promise((resolve) => (release = resolve));
  const first = setup({
    path,
    storeWrapper: (store) => ({
      ...store,
      commit: async (owner, changes) => {
        if (changes.some((c) => c.space === "import-receipts")) {
          reached();
          await resume;
        }
        return store.commit(owner, changes);
      },
    }),
  });
  let second;
  try {
    const view = await first.service.fetchDraft("a", { url });
    const result = first.service.addDraft("a", input(view)).then(
      () => null,
      (e) => e,
    );
    await prepared;
    await first.service.clearDraft("a", input(view));
    release();
    assert.equal((await result).status, 409);
    assert.deepEqual(await first.collection.list("a"), []);
    assert.deepEqual(await first.collection.tags("a"), []);
    assert.deepEqual(await first.raw.list("a", "import-receipts"), []);
    const next = await first.service.fetchDraft("a", { url });
    first.db.close();
    second = setup({ path });
    assert.deepEqual((await second.service.getDraft("a")).draft, next.draft);
    await assert.rejects(
      () => second.service.clearDraft("a", input(view)),
      (e) => e.status === 409,
    );
    await second.service.addDraft("a", input(next));
    assert.equal((await second.collection.list("a"))[0].quantity, 1);
  } finally {
    release();
    if (second) second.db.close();
    else first.db.close();
    rmSync(directory, { recursive: true });
  }
});
test("UC-21 pending imports never create owned cards or user tags; 100 lines persist, revise and Clear in the correct account", async () => {
  const {
    db,
    service: s,
    collection: c,
    raw,
    failProvider,
  } = setup({ count: 100 });
  try {
    let view = await s.fetchDraft("a", { url });
    assert.equal(view.draft.rows.length, 100);
    assert.equal(view.summary.reviewed_copies, 100);
    assert.equal(view.summary.additions, 100);
    assert.deepEqual(view.draft.system_tag_ids, [IMPORT_PENDING_TAG.id]);
    assert.deepEqual(await c.list("a"), []);
    assert.deepEqual(await c.tags("a"), []);
    assert.deepEqual(await c.decks("a"), []);
    assert.equal((await s.getDraft("b")).draft, null);
    await assert.rejects(
      () => s.clearDraft("b", input(view)),
      (e) => e.status === 409,
    );
    await assert.rejects(() =>
      c.createTag("a", {
        label: "system:import-pending",
        type: "role",
        kind: "role",
      }),
    );
    await assert.rejects(() =>
      c.createTag("a", {
        label: "Hidden",
        type: "system",
        kind: "import-pending",
      }),
    );
    await assert.rejects(() =>
      c.renameTag("a", IMPORT_PENDING_TAG.id, { label: "Visible" }),
    );
    await assert.rejects(() => c.deleteTag("a", IMPORT_PENDING_TAG.id));
    const original = view.draft.original;
    const edits = view.draft.rows
      .slice(0, 99)
      .map((row, index) =>
        index === 0 ? { ...row, quantity: 3, printing_id: alternate.id } : row,
      );
    view = await s.saveDraft("a", { ...input(view), rows: edits });
    assert.equal(view.summary.reviewed_copies, 101);
    assert.equal(view.draft.rows[0].card.collector_number, "2");
    assert.deepEqual(view.draft.original, original);
    assert.equal((await s.getDraft("a")).draft.rows[0].quantity, 3);
    await assert.rejects(
      () => s.saveDraft("a", { id: view.draft.id, version: 1, rows: edits }),
      (e) => e.status === 409,
    );
    failProvider();
    await assert.rejects(() => s.fetchDraft("a", { url }));
    assert.equal((await s.getDraft("a")).summary.reviewed_copies, 101);
    const oldInput = input(view);
    await s.clearDraft("a", oldInput);
    assert.equal((await s.getDraft("a")).draft, null);
    assert.deepEqual(await c.list("a"), []);
    await assert.rejects(
      () => s.addDraft("a", oldInput),
      (e) => e.status === 409,
    );
    await assert.rejects(() => s.fetchDraft("a", { url }), /provider failed/);
    assert.equal((await s.getDraft("a")).draft, null);
    assert.equal((await raw.list("a", "import-receipts")).length, 0);
  } finally {
    db.close();
  }
});
test("UC-22 Add atomically preserves existing ownership/assignments, edited provenance and source tags; receipts and source identities prevent duplicates", async () => {
  const { db, service: s, collection: c } = setup({ count: 2 });
  try {
    await c.createTag("a", { label: "Box", type: "location", kind: "box" });
    await c.createTag("a", { label: "Draw", type: "role", kind: "role" });
    const tags = await c.tags("a"),
      box = tags.find((t) => t.type === "location"),
      role = tags.find((t) => t.type === "role");
    const previous = {
      provider: "moxfield",
      source_id: "keeper_original_test_01",
      name: "Previous source",
      entries: [
        {
          printing_id: card.id,
          finish: "nonfoil",
          quantity: 3,
          section: "mainboard",
        },
      ],
    };
    await c.importDeck("a", { ...previous, expected_version: 0 });
    let oldRow = (await c.list("a"))[0];
    await c.assign("a", oldRow.id, {
      locations: [{ tag_id: box.id, quantity: 1 }],
      tag_ids: [],
    });
    let view = await s.fetchDraft("a", { url });
    view = await s.saveDraft("a", {
      ...input(view),
      rows: view.draft.rows.map((r) => ({
        ...r,
        locations: [{ tag_id: box.id, quantity: 1 }],
        tag_ids: [role.id],
      })),
    });
    assert.equal((await c.list("a"))[0].quantity, 3);
    assert.equal(
      (await c.tags("a")).find((t) => t.id === role.id).references,
      0,
    );
    const request = input(view),
      result = await s.addDraft("a", request);
    assert.equal(result.additions, 2);
    assert.equal((await s.getDraft("a")).draft, null);
    const row = (await c.list("a"))[0];
    assert.equal(row.quantity, 5);
    assert.equal(row.locations.find((l) => l.tag_id === box.id).quantity, 3);
    assert.equal(
      row.locations.find((l) => l.tag_id === result.tag_id).quantity,
      2,
    );
    assert.deepEqual(row.tag_ids, [role.id]);
    assert.equal(
      row.provenance_list.find((p) => p.source_id === result.source_id)
        .original_lines.length,
      2,
    );
    assert.equal((await s.addDraft("a", request)).replayed, true);
    assert.equal((await c.list("a"))[0].quantity, 5);
    await assert.rejects(
      () => c.deleteTag("a", role.id),
      (e) => e.status === 409,
    );
    await c.assign("a", row.id, {
      locations: [{ tag_id: box.id, quantity: 5 }],
      tag_ids: [],
    });
    assert.deepEqual((await c.list("a"))[0].tag_ids, []);
    assert.equal((await c.list("a"))[0].locations.length, 1);
    view = await s.fetchDraft("a", { url });
    assert.equal(view.summary.additions, 0);
    await s.addDraft("a", input(view));
    assert.equal((await c.list("a"))[0].quantity, 5);
    assert.deepEqual(await c.list("b"), []);
  } finally {
    db.close();
  }
});
test("UC-22 failed atomic commits and stale Clear/Add races preserve the pending batch without partial ownership", async () => {
  let rejectCommit = true;
  const {
    db,
    service: s,
    collection: c,
    raw,
  } = setup({
    storeWrapper: (store) => ({
      ...store,
      commit: async (owner, changes) => {
        if (
          rejectCommit &&
          changes.some((change) => change.space === "import-receipts")
        )
          throw Error("injected transaction failure");
        return store.commit(owner, changes);
      },
    }),
  });
  try {
    let view = await s.fetchDraft("a", { url });
    const request = input(view);
    await assert.rejects(() => s.addDraft("a", request), /transaction failure/);
    assert.deepEqual(await c.list("a"), []);
    assert.deepEqual(await c.tags("a"), []);
    assert.deepEqual(await c.decks("a"), []);
    assert.equal((await s.getDraft("a")).draft.id, request.id);
    assert.deepEqual(await raw.list("a", "import-receipts"), []);
    rejectCommit = false;
    const concurrent = await Promise.allSettled([
      s.addDraft("a", request),
      s.addDraft("a", request),
    ]);
    assert(concurrent.some((r) => r.status === "fulfilled"));
    assert.equal((await c.list("a"))[0].quantity, 1);
    assert.equal((await s.addDraft("a", request)).replayed, true);
    view = await s.fetchDraft("a", { url });
    const stale = input(view);
    await s.clearDraft("a", stale);
    const next = await s.fetchDraft("a", { url });
    assert(next.draft.version > stale.version);
    await assert.rejects(
      () => s.addDraft("a", stale),
      (e) => e.status === 409,
    );
    assert.equal((await s.getDraft("a")).draft.id, next.draft.id);
  } finally {
    db.close();
  }
});
test("UC-21 invalid edits, unknown printings and deleted tags cannot silently become owned", async () => {
  const { db, service: s, collection: c } = setup();
  try {
    let view = await s.fetchDraft("a", { url });
    const row = view.draft.rows[0];
    for (const malformed of [
      null,
      { ...row, locations: [null] },
      { ...row, tag_ids: {} },
    ])
      await assert.rejects(
        () => s.saveDraft("a", { ...input(view), rows: [malformed] }),
        (e) => e.status === 400,
      );
    await assert.rejects(() =>
      s.saveDraft("a", { ...input(view), rows: [{ ...row, quantity: 0 }] }),
    );
    await assert.rejects(() =>
      s.saveDraft("a", {
        ...input(view),
        rows: [{ ...row, printing_id: randomUUID() }],
      }),
    );
    await assert.rejects(() =>
      s.saveDraft("a", {
        ...input(view),
        rows: [{ ...row, tag_ids: [IMPORT_PENDING_TAG.id] }],
      }),
    );
    await c.createTag("a", {
      label: "Later deleted",
      type: "category",
      kind: "category",
    });
    const tag = (await c.tags("a"))[0];
    view = await s.saveDraft("a", {
      ...input(view),
      rows: [{ ...row, tag_ids: [tag.id] }],
    });
    await c.deleteTag("a", tag.id);
    assert.equal((await s.getDraft("a")).summary.can_add, false);
    await assert.rejects(() => s.addDraft("a", input(view)));
    view = await s.saveDraft("a", {
      ...input(view),
      rows: [{ ...view.draft.rows[0], printing_id: null, tag_ids: [] }],
    });
    assert.equal(view.summary.can_add, false);
    await assert.rejects(() => s.addDraft("a", input(view)));
    assert.deepEqual(await c.list("a"), []);
  } finally {
    db.close();
  }
});
test("UC-23 provider validation blocks SSRF/redirects and handles public payload, denial, throttling and bounds without credentials", async () => {
  for (const bad of [
    "http://moxfield.com/decks/keeper_pending_test_01",
    "https://moxfield.com.evil.test/decks/keeper_pending_test_01",
    "https://moxfield.com@127.0.0.1/decks/keeper_pending_test_01",
    "https://moxfield.com:8443/decks/keeper_pending_test_01",
    "https://moxfield.com/decks/keeper_pending_test_01?redirect=https://localhost",
    "https://moxfield.com/decks/../admin",
  ])
    assert.throws(() => moxfieldSource(bad));
  const parsed = parseMoxfieldDeck(moxfieldSource(url), {
    name: "Public fixture",
    boards: {
      mainboard: {
        cards: {
          x: {
            quantity: 2,
            finish: "foil",
            card: {
              name: card.name,
              scryfall_id: card.id,
              set: "tst",
              cn: "1",
            },
          },
        },
      },
      sideboard: { cards: { x: { quantity: 1 } } },
    },
  });
  assert.equal(parsed.rows[0].finish, "foil");
  assert.equal(parsed.excluded[0].quantity, 1);
  let paused = 0,
    calls = 0;
  for (const code of [403, 404, 429]) {
    const provider = createMoxfieldProvider({
      rateLimit: {
        acquire: async () => {},
        pause: async (ms) => (paused += ms),
      },
      fetcher: async (target, options) => {
        calls++;
        assert.equal(
          target,
          "https://api2.moxfield.com/v3/decks/all/keeper_pending_test_01",
        );
        assert.equal(options.redirect, "error");
        assert.equal(options.headers.Cookie, undefined);
        assert.equal(options.headers.Authorization, undefined);
        return new Response("{}", {
          status: code,
          headers: { "content-type": "application/json" },
        });
      },
    });
    await assert.rejects(
      () => provider.fetchDeck(url),
      (e) => e.status === code,
    );
  }
  assert.equal(calls, 3);
  assert.equal(paused, 60000);
  await assert.rejects(
    () =>
      createMoxfieldProvider({
        fetcher: async () => {
          throw Error("timeout or redirect");
        },
      }).fetchDeck(url),
    (e) => e.status === 502,
  );
  await assert.rejects(
    () =>
      createMoxfieldProvider({
        fetcher: async () =>
          new Response("x".repeat(2000001), {
            headers: { "content-type": "application/json" },
          }),
      }).fetchDeck(url),
    (e) => e.status === 413,
  );
});
test("UC-23 batched canonical resolution shares the existing cache and limiter, preserving 429 cooldown", async () => {
  const cache = new Map();
  let calls = 0,
    leases = 0,
    paused = 0;
  const catalog = createScryfallCatalog({
    cache: {
      get: async (k) => cache.get(k),
      put: async (k, v) => cache.set(k, v),
    },
    rateLimit: {
      acquire: async () => leases++,
      pause: async (ms) => (paused = ms),
    },
    fetcher: async (target, options) => {
      calls++;
      assert.equal(target, "https://api.scryfall.com/cards/collection");
      const ids = JSON.parse(options.body).identifiers;
      assert(ids.length <= 75);
      return Response.json({ data: ids.map(({ id }) => ({ ...card, id })) });
    },
  });
  const ids = Array.from({ length: 100 }, () => randomUUID());
  assert.equal((await catalog.resolve(ids)).length, 100);
  assert.equal(calls, 2);
  assert.equal(leases, 2);
  await catalog.resolve(ids);
  assert.equal(calls, 2);
  const limited = createScryfallCatalog({
    cache: { get: async () => null },
    rateLimit: { acquire: async () => {}, pause: async (ms) => (paused = ms) },
    fetcher: async () =>
      new Response("{}", { status: 429, headers: { "retry-after": "90" } }),
  });
  await assert.rejects(
    () => limited.resolve([card.id]),
    (e) => e.status === 429,
  );
  assert.equal(paused, 90000);
});
