import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
test("LIVE-10 home opens real recent cards/decks/tags across reload without changing ownership", async ({
  page,
  request,
}) => {
  page.setDefaultTimeout(15000);
  expect(process.env.KEEPER_TAGS_USER).toBe("keeper-tags");
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
  async function api(path, method = "GET") {
    const result = await request.fetch(`${config.apiUrl}/api/${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(result.ok()).toBe(true);
    return result.json();
  }
  const before = await api("collection"),
    beforeTags = await api("tags");
  const label = `Home recent ${randomUUID().slice(0, 8)}`;
  let created;
  try {
    await expect(page.locator("#home-page")).toBeVisible();
    await expect(page.locator("#grid")).toBeEmpty();
    for (const id of [
      "search",
      "scan",
      "import-nav",
      "manage-tags",
      "collection-nav",
    ])
      await expect(page.locator("#" + id)).toBeInViewport();
    await page.locator("#collection-nav").tap();
    await expect(page.locator(".card")).toHaveCount(before.length);
    await page.locator(".card-open").first().tap();
    await expect(page.locator("#detail")).toBeVisible();
    await page.locator("#close").click();
    await page.locator("#home-nav").click();
    await expect(page.locator(".home-card")).toHaveCount(1);
    const deck = page.locator(".home-decks a").first();
    const deckId = await deck.getAttribute("data-tag-id");
    await deck.tap();
    await expect(page.locator("#tag-filter")).toHaveValue(deckId);
    await page.locator("#home-nav").click();
    await expect(
      page
        .getByRole("region", { name: "Recent decks" })
        .locator(`[data-tag-id="${deckId}"]`),
    ).toBeVisible();
    await page.locator("#manage-tags").click();
    await page.getByLabel("Tag name", { exact: true }).fill(label);
    await page
      .getByRole("combobox", { name: "Type", exact: true })
      .selectOption("role");
    await page.getByRole("button", { name: "Create tag", exact: true }).click();
    await expect(page.locator("#tag-message")).toContainText("Tag created");
    created = (await api("tags")).find(
      (t) => !beforeTags.some((old) => old.id === t.id),
    );
    expect(created).toBeTruthy();
    await page.locator("#tags-close").click();
    await expect(
      page.getByRole("region", { name: "Recent tags" }),
    ).toContainText(label);
    await page
      .getByRole("region", { name: "Recent tags" })
      .getByRole("link")
      .tap();
    await expect(page.locator("#tag-filter")).toHaveValue(created.id);
    await page.locator("#home-nav").click();
    await page.reload();
    await expect(page.locator(".home-card")).toHaveCount(1);
    await expect(
      page.getByRole("region", { name: "Recent decks" }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Recent tags" }),
    ).toContainText(label);
    await page.locator(".home-card").tap();
    await expect(page.locator("#detail")).toBeVisible();
    await page.locator("#close").click();
    expect(await api("collection")).toEqual(before);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    console.log(
      "Real home dashboard: verified recent card/deck/tag navigation and reload in keeper-tags; ownership unchanged. WebKit emulation, not physical iPhone.",
    );
  } finally {
    if (!created)
      created = (await api("tags")).find(
        (tag) =>
          tag.label === label && !beforeTags.some((old) => old.id === tag.id),
      );
    if (created) await api(`tags/${created.id}`, "DELETE");
    if (await page.locator("#detail").isVisible())
      await page.locator("#close").click();
    if (await page.locator("#tags-close").isVisible())
      await page.locator("#tags-close").click();
    await page.locator("#home-nav").click();
    if (await page.locator("#clear-home-history").isVisible())
      await page.locator("#clear-home-history").click();
    expect(await api("collection")).toEqual(before);
    expect((await api("tags")).map((t) => t.id).sort()).toEqual(
      beforeTags.map((t) => t.id).sort(),
    );
    await page.locator("#sign-out").click();
  }
});
