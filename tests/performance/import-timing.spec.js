import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test, expect } from "../ui/fixtures.js";
import { fixture, card } from "../helpers/import-page-fixture.js";
for (const version of ["baseline", "current"])
  test("measurement " + version, async ({ page }) => {
    const f = await fixture(page);
    let reads = 0,
      receivedAt;
    try {
      if (version === "baseline")
        for (const file of ["app.js", "collection-loader.js"])
          await page.route("**/" + file, (route) =>
            route.fulfill({
              contentType: "text/javascript",
              body: execFileSync("git", ["show", "e0815c3:public/" + file], {
                encoding: "utf8",
              }),
            }),
          );
      const staged = await f.drafts.stageDraft("test", {
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
      });
      await page.goto("/#collection");
      await expect(page.locator("#collection-status-text")).toContainText(
        "up to date",
      );
      await page.locator("#import-nav").click();
      await page.locator(`[data-draft="${staged.draft.id}"]`).click();
      await expect(page.locator(".draft-row")).toHaveCount(1);
      await page.route("**/api/collection", async (route) => {
        reads++;
        await new Promise((r) => setTimeout(r, 500));
        await route.fallback();
      });
      page.on("response", (response) => {
        if (new URL(response.url()).pathname === "/api/import-draft/add")
          receivedAt = performance.now();
      });
      const start = performance.now();
      await page.locator("#draft-add").click();
      await expect(page.locator(".import-status")).toContainText(
        "Added 1 new copies",
      );
      const done = performance.now();
      const result = {
        version,
        backendAndTransportMs: receivedAt - start,
        postResponseUiMs: done - receivedAt,
        confirmationMs: done - start,
        postReceiptCollectionRequests: reads,
        injectedCollectionDelayMs: 500,
        scope:
          "Isolated SQLite and Chromium; one controlled observation, not production speedup",
      };
      console.log(JSON.stringify(result));
      await writeFile(
        test.info().outputPath("timing-" + version + ".json"),
        JSON.stringify(result, null, 2),
      );
      expect(reads).toBe(version === "baseline" ? 1 : 0);
    } finally {
      f.db.close();
    }
  });
