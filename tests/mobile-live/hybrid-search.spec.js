import { test, expect } from "@playwright/test";
test("LIVE-11 public worker index, multilingual local search, cached reload and detail reuse preserve private inventory", async ({
  page,
  request,
}) => {
  test.setTimeout(120000);
  expect(process.env.KEEPER_TAGS_USER).toBe("keeper-tags");
  await page.addInitScript(() => {
    window.searchMetrics = [];
    window.addEventListener("keeper-search-metric", (e) =>
      window.searchMetrics.push(e.detail),
    );
  });
  const calls = { names: 0, manifests: 0, downloads: 0, details: 0 };
  page.on("request", (r) => {
    if (r.url().includes("/api/suggest?")) calls.names++;
    if (r.url().endsWith("/catalog/current.json")) calls.manifests++;
    if (r.url().endsWith(".names.gz")) calls.downloads++;
    if (r.url().includes("/api/discover?")) calls.details++;
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
    await request.get(`${process.env.LIVE_URL}/config.json`)
  ).json();
  const token = await page.evaluate(
    () => JSON.parse(sessionStorage.getItem("keeper-session")).IdToken,
  );
  async function inventory() {
    const r = await request.get(`${config.apiUrl}/api/collection`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(r.ok()).toBe(true);
    return r.json();
  }
  const before = await inventory();
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          window.searchMetrics.some((m) => m.phase === "refresh"),
        ),
      { timeout: 60000 },
    )
    .toBe(true);
  const coldMetrics = await page.evaluate(() => window.searchMetrics),
    counts = { ...calls };
  const input = page.locator("#search"),
    options = () => page.locator("#suggestion-panel").getByRole("option");
  for (const [q, name] of [
    ["Piracy", "Piracy"],
    ["relampa", "Lightning Bolt"],
    ["Fuego", "Fire // Ice"],
    ["NÉPHILIM", "Glint-Eye Nephilim"],
    ["稲妻", "Lightning Bolt"],
  ]) {
    await input.fill(q);
    await expect(options().filter({ hasText: name }).first()).toBeVisible();
  }
  await input.fill("relampa");
  await expect(options().first()).toContainText("Lightning Bolt");
  await expect(options().first()).toHaveAccessibleName(/Owned/);
  await options().first().tap();
  await expect(page.locator("#detail h2")).toHaveText("Lightning Bolt", {
    timeout: 30000,
  });
  await expect(page.locator("#inventory-form")).toBeVisible({ timeout: 30000 });
  await page.locator("#close").click();
  const opened = calls.details;
  await input.fill("Lightning Bolt");
  await expect(options().first()).toContainText("Lightning Bolt");
  await options().first().tap();
  await expect(page.locator("#detail")).toBeVisible();
  expect(calls.details).toBe(opened);
  await expect(page.locator("#inventory-form")).toBeVisible({ timeout: 30000 });
  await page.locator("#close").click();
  expect(calls.names).toBe(counts.names);
  const warmMetrics = await page.evaluate(() => window.searchMetrics);
  await page.reload();
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          window.searchMetrics.some((m) => m.phase === "restore"),
        ),
      { timeout: 30000 },
    )
    .toBe(true);
  await input.fill("Fuego");
  await expect(options().first()).toContainText("Fire // Ice");
  expect(calls.downloads).toBe(counts.downloads);
  expect(calls.manifests).toBe(counts.manifests);
  expect(calls.names).toBe(counts.names);
  expect(await inventory()).toEqual(before);
  const restoreMetrics = await page.evaluate(() => window.searchMetrics);
  console.log(
    JSON.stringify({
      realHybridSearch: true,
      device: "iPhone 13 WebKit emulation on CI host; not physical phone",
      calls,
      coldMetrics,
      warmMetrics,
      restoreMetrics,
      ownershipUnchanged: true,
    }),
  );
  await input.fill("");
  await page
    .getByRole("button", { name: "Clear recent searches", exact: true })
    .click();
  await page.locator("#home-nav").click();
  if (await page.locator("#clear-home-history").isVisible())
    await page.locator("#clear-home-history").click();
  await page.locator("#sign-out").click();
});
