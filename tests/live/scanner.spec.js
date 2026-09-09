import { publicCardFrame } from "../helpers/public-frame.js";
import { liveApi } from "../helpers/backend-live.js";
import { test, expect } from "@playwright/test";
import { installSyntheticCardCamera } from "../helpers/synthetic-camera.js";

test("LIVE-04 continuous synthetic camera with real recognition, real printing resolution and durable quantity", async ({
  page,
}) => {
  test.setTimeout(180000);
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
  const image = await publicCardFrame(page);
  await page.addInitScript(installSyntheticCardCamera, image);
  await page.reload();
  await page.locator("#scan").click();
  await page.locator("#camera-start").click();
  async function choose() {
    await expect(page.locator("#scan-possible")).toBeVisible({
      timeout: 60000,
    });
    const panel = page.locator("#scan-possible");
    if (!(await panel.evaluate((el) => el.open)))
      await panel.locator("summary").click();
    await panel
      .getByRole("button", {
        name: "Adaptive Training Post · tdc #58 · en",
        exact: true,
      })
      .click();
  }
  await choose();
  await expect(page.locator(".scan-option")).toHaveCount(1);
  await page.waitForTimeout(1800);
  await expect(page.locator(".scan-option")).toHaveCount(1);
  await page.evaluate(() => window.paintSyntheticCard(true));
  await page.waitForTimeout(700);
  await page.evaluate(() => window.paintSyntheticCard());
  await choose();
  await expect(page.locator(".scan-option")).toHaveCount(2);
  await page.locator(".scan-plus").click();
  await expect(page.locator("#scan-controls output")).toHaveText("2");
  await page.locator("#scan-back").click();
  expect(
    await page.evaluate(() => window.syntheticStream.getTracks()[0].readyState),
  ).toBe("ended");
  await expect(page.locator(".review-row")).toHaveCount(2);
  await page.locator("#ownership").check();
  await page.locator("#save-batch").click();
  await expect(page.locator("#batch-status")).toContainText(
    "2 reviewed entries added",
  );
  await page.locator("#batch-close").click();
  await page.reload();
  await expect(page.locator("#total")).toHaveText("3");
  const saved = await liveApi(page, "/api/collection");
  expect(saved).toHaveLength(1);
  expect(saved[0].quantity).toBe(3);
  await liveApi(page, "/api/collection/" + saved[0].id, { method: "DELETE" });
  expect(await liveApi(page, "/api/collection")).toEqual([]);
  await page.locator("#sign-out").click();
});
