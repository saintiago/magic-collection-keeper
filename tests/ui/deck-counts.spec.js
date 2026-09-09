import { test, expect } from "./fixtures.js";
const deck = {
  id: "deck",
  label: "Test Nephilim",
  type: "location",
  kind: "deck",
};
const other = {
  id: "other",
  label: "Other deck",
  type: "location",
  kind: "deck",
};
const make = (name, assigned, quantity, id = name, finish = "nonfoil") => ({
  id: name,
  printing_id: id,
  quantity,
  finish,
  language: "en",
  condition: "UNK",
  locations: [
    { tag_id: deck.id, quantity: assigned, tag: deck },
    ...(quantity > assigned
      ? [{ tag_id: other.id, quantity: quantity - assigned, tag: other }]
      : []),
  ],
  card: {
    id,
    name,
    set: "tst",
    set_name: "Test",
    collector_number: "1",
    lang: "en",
    color_identity: name === "Forest" ? ["G"] : [],
  },
});
const rows = [
  make("Forest", 6, 10),
  make("Mountain", 5, 8),
  make("Island", 2, 2),
  make("Plains", 2, 26),
  ...Array.from({ length: 84 }, (_, i) =>
    make(
      i === 0 ? "Commander" : "Single " + i,
      1,
      1,
      i === 1 ? "Plains" : "single-" + i,
      i === 1 ? "foil" : "nonfoil",
    ),
  ),
];
test("UC-18 deck copies, unique entries, pooled ownership, pending source and cached filters stay distinct", async ({
  page,
}) => {
  let wait = false,
    release;
  await page.route("**/api/collection", async (route) => {
    if (wait) await new Promise((resolve) => (release = resolve));
    await route.fulfill({ json: rows });
  });
  await page.route("**/api/tags", (route) =>
    route.fulfill({ json: [deck, other] }),
  );
  await page.route("**/api/deck-imports", (route) =>
    route.fulfill({
      json: [
        {
          name: deck.label,
          url: "https://moxfield.com/decks/test",
          folder: "Fixture",
          updated_at: "2026-09-08T00:00:00Z",
          lots: rows.map((row) => ({
            allocated_quantity: row.locations[0].quantity,
            owned_quantity: row.locations[0].quantity,
          })),
          excluded: [],
          pending: [
            {
              name: "Unresolved paper printing",
              quantity: 1,
              set: "prm",
              collector_number: "1",
              finish: "foil",
              reason: "Test fixture",
            },
          ],
        },
      ],
    }),
  );
  await page.goto("/#collection");
  await page.locator("#tag-filter").selectOption(deck.id);
  await expect(page.locator("#total")).toHaveText("130");
  await expect(page.locator("#result-count")).toHaveText(
    "99 assigned copies · 88 distinct entries",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const plains = page.locator(".card").filter({
    has: page.getByRole("button", { name: /^Open Plains printing/ }),
  });
  await expect(plains.locator(".card-open")).toHaveAccessibleName(
    /2 assigned here/,
  );
  await expect(plains).toContainText("26 owned");
  await page.locator("#sort").selectOption("quantity");
  await expect(page.locator(".card-open").first()).toHaveAccessibleName(
    /^Open Forest printing/,
  );
  await page.locator("#color").selectOption("G");
  await expect(page.locator("#result-count")).toHaveText(
    "6 assigned copies of 99 · 1 distinct entry",
  );
  await page.locator("#manage-tags").click();
  await page.locator("#deck-sources").click();
  await expect(page.locator(".source-total")).toHaveText(
    "100 cards in source · 99 imported copies · 1 awaiting printing review",
  );
  await page.locator("#back-tags").click();
  await page.locator("#tags-close").click();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { snapshotKey, snapshotStore } =
          await import("/collection-cache.js");
        const { collectionIdentity } = await import("/auth.js");
        return Boolean(
          await snapshotStore.read(snapshotKey(await collectionIdentity())),
        );
      }),
    )
    .toBe(true);
  wait = true;
  await page.reload();
  await expect(page.locator("#collection-status-text")).toContainText(
    "Showing saved snapshot",
  );
  // Location choices are restored from the cached rows before either network response.
  await page.locator("#tag-filter").selectOption(deck.id);
  await expect(page.locator("#result-count")).toHaveText(
    "99 assigned copies · 88 distinct entries",
  );
  await expect.poll(() => Boolean(release)).toBe(true);
  release();
  await expect(page.locator("#collection-status-text")).toContainText(
    "up to date",
  );
  await expect(page.locator("#result-count")).toHaveText(
    "99 assigned copies · 88 distinct entries",
  );
});
