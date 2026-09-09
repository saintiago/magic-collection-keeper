import { test, expect } from "./fixtures.js";
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
  ["n", "Glint-Eye Nephilim", "n-en", [["Nephilim brilleœil", "fr"]]],
  ["e", "Éowyn, Shieldmaiden", "e-en", [["Éowyn", "fr"]]],
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
const boltOwnership = () =>
  ["en", "es"].map((lang, i) => ({
    id: `bolt-owned-${i}`,
    printing_id: `bolt-${lang}`,
    card: { ...cards[3], id: `bolt-${lang}`, lang },
    quantity: i + 2,
    language: lang,
    condition: i ? "UNK" : "NM",
    finish: i ? "foil" : "nonfoil",
    locations: [],
    tag_ids: [],
    tags: [],
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
async function fixture(
  page,
  initialRows = [],
  { holdCollection = false } = {},
) {
  let collectionRequests = 0,
    releaseCollection;
  let rows = structuredClone(initialRows),
    assignmentFailure = false,
    collectionFailure = false;
  const assignments = [];
  let suggestRequests = 0,
    searchRequests = 0,
    heldSearch = false,
    releaseSearch,
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
  await page.route("**/api/collection", async (route) => {
    collectionRequests++;
    if (holdCollection)
      await new Promise((resolve) => (releaseCollection = resolve));
    if (route.request().method() === "POST")
      writes.push(route.request().postDataJSON());
    if (collectionFailure)
      return route.fulfill({
        status: 503,
        json: { error: "Collection unavailable" },
      });
    return route.fulfill({ json: rows });
  });
  await page.route("**/api/collection/*", (route) => {
    const id = decodeURIComponent(route.request().url().split("/").at(-1));
    const input = route.request().postDataJSON();
    writes.push(input);
    rows = rows.map((row) =>
      row.id === id ? { ...row, quantity: input.quantity } : row,
    );
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
    searchRequests++;
    if (heldSearch) await new Promise((resolve) => (releaseSearch = resolve));
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
  await page.goto("/#collection");
  await page.locator("#catalog-nav").click();
  return {
    counts: () => ({
      suggestRequests,
      resolves,
      searchRequests,
      collectionRequests,
    }),
    releaseCollection: () => {
      holdCollection = false;
      releaseCollection?.();
    },
    writes,
    failSuggestions: (v) => (suggestFailure = v),
    failSearch: (v) => (searchFailure = v),
    holdSearch: () => (heldSearch = true),
    releaseSearch: () => {
      heldSearch = false;
      releaseSearch?.();
    },
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
  await expect(page.locator(".card-open")).toHaveCount(3);
  for (const [index, name] of [
    "Piracy",
    "Coastal Piracy",
    "Conspiracy",
  ].entries())
    await expect(page.locator(".card-open").nth(index)).toHaveAccessibleName(
      new RegExp(`^Open ${name} printing `),
    );
  await input.fill("relampa");
  await expect(
    page.locator("#suggestion-panel").getByRole("option"),
  ).toHaveCount(1);
  await expect(
    page.locator("#suggestion-panel").getByRole("option"),
  ).toContainText("Lightning Bolt");
  await expect(
    page.locator("#suggestion-panel").getByRole("option"),
  ).toContainText("Relámpago · ES");
  await input.press("ArrowDown");
  await expect(input).toHaveAttribute(
    "aria-activedescendant",
    "card-suggestion-0",
  );
  await input.press("Enter");
  await expect(page.locator("#card-heading")).toHaveText("Lightning Bolt");
  await expect(page.locator("#grid .card")).toHaveCount(0);
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
  await expect(
    page.locator("#suggestion-panel").getByRole("option"),
  ).toHaveCount(1);
  expect(f.counts().suggestRequests).toBe(1);
  await input.press("Escape");
  await expect(page.locator("#suggestion-panel")).toBeHidden();
  await input.fill("Piracy");
  await expect(
    page.locator("#suggestion-panel").getByRole("option"),
  ).toHaveCount(3);
  await input.fill("relampa");
  await expect(
    page.locator("#suggestion-panel").getByRole("option"),
  ).toHaveCount(1);
  expect(f.counts().suggestRequests).toBe(2);
  f.hold("Fuego");
  await input.fill("Fuego");
  await expect(page.locator("#suggestion-panel")).toContainText(
    "Finding card names",
  );
  await input.fill("Piracy");
  await expect(
    page.locator("#suggestion-panel").getByRole("option"),
  ).toHaveCount(3);
  f.release();
  await expect(input).toHaveValue("Piracy");
  await expect(
    page.locator("#suggestion-panel").getByRole("option").first(),
  ).toContainText("Piracy");
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
  await expect(
    page.locator("#suggestion-panel").getByRole("option"),
  ).toHaveCount(1);
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
  await expect(
    page.locator("#suggestion-panel").getByRole("option"),
  ).toHaveCount(1);
  await page.locator("#suggestion-panel").getByRole("option").tap();
  await expect(page.locator("#card-heading")).toHaveText("Lightning Bolt");
  await expect(page.locator("#grid .card")).toHaveCount(0);
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
  await expect(page.locator(".card-open")).toHaveAccessibleName(
    /Open Fire \/\/ Ice printing .*matched Fuego · ES/,
  );
  await page.locator("#collection-nav").click();
  await expect(page.locator("#suggestion-panel")).toBeHidden();
  await expect(page.locator("#search")).toHaveAttribute("role", "combobox");
  expect(f.writes).toHaveLength(0);
});

test("UC-27 failed selected-card resolution can retry and late selection cannot reopen detail after navigation", async ({
  page,
}) => {
  const f = await fixture(page);
  const input = page.getByRole("combobox", { name: "Search cards" });
  f.failSearch(true);
  await input.fill("Piracy");
  await page.locator("#suggestion-panel").getByRole("option").first().click();
  await expect(page.locator("#card-status")).toContainText(
    "Catalog unavailable",
  );
  await expect(page.locator("#inventory-form")).toHaveCount(0);
  f.failSearch(false);
  await page.getByRole("button", { name: "Retry opening card" }).click();
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
  await page.locator("#suggestion-panel").getByRole("option").first().click();
  await expect.poll(() => !!release).toBe(true);
  await page.locator("#collection-nav").click();
  release();
  await expect(page.locator("#detail")).not.toBeVisible();
  await expect(page.locator("#title")).toContainText("My collection");
  expect(f.writes).toHaveLength(0);
});

test("UC-28 native touch selection survives keyboard blur, shows slow opening, and commits once without compatibility click", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("combobox", { name: "Search cards" }).fill("relampa");
  await expect(
    page.locator("#suggestion-panel").getByRole("option"),
  ).toHaveCount(1);
  f.holdSearch();
  // Inject only the keyboard-blur ordering; the tap itself uses native browser input.
  await page.evaluate(() =>
    document.addEventListener(
      "touchstart",
      (event) => {
        if (event.target.closest("[data-suggestion]"))
          document.getElementById("search").blur();
      },
      { once: true },
    ),
  );
  await page.locator("#suggestion-panel").getByRole("option").tap();
  await expect(page.locator("#card-status")).toHaveText(
    "Opening Lightning Bolt…",
  );
  await expect(page.locator("#card-status")).toBeInViewport();
  await expect(page.locator("#suggestion-panel")).toBeHidden();
  await expect(page.locator("#detail")).toBeVisible();
  await expect(page.locator("#inventory-form")).toHaveCount(0);
  await expect.poll(() => f.counts().searchRequests).toBe(1);
  f.releaseSearch();
  await expect(page.locator("#detail")).toBeVisible();
  expect(f.counts().searchRequests).toBe(1);
  expect(f.writes).toHaveLength(0);
});

test("UC-28 scrolling and canceled touches never select; a later stationary tap still opens", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.getByRole("combobox", { name: "Search cards" }).fill("Piracy");
  await expect(
    page.locator("#suggestion-panel").getByRole("option"),
  ).toHaveCount(3);
  // Explicit lifecycle fixtures complement native Chromium/WebKit tap tests.
  for (const kind of ["move", "scroll", "cancel", "multi"]) {
    await page.evaluate((kind) => {
      const option = document.querySelector('[data-suggestion="0"]');
      const point = (x) => ({
        identifier: 1,
        target: option,
        clientX: x,
        clientY: 100,
      });
      const send = (type, x, touches = [point(x)]) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperties(event, {
          touches: { value: touches },
          changedTouches: { value: [point(x)] },
        });
        option.dispatchEvent(event);
      };
      send("touchstart", 100);
      if (kind === "move") send("touchmove", 125);
      if (kind === "scroll")
        document
          .getElementById("card-suggestions")
          .dispatchEvent(new Event("scroll"));
      if (kind === "cancel") send("touchcancel", 100, []);
      if (kind === "multi")
        send("touchstart", 100, [
          point(100),
          {
            identifier: 2,
            target: option,
            clientX: 110,
            clientY: 100,
          },
        ]);
      send("touchend", kind === "move" ? 125 : 100, []);
    }, kind);
    expect(f.counts().searchRequests).toBe(0);
    await expect(page.locator("#detail")).not.toBeVisible();
  }
  await page.locator("#suggestion-panel").getByRole("option").first().tap();
  await expect(page.locator("#detail")).toBeVisible();
  expect(f.counts().searchRequests).toBe(1);
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
    await page.locator("#collection-nav").click();
    await page.locator("#catalog-nav").click();
    await page.getByRole("combobox", { name: "Search cards" }).fill("relampa");
    await page.locator("#suggestion-panel").getByRole("option").click();
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
  await page.locator("#suggestion-panel").getByRole("option").first().click();
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
  await page.locator("#search-submit").click();
  await page.locator(".card-open").first().click();
  await expect(page.locator(".detail-ownership")).toContainText(
    "No owned copies",
  );
  expect(f.writes).toHaveLength(0);
});

test("UC-29 one shared search marks ownership across languages without extra inventory reads and stays coherent after quantity edits", async ({
  page,
}) => {
  const f = await fixture(page, boltOwnership());
  await page.locator("#collection-nav").click();
  const input = page.getByRole("combobox", { name: "Search cards" });
  await expect(page.locator("#search")).toHaveCount(1);
  await input.fill("relampa");
  await expect(
    page.locator("#suggestion-panel").getByRole("option"),
  ).toHaveAccessibleName(/Owned/);
  const reads = f.counts().collectionRequests;
  await input.fill("Piracy");
  await expect(
    page.locator("#suggestion-panel").getByRole("option"),
  ).toHaveCount(3);
  await expect(
    page.locator("#suggestion-panel").getByRole("option").first(),
  ).toHaveAccessibleName(/Not owned/);
  await page.locator("#catalog-nav").click();
  await expect(input).toHaveValue("Piracy");
  await page.locator("#collection-nav").click();
  await expect(input).toHaveValue("Piracy");
  await expect(page.locator(".card")).toHaveCount(2);
  expect(f.counts().collectionRequests).toBe(reads);
  await input.fill("relampa");
  await expect(
    page.locator("#suggestion-panel").getByRole("option"),
  ).toHaveAccessibleName(/Owned/);
  await page.locator("#suggestion-panel").getByRole("option").tap();
  await expect(page.locator("#detail")).toBeVisible();
  await expect(page.locator(".owned-printing")).toHaveCount(2);
  await page.locator("#close").click();
  await page.locator("#collection-nav").click();
  await page.locator(".card-open").first().click();
  await page.getByLabel("Quantity", { exact: true }).fill("4");
  await page
    .getByRole("button", { name: "Save quantity", exact: true })
    .click();
  await expect(page.locator("#detail")).not.toBeVisible();
  await input.fill("relampa");
  await expect(
    page.locator("#suggestion-panel").getByRole("option"),
  ).toHaveAccessibleName(/Owned/);
  await input.fill("Piracy");
  await input.press("Escape");
  await page.locator("#search-submit").click();
  await expect(page.locator(".card-open")).toHaveCount(3);
  for (const [index, name] of [
    "Piracy",
    "Coastal Piracy",
    "Conspiracy",
  ].entries())
    await expect(page.locator(".card-open").nth(index)).toHaveAccessibleName(
      new RegExp(`^Open ${name} printing `),
    );
});

test("UC-29 unknown ownership stays honest, retry updates visible suggestions in place, and saved failures remain labeled", async ({
  page,
}) => {
  const f = await fixture(page, boltOwnership(), { holdCollection: true });
  const input = page.getByRole("combobox", { name: "Search cards" });
  await input.fill("relampa");
  await expect(
    page.locator("#suggestion-panel").getByRole("option"),
  ).toHaveAccessibleName(/Checking ownership/);
  f.failCollection(true);
  f.releaseCollection();
  await expect(
    page.locator("#suggestion-panel").getByRole("option"),
  ).toHaveAccessibleName(/Ownership unavailable/);
  await expect(
    page.locator("#suggestion-panel").getByRole("option"),
  ).not.toHaveAccessibleName(/Not owned/);
  f.failCollection(false);
  await page.locator("#collection-nav").click();
  await page.locator("#refresh").click();
  await expect(page.locator("#total")).toHaveText("5");
  await input.fill("relampa");
  await expect(
    page.locator("#suggestion-panel").getByRole("option"),
  ).toHaveAccessibleName(/Owned/);
  f.failCollection(true);
  await page.locator("#refresh").click();
  await expect(page.locator("#collection-status-text")).toContainText(
    "Update failed",
  );
  await input.fill("relampa");
  await expect(
    page.locator("#suggestion-panel").getByRole("option"),
  ).toHaveAccessibleName(/Saved: owned · update failed/);
  await expect(
    page.locator("#suggestion-panel .suggestion-ownership"),
  ).toHaveText("◷");
  await expect(page.locator("#suggestion-panel .is-owned")).toHaveCount(0);
});

test("UC-30 empty focus shows recent committed cards and queries, supports touch/keyboard, dedupes, persists and clears", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await fixture(page, boltOwnership());
  const input = page.getByRole("combobox", { name: "Search cards" });
  const options = () => page.locator("#suggestion-panel").getByRole("option");
  await input.fill("");
  await expect(page.locator("#suggestion-panel")).toContainText(
    "No recent searches yet",
  );
  await input.fill("uncommitted");
  await input.fill("");
  await expect(options()).toHaveCount(0);
  await input.fill("relampa");
  await expect(options()).toHaveCount(1);
  await options().tap();
  await expect(page.locator("#detail")).toBeVisible();
  await page.locator("#close").click();
  await input.fill("");
  await expect(
    page.getByRole("listbox", { name: "Recent searches" }),
  ).toBeVisible();
  await expect(options()).toContainText("Lightning Bolt");
  await expect(options()).toHaveAccessibleName(/Owned/);
  await input.press("ArrowDown");
  await input.press("Enter");
  await expect(page.locator("#detail")).toBeVisible();
  await page.locator("#close").click();
  await input.fill("Piracy");
  await page.locator("#search-submit").click();
  await expect(page.locator(".card-open")).toHaveCount(3);
  await input.fill("");
  await expect(options()).toHaveCount(2);
  await expect(options().first()).toContainText("Piracy");
  await expect(options().first()).toContainText("Run this search again");
  const lookups = f.counts().suggestRequests;
  await page.reload();
  await input.click();
  await expect(options()).toHaveCount(2);
  expect(f.counts().suggestRequests).toBe(lookups);
  await options().first().tap();
  await expect(page.locator(".card-open")).toHaveCount(3);
  await expect(page.locator("#detail")).not.toBeVisible();
  await input.fill("");
  await expect(options()).toHaveCount(2);
  await page
    .getByRole("button", { name: "Clear recent searches", exact: true })
    .tap();
  await input.click();
  await expect(page.locator("#suggestion-panel")).toContainText(
    "No recent searches yet",
  );
  await page.reload();
  await input.click();
  await expect(options()).toHaveCount(0);
  expect(f.writes).toHaveLength(0);
});

test("UC-30 result choices enter history and committed queries stay bounded in recency order", async ({
  page,
}) => {
  const f = await fixture(page);
  const input = page.getByRole("combobox", { name: "Search cards" });
  const options = () =>
    page.getByRole("listbox", { name: "Recent searches" }).getByRole("option");
  await input.fill("Piracy");
  await page.locator("#search-submit").click();
  await page.locator(".card-open").first().click();
  await expect(page.locator("#detail h2")).toHaveText("Piracy");
  await page.locator("#close").click();
  await input.fill("");
  await expect(options()).toHaveCount(2);
  await expect(options().first()).toHaveAccessibleName(/Not owned/);
  await expect(options().nth(1)).toContainText("Run this search again");
  for (let i = 0; i < 12; i++) {
    await input.fill(`Missing ${i}`);
    await page.locator("#search-submit").click();
    await expect(page.locator("#message")).toContainText("0 matching cards");
  }
  await input.fill("Missing 5");
  await page.locator("#search-submit").click();
  await expect(page.locator("#message")).toContainText("0 matching cards");
  await input.fill("");
  await expect(options()).toHaveCount(10);
  await expect(options().first()).toContainText("Missing 5");
  await expect(options().nth(1)).toContainText("Missing 11");
  await expect(options().last()).toContainText("Missing 2");
  await page.reload();
  await input.click();
  await expect(options()).toHaveCount(10);
  await expect(options().first()).toContainText("Missing 5");
  expect(f.writes).toHaveLength(0);
});

test("UC-30 storage failure keeps recent selection usable for the visit and reports failed clearing", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new Error("Storage disabled");
    };
    Storage.prototype.removeItem = () => {
      throw new Error("Storage disabled");
    };
  });
  await fixture(page);
  const input = page.getByRole("combobox", { name: "Search cards" });
  await input.fill("relampa");
  await page.locator("#suggestion-panel").getByRole("option").tap();
  await expect(page.locator("#detail")).toBeVisible();
  await page.locator("#close").click();
  await input.fill("");
  await expect(
    page.getByRole("listbox", { name: "Recent searches" }),
  ).toContainText("Lightning Bolt");
  await expect(page.locator("#recent-search-message")).toContainText(
    "this visit only",
  );
  await page
    .getByRole("button", { name: "Clear recent searches", exact: true })
    .click();
  await expect(page.locator("#recent-search-message")).toContainText(
    "Could not clear",
  );
  await page.reload();
  await input.click();
  await expect(page.locator("#suggestion-panel")).toContainText(
    "No recent searches yet",
  );
});

