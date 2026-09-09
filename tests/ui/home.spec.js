import { test, expect } from "./fixtures.js";
test.use({ hasTouch: true });
const cards = [
  ["bolt", "Lightning Bolt"],
  ["ring", "Sol Ring"],
].map(([id, name]) => ({
  id,
  oracle_id: id,
  name,
  set: "tst",
  set_name: "Test",
  collector_number: "1",
  lang: "en",
  finishes: ["nonfoil"],
  color_identity: [],
  oracle_text: "Test rules",
  type_line: "Artifact",
}));
const tags = [
  ...Array.from({ length: 6 }, (_, i) => ({
    id: `deck-${i}`,
    label: `Deck ${i}`,
    type: "location",
    kind: "deck",
  })),
  { id: "role", label: "Deck role", type: "role", kind: "role" },
];
const rows = cards.map((card, i) => ({
  id: `row-${i}`,
  card,
  printing_id: card.id,
  quantity: 2,
  language: "en",
  finish: "nonfoil",
  condition: "NM",
  locations: [{ tag_id: "deck-0", quantity: 2, tag: tags[0] }],
  tags: [tags.at(-1)],
  tag_ids: ["role"],
}));
async function fixture(page, { cloud = false } = {}) {
  let owner = "one",
    fail = false,
    tagFail = false;
  const writes = [];
  await page.route("**/api/collection", (r) => {
    if (r.request().method() !== "GET") writes.push(r.request().method());
    return r.fulfill(
      fail
        ? { status: 503, json: { error: "Offline" } }
        : { json: owner === "one" ? rows : [] },
    );
  });
  await page.route("**/api/tags", (r) =>
    r.fulfill(
      tagFail
        ? { status: 503, json: { error: "Tags offline" } }
        : { json: owner === "one" ? tags : [] },
    ),
  );
  await page.route("**/api/discover?*", (r) =>
    r.fulfill({ json: { cards: [cards[0]], total: 1, hasMore: false } }),
  );
  await page.route("**/api/suggest?*", (r) =>
    r.fulfill({
      json: {
        suggestions: [
          { name: cards[0].name, oracle_id: "bolt", printing_id: "bolt" },
        ],
      },
    }),
  );
  if (cloud) {
    await page.route("**/config.json", (r) =>
      r.fulfill({
        json: { region: "us-east-1", clientId: "test", apiUrl: "" },
      }),
    );
    await page.route("**/api/session", (r) => r.fulfill({ json: { owner } }));
    await page.addInitScript(() => {
      if (!sessionStorage.getItem("initialized")) {
        sessionStorage.setItem("initialized", "1");
        sessionStorage.setItem(
          "keeper-session",
          JSON.stringify({
            IdToken: "test-one",
            expires: Date.now() + 3600000,
          }),
        );
      }
    });
  }
  await page.goto("/");
  return {
    writes,
    owner: (value) => (owner = value),
    fail: (value) => (fail = value),
    tagFail: (value) => (tagFail = value),
  };
}
test("UC-32 default mobile home prioritizes search/actions and real deck/tag shortcuts without the full grid", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 700 });
  const f = await fixture(page);
  await expect(
    page.getByRole("heading", { name: "Home", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#grid")).toBeEmpty();
  await expect(page.locator("#stats")).not.toBeVisible();
  await expect(page.locator(".brand")).toHaveText("✦");
  for (const id of [
    "search",
    "scan",
    "import-nav",
    "manage-tags",
    "collection-nav",
  ])
    await expect(page.locator("#" + id)).toBeInViewport();
  await expect(
    page.getByRole("region", { name: "Your decks" }).getByRole("link"),
  ).toHaveCount(4);
  await expect(page.getByRole("region", { name: "Your tags" })).toContainText(
    "Deck role",
  );
  await expect(page.locator("#home-page")).toContainText(
    "Cards you open will appear here",
  );
  await page.locator("#collection-nav").tap();
  await expect(page).toHaveURL(/#collection$/);
  await expect(page.locator(".card")).toHaveCount(2);
  await page.goBack();
  await expect(page.locator("#home-page")).toBeVisible();
  await expect(page.locator("#grid")).toBeEmpty();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(f.writes).toHaveLength(0);
});
test("UC-32 actual card opens and tag visits order recent activity, persist and navigate by stable IDs", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.locator("#collection-nav").click();
  for (const name of ["Lightning Bolt", "Sol Ring", "Lightning Bolt"]) {
    await page.getByRole("button", { name: `Open ${name} printing` }).click();
    await page.locator('[data-artwork="details"]').click();
    await page.locator("#close").click();
  }
  await page.locator("#home-nav").click();
  await expect(page.locator(".home-card")).toHaveCount(2);
  await expect(
    page.locator(".home-card").first().locator("button"),
  ).toHaveAccessibleName(/^Open Lightning Bolt artwork/);
  await page
    .getByRole("region", { name: "Your decks" })
    .locator('[data-tag-id="deck-0"]')
    .click();
  await expect(page).toHaveURL(/#tag=deck-0$/);
  await expect(page.locator(".card")).toHaveCount(2);
  await page.locator("#home-nav").click();
  await expect(
    page.getByRole("region", { name: "Recent decks" }),
  ).toContainText("Deck 0");
  await page
    .getByRole("region", { name: "Your tags" })
    .getByRole("link")
    .click();
  await page.locator("#home-nav").click();
  await page.reload();
  await expect(page.getByRole("region", { name: "Recent tags" })).toContainText(
    "Deck role",
  );
  await expect(
    page.locator(".home-card").first().locator("button"),
  ).toHaveAccessibleName(/^Open Lightning Bolt artwork/);
  await page.locator(".home-card").last().tap();
  await page.locator('[data-artwork="details"]').click();
  await expect(page.locator("#detail h2")).toHaveText("Sol Ring");
  await page.locator("#close").click();
  await expect(
    page.locator(".home-card").first().locator("button"),
  ).toHaveAccessibleName(/^Open Sol Ring artwork/);
  await page.locator("#clear-home-history").click();
  await page.reload();
  await expect(page.locator(".home-card")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Your decks" })).toBeVisible();
  expect(f.writes).toHaveLength(0);
});
test("UC-32 home respects verified account isolation and sign-out hides every private recent item", async ({
  page,
}) => {
  const f = await fixture(page, { cloud: true });
  await page.locator("#collection-nav").click();
  await page.locator(".card-open").first().click();
  await page.locator('[data-artwork="details"]').click();
  await page.locator("#close").click();
  await page.locator("#home-nav").click();
  await expect(page.locator(".home-card")).toHaveCount(1);
  f.owner("two");
  await page.evaluate(() =>
    sessionStorage.setItem(
      "keeper-session",
      JSON.stringify({ IdToken: "test-two", expires: Date.now() + 3600000 }),
    ),
  );
  await page.reload();
  await expect(page.locator("#home-page")).toContainText("No decks yet");
  await expect(page.locator(".home-card")).toHaveCount(0);
  await expect(page.locator("#home-page")).not.toContainText("Deck 0");
  f.owner("one");
  await page.evaluate(() =>
    sessionStorage.setItem(
      "keeper-session",
      JSON.stringify({ IdToken: "test-one", expires: Date.now() + 3600000 }),
    ),
  );
  await page.reload();
  await expect(page.locator(".home-card")).toHaveCount(1);
  await page.locator("#sign-out").click();
  await expect(page.locator(".auth-dialog")).toBeVisible();
  await expect(page.locator(".home-card")).toHaveCount(0);
  await expect(page.locator("#home-page")).not.toContainText("Deck 0");
});
test("UC-32 home errors stay honest and search, import and scanner remain reachable on phones", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 700 });
  const f = await fixture(page);
  f.tagFail(true);
  await page.reload();
  await expect(page.locator("#home-page")).toContainText(
    "Tags could not be refreshed",
  );
  await expect(page.locator("#home-page")).not.toContainText("No tags yet");
  f.tagFail(false);
  await page.locator("#home-retry").click();
  await expect(page.getByRole("region", { name: "Your decks" })).toContainText(
    "Deck 0",
  );
  await page.locator("#search").fill("relampa");
  await page.locator("#suggestion-panel").getByRole("option").tap();
  await expect(page.locator("#detail h2")).toHaveText("Lightning Bolt");
  await page.locator("#close").click();
  await page.locator("#home-nav").click();
  await expect(page.locator(".home-card")).toHaveCount(1);
  await page.locator("#import-nav").tap();
  await expect(page).toHaveURL(/#import$/);
  await expect(page.locator("#draft-show-text")).toBeVisible();
  await page.goBack();
  await expect(page.locator("#home-page")).toBeVisible();
  await page.locator("#scan").tap();
  await expect(
    page.getByRole("button", { name: "Start camera", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  expect(f.writes).toHaveLength(0);
});
