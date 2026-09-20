import { openArtworkDetails } from "../helpers/artwork-actions.js";
import { clearCaptureTestData, liveApi } from "../helpers/backend-live.js";
import { test, expect } from "@playwright/test";
test("LIVE-02 real text import, explicit ownership and durable quantity", async ({
  page,
}) => {
  test.setTimeout(120000);
  await page.goto("/#collection");
  await page
    .getByLabel("Username", { exact: true })
    .fill(process.env.KEEPER_TEST_USER);
  await page
    .getByLabel("Password", { exact: true })
    .fill(process.env.KEEPER_TEST_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".auth-dialog")).toHaveCount(0);
  expect(process.env.KEEPER_TEST_USER).toBe("keeper-e2e");
  const before = await liveApi(page, "/api/collection");
  expect(before).toEqual([]);
  const beforeIds = new Set(before.map((row) => row.id));
  const beforeDrafts = new Set(
    (await liveApi(page, "/api/import-draft")).pending_drafts.map(
      (draft) => draft.id,
    ),
  );
  let failure;
  try {
    await expect(page.locator("#collection-status-text")).toContainText(
      "up to date",
    );
    let collectionReads = 0;
    page.on("request", (request) => {
      if (
        request.method() === "GET" &&
        new URL(request.url()).pathname === "/api/collection"
      )
        collectionReads++;
    });
    await page.locator("#import-nav").click();
    await page.locator("#draft-show-text").click();
    await page.locator("#import-text").fill("1 Lightning Bolt (M11) 149");
    await page.locator("#draft-text-form button").click();
    await expect(page.locator(".draft-row")).toHaveCount(1, {
      timeout: 25000,
    });
    await page.locator("#draft-add").click();
    await expect(
      page.getByText("Added 1 new copies", { exact: false }),
    ).toBeVisible();
    expect(collectionReads).toBe(0);
    await page.locator("#draft-back").click();
    await page.locator("#collection-nav").click();
    await expect(page.locator("#total")).toHaveText("1");
    expect(collectionReads).toBeGreaterThan(0);
    await page.reload();
    await expect(page.locator("#total")).toHaveText("1");
    await page.locator(".card").click();
    await openArtworkDetails(page);
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#remove").click();
    await expect(page.locator("#total")).toHaveText("0");
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      await clearCaptureTestData(page, beforeDrafts, beforeIds);
      expect(await liveApi(page, "/api/collection")).toEqual(before);
      await page.goto("/#home", { timeout: 15000 });
      await page.locator("#sign-out").click({ timeout: 10000 });
    } catch (error) {
      if (!failure) throw error;
      console.info(
        "Capture import cleanup failed; preserving scenario error:",
        error.message,
      );
    }
  }
});
