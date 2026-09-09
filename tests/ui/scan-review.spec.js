import { test, expect } from "./fixtures.js";
test("UC-08 permission timeout and invalid uploaded photo give actionable errors", async ({
  page,
}) => {
  await page.route("**/api/collection", (r) => r.fulfill({ json: [] }));
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => new Promise(() => {});
  });
  await page.clock.install();
  await page.goto("/#collection");
  await page.locator("#scan").click();
  await page.locator("#camera-start").click();
  await expect(page.getByText("Waiting for camera permission…")).toBeVisible();
  await page.clock.runFor(16000);
  await expect(
    page.getByText("Camera unavailable: Permission request timed out.", {
      exact: false,
    }),
  ).toBeVisible();
  await page.locator("#photo").setInputFiles({
    name: "invalid.png",
    mimeType: "image/png",
    buffer: Buffer.from("not an image"),
  });
  await expect(
    page.getByText("Could not read that image:", { exact: false }),
  ).toBeVisible();
});
