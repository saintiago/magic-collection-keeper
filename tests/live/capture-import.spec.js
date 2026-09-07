import { test, expect } from "@playwright/test";
test("LIVE-02 real text import and deployed OCR photo-review workflow", async ({
  page,
}) => {
  test.setTimeout(120000);
  await page.goto("/");
  await page
    .getByLabel("Username", { exact: true })
    .fill(process.env.KEEPER_TEST_USER);
  await page
    .getByLabel("Password", { exact: true })
    .fill(process.env.KEEPER_TEST_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".auth-dialog")).toHaveCount(0);
  await page.locator("#import-list").click();
  await page.locator("#import-text").fill("1 Lightning Bolt (M11) 149");
  await page.locator("#preview").click();
  await expect(page.locator(".candidate")).not.toHaveValue("", {
    timeout: 25000,
  });
  await page.locator("#ownership").check();
  await page.locator("#save-batch").click();
  await expect(
    page.getByText("1 reviewed entries added.", { exact: false }),
  ).toBeVisible();
  await page.locator("#batch-close").click();
  await page.locator("#scan").click();
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 700;
    canvas.height = 980;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, 700, 980);
    ctx.fillStyle = "black";
    ctx.font = "bold 46px Arial";
    ctx.fillText("Lightning Bolt", 35, 80);
    ctx.font = "30px Arial";
    ctx.fillText("Instant", 35, 620);
    ctx.fillText("149", 35, 870);
    ctx.fillText("M11 EN", 35, 920);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.locator("#photo").setInputFiles({
    name: "ocr-test.png",
    mimeType: "image/png",
    buffer: Buffer.from(png, "base64"),
  });
  await expect(page.locator(".scan-option")).toHaveCount(1, { timeout: 60000 });
  await expect(page.locator(".scan-option small")).not.toHaveText("Reading…", {
    timeout: 60000,
  });
  await page.locator("#scan-review").click();
  await page
    .locator(".review-search input")
    .fill('!"Lightning Bolt" set:m11 lang:en');
  await page.locator(".resolve").click();
  await expect(page.locator(".candidate")).not.toHaveValue("");
  await page.locator("#ownership").check();
  await page.locator("#save-batch").click();
  await expect(
    page.getByText("1 reviewed entries added.", { exact: false }),
  ).toBeVisible();
  await page.locator("#batch-close").click();
  await expect(page.locator("#total")).toHaveText("2");
  await page.locator(".card").click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#remove").click();
  await expect(page.locator("#total")).toHaveText("0");
  await page.locator("#sign-out").click();
});
