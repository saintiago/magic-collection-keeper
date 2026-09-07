import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { openDatabase, savePrinting } from "../db.js";
import { createSqliteAdapters } from "../adapters/sqlite.js";
import { createSqliteDocumentStore } from "../adapters/document-store.js";
import { createCollectionService } from "../application/collection.js";
import { createTaggedCollection } from "../application/tagged-collection.js";
const card = {
  id: "11111111-1111-4111-8111-111111111111",
  oracle_id: "22222222-2222-4222-8222-222222222222",
  name: "Test Card",
  set: "tst",
  set_name: "Test Set",
  collector_number: "1",
  lang: "en",
  finishes: ["nonfoil", "foil"],
};
function setup() {
  const db = openDatabase(":memory:");
  savePrinting(db, card);
  const adapters = createSqliteAdapters(db),
    store = createSqliteDocumentStore(db),
    base = createCollectionService({
      repository: adapters.repository,
      catalog: {},
    });
  return {
    db,
    store,
    service: createTaggedCollection({
      collection: base,
      repository: adapters.repository,
      store,
      newId: randomUUID,
      hash: (v) => createHash("sha256").update(v).digest("hex"),
    }),
  };
}
test("typed tags preserve IDs through rename; owner isolation and deletion references", async () => {
  const { db, service: s } = setup();
  try {
    await s.createTag("a", { label: "Deck A", type: "location", kind: "deck" });
    await s.createTag("a", { label: "Card Draw", type: "role", kind: "role" });
    const [location, role] = (await s.tags("a")).sort((a, b) =>
      a.type.localeCompare(b.type),
    );
    assert.equal((await s.tags("b")).length, 0);
    await assert.rejects(
      () => s.renameTag("b", location.id, { label: "Stolen" }),
      (e) => e.status === 404,
    );
    let rows = await s.add("a", {
      printing_id: card.id,
      quantity: 2,
      finish: "nonfoil",
      condition: "NM",
    });
    rows = await s.assign("a", rows[0].id, {
      locations: [{ tag_id: location.id, quantity: 3 }],
      tag_ids: [role.id],
    });
    assert.equal(rows[0].allocation_shortfall, 1);
    assert.equal(rows[0].unallocated_quantity, 0);
    assert.equal(rows[0].tags[0].label, "Card Draw");
    await s.renameTag("a", location.id, { label: "Renamed <Deck>" });
    rows = await s.list("a");
    assert.equal(rows[0].locations[0].tag.label, "Renamed <Deck>");
    assert.equal(rows[0].locations[0].tag_id, location.id);
    await assert.rejects(
      () => s.deleteTag("a", location.id),
      (e) => e.status === 409,
    );
    rows = await s.setQuantity("a", rows[0].id, 1);
    assert.equal(rows[0].allocated_quantity, 3);
    assert.equal(rows[0].allocation_shortfall, 2);
    rows = await s.setQuantity("a", rows[0].id, 4);
    assert.equal(rows[0].allocation_shortfall, 0);
    assert.equal(rows[0].unallocated_quantity, 1);
    await s.assign("a", rows[0].id, { locations: [], tag_ids: [] });
    await s.deleteTag("a", location.id);
    await s.deleteTag("a", role.id);
    assert.deepEqual(await s.tags("a"), []);
  } finally {
    db.close();
  }
});
test("deck imports aggregate quantity-bearing locations, preserve loose copies and are permanently idempotent", async () => {
  const { db, service: s } = setup();
  try {
    await s.add("a", {
      printing_id: card.id,
      quantity: 5,
      finish: "nonfoil",
      condition: "NM",
    });
    const deck = {
      provider: "moxfield",
      source_id: "aaaaaaaaaaaaaaaaaaaaaa",
      name: "Alpha Deck",
      folder: "Commander",
      entries: [
        {
          printing_id: card.id,
          quantity: 2,
          finish: "nonfoil",
          section: "mainboard",
        },
      ],
      excluded: [{ section: "maybeboard", quantity: 3 }],
      pending: [
        {
          name: "Needs review",
          quantity: 1,
          reason: "Paper printing unknown",
          set: "prm",
          collector_number: "1",
          finish: "foil",
        },
      ],
    };
    let preview = await s.previewDeck("a", deck);
    assert.equal(preview.additions, 2);
    await s.importDeck("a", {
      ...deck,
      expected_version: preview.existing_version,
    });
    preview = await s.previewDeck("a", deck);
    assert.equal(preview.unchanged, true);
    assert.equal(preview.additions, 0);
    assert.equal((await s.decks("a"))[0].pending[0].name, "Needs review");
    const movedSection = {
      ...deck,
      entries: [{ ...deck.entries[0], section: "commanders" }],
    };
    assert.equal((await s.previewDeck("a", movedSection)).additions, 0);
    await s.importDeck("a", {
      ...deck,
      expected_version: preview.existing_version,
    });
    const second = {
      ...deck,
      source_id: "bbbbbbbbbbbbbbbbbbbbbb",
      name: "Beta Deck",
      entries: [{ ...deck.entries[0], quantity: 1 }],
    };
    await s.importDeck("a", { ...second, expected_version: 0 });
    let rows = await s.list("a");
    assert.equal(
      rows.reduce((n, r) => n + r.quantity, 0),
      8,
    );
    const imported = rows.find((r) => r.source_managed);
    assert.equal(imported.quantity, 3);
    assert.equal(imported.locations.length, 2);
    assert.equal(imported.allocated_quantity, 3);
    rows = await s.setQuantity("a", imported.id, 2);
    assert.equal(
      rows.find((r) => r.id === imported.id).allocation_shortfall,
      1,
    );
    const changed = { ...deck, entries: [{ ...deck.entries[0], quantity: 1 }] };
    preview = await s.previewDeck("a", changed);
    assert.equal(preview.retained_loose, 1);
    await s.importDeck("a", {
      ...changed,
      expected_version: preview.existing_version,
    });
    rows = await s.list("a");
    const adjusted = rows.find((r) => r.source_managed);
    assert.equal(adjusted.quantity, 2);
    assert.equal(adjusted.allocated_quantity, 2);
    assert.equal(adjusted.allocation_shortfall, 0);
    assert.equal(rows.find((r) => !r.source_managed).quantity, 5);
    await s.assign("a", adjusted.id, { locations: [], tag_ids: [] });
    assert.equal(
      (await s.list("a")).find((r) => r.source_managed).allocated_quantity,
      0,
    );
    assert.equal((await s.decks("b")).length, 0);
    await assert.rejects(
      () => s.importDeck("a", { ...changed, expected_version: 0 }),
      (e) => e.status === 409,
    );
  } finally {
    db.close();
  }
});
test("tag validation rejects structural content, invalid kinds, cross-owner and duplicate assignments", async () => {
  const { db, service: s } = setup();
  try {
    await assert.rejects(() =>
      s.createTag("a", { label: "A", type: "location:Deck A", kind: "deck" }),
    );
    await assert.rejects(() =>
      s.createTag("a", { label: "\n", type: "role", kind: "role" }),
    );
    await s.createTag("b", { label: "Other", type: "location", kind: "box" });
    const tag = (await s.tags("b"))[0];
    const [row] = await s.add("a", {
      printing_id: card.id,
      quantity: 1,
      condition: "NM",
      finish: "foil",
    });
    await assert.rejects(() =>
      s.assign("a", row.id, {
        locations: [{ tag_id: tag.id, quantity: 1 }],
        tag_ids: [],
      }),
    );
    await s.createTag("a", { label: "Mine", type: "location", kind: "binder" });
    const own = (await s.tags("a"))[0];
    await assert.rejects(() =>
      s.assign("a", row.id, {
        locations: [{ tag_id: own.id, quantity: 0 }],
        tag_ids: [],
      }),
    );
  } finally {
    db.close();
  }
});