test("UC-31 inline accessible ownership and relevant-only translations stay compact and touch-selectable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await fixture(page, [
    ...boltOwnership(),
    {
      ...boltOwnership()[0],
      id: "owned-nephilim",
      printing_id: "n-en",
      card: cards[5],
      quantity: 9,
    },
  ]);
  const input = page.getByRole("combobox", { name: "Search cards" });
  const options = () => page.locator("#suggestion-panel").getByRole("option");
  for (const query of ["nephilim", "NÉPHILIM"]) {
    await input.fill(query);
    await expect(options()).toHaveCount(1);
    await expect(
      options().getByRole("img", { name: "Owned", exact: true }),
    ).toHaveText("✓");
    await expect(options().locator(".suggestion-alias")).toHaveCount(0);
    await expect(options()).not.toContainText(/owned|9/);
    const name = await options().locator("b").boundingBox();
    const icon = await options().locator(".suggestion-ownership").boundingBox();
    expect(icon.x).toBeGreaterThan(name.x + name.width);
    expect(icon.y).toBeLessThan(name.y + name.height);
  }
  await input.fill("brilleœil");
  await expect(options().locator(".suggestion-alias")).toHaveText(
    "Nephilim brilleœil · FR",
  );
  await options().tap();
  await expect(page.locator("#detail h2")).toHaveText("Glint-Eye Nephilim");
  await page.locator("#close").click();
  await input.fill("");
  await expect(
    page.getByRole("listbox", { name: "Recent searches" }),
  ).toBeVisible();
  await expect(options().locator(".suggestion-alias")).toHaveCount(0);
  await expect(
    options().getByRole("img", { name: "Owned", exact: true }),
  ).toBeVisible();
  await input.fill("relampa");
  await expect(options().locator(".suggestion-alias")).toHaveText(
    "Relámpago · ES",
  );
  await options().tap();
  await expect(page.locator("#detail h2")).toHaveText("Lightning Bolt");
  await page.locator("#close").click();
  for (const query of ["eowyn", "ÉOWYN", "Ice"]) {
    await input.fill(query);
    await expect(options()).toHaveCount(1);
    await expect(options().locator(".suggestion-alias")).toHaveCount(0);
  }
  await input.fill("Fuego");
  await expect(options().locator(".suggestion-alias")).toHaveText("Fuego · ES");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(f.writes).toHaveLength(0);
});
