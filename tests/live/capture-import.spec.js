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
  await page.locator("#import-nav").click();
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
  await page.locator("#collection-nav").click();
  await page.reload();
  await expect(page.locator("#total")).toHaveText("1");
  await page.locator(".card").click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#remove").click();
  await expect(page.locator("#total")).toHaveText("0");
  await page.locator("#sign-out").click();
});
