import { test, expect } from "@playwright/test";
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
const card = {
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
const alt = {
  ...card,
  id: "33333333-3333-4333-8333-333333333333",
  collector_number: "2",
};
const url = "https://moxfield.com/decks/keeper_import_ui_0001";
async function fixture(page, { lines = 3, unresolved = false } = {}) {
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
      const value = await routeCollection(
        service,
        "test",
        method,
        target.pathname,
        request.postDataJSON() || {},
        Object.fromEntries(target.searchParams),
      );
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
    counts: () => ({ ownedWrites, loads }),
  };
}
async function openAndLoad(page) {
  await page.goto("/#import");
  await expect(page.locator("#moxfield-url")).toBeEnabled();
  await page.locator("#moxfield-url").fill(url);
  await page.getByRole("button", { name: "Load deck", exact: true }).click();
  await expect(page.locator(".draft-row").first()).toBeVisible();
}
test("UC-21/22 URL draft edits and tags survive reload, stay unowned, then Add commits the reviewed copies", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    await openAndLoad(page);
    await expect(page.locator(".draft-row")).toHaveCount(3);
    await expect(page.locator(".draft-heading")).toContainText(
      "100 copies in fetched source",
    );
    expect(await f.tagged.list("test")).toEqual([]);
    expect(await f.tagged.decks("test")).toEqual([]);
    await page.getByLabel("Quantity for line 1", { exact: true }).fill("97");
    await page.getByLabel("Quantity for line 1", { exact: true }).press("Tab");
    await expect(page.locator("#draft-add")).toBeEnabled();
    await page
      .getByRole("button", { name: "Delete line 2", exact: true })
      .click();
    await expect(page.locator(".draft-row")).toHaveCount(2);
    await page
      .locator(".draft-row")
      .first()
      .getByRole("button", { name: "Change printing" })
      .click();
    await expect(page.locator(".draft-printing-choice")).toHaveCount(2);
    await page.locator(".draft-printing-choice").nth(1).click();
    await expect(page.locator(".draft-dialog")).not.toBeVisible();
    await page
      .getByLabel("Finish for line 1", { exact: true })
      .selectOption("foil");
    await expect(page.locator("#draft-add")).toBeEnabled();
    await page
      .locator(".draft-row")
      .first()
      .getByRole("button", { name: "Edit tags" })
      .click();
    await page.getByLabel("Draft Box", { exact: true }).check();
    await page.getByLabel("Copies at Draft Box").fill("2");
    await page.getByLabel("Draw", { exact: true }).check();
    await page.getByRole("button", { name: "Save tags", exact: true }).click();
    await expect(page.locator(".draft-dialog")).not.toBeVisible();
    await page.reload();
    await expect(page.locator(".draft-row")).toHaveCount(2);
    await expect(
      page.getByLabel("Quantity for line 1", { exact: true }),
    ).toHaveValue("97");
    await expect(
      page.getByLabel("Finish for line 1", { exact: true }),
    ).toHaveValue("foil");
    await expect(page.locator(".draft-row").first()).toContainText("TST #2");
    await expect(page.locator(".draft-tag-summary").first()).toContainText(
      "1 other locations · 1 classifications",
    );
    expect(f.counts().ownedWrites).toBe(0);
    expect(await f.tagged.list("test")).toEqual([]);
    await page.locator("#collection-nav").click();
    await expect(page.locator("#total")).toHaveText("0");
    await expect(page.locator("#tag-filter option")).not.toContainText([
      "system:import-pending",
    ]);
    await page.locator("#import-nav").click();
    await expect(page.locator(".draft-row")).toHaveCount(2);
    await page.locator("#draft-add").click();
    await expect(page.locator(".import-status")).toContainText(
      "Added 98 new copies",
    );
    await expect(page.locator(".draft-row")).toHaveCount(0);
    await expect(page.locator("#draft-add")).toBeDisabled();
    await page.locator("#collection-nav").click();
    await expect(page.locator("#total")).toHaveText("98");
    expect(
      (await f.tagged.list("test")).reduce((n, r) => n + r.quantity, 0),
    ).toBe(98);
    const deck = (await f.tagged.decks("test"))[0];
    expect(deck.review.original.total).toBe(100);
    expect(deck.review.reviewed_count).toBe(98);
    await page.locator("#manage-tags").click();
    await page.getByRole("button", { name: "View deck sources" }).click();
    await expect(page.locator(".source-review-counts")).toHaveText(
      "Fetched source: 100 cards · Reviewed: 98 cards",
    );
    await expect(page.locator(".source-total")).toContainText(
      "98 cards in reviewed source",
    );
    expect(
      deck.lots.find((l) => l.printing_id === alt.id).original_lines[0]
        .collector_number,
    ).toBe("1");
  } finally {
    f.db.close();
  }
});
test("UC-21 failures preserve the saved draft; failed edits require retry and Clear never changes owned cards", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    f.setFailure(
      "Moxfield denied this server access. Approved access is required.",
    );
    await page.goto("/#import");
    await page.locator("#moxfield-url").fill(url);
    await page.getByRole("button", { name: "Load deck", exact: true }).click();
    await expect(page.locator(".import-status")).toContainText("denied");
    await expect(page.locator("#draft-add")).toBeDisabled();
    f.setFailure("");
    await page.getByRole("button", { name: "Load deck", exact: true }).click();
    await expect(page.locator(".draft-row")).toHaveCount(3);
    f.failPatch();
    await page.getByLabel("Quantity for line 1", { exact: true }).fill("4");
    await page.getByLabel("Quantity for line 1", { exact: true }).press("Tab");
    await expect(page.locator(".import-status")).toContainText(
      "Save interrupted",
    );
    await expect(page.locator("#draft-add")).toBeDisabled();
    await expect(
      page.getByLabel("Quantity for line 1", { exact: true }),
    ).toHaveValue("4");
    await page.getByRole("button", { name: "Retry saving edits" }).click();
    await expect(page.locator("#draft-add")).toBeEnabled();
    expect((await f.drafts.getDraft("test")).draft.rows[0].quantity).toBe(4);
    f.setGetFailure(true);
    await page.reload();
    await expect(page.locator(".import-status")).toContainText(
      "could not be loaded",
    );
    f.setGetFailure(false);
    await page.getByRole("button", { name: "Reload saved draft" }).click();
    await expect(
      page.getByLabel("Quantity for line 1", { exact: true }),
    ).toHaveValue("4");
    await page.locator("#draft-clear").click();
    await expect(page.locator(".import-status")).toContainText(
      "Owned cards are unchanged",
    );
    await page.reload();
    await expect(page.locator(".draft-row")).toHaveCount(0);
    expect(await f.tagged.list("test")).toEqual([]);
    expect(f.counts().ownedWrites).toBe(0);
  } finally {
    f.db.close();
  }
});
test("UC-21 unresolved printing and removed tags block Add until explicitly repaired", async ({
  page,
}) => {
  const f = await fixture(page, { lines: 1, unresolved: true });
  try {
    await openAndLoad(page);
    await expect(page.locator("#draft-add")).toBeDisabled();
    await page.getByRole("button", { name: "Change printing" }).click();
    await page.locator(".draft-printing-choice").first().click();
    await expect(page.locator("#draft-add")).toBeEnabled();
    await page.getByRole("button", { name: "Edit tags" }).click();
    await page.getByLabel("Draw", { exact: true }).check();
    await page.getByRole("button", { name: "Save tags", exact: true }).click();
    await expect(page.locator(".draft-dialog")).not.toBeVisible();
    const tag = (await f.tagged.tags("test")).find((t) => t.label === "Draw");
    await f.tagged.deleteTag("test", tag.id);
    await page.reload();
    await expect(page.locator("#draft-add")).toBeDisabled();
    await expect(page.locator(".draft-heading")).toContainText("unavailable");
    await page.getByRole("button", { name: "Edit tags" }).click();
    await page.getByRole("button", { name: "Save tags", exact: true }).click();
    await expect(page.locator("#draft-add")).toBeEnabled();
    await page
      .getByLabel("Finish for line 1", { exact: true })
      .selectOption("etched");
    await expect(page.locator("#draft-add")).toBeDisabled();
    await page
      .getByLabel("Finish for line 1", { exact: true })
      .selectOption("nonfoil");
    await expect(page.locator("#draft-add")).toBeEnabled();
  } finally {
    f.db.close();
  }
});
test("UC-21 mobile hundred-line draft, history and account API visibility remain separate from owned inventory", async ({
  page,
}) => {
  const f = await fixture(page, { lines: 100 });
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/#collection");
    await page.locator("#import-nav").click();
    await page.locator("#moxfield-url").fill(url);
    await page.getByRole("button", { name: "Load deck", exact: true }).click();
    await expect(page.locator(".draft-row")).toHaveCount(100);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.goBack();
    await expect(page.locator("#import-page")).toBeHidden();
    await page.goForward();
    await expect(page.locator(".draft-row")).toHaveCount(100);
    expect(
      (await f.tagged.tags("test")).some((t) => t.id === IMPORT_PENDING_TAG.id),
    ).toBe(false);
    expect((await f.drafts.getDraft("other")).draft).toBeNull();
    expect(await f.tagged.decks("test")).toEqual([]);
    expect(await f.tagged.list("test")).toEqual([]);
    await page.locator("#draft-add").click();
    await expect(page.locator(".import-status")).toContainText(
      "Added 100 new copies",
    );
    expect(f.counts().ownedWrites).toBe(1);
    expect(
      (await f.tagged.list("test")).reduce((n, r) => n + r.quantity, 0),
    ).toBe(100);
  } finally {
    f.db.close();
  }
});
