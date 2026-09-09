import { test, expect } from "@playwright/test";
test("LIVE-12 direct card pages show immediately, reuse details, preserve Back/search and reload exact identity without ownership writes", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120000);
  expect(process.env.KEEPER_TAGS_USER).toBe("keeper-tags");
  await page.addInitScript(() => {
    window.cardMetrics = [];
    window.addEventListener("keeper-card-metric", (e) =>
      window.cardMetrics.push(e.detail),
    );
  });
  const errors = [],
    writes = [];
  let details = 0;
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (r.url().includes("/api/discover?")) details++;
    if (r.url().includes("/api/") && !["GET", "OPTIONS"].includes(r.method()))
      writes.push(r.method());
  });
  await page.goto("/");
  await page
    .getByLabel("Username", { exact: true })
    .fill(process.env.KEEPER_TAGS_USER);
  await page
    .getByLabel("Password", { exact: true })
    .fill(process.env.KEEPER_TAGS_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".auth-dialog")).toHaveCount(0);
  const config = await (
    await request.get(process.env.LIVE_URL + "/config.json")
  ).json();
  const token = await page.evaluate(
    () => JSON.parse(sessionStorage.getItem("keeper-session")).IdToken,
  );
  async function inventory() {
    const r = await request.get(config.apiUrl + "/api/collection", {
      headers: { Authorization: "Bearer " + token },
    });
    expect(r.ok()).toBe(true);
    return r.json();
  }
  const before = await inventory();
  await expect(page.locator("#total")).toHaveText("4");
  const samples = [];
  for (const [query, name] of [
    ["relampa", "Lightning Bolt"],
    ["Piracy", "Piracy"],
    ["Fuego", "Fire // Ice"],
  ]) {
    for (const cached of [false, true]) {
      const n = details;
      await page.locator("#search").fill(query);
      const option = page
        .locator("#suggestion-panel")
        .getByRole("option")
        .filter({ hasText: name })
        .first();
      await expect(option).toBeVisible({ timeout: 30000 });
      await page.evaluate(() => (window.cardMetrics = []));
      await option.tap();
      await expect(page.locator("#card-heading")).toHaveText(name);
      await expect(page).toHaveURL(/#card=/);
      await expect(page.locator("dialog#detail")).toHaveCount(0);
      await expect(page.locator(".library")).toBeHidden();
      await expect(page.locator("#grid .card")).toHaveCount(0);
      await expect(page.locator("#inventory-form")).toBeVisible({
        timeout: 30000,
      });
      await expect(page.locator("#detail")).toHaveAttribute(
        "aria-busy",
        "false",
      );
      await expect(page.locator(".detail-ownership")).not.toContainText(
        "Checking",
      );
      expect(details - n).toBe(cached ? 0 : 1);
      samples.push({
        cached,
        metrics: await page.evaluate(() => window.cardMetrics),
      });
      if (name === "Lightning Bolt" && cached) {
        await page.screenshot({
          path: testInfo.outputPath("card-page-mobile.png"),
          fullPage: true,
        });
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.screenshot({
          path: testInfo.outputPath("card-page-desktop.png"),
          fullPage: true,
        });
        await page.setViewportSize({ width: 390, height: 844 });
      }
      await page.locator("#close").click();
      await expect(page.locator("#home-page")).toBeVisible();
    }
  }
  await page.locator("#search").fill("Piracy");
  await page.locator("#search-submit").tap();
  await expect(page.locator("#grid .card-open").first()).toHaveAccessibleName(
    /^Open Piracy printing /,
    {
      timeout: 30000,
    },
  );
  const count = await page.locator("#grid .card").count();
  await page.locator("#grid .card-open").first().tap();
  await page.getByRole("button", { name: "Card details", exact: true }).tap();
  await expect(page.locator("#inventory-form")).toBeVisible();
  await page.locator("#close").click();
  await expect(page.locator("#grid .card")).toHaveCount(count);
  await page.locator("#grid .card-open").first().tap();
  await page.getByRole("button", { name: "Card details", exact: true }).tap();
  await expect(page).toHaveURL(/#card=/);
  const url = page.url();
  await page.reload();
  await expect(page.locator("#inventory-form")).toBeVisible({ timeout: 30000 });
  await expect(page).toHaveURL(url);
  await expect(page.locator("#card-heading")).toHaveText("Piracy");
  await page.locator("#close").click();
  expect(await inventory()).toEqual(before);
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
  console.log(
    JSON.stringify({
      realCardPage: true,
      environment:
        "Actual CloudFront, desktop-host WebKit phone emulation; not physical device or controlled cellular",
      samples,
      ownershipUnchanged: true,
      writes,
      errors,
    }),
  );
  await page.locator("#home-nav").click();
  await page
    .getByRole("button", { name: "Clear activity", exact: true })
    .click();
  await page.locator("#sign-out").click();
});
