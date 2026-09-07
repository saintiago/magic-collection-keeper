import { test, expect } from "@playwright/test";
import { installSyntheticCardCamera } from "../helpers/synthetic-camera.js";

test("LIVE-04 continuous synthetic camera with real OCR, real printing resolution and durable quantity", async ({
  page,
}) => {
  test.setTimeout(120000);
  await page.addInitScript(installSyntheticCardCamera);
  await page.goto("/");
  await page
    .getByLabel("Username", { exact: true })
    .fill(process.env.KEEPER_TEST_USER);
  await page
    .getByLabel("Password", { exact: true })
    .fill(process.env.KEEPER_TEST_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".auth-dialog")).toHaveCount(0);
  await expect(page.locator("#total")).toHaveText("0");
  await page.locator("#scan").click();
  await page.locator("#camera-start").click();
  await expect(page.locator("#scan-status")).toContainText(
    "Lightning Bolt matched",
    { timeout: 60000 },
  );
  await page.waitForTimeout(1800);
  await expect(page.locator(".scan-option")).toHaveCount(1);
  await page.evaluate(() => window.paintSyntheticCard(true));
  await page.waitForTimeout(500);
  await page.evaluate(() => window.paintSyntheticCard());
  await expect(page.locator(".scan-option")).toHaveCount(2);
  await expect(page.locator(".scan-option small").last()).toHaveText(
    "✓ Matched",
    { timeout: 30000 },
  );
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
  await page.locator(".card").click();
  page.once("dialog", (d) => d.accept());
  await page.locator("#remove").click();
  await expect(page.locator("#total")).toHaveText("0");
  await page.locator("#sign-out").click();
});
