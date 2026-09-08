import { test, expect } from "@playwright/test";
import { createNameSearch } from "../../domain/card-names.js";
import { createDiscoveryService } from "../../application/discovery.js";
const data = [
  ["p", "Piracy", "p-en", []],
  ["c", "Coastal Piracy", "c-en", []],
  ["s", "Conspiracy", "s-en", []],
  ["b", "Lightning Bolt", "b-en", [["Relámpago", "es"]]],
  [
    "f",
    "Fire // Ice",
    "f-en",
    [
      ["Fuego", "es"],
      ["Ice", "en"],
    ],
  ],
];
const cards = data.map(([oracle_id, name, id]) => ({
  oracle_id,
  name,
  id,
  lang: "en",
  games: ["paper"],
  set: "m11",
  set_name: "Magic 2011",
  collector_number: "149",
  finishes: ["nonfoil", "foil"],
  type_line: "Instant",
  color_identity: [],
  oracle_text: "English rules text.",
  rarity: "common",
}));
async function fixture(page) {
  let suggestRequests = 0,
    resolves = 0,
    suggestFailure = false,
    searchFailure = false,
    hold = null,
    release = null,
    writes = [];
  const service = createDiscoveryService({
    names: {
      get: async () => ({
        search: createNameSearch(data),
        metadata: { version: "test-v1", updated_at: new Date().toISOString() },
      }),
    },
    catalog: {
      resolve: async (ids) => {
        resolves++;
        return cards.filter((c) => ids.includes(c.id));
      },
    },
  });
  await page.route("**/api/collection", (route) => {
    if (route.request().method() === "POST")
      writes.push(route.request().postDataJSON());
    return route.fulfill({ json: [] });
  });
  await page.route("**/api/suggest?*", async (route) => {
    suggestRequests++;
    const q = new URL(route.request().url()).searchParams.get("q");
    if (q === hold) await new Promise((resolve) => (release = resolve));
    if (suggestFailure)
      return route.fulfill({ status: 503, json: { error: "Unavailable" } });
    return route.fulfill({ json: await service.suggest(q) });
  });
  await page.route("**/api/discover?*", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (searchFailure)
      return route.fulfill({
        status: 503,
        json: { error: "Catalog unavailable. Retry." },
      });
    return route.fulfill({
      json: await service.discover(
        params.get("q"),
        Number(params.get("page")),
        params.get("oracle") || "",
      ),
    });
  });
  await page.route("**/api/search?*", async (route) => {
    const q = new URL(route.request().url()).searchParams.get("q");
    return route.fulfill({
      json: {
        cards: [
          {
            ...cards[3],
            ...(q.includes("lang:es")
              ? { id: "b-es", lang: "es", printed_name: "Relámpago" }
              : {}),
          },
        ],
        total: 1,
        hasMore: false,
      },
    });
  });
  await page.goto("/");
  await page.locator("#catalog-nav").click();
  return {
    counts: () => ({ suggestRequests, resolves }),
    writes,
    failSuggestions: (v) => (suggestFailure = v),
    failSearch: (v) => (searchFailure = v),
    hold: (q) => (hold = q),
    release: () => release?.(),
  };
}
test("UC-24/26 exact ranking, Spanish autocomplete keyboard selection and explicit physical printing language remain separate", async ({
  page,
}) => {
  const f = await fixture(page),
    input = page.getByRole("combobox", { name: "Search cards" });
  await input.fill("Piracy");
  await page.locator("#search-submit").click();
  await expect(page.locator(".card-title")).toHaveText([
    "Piracy",
    "Coastal Piracy",
    "Conspiracy",
  ]);
  await input.fill("relampa");
  await expect(page.getByRole("option")).toHaveCount(1);
  await expect(page.getByRole("option")).toContainText("Lightning Bolt");
  await expect(page.getByRole("option")).toContainText("Relámpago · ES");
  await input.press("ArrowDown");
  await expect(input).toHaveAttribute(
    "aria-activedescendant",
    "card-suggestion-0",
  );
  await input.press("Enter");
  await expect(page.locator(".card-title")).toHaveText(["Lightning Bolt"]);
  await expect(input).toHaveValue("Lightning Bolt");
  await page.locator(".card-open").click();
  await expect(page.locator(".oracle")).toContainText("English rules text");
  await page
    .getByRole("button", { name: "Change printing or language" })
    .click();
  await page.getByLabel("Printing language").selectOption("es");
  await page
    .getByRole("button", { name: "Find printings", exact: true })
    .click();
  await expect(page.locator(".printing-choice")).toContainText("ES");
  await page.locator(".printing-choice").click();
  await expect(page.locator("#detail .printing")).toContainText("ES");
  await expect(page.locator(".oracle")).toContainText("English rules text");
  expect(f.writes).toHaveLength(0);
  await page.locator("#inventory-form button[type=submit]").click();
  expect(f.writes[0].printing_id).toBe("b-es");
});
test("UC-25 debounce, repeat cache, Escape and stale suggestions cannot overwrite later input", async ({
  page,
}) => {
  const f = await fixture(page),
    input = page.getByRole("combobox", { name: "Search cards" });
  await input.pressSequentially("relampa", { delay: 15 });
  await expect(page.getByRole("option")).toHaveCount(1);
  expect(f.counts().suggestRequests).toBe(1);
  await input.press("Escape");
  await expect(page.locator("#suggestion-panel")).toBeHidden();
  await input.fill("Piracy");
  await expect(page.getByRole("option")).toHaveCount(3);
  await input.fill("relampa");
  await expect(page.getByRole("option")).toHaveCount(1);
  expect(f.counts().suggestRequests).toBe(2);
  f.hold("Fuego");
  await input.fill("Fuego");
  await expect(page.locator("#suggestion-panel")).toContainText(
    "Finding card names",
  );
  await input.fill("Piracy");
  await expect(page.getByRole("option")).toHaveCount(3);
  f.release();
  await expect(input).toHaveValue("Piracy");
  await expect(page.getByRole("option").first()).toContainText("Piracy");
  await input.press("ArrowDown");
  await input.press("ArrowUp");
  await expect(input).toHaveAttribute(
    "aria-activedescendant",
    "card-suggestion-2",
  );
  await input.press("Tab");
  await expect(page.locator("#suggestion-panel")).toBeHidden();
});
test("UC-26 mobile touch choice, no matches, suggestion/search failures and retry stay usable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await fixture(page),
    input = page.getByRole("combobox", { name: "Search cards" });
  f.failSuggestions(true);
  await input.fill("relamp");
  await expect(page.locator("#suggestion-panel")).toContainText(
    "Suggestions unavailable",
  );
  f.failSuggestions(false);
  await input.fill("relampa");
  await expect(page.getByRole("option")).toHaveCount(1);
  await page.getByRole("option").click();
  await expect(page.locator(".card-title")).toHaveText(["Lightning Bolt"]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await input.fill("qzxqzxqzx");
  await expect(page.locator("#suggestion-panel")).toContainText(
    "No matching names",
  );
  f.failSearch(true);
  await page.locator("#search-submit").click();
  await expect(page.locator("#message")).toContainText("Catalog unavailable");
  f.failSearch(false);
  await input.fill("Fuego");
  await page.locator("#search-submit").click();
  await expect(page.locator(".card-title")).toHaveText(["Fire // Ice"]);
  await expect(page.locator(".matched-name")).toContainText("Fuego · ES");
  await page.locator("#collection-nav").click();
  await expect(page.locator("#suggestion-panel")).toBeHidden();
  await expect(page.locator("#search")).not.toHaveAttribute("role", "combobox");
  expect(f.writes).toHaveLength(0);
});
