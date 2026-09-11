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

test("RECENT-01 an atomic import receipt identifies only actual printing additions and preserves them on replay", async () => {
  const s = setup({ count: 2 });
  try {
    await s.collection.importDeck("a", {
      ...moxfieldSource(url),
      name: "Existing source",
      expected_version: 0,
      entries: [card, alternate].map((card) => ({
        printing_id: card.id,
        finish: "nonfoil",
        condition: "UNK",
        quantity: 1,
        section: "mainboard",
      })),
    });
    const draft = await s.service.fetchDraft("a", { url });
    const request = input(draft);
    const result = await s.service.addDraft("a", request);
    assert.equal(result.additions, 1);
    assert.deepEqual(result.added_printings, [card.id]);
    const beforeReplay = await s.collection.list("a");
    assert.equal(
      beforeReplay.find((row) => row.printing_id === alternate.id).quantity,
      1,
    );
    const replay = await s.service.addDraft("a", request);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.added_printings, [card.id]);
    assert.deepEqual(await s.collection.list("a"), beforeReplay);
    const repeated = await s.service.fetchDraft("a", { url });
    const unchanged = await s.service.addDraft("a", input(repeated));
    assert.equal(unchanged.additions, 0);
    assert.deepEqual(unchanged.added_printings, []);
    await assert.rejects(s.service.addDraft("b", request));
    assert.deepEqual(await s.collection.list("b"), []);
  } finally {
    s.db.close();
  }
});
function setup({
  count = 1,
  storeWrapper = (s) => s,
  path = ":memory:",
  now,
} = {}) {
  const db = openDatabase(path);
  [card, alternate].forEach((c) => savePrinting(db, c));
  const { repository } = createSqliteAdapters(db),
    raw = createSqliteDocumentStore(db),
    store = storeWrapper(raw);
  const collection = createTaggedCollection({
    now,
    collection: createCollectionService({ repository, catalog: {} }),
    repository,
    store,
    newId: randomUUID,
    hash: (s) => createHash("sha256").update(s).digest("hex"),
  });
  let failing = false;
  const service = createImportDraftService({
    now,
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
test("CARD-13 pending tag actions are atomic targeted edits with permanent receipts, without ownership or source changes", async () => {
  const { db, raw, collection, service } = setup();
  try {
    const [role] = await collection.createTag("a", {
      label: "Draw",
      type: "role",
      kind: "role",
    });
    const box = (
      await collection.createTag("a", {
        label: "Box",
        type: "location",
        kind: "box",
      })
    ).find((tag) => tag.type === "location");
    const staged = await service.stageDraft("a", {
      id: randomUUID(),
      kind: "catalog",
      rows: [
        {
          id: randomUUID(),
          name: card.name,
          printing_id: card.id,
          quantity: 3,
          finish: "nonfoil",
          condition: "NM",
        },
      ],
    });
    const draft = staged.draft,
      original = structuredClone(draft.original);
    const action = (tag, selected, quantity = 1) => ({
      id: draft.id,
      kind: "capture",
      row_id: draft.rows[0].id,
      tag_id: tag.id,
      selected,
      quantity,
      operation_id: randomUUID(),
    });
    const add = action(box, true, 2);
    let result = await service.tagDraft("a", add);
    assert.equal(result.draft.rows[0].locations[0].quantity, 2);
    assert.equal(result.draft.rows[0].quantity, 3);
    const created = result.draft.rows[0].created_at;
    await service.tagDraft("a", action(role, true));
    result = await service.tagDraft("a", action(box, true));
    assert.equal(result.draft.rows[0].locations[0].quantity, 2);
    await service.tagDraft("a", action(box, false));
    result = await service.tagDraft("a", add);
    assert.deepEqual(
      result.draft.rows[0].locations,
      [],
      "old add cannot resurrect a removed assignment",
    );
    assert.deepEqual(result.draft.rows[0].tag_ids, [role.id]);
    assert.deepEqual(result.draft.original, original);
    assert.equal(result.draft.rows[0].created_at, created);
    assert.deepEqual(await collection.list("a"), []);
    assert.deepEqual(await raw.list("a", "decks"), []);
    await assert.rejects(service.tagDraft("b", add), /no longer available/);
    await assert.rejects(
      service.tagDraft("a", { ...add, selected: false }),
      /different input/,
    );
    await assert.rejects(
      service.tagDraft("a", {
        ...action(role, false),
        tag_id: "ae07f79b-38cc-44a2-8fc9-56588cf003ab",
      }),
      /System tags/,
    );
    const fail = action(role, false),
      commit = raw.commit;
    raw.commit = async () => {
      throw Error("Interrupted tag commit");
    };
    await assert.rejects(service.tagDraft("a", fail), /Interrupted tag commit/);
    raw.commit = commit;
    assert.equal(
      await raw.get("a", "draft-tag-actions", fail.operation_id),
      null,
    );
    assert.deepEqual(
      (await service.getDraft("a", { id: draft.id })).draft.rows[0].tag_ids,
      [role.id],
    );
    await service.clearDraft("a", { ...input(result), kind: "capture" });
    assert.equal(
      (await service.tagDraft("a", add)).draft,
      null,
      "receipt cannot resurrect a cleared draft",
    );
  } finally {
    db.close();
  }
});
function reorderedReads(store) {
  const reorder = (value) =>
    Array.isArray(value)
      ? value.map(reorder)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .reverse()
              .map(([key, item]) => [key, reorder(item)]),
          )
        : value;
  return {
    ...store,
    get: async (...args) => reorder(await store.get(...args)),
    list: async (...args) => reorder(await store.list(...args)),
  };
}

test("UC-CARD-ACTIONS catalogue drops stage tagged review with honest provenance and never imply ownership", async () => {
  const s = setup({ storeWrapper: reorderedReads });
  try {
    const [tag] = await s.collection.createTag("a", {
      label: "Binder",
      type: "location",
      kind: "binder",
    });
    const raw = {
      id: randomUUID(),
      kind: "catalog",
      tag_id: tag.id,
      rows: [
        {
          id: randomUUID(),
          name: card.name,
          printing_id: card.id,
          quantity: 1,
          finish: "nonfoil",
          condition: "UNK",
        },
      ],
    };
    const staged = await s.service.stageDraft("a", raw);
    assert.equal(staged.draft.name, "Catalogue selections");
    assert.equal(staged.draft.rows[0].original.capture_kind, "catalog");
    assert.deepEqual(staged.draft.rows[0].locations, [
      { tag_id: tag.id, quantity: 1 },
    ]);
    assert.deepEqual(await s.collection.list("a"), []);
    assert.deepEqual(await s.service.stageDraft("a", raw), staged);
    await assert.rejects(
      s.service.stageDraft("b", raw),
      /tag is no longer available/,
    );
    await assert.rejects(
      s.service.stageDraft("a", { ...raw, tag_id: randomUUID() }),
      /different lines/,
    );
    await s.service.addDraft("a", { ...input(staged), kind: "capture" });
    const [owned] = await s.collection.list("a");
    assert.equal(owned.quantity, 1);
    assert.equal(owned.locations[0].tag_id, tag.id);
    assert.equal(owned.locations[0].quantity, 1);
    assert.equal((await s.service.stageDraft("a", raw)).draft, null);
    assert.equal((await s.collection.list("a"))[0].quantity, 1);
  } finally {
    s.db.close();
  }
});

test("UC-SCAN-IMPORT persisted map order cannot reject an identical receipt or turn a no-op into an edit", async () => {
  let time = "2026-09-09T10:00:00Z";
  const s = setup({ now: () => time, storeWrapper: reorderedReads });
  try {
    const raw = {
      id: randomUUID(),
      kind: "scan",
      rows: [1, 2].map(() => ({
        id: randomUUID(),
        name: card.name,
        printing_id: card.id,
        quantity: 1,
        finish: "nonfoil",
        condition: "NM",
        recognition: [
          {
            printing_id: card.id,
            provider: "browser-onnx",
            evidence: "visual",
          },
        ],
      })),
    };
    const saved = await s.service.stageDraft("test", raw);
    time = "2026-09-10T11:00:00Z";
    assert.deepEqual(
      (await s.service.stageDraft("test", raw)).draft,
      saved.draft,
    );
    const unchanged = await s.service.saveDraft("test", {
      ...input(saved),
      kind: "capture",
      rows: saved.draft.rows,
    });
    assert.deepEqual(unchanged.draft, saved.draft);
    await assert.rejects(
      s.service.stageDraft("test", {
        ...raw,
        rows: [...raw.rows].reverse(),
      }),
      /different lines/,
    );
    await assert.rejects(
      s.service.stageDraft("test", {
        ...raw,
        rows: raw.rows.map((row) => ({ ...row, quantity: 2 })),
      }),
      /different lines/,
    );
    await s.service.clearDraft("test", { ...input(saved), kind: "capture" });
    assert.equal((await s.service.stageDraft("test", raw)).draft, null);
    assert.deepEqual(await s.collection.list("test"), []);
  } finally {
    s.db.close();
  }
});
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

test("UC-SCAN-IMPORT 50 duplicate captures commit atomically, retain separate conditions and preserve URL and other date-grouped drafts", async () => {
  let time = "2026-09-09T10:00:00Z",
    fail = false;
  const s = setup({
    now: () => time,
    storeWrapper: (store) => ({
      ...store,
      commit: async (owner, changes) => {
        if (
          fail &&
          changes.some((change) => change.space === "import-receipts")
        )
          throw Error("interrupted atomic commit");
        return store.commit(owner, changes);
      },
    }),
  });
  const urlDraft = await s.service.fetchDraft("test", { url });
  const payload = (count) => ({
    id: randomUUID(),
    kind: "scan",
    rows: Array.from({ length: count }, (_, index) => ({
      id: randomUUID(),
      name: card.name,
      printing_id: card.id,
      quantity: 1,
      finish: "nonfoil",
      condition: index % 2 ? "LP" : "NM",
    })),
  });
  const firstInput = payload(50),
    first = await s.service.stageDraft("test", firstInput);
  const second = await s.service.stageDraft("test", payload(1));
  assert.equal((await s.service.getDraft("test")).pending_drafts.length, 3);
  assert.equal((await s.collection.list("test")).length, 0);
  assert.equal((await s.collection.tags("test")).length, 0);
  assert.equal((await s.service.getDraft("other")).pending_drafts.length, 0);
  const identity = { ...input(first), kind: "capture" };
  fail = true;
  await assert.rejects(s.service.addDraft("test", identity), /interrupted/);
  assert.equal((await s.collection.list("test")).length, 0);
  assert.equal(
    (await s.service.getDraft("test", { id: first.draft.id })).draft.rows
      .length,
    50,
  );
  fail = false;
  const result = await s.service.addDraft("test", identity);
  assert.equal(result.additions, 50);
  let owned = await s.collection.list("test");
  assert.equal(owned.length, 2);
  assert.deepEqual(
    owned.map((row) => row.quantity),
    [25, 25],
  );
  assert.ok(
    owned.every(
      (row) =>
        row.locations.length === 0 &&
        row.created_at === "2026-09-09T10:00:00.000Z",
    ),
  );
  time = "2026-09-10T10:00:00Z";
  assert.equal((await s.service.addDraft("test", identity)).replayed, true);
  assert.equal((await s.service.stageDraft("test", firstInput)).draft, null);
  assert.deepEqual(await s.collection.list("test"), owned);
  assert.equal(
    (await s.service.getDraft("test", { id: urlDraft.draft.id })).draft.id,
    urlDraft.draft.id,
  );
  assert.equal(
    (await s.service.getDraft("test", { id: second.draft.id })).draft.id,
    second.draft.id,
  );
  await assert.rejects(
    s.service.stageDraft("test", { ...firstInput, owner: "other" }),
    /Stage/,
  );
  const before = second.draft.rows[0];
  const edited = await s.service.saveDraft("test", {
    ...input(second),
    kind: "capture",
    rows: [{ ...before, quantity: 3, condition: "HP" }],
  });
  assert.equal(edited.draft.rows[0].created_at, before.created_at);
  assert.equal(edited.draft.rows[0].updated_at, time);
  const noOp = await s.service.saveDraft("test", {
    ...input(edited),
    kind: "capture",
    rows: edited.draft.rows,
  });
  assert.equal(noOp.draft.version, edited.draft.version);
  await s.service.clearDraft("test", { ...input(noOp), kind: "capture" });
  assert.equal((await s.service.getDraft("test")).pending_drafts.length, 1);
  s.db.close();
});

test("UC-CARD-DATES creation stays immutable while meaningful quantities and assignments update modification time", async () => {
  let time = "2026-09-09T10:00:00Z";
  const s = setup({ now: () => time, storeWrapper: reorderedReads });
  const staged = await s.service.stageDraft("test", {
    id: randomUUID(),
    kind: "scan",
    rows: [
      {
        id: randomUUID(),
        name: card.name,
        printing_id: card.id,
        quantity: 2,
        finish: "nonfoil",
        condition: "NM",
      },
    ],
  });
  await s.service.addDraft("test", { ...input(staged), kind: "capture" });
  const [before] = await s.collection.list("test");
  time = "2026-09-10T11:00:00Z";
  let [row] = await s.collection.setQuantity("test", before.id, 3);
  assert.equal(row.created_at, before.created_at);
  assert.equal(row.updated_at, "2026-09-10T11:00:00.000Z");
  time = "2026-09-11T11:00:00Z";
  assert.equal(
    (await s.collection.setQuantity("test", before.id, 3))[0].updated_at,
    row.updated_at,
  );
  const [tag] = await s.collection.createTag("test", {
    type: "location",
    kind: "binder",
    label: "Test location",
  });
  [row] = await s.collection.assign("test", before.id, {
    locations: [{ tag_id: tag.id, quantity: 2 }],
    tag_ids: [],
  });
  assert.equal(row.created_at, before.created_at);
  assert.equal(row.updated_at, "2026-09-11T11:00:00.000Z");
  time = "2026-09-12T11:00:00Z";
  assert.equal(
    (
      await s.collection.assign("test", before.id, {
        locations: [{ tag_id: tag.id, quantity: 2 }],
        tag_ids: [],
      })
    )[0].updated_at,
    row.updated_at,
  );
  s.db.close();
});

test("UC-SCAN-IMPORT canonical alternatives survive review and removing captures cannot resurrect a receipt", async () => {
  const s = setup();
  const other = {
    ...alternate,
    oracle_id: randomUUID(),
    name: "Another Identified Card",
  };
  savePrinting(s.db, other);
  const raw = {
    id: randomUUID(),
    kind: "scan",
    rows: [
      {
        id: randomUUID(),
        name: card.name,
        printing_id: card.id,
        quantity: 2,
        finish: "nonfoil",
        condition: "NM",
        recognition: [
          {
            printing_id: card.id,
            provider: "browser-onnx",
            evidence: "visual",
          },
          {
            printing_id: other.id,
            provider: "lambda",
            evidence: "visible-title-model",
          },
        ],
      },
    ],
  };
  const staged = await s.service.stageDraft("test", raw);
  assert.equal(
    staged.draft.rows[0].recognition_candidates[1].card.name,
    other.name,
  );
  const chosen = await s.service.saveDraft("test", {
    ...input(staged),
    kind: "capture",
    rows: staged.draft.rows.map((row) => ({ ...row, printing_id: other.id })),
  });
  await s.service.addDraft("test", { ...input(chosen), kind: "capture" });
  const [owned] = await s.collection.list("test");
  assert.equal(owned.card.oracle_id, other.oracle_id);
  await s.collection.remove("test", owned.id);
  assert.deepEqual(await s.collection.list("test"), []);
  assert.equal(
    (await s.service.addDraft("test", { ...input(chosen), kind: "capture" }))
      .replayed,
    true,
  );
  assert.deepEqual(await s.collection.list("test"), []);
  const overflow = await s.service.stageDraft("test", {
    id: randomUUID(),
    kind: "scan",
    rows: Array.from({ length: 50 }, () => ({
      id: randomUUID(),
      name: card.name,
      printing_id: card.id,
      quantity: 5000,
      finish: "nonfoil",
      condition: "NM",
    })),
  });
  assert.equal(overflow.summary.can_add, false);
  assert.equal(
    (await s.service.getDraft("test", { id: overflow.draft.id })).draft.rows
      .length,
    50,
  );
  await assert.rejects(
    s.service.addDraft("test", { ...input(overflow), kind: "capture" }),
    /100,000/,
  );
  assert.deepEqual(await s.collection.list("test"), []);
  s.db.close();
});

test("SCAN-12 bounded scan batches retain 2000 captures, permanent replay, paged review and explicit ownership", async () => {
  const s = setup();
  const id = randomUUID();
  const batches = [];
  const payload = (index, count = 50) => ({
    id,
    index,
    last_oracle: card.oracle_id,
    batch: {
      id: randomUUID(),
      kind: "scan",
      rows: Array.from({ length: count }, () => ({
        id: randomUUID(),
        name: card.name,
        printing_id: card.id,
        quantity: 1,
        finish: "nonfoil",
        condition: "NM",
      })),
    },
  });
  try {
    for (let index = 1; index <= 40; index++) {
      const batch = payload(index);
      batches.push(batch);
      const result = await s.service.stageScanBatch("a", batch);
      assert.equal(result.accepted, index * 50);
      assert.equal(result.index, index);
      assert.equal(result.last_oracle, card.oracle_id);
    }
    assert.deepEqual(await s.collection.list("a"), []);
    const latest = await s.service.getDraft("a", { id });
    assert.equal(latest.pending_drafts.length, 1);
    assert.equal(latest.pending_drafts[0].copies, 2000);
    assert.equal(latest.draft.rows.length, 50);
    assert.equal(latest.scan_session.index, 40);
    assert.equal(latest.scan_session.previous, batches[38].batch.id);
    const first = await s.service.getDraft("a", { id: batches[0].batch.id });
    assert.equal(first.scan_session.next, batches[1].batch.id);
    assert.equal(first.scan_session.previous, null);
    assert.equal(
      (await s.service.stageScanBatch("a", batches[0])).accepted,
      2000,
    );
    assert.equal((await s.service.getDraft("b", { id })).draft, null);
    await assert.rejects(
      s.service.stageScanBatch("a", {
        ...batches[0],
        last_oracle: randomUUID(),
      }),
      /different/,
    );
    await assert.rejects(
      s.service.stageScanBatch("a", payload(42)),
      /advanced/,
    );
    const duplicate = payload(41);
    duplicate.batch.rows[0].id = batches[0].batch.rows[0].id;
    await assert.rejects(s.service.stageScanBatch("a", duplicate), /changed/);
    const identity = { ...input(first), kind: "capture" };
    const result = await s.service.addDraft("a", identity);
    assert.equal(result.additions, 50);
    assert.equal((await s.service.addDraft("a", identity)).replayed, true);
    assert.equal(
      (await s.service.stageScanBatch("a", batches[0])).accepted,
      2000,
    );
    const cleared = await s.service.getDraft("a", { id: batches[0].batch.id });
    assert.equal(cleared.draft, null);
    assert.equal(cleared.scan_session.next, batches[1].batch.id);
    assert.equal(cleared.pending_drafts[0].copies, 1950);
    const second = await s.service.getDraft("a", { id: batches[1].batch.id });
    second.draft.rows[0].quantity = 3;
    const edited = await s.service.saveDraft("a", {
      ...input(second),
      kind: "capture",
      rows: second.draft.rows,
    });
    assert.equal(
      (await s.service.getDraft("a", { id })).pending_drafts[0].copies,
      1952,
    );
    await s.service.clearDraft("a", { ...input(edited), kind: "capture" });
    assert.equal(
      (await s.service.getDraft("a", { id })).pending_drafts[0].copies,
      1900,
    );
    assert.equal((await s.collection.list("a"))[0].quantity, 50);
  } finally {
    s.db.close();
  }
});

test("SCAN-12 concurrent batch writers cannot fork a session or partially stage captures", async () => {
  const s = setup(),
    id = randomUUID();
  const payload = () => ({
    id,
    index: 1,
    last_oracle: card.oracle_id,
    batch: {
      id: randomUUID(),
      kind: "scan",
      rows: [
        {
          id: randomUUID(),
          name: card.name,
          printing_id: card.id,
          quantity: 1,
          finish: "nonfoil",
          condition: "NM",
        },
      ],
    },
  });
  try {
    const a = payload(),
      b = payload();
    const results = await Promise.allSettled([
      s.service.stageScanBatch("a", a),
      s.service.stageScanBatch("a", b),
    ]);
    assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
    const loser = results[0].status === "rejected" ? a : b;
    assert.equal(await s.raw.get("a", "import-stages", loser.batch.id), null);
    assert.equal(
      await s.raw.get("a", "scan-capture-index", loser.batch.rows[0].id),
      null,
    );
    assert.equal(
      (await s.service.getDraft("a", { id })).scan_session.accepted,
      1,
    );
    await s.service.stageScanBatch("a", { ...loser, index: 2 });
    assert.equal(
      (await s.service.getDraft("a", { id })).scan_session.accepted,
      2,
    );
    assert.deepEqual(await s.collection.list("a"), []);
    for (const invalid of [
      { ...payload(), batch: {} },
      { ...payload(), owner: "b" },
      { ...payload(), last_oracle: "invalid" },
    ])
      await assert.rejects(
        s.service.stageScanBatch("a", invalid),
        (error) => error.status === 400,
      );
  } finally {
    s.db.close();
  }
});
