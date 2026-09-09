import { test, expect } from "@playwright/test";
test("LIVE-01 protected collection survives reload and isolates a second owner", async ({
  page,
  browser,
  request,
}) => {
  const config = await (
    await request.get(`${process.env.LIVE_URL}/config.json`)
  ).json();
  const unauth = await request.get(`${config.apiUrl}/api/collection`);
  expect(unauth.status()).toBe(401);
  await page.goto("/#collection");
  await page
    .getByLabel("Username", { exact: true })
    .fill(process.env.KEEPER_TEST_USER);
  await page
    .getByLabel("Password", { exact: true })
    .fill(process.env.KEEPER_TEST_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".auth-dialog")).toHaveCount(0);
  await expect(page.locator("#sign-out")).toBeVisible();
  const auth = await page.evaluate(
    () => JSON.parse(sessionStorage.getItem("keeper-session")).IdToken,
  );
  const headers = { Authorization: `Bearer ${auth}` };
  const verified = await request.get(`${config.apiUrl}/api/session`, {
    headers,
  });
  expect(verified.ok()).toBe(true);
  expect((await verified.json()).owner).toBeTruthy();
  const initial = await (
    await request.get(`${config.apiUrl}/api/collection`, { headers })
  ).json();
  // Only this dedicated test profile is cleared; no owner account is touched.
  for (const row of initial)
    await request.delete(`${config.apiUrl}/api/collection/${row.id}`, {
      headers,
    });
  await page
    .getByRole("button", { name: "Update collection", exact: false })
    .click();
  await page.getByRole("button", { name: "Add cards", exact: false }).click();
  await page
    .getByRole("combobox", { name: "Search cards" })
    .fill('!"Lightning Bolt" set:m11 lang:en');
  await page.getByRole("button", { name: "Search cards", exact: true }).click();
  await expect(page.locator(".card")).toHaveCount(1);
  await expect(page.locator(".card img")).toBeVisible();
  await page.locator(".card").click();
  await page.locator('[data-artwork="details"]').click();
  await page.locator("#quantity").fill("3");
  await page
    .getByRole("button", { name: "Add to collection", exact: false })
    .last()
    .click();
  await page.locator("#collection-nav").click();
  await expect(page.locator("#total")).toHaveText("3");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const prefix = document
          .querySelector('script[type="module"]')
          .src.replace(/app.js$/, "");
        const { snapshotStore, snapshotKey } = await import(
          prefix + "collection-cache.js"
        );
        const { collectionIdentity } = await import(prefix + "auth.js");
        return (
          await snapshotStore.read(snapshotKey(await collectionIdentity()))
        )?.rows?.reduce((sum, row) => sum + row.quantity, 0);
      }),
    )
    .toBe(3);
  let releaseRefresh;
  await page.route("**/api/collection", async (route) => {
    await new Promise((resolve) => (releaseRefresh = resolve));
    await route.continue();
  });
  await page.reload();
  await expect(page.locator("#total")).toHaveText("3");
  await expect(page.locator("#collection-status-text")).toContainText(
    "Showing saved snapshot from",
  );
  await expect(page.locator("#collection-status-text")).toContainText(
    "Updating",
  );
  await expect.poll(() => Boolean(releaseRefresh)).toBe(true);
  releaseRefresh();
  await expect(page.locator("#collection-status-text")).toContainText(
    "Collection is up to date",
  );
  await page.unroute("**/api/collection");
  const stored = await (
    await request.get(`${config.apiUrl}/api/collection`, { headers })
  ).json();
  expect(stored).toHaveLength(1);
  const second = await browser.newContext();
  const other = await second.newPage();
  await other.goto(process.env.LIVE_URL);
  await other
    .getByLabel("Username", { exact: true })
    .fill(process.env.KEEPER_OTHER_USER);
  await other
    .getByLabel("Password", { exact: true })
    .fill(process.env.KEEPER_OTHER_PASSWORD);
  await other.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(other.locator(".auth-dialog")).toHaveCount(0);
  await expect(other.locator("#sign-out")).toBeVisible();
  const otherToken = await other.evaluate(
    () => JSON.parse(sessionStorage.getItem("keeper-session")).IdToken,
  );
  const foreign = await request.patch(
    `${config.apiUrl}/api/collection/${stored[0].id}`,
    {
      headers: { Authorization: `Bearer ${otherToken}` },
      data: { quantity: 99 },
    },
  );
  expect(foreign.status()).toBe(404);
  await expect(other.locator("#total")).toHaveText("0");
  await second.close();
  await page.locator(".card").click();
  await page.locator('[data-artwork="details"]').click();
  await page.locator("#quantity").fill("2");
  await page.getByRole("button", { name: "Save quantity" }).click();
  await expect(page.locator("#total")).toHaveText("2");
  await page.locator(".card").click();
  await page.locator('[data-artwork="details"]').click();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Remove this entry" }).click();
  await expect(page.locator("#total")).toHaveText("0");
  await page.locator("#sign-out").click();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
});
