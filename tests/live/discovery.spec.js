import { test, expect } from "@playwright/test";
test("LIVE-07 real multilingual bulk names rank English identities and preserve explicit Spanish printing review", async ({
  page,
  request,
}) => {
  test.setTimeout(180000);
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
  const headers = { Authorization: `Bearer ${token}` };
  const measured = [];
  async function get(path) {
    const start = Date.now();
    const response = await request.get(`${config.apiUrl}/api/${path}`, {
      headers,
      timeout: 40000,
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    const body = await response.body();
    measured.push({ path, ms: Date.now() - start, bytes: body.length });
    return response.json();
  }
  const before = await get("collection");
  const first = await get("suggest?q=relampa"),
    repeat = await get("suggest?q=relampa");
  expect(first).toEqual(repeat);
  expect(first.suggestions[0].name).toBe("Lightning Bolt");
  expect(first.suggestions[0].matched_name).toBe("Relámpago");
  expect(first.suggestions.length).toBeLessThanOrEqual(8);
  expect(measured.at(-1).bytes).toBeLessThan(10000);
  expect(Date.now() - Date.parse(first.catalog.updated_at)).toBeLessThan(
    3 * 86400000,
  );
  const found = await get("discover?q=Piracy");
  expect(found.cards[0].name).toBe("Piracy");
  expect(
    found.cards.findIndex((c) => c.name === "Coastal Piracy"),
  ).toBeGreaterThan(0);
  expect(found.cards.findIndex((c) => c.name === "Conspiracy")).toBeGreaterThan(
    0,
  );
  expect(found.cards.every((c) => c.lang === "en")).toBe(true);
  expect(new Set(found.cards.map((c) => c.oracle_id)).size).toBe(
    found.cards.length,
  );
  const again = await get("discover?q=Piracy");
  expect(again).toEqual(found);
  const faces = await get("suggest?q=Fuego");
  expect(faces.suggestions.some((s) => s.name === "Fire // Ice")).toBe(true);
  await page.locator("#catalog-nav").click();
  const input = page.getByRole("combobox", { name: "Search cards" });
  await input.fill("relampa");
  await expect(page.getByRole("option").first()).toContainText(
    "Lightning Bolt",
    { timeout: 30000 },
  );
  await input.press("ArrowDown");
  await input.press("Enter");
  await expect(page.locator(".card-title")).toHaveText(["Lightning Bolt"], {
    timeout: 30000,
  });
  await expect(page.locator("#detail")).toBeVisible();
  await expect(page.locator(".detail-ownership")).toContainText(
    "No owned copies",
    { timeout: 30000 },
  );
  await expect(page.locator(".oracle")).toContainText("3 damage");
  await page
    .getByRole("button", { name: "Change printing or language" })
    .click();
  await expect(page.getByLabel("Printing language")).toBeEnabled({
    timeout: 30000,
  });
  await page.getByLabel("Printing language").selectOption("es");
  await page
    .getByRole("button", { name: "Find printings", exact: true })
    .click();
  await expect(page.locator(".printing-choice").first()).toContainText("ES", {
    timeout: 30000,
  });
  await page.locator(".printing-choice").first().click();
  await expect(page.locator("#detail .printing")).toContainText("ES");
  await expect(page.locator(".oracle")).toContainText("3 damage");
  await page.locator("#close").click();
  expect(await get("collection")).toEqual(before);
  console.log(
    JSON.stringify({
      realCatalogDiscovery: true,
      catalog: first.catalog,
      measured,
      ownedUnchanged: true,
    }),
  );
  await page.locator("#sign-out").click();
});
