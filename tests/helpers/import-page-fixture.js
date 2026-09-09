import { randomUUID, createHash } from "node:crypto";
import { openDatabase, savePrinting } from "../../db.js";
import { createSqliteAdapters } from "../../adapters/sqlite.js";
import { createSqliteDocumentStore } from "../../adapters/document-store.js";
import { createCollectionService } from "../../application/collection.js";
import { createTaggedCollection } from "../../application/tagged-collection.js";
import { createImportDraftService } from "../../application/import-drafts.js";
import { routeCollection } from "../../application/routes.js";
import {
  moxfieldSource,
  IMPORT_PENDING_TAG,
} from "../../domain/import-draft.js";
export const card = {
  id: "11111111-1111-4111-8111-111111111111",
  oracle_id: "22222222-2222-4222-8222-222222222222",
  name: "Draft Test Card",
  set: "tst",
  set_name: "Test Set",
  collector_number: "1",
  lang: "en",
  finishes: ["nonfoil", "foil"],
  games: ["paper"],
  color_identity: [],
  type_line: "Artifact",
};
export const alt = {
  ...card,
  id: "33333333-3333-4333-8333-333333333333",
  collector_number: "2",
};
const url = "https://moxfield.com/decks/keeper_import_ui_0001";
export async function fixture(page, { lines = 3, unresolved = false } = {}) {
  const db = openDatabase(":memory:");
  [card, alt].forEach((c) => savePrinting(db, c));
  const { repository } = createSqliteAdapters(db),
    store = createSqliteDocumentStore(db);
  const tagged = createTaggedCollection({
    collection: createCollectionService({
      repository,
      catalog: {
        search: async () => ({ cards: [card, alt], total: 2, hasMore: false }),
      },
    }),
    repository,
    store,
    newId: randomUUID,
    hash: (v) => createHash("sha256").update(v).digest("hex"),
  });
  let failure = "",
    loseResponse = false,
    loseStage = false,
    collectionReads = 0,
    patchFailure = false,
    getFailure = false,
    ownedWrites = 0,
    loads = 0;
  const drafts = createImportDraftService({
    store,
    repository,
    collection: tagged,
    newId: randomUUID,
    catalog: { resolve: async () => (unresolved ? [] : [card]) },
    provider: {
      fetchDeck: async (requested) => {
        loads++;
        if (failure) throw Error(failure);
        return {
          ...moxfieldSource(requested),
          name: "Draft <source>",
          retrieved_at: "2026-09-08T00:00:00Z",
          excluded: [{ section: "sideboard", quantity: 1 }],
          rows: Array.from({ length: lines }, (_, i) => ({
            name: card.name,
            source_line: `mainboard:${i}`,
            section: "mainboard",
            quantity: lines === 3 && i === 0 ? 98 : 1,
            printing_id: card.id,
            finish: "nonfoil",
            set: "tst",
            collector_number: "1",
            language: "en",
          })),
        };
      },
    },
  });
  await tagged.createTag("test", {
    label: "Draft Box",
    type: "location",
    kind: "box",
  });
  await tagged.createTag("test", { label: "Draw", type: "role", kind: "role" });
  const service = { ...tagged, ...drafts };
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      target = new URL(request.url()),
      method = request.method();
    try {
      if (
        method === "PATCH" &&
        target.pathname === "/api/import-draft" &&
        patchFailure
      ) {
        patchFailure = false;
        throw Error("Save interrupted. Retry your edits.");
      }
      if (
        method === "GET" &&
        target.pathname === "/api/import-draft" &&
        getFailure
      )
        throw Error("Draft could not be loaded. Retry.");
      if (target.pathname === "/api/import-draft/add") ownedWrites++;
      if (target.pathname === "/api/collection" && method === "GET")
        collectionReads++;
      const value = await routeCollection(
        service,
        "test",
        method,
        target.pathname,
        request.postDataJSON() || {},
        Object.fromEntries(target.searchParams),
      );
      if (target.pathname === "/api/import-draft/add" && loseResponse) {
        loseResponse = false;
        throw Error("Response interrupted after commit. Retry safely.");
      }
      if (target.pathname === "/api/import-draft/stage" && loseStage) {
        loseStage = false;
        throw Error("Stage response interrupted. Retry safely.");
      }
      await route.fulfill({
        status: value === undefined ? 404 : 200,
        json: value === undefined ? { error: "not found" } : value,
      });
    } catch (e) {
      await route.fulfill({
        status: e.status || 503,
        json: { error: e.message },
      });
    }
  });
  return {
    db,
    tagged,
    drafts,
    setFailure: (value) => (failure = value),
    failPatch: () => (patchFailure = true),
    setGetFailure: (value) => (getFailure = value),
    loseAddResponse: () => {
      loseResponse = true;
    },
    loseStageResponse: () => {
      loseStage = true;
    },
    counts: () => ({ ownedWrites, loads, collectionReads }),
  };
}
