import { test, expect } from "@playwright/test";
import { fixture, card } from "../helpers/import-page-fixture.js";

async function setup(page) {
  const f = await fixture(page);
  await page.route("**/tag-retry-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Tag retry fixture</title>",
    }),
  );
  await page.goto("/tag-retry-fixture");
  await compose(page);
  return f;
}
async function compose(page) {
  await page.evaluate(async (card) => {
    const { createCardActionSave } = await import("/card-action-save.js");
    const { createCardTagActions } = await import("/card-tag-actions.js");
    window.writes = [];
    const api = async (path, options) => {
      if (options?.method === "POST") writes.push({ path, body: options.body });
      const response = await fetch(path, {
        ...options,
        headers: { "Content-Type": "application/json" },
      });
      const result = await response.json();
      if (!response.ok)
        throw Object.assign(Error(result.error), { status: response.status });
      return result;
    };
    window.available = await api("/api/tags");
    const save = createCardActionSave({
      api,
      currentView: () => 1,
      onOwned: () => {},
      onPending: () => {},
      onUsed: () => {},
      notify: () => {},
    });
    save.start("tag-test");
    window.actions = createCardTagActions({
      api,
      save: (intent) => save.save(intent),
      tags: () => available,
    });
    actions.start("tag-test");
    window.item = { kind: "catalog", card, row: { card } };
  }, card);
}

test("UC-CARD-RETRY a committed catalogue tag retries its original stage after reload into pending", async ({
  page,
}) => {
  const f = await setup(page);
  f.loseStageResponse();
  const first = await page.evaluate(async () => {
    try {
      await actions.toggle(item, available[0], true);
    } catch (error) {
      return { error: error.message, request: writes[0] };
    }
  });
  expect(first.error).toContain("interrupted");
  expect((await f.tagged.list("test")).length).toBe(0);
  await page.reload();
  await compose(page);
  const retried = await page.evaluate(async () => {
    await actions.load(item);
    const loadedKind = item.kind;
    await actions.toggle(item, available[0], true);
    return {
      loadedKind,
      writes,
      id: item.draftId,
      journal: sessionStorage.getItem("keeper-card-action-v1:tag-test"),
    };
  });
  expect(retried.loadedKind).toBe("pending");
  expect(retried.writes).toEqual([first.request]);
  expect(retried.id).toBe(JSON.parse(first.request.body).id);
  expect(retried.journal).toBeNull();
  expect((await f.tagged.list("test")).length).toBe(0);
  expect(f.counts().ownedWrites).toBe(0);
  f.db.close();
});

test("UC-CARD-RETRY corrupt or oversized pending references block a new stage", async ({
  page,
}) => {
  const f = await setup(page);
  const outcomes = await page.evaluate(async () => {
    const outcomes = [];
    for (const raw of [
      JSON.stringify([{ printingId: "bad", draftId: "bad", rowId: "bad" }]),
      "x".repeat(250000),
    ]) {
      sessionStorage.setItem("keeper-catalog-tags-v1:tag-test", raw);
      actions.start("tag-test");
      try {
        await actions.toggle(item, available[0], true);
      } catch (error) {
        outcomes.push(error.message);
      }
    }
    return { outcomes, writes };
  });
  expect(outcomes.outcomes).toHaveLength(2);
  for (const error of outcomes.outcomes)
    expect(error).toContain("could not be read");
  expect(outcomes.writes).toEqual([]);
  f.db.close();
});

test("UC-CARD-RETRY a cleared catalogue review gets a fresh stage identity without reviving the old receipt", async ({
  page,
}) => {
  const f = await setup(page);
  const previous = await page.evaluate(async () => {
    await actions.toggle(item, available[0], true);
    return { id: item.draftId, row: item.row.id };
  });
  const saved = await f.drafts.getDraft("test", { id: previous.id });
  await f.drafts.clearDraft("test", {
    id: previous.id,
    kind: "capture",
    version: saved.draft.version,
  });
  await page.reload();
  await compose(page);
  const next = await page.evaluate(async () => {
    await actions.toggle(item, available[0], true);
    return { id: item.draftId, row: item.row.id, writes };
  });
  expect(next.id).not.toBe(previous.id);
  expect(next.row).not.toBe(previous.row);
  expect(next.writes).toHaveLength(1);
  expect((await f.tagged.list("test")).length).toBe(0);
  f.db.close();
});

test("UC-CARD-RETRY storage failure after commit reports a saved review without another stage", async ({
  page,
}) => {
  const f = await setup(page);
  const result = await page.evaluate(async () => {
    const original = Storage.prototype.setItem;
    let remembered = 0;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("keeper-catalog-tags-v1:") && ++remembered === 2)
        throw Error("Quota exceeded");
      return original.call(this, key, value);
    };
    let error;
    try {
      await actions.toggle(item, available[0], true);
    } catch (caught) {
      error = caught.message;
    } finally {
      Storage.prototype.setItem = original;
    }
    return { error, writes, kind: item.kind, id: item.draftId };
  });
  expect(result.error).toContain("Your tag was saved");
  expect(result.error).not.toContain("No new capture was staged");
  expect(result.writes).toHaveLength(1);
  expect(result.kind).toBe("pending");
  expect((await f.tagged.list("test")).length).toBe(0);
  f.db.close();
});
