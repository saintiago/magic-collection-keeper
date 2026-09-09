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
  await page.addInitScript(() => {
    window.emptyGeometryChecks = 0;
    window.addEventListener(
      "keeper-card-geometry-measurement",
      ({ detail }) => {
        if (detail.state === "none" && detail.sameScene)
          window.emptyGeometryChecks++;
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
    window.emptyGeometryChecks = 0;
    window.paintSyntheticCard(true);
  });
  // Actual geometry must observe departure; a fixed 700 ms flash can finish
  // before a slow worker has checked even one empty frame.
  await expect
    .poll(() => page.evaluate(() => window.emptyGeometryChecks), {
      timeout: 15000,
    })
    .toBeGreaterThanOrEqual(3);
  await page.evaluate(() => window.paintSyntheticCard());
  await choose();
  await expect(page.locator(".scan-option")).toHaveCount(2);
  await page.locator(".scan-plus").click();
  await expect(page.locator("#scan-controls output")).toHaveText("2");
  await page.locator("#scan-back").click();
  expect(
    await page.evaluate(() => window.syntheticStream.getTracks()[0].readyState),
  ).toBe("ended");
  await expect(page.locator(".draft-row")).toHaveCount(2);
  await page.locator("#draft-add").click();
  await expect(page.locator(".import-status")).toContainText(
    "Added 3 new copies",
  );
  await page.locator("#draft-back").click();
  await page.reload();
  await expect(page.locator("#total")).toHaveText("3");
  const saved = await liveApi(page, "/api/collection");
  expect(saved).toHaveLength(1);
  expect(saved[0].quantity).toBe(3);
  await liveApi(page, "/api/collection/" + saved[0].id, { method: "DELETE" });
  expect(await liveApi(page, "/api/collection")).toEqual([]);
  await page.locator("#sign-out").click();
});
