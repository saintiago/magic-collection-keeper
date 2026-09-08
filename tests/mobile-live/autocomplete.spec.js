import { test, expect } from "@playwright/test";

test("LIVE-09 real WebKit touch opens English and translated suggestions exactly once, including delayed resolution", async ({
  page,
  request,
}) => {
  expect(process.env.KEEPER_TEST_USER).toBe("keeper-e2e");
  await page.goto("/");
  await page
    .getByLabel("Username", { exact: true })
    .fill(process.env.KEEPER_TEST_USER);
  await page
    .getByLabel("Password", { exact: true })
    .fill(process.env.KEEPER_TEST_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".auth-dialog")).toHaveCount(0);
  const config = await (
    await request.get(`${process.env.LIVE_URL}/config.json`)
  ).json();
  const token = await page.evaluate(
    () => JSON.parse(sessionStorage.getItem("keeper-session")).IdToken,
  );
  async function collection() {
    const response = await request.get(`${config.apiUrl}/api/collection`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.ok()).toBe(true);
    return response.json();
  }
  const before = await collection();
  let resolutions = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/discover?")) resolutions++;
  });
  // Delay a real upstream response, preserving its body/status, to test visible progress.
  await page.route("**/api/discover?*", async (route) => {
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await route.fulfill({ response });
  });
  for (const [query, name] of [
    ["relampa", "Lightning Bolt"],
    ["Piracy", "Piracy"],
    ["Fuego", "Fire // Ice"],
  ]) {
    await page
      .locator(query === "Piracy" ? "#catalog-nav" : "#collection-nav")
      .click();
    await page.getByRole("combobox", { name: "Search cards" }).fill(query);
    const option = page
      .locator("#suggestion-panel")
      .getByRole("option")
      .filter({ hasText: name })
      .first();
    await expect(option).toBeVisible({ timeout: 30000 });
    await expect(option).toContainText("Not owned");
    const count = resolutions;
    await option.tap();
    await expect(page.locator("#message")).toHaveText(`Opening ${name}…`);
    await expect(page.locator("#message")).toBeInViewport();
    await expect(page.locator("#detail")).toBeVisible({ timeout: 30000 });
    await expect(page.locator("#detail h2")).toHaveText(name);
    await expect(page.locator(".detail-ownership")).toContainText(
      "No owned copies",
      { timeout: 30000 },
    );
    expect(resolutions).toBe(count + 1);
    await page.locator("#close").click();
  }
  const input = page.getByRole("combobox", { name: "Search cards" });
  const options = () =>
    page.getByRole("listbox", { name: "Recent searches" }).getByRole("option");
  await input.fill("");
  await expect(options()).toHaveCount(3);
  await expect(options().first()).toContainText("Fire // Ice");
  await page.reload();
  await input.click();
  await expect(options()).toHaveCount(3);
  const beforeRecent = resolutions;
  await options().filter({ hasText: "Lightning Bolt" }).tap();
  await expect(page.locator("#detail h2")).toHaveText("Lightning Bolt", {
    timeout: 30000,
  });
  expect(resolutions).toBe(beforeRecent + 1);
  await page.locator("#close").click();
  await input.fill("Piracy");
  await page.locator("#search-submit").tap();
  await expect(page.locator(".card-title").first()).toHaveText("Piracy", {
    timeout: 30000,
  });
  await input.fill("");
  await expect(options()).toHaveCount(4);
  await expect(options().first()).toContainText("Run this search again");
  await options().first().tap();
  await expect(page.locator(".card-title").first()).toHaveText("Piracy", {
    timeout: 30000,
  });
  await expect(page.locator("#detail")).not.toBeVisible();
  await input.fill("");
  await expect(options()).toHaveCount(4);
  await page
    .getByRole("button", { name: "Clear recent searches", exact: true })
    .tap();
  await page.reload();
  await input.click();
  await expect(page.locator("#suggestion-panel")).toContainText(
    "No recent searches yet",
  );
  expect(await collection()).toEqual(before);
  console.log(
    "Real deployed WebKit touch: relampa, Piracy, Fuego; one resolution per tap; delayed upstream response; recent card/query selection, reload persistence and clearing; ownership unchanged. Physical iPhone not verified.",
  );
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.locator("#sign-out").click();
});
