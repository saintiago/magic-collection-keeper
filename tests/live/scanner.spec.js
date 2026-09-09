import { publicCardFrame } from "../helpers/public-frame.js";
import {
  liveApi,
  reviewedOwnership,
  clearCaptureTestData,
} from "../helpers/backend-live.js";
import { test, expect } from "@playwright/test";
import { installSyntheticCardCamera } from "../helpers/synthetic-camera.js";

test("LIVE-04 continuous synthetic camera with real recognition, real printing resolution and durable quantity", async ({
  page,
}) => {
  test.setTimeout(180000);
  expect(process.env.KEEPER_TEST_USER).toBe("keeper-e2e");
  await page.goto("/#collection");
  await page
    .getByLabel("Username", { exact: true })
    .fill(process.env.KEEPER_TEST_USER);
  await page
    .getByLabel("Password", { exact: true })
    .fill(process.env.KEEPER_TEST_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".auth-dialog")).toHaveCount(0);
  await expect(page.locator("#total")).toHaveText("0");
  expect(await liveApi(page, "/api/collection")).toEqual([]);
  const beforeDrafts = new Set(
    (await liveApi(page, "/api/import-draft")).pending_drafts.map(
      (draft) => draft.id,
    ),
  );
  try {
    const image = await publicCardFrame(page);
    await page.addInitScript(installSyntheticCardCamera, image);
    await page.addInitScript(() => {
      window.emptyGeometryChecks = [];
      window.addEventListener(
        "keeper-card-geometry-measurement",
        ({ detail }) => {
          if (detail.state === "none" && detail.sameScene)
            window.emptyGeometryChecks.push(detail.capturedAt);
        },
      );
    });
    await page.reload();
    await page.locator("#scan").click();
    await page.locator("#camera-start").click();
    let count = 0;
    async function choose() {
      await expect(page.locator(".scan-option")).toHaveCount(++count, {
        timeout: 60000,
      });
    }
    await choose();
    await expect(page.locator(".scan-option")).toHaveCount(1);
    await page.waitForTimeout(1800);
    await expect(page.locator(".scan-option")).toHaveCount(1);
    await page.evaluate(() => {
      window.emptyGeometryChecks = [];
      window.paintSyntheticCard(true);
    });
    // Actual geometry must observe departure; a fixed 700 ms flash can finish
    // before a slow worker has checked even one empty frame.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const frames = window.emptyGeometryChecks;
            return frames.length >= 3 && frames.at(-1) - frames[0] >= 600;
          }),
        {
          timeout: 15000,
        },
      )
      .toBe(true);
    await page.evaluate(() => window.paintSyntheticCard());
    await choose();
    await expect(page.locator(".scan-option")).toHaveCount(2);
    await page.locator(".scan-plus").click();
    await expect(page.locator("#scan-controls output")).toHaveText("2");
    await page.locator("#scan-back").click();
    expect(
      await page.evaluate(
        () => window.syntheticStream.getTracks()[0].readyState,
      ),
    ).toBe("ended");
    await expect(page.locator(".draft-row")).toHaveCount(2);
    const { draft } = await liveApi(page, "/api/import-draft");
    expect(draft.rows).toHaveLength(2);
    for (const row of draft.rows)
      expect(row.card.oracle_id).toBe("a6657fcf-f08c-4b03-8ec8-cb0b194eb553");
    const reviewed = reviewedOwnership(draft.rows);
    await page.locator("#draft-add").click();
    await expect(page.locator(".import-status")).toContainText(
      "Added 3 new copies",
    );
    await page.locator("#draft-back").click();
    await page.reload();
    await expect(page.locator("#total")).toHaveText("3");
    const saved = await liveApi(page, "/api/collection");
    expect(saved).toHaveLength(reviewed.length);
    expect(reviewedOwnership(saved)).toEqual(reviewed);
  } finally {
    await clearCaptureTestData(page, beforeDrafts);
    await page.reload();
    await page.locator("#sign-out").click();
  }
});
