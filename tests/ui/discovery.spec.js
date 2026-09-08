import { test, expect } from "@playwright/test";
import { createNameSearch } from "../../domain/card-names.js";
import { createDiscoveryService } from "../../application/discovery.js";
test.use({ hasTouch: true });
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
const role = {
  id: "00000000-0000-4000-8000-000000000001",
  label: "Burn",
  type: "role",
  kind: "role",
};
const location = {
  id: "00000000-0000-4000-8000-000000000002",
  label: "Red deck",
  type: "location",
  kind: "deck",
};
async function fixture(page, initialRows = []) {
  let rows = structuredClone(initialRows),
    assignmentFailure = false,
    collectionFailure = false;
  const assignments = [];
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
    if (collectionFailure)
      return route.fulfill({
        status: 503,
        json: { error: "Collection unavailable" },
      });
    return route.fulfill({ json: rows });
  });
  await page.route("**/api/tags", (route) =>
    route.fulfill({ json: [role, location] }),
  );
  await page.route("**/api/tag-assignments", (route) => {
    const input = route.request().postDataJSON();
    assignments.push(input);
    if (assignmentFailure)
      return route.fulfill({
        status: 409,
        json: { error: "Tags changed. Retry saving." },
      });
    rows = rows.map((row) => {
      if (row.id !== input.inventory_id) return row;
      const allocated = input.locations.reduce((sum, a) => sum + a.quantity, 0);
      return {
        ...row,
        ...input,
        locations: input.locations.map((a) => ({ ...a, tag: location })),
        tags: input.tag_ids.includes(role.id) ? [role] : [],
        allocated_quantity: allocated,
        allocation_shortfall: Math.max(0, allocated - row.quantity),
      };
    });
    return route.fulfill({ json: rows });
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
    assignments,
    rows: () => rows,
    failAssignments: (v) => (assignmentFailure = v),
    failCollection: (v) => (collectionFailure = v),
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
  await expect(page.locator("#detail")).toBeVisible();
  await expect(page.locator(".detail-ownership")).toContainText(
    "No owned copies",
  );
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
  const beforeExpiry = f.counts().suggestRequests;
  await page.clock.install();
  await page.clock.fastForward(300001);
  await input.fill("relampa");
  await expect(page.getByRole("option")).toHaveCount(1);
  expect(f.counts().suggestRequests).toBe(beforeExpiry + 1);
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
  await page.getByRole("option").tap();
  await expect(page.locator(".card-title")).toHaveText(["Lightning Bolt"]);
  await expect(page.locator("#detail")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.locator("#close").click();
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

test("UC-27 failed selected-card resolution can retry and late selection cannot reopen detail after navigation", async ({
  page,
}) => {
  const f = await fixture(page);
  const input = page.getByRole("combobox", { name: "Search cards" });
  f.failSearch(true);
  await input.fill("Piracy");
  await page.getByRole("option").first().click();
  await expect(page.locator("#message")).toContainText("Catalog unavailable");
  await expect(page.locator("#detail")).not.toBeVisible();
  f.failSearch(false);
  await input.fill("relampa");
  await page.getByRole("option").click();
  await expect(page.locator("#detail")).toBeVisible();
  await page.locator("#close").click();
  let release;
  await page.route("**/api/discover?*", async (route) => {
    await new Promise((resolve) => (release = resolve));
    await route
      .fulfill({ json: { cards: [cards[0]], hasMore: false, total: 1 } })
      .catch(() => {});
  });
  await input.fill("Piracy");
  await page.getByRole("option").first().click();
  await expect.poll(() => !!release).toBe(true);
  await page.locator("#collection-nav").click();
  release();
  await expect(page.locator("#detail")).not.toBeVisible();
  await expect(page.locator("#title")).toContainText("My collection");
  expect(f.writes).toHaveLength(0);
});

test("UC-27 Discover detail edits each owned printing's tags with persistence, shortfalls, errors and clickable filters", async ({
  page,
}) => {
  const owned = ["es", "en"].map((lang, i) => ({
    id: `owned-${i}`,
    printing_id: `owned-${lang}`,
    card: { ...cards[3], id: `owned-${lang}`, lang },
    language: lang,
    finish: i ? "foil" : "nonfoil",
    condition: i ? "UNK" : "NM",
    quantity: 2,
    locations: [],
    tag_ids: [],
    tags: [],
    source_managed: !!i,
    provenance_list: i
      ? [
          {
            name: "Synthetic source",
            url: "https://example.com",
            section: "mainboard",
          },
        ]
      : [],
  }));
  const f = await fixture(page, owned);
  async function open() {
    await page.locator("#catalog-nav").click();
    await page.getByRole("combobox", { name: "Search cards" }).fill("relampa");
    await page.getByRole("option").click();
    await expect(page.locator("#detail")).toBeVisible();
    await expect(page.locator(".owned-printing")).toHaveCount(2);
  }
  await open();
  const spanish = () =>
    page.locator(".owned-printing").filter({ hasText: "ES · Nonfoil" });
  await spanish().getByRole("button").click();
  await page.getByLabel("Burn (Role)", { exact: true }).check();
  await page.getByRole("button", { name: "Add location", exact: true }).click();
  await page.getByLabel("Copies at location 1").fill("3");
  await expect(page.locator("#assigned-count")).toContainText("1 short");
  f.failAssignments(true);
  await page.getByRole("button", { name: "Save card tags" }).click();
  await expect(page.locator("#tag-message")).toContainText("Retry saving");
  await expect(page.getByLabel("Burn (Role)", { exact: true })).toBeChecked();
  f.failAssignments(false);
  await page.getByRole("button", { name: "Save card tags" }).click();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await page.reload();
  await open();
  await expect(spanish()).toContainText("3 assigned · 2 owned");
  await spanish().locator(`a[data-tag-id="${role.id}"]`).click();
  await expect(page.locator("#tag-filter")).toHaveValue(role.id);
  await expect(page.locator(".card")).toHaveCount(1);
  await open();
  await spanish().getByRole("button").click();
  await page.getByLabel("Burn (Role)", { exact: true }).uncheck();
  await page
    .getByRole("button", { name: "Remove location 1", exact: true })
    .click();
  await page.getByRole("button", { name: "Save card tags" }).click();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await page.reload();
  await open();
  await expect(spanish().locator("a[data-tag-id]")).toHaveCount(0);
  expect(f.assignments.every((a) => a.inventory_id === "owned-0")).toBe(true);
  expect(f.rows()[1]).toEqual(owned[1]);
  expect(f.rows().map((r) => r.quantity)).toEqual([2, 2]);
  expect(f.writes).toHaveLength(0);
});

test("UC-27 ownership refresh failure never claims unowned and retry recovers; grid and suggestions share detail", async ({
  page,
}) => {
  const f = await fixture(page);
  f.failCollection(true);
  await page.getByRole("combobox", { name: "Search cards" }).fill("Piracy");
  await page.getByRole("option").first().click();
  await expect(page.locator("#detail")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry owned printings" }),
  ).toBeVisible();
  await expect(page.locator(".detail-ownership")).not.toContainText(
    "No owned copies",
  );
  f.failCollection(false);
  await page.getByRole("button", { name: "Retry owned printings" }).click();
  await expect(page.locator(".detail-ownership")).toContainText(
    "No owned copies",
  );
  await page.locator("#close").click();
  await page.locator(".card-open").click();
  await expect(page.locator(".detail-ownership")).toContainText(
    "No owned copies",
  );
  expect(f.writes).toHaveLength(0);
});
