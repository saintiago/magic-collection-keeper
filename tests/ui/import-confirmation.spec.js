import { randomUUID } from "node:crypto";
import { test, expect } from "./fixtures.js";
import { fixture, card } from "../helpers/import-page-fixture.js";
const payload = (count) => ({
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
});
for (const destination of ["collection", "home", "back"]) {
  test(`IMPORT-05/07 receipt settles without collection I/O; ${destination} lazily refreshes`, async ({
    page,
  }) => {
    const f = await fixture(page);
    let release;
    try {
      const staged = await f.drafts.stageDraft("test", payload(50));
      const other = await f.drafts.stageDraft("test", payload(1));
      await page.goto("/#collection");
      await expect(page.locator("#collection-status-text")).toContainText(
        "up to date",
      );
      await page.locator("#import-nav").click();
      await page.locator(`[data-draft="${staged.draft.id}"]`).click();
      await expect(page.locator(".draft-row")).toHaveCount(50);
      const reads = f.counts().collectionReads;
      // A stalled collection must never delay successful Import confirmation.
      let requested = 0;
      await page.route("**/api/collection", async (route) => {
        requested++;
        await new Promise((resolve) => {
          release = resolve;
        });
        await route.fallback();
      });
      const before = performance.now();
      await page.locator("#draft-add").click();
      await expect(page.locator(".import-status")).toContainText(
        "Added 50 new copies",
      );
      const settledMs = performance.now() - before;
      await expect(page.locator(".draft-row")).toHaveCount(0);
      await expect(
        page.locator(`[data-draft="${other.draft.id}"]`),
      ).toBeVisible();
      expect(requested).toBe(0);
      expect(f.counts().collectionReads).toBe(reads);
      expect(
        (await f.tagged.list("test")).reduce((n, r) => n + r.quantity, 0),
      ).toBe(50);
      if (destination === "back") {
        await page.goBack();
        await expect(page.locator("#import-page")).toBeVisible();
        expect(requested).toBe(0);
        await page.goBack();
      } else
        await page
          .locator(destination === "home" ? "#home-nav" : "#collection-nav")
          .click();
      await expect.poll(() => requested).toBe(1);
      release();
      await expect(page.locator("#total")).toHaveText("50");
      expect(f.counts().collectionReads).toBe(reads + 1);
      if (destination === "home")
        await expect(page.locator(".home-card")).toHaveCount(1);
      console.log(
        JSON.stringify({
          case: destination,
          confirmationMs: settledMs,
          postReceiptCollectionRequests: 0,
          lazyCollectionRequests: 1,
          fixture: "isolated SQLite/browser; no cloud latency claim",
        }),
      );
    } finally {
      release?.();
      f.db.close();
    }
  });
}
