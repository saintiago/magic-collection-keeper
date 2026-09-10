import { test, expect } from "./fixtures.js";

test("RECENT-02 Home opens and stages the unowned exact printing while another printing is owned", async ({
  page,
}) => {
  const oracle = "33333333-3333-4333-8333-333333333333";
  const first = {
    id: "11111111-1111-4111-8111-111111111111",
    oracle_id: oracle,
    name: "Printing fixture",
    set: "one",
    set_name: "First set",
    collector_number: "1",
    lang: "en",
    finishes: ["nonfoil"],
    type_line: "Artifact",
    image_uris: { normal: "https://cards.scryfall.io/first.jpg" },
  };
  const second = {
    ...first,
    id: "22222222-2222-4222-8222-222222222222",
    set: "two",
    set_name: "Second set",
    image_uris: { normal: "https://cards.scryfall.io/second.jpg" },
  };
  const tag = {
    id: "44444444-4444-4444-8444-444444444444",
    label: "Fixture role",
    type: "role",
    kind: "role",
  };
  const writes = [];
  await page.route("https://cards.scryfall.io/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="488" height="680"><rect width="488" height="680" fill="green"/></svg>',
    }),
  );
  await page.route("**/api/collection", (route) =>
    route.fulfill({
      json: [
        {
          id: "owned-first",
          card: first,
          printing_id: first.id,
          quantity: 3,
          finish: "nonfoil",
          condition: "NM",
          tag_ids: [tag.id],
          tags: [tag],
          locations: [],
        },
      ],
    }),
  );
  await page.route("**/api/tags", (route) => route.fulfill({ json: [tag] }));
  await page.route("**/api/card?*", (route) => {
    expect(new URL(route.request().url()).searchParams.get("printing")).toBe(
      second.id,
    );
    return route.fulfill({ json: { cards: [second] } });
  });
  for (const path of ["tag-actions", "import-draft/stage"])
    await page.route(`**/api/${path}`, (route) => {
      writes.push({ path, body: route.request().postDataJSON() });
      return route.fulfill({
        status: 503,
        json: { error: "Fixture interrupted save" },
      });
    });
  await page.goto("/");
  await expect(page.locator("#collection-nav")).toBeVisible();
  await page.evaluate(
    async (cards) => {
      const { collectionIdentity } = await import("/auth.js");
      const { snapshotKey } = await import("/collection-cache.js");
      const key = "keeper-home-v1:" + snapshotKey(await collectionIdentity());
      localStorage.setItem(
        key,
        JSON.stringify({
          schema: 1,
          entries: cards.map((card) => ({
            kind: "card",
            printing_id: card.id,
            oracle_id: card.oracle_id,
            name: card.name,
            image_url: card.image_uris.normal,
          })),
        }),
      );
    },
    [second, first],
  );
  await page.reload();
  const tile = page.locator(`.home-card[data-card-key="${second.id}"] button`);
  await expect(page.locator(".home-card")).toHaveCount(2);
  await expect(tile).toHaveAccessibleName(/Not owned/);
  await expect(tile.locator("img")).toHaveAttribute(
    "src",
    second.image_uris.normal,
  );
  await tile.click();
  const viewer = page.locator(".artwork-viewer");
  await expect(viewer.locator(".artwork-full-image")).toHaveAttribute(
    "src",
    second.image_uris.normal,
  );
  const toggle = viewer.getByRole("button", { name: tag.label, exact: true });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].path).toBe("import-draft/stage");
  expect(writes[0].body.rows[0].printing_id).toBe(second.id);
  expect(writes[0].body.rows[0].quantity).toBe(1);
  await expect(viewer).toContainText("Fixture interrupted save");
  await page.keyboard.press("Escape");
  await expect(viewer).not.toBeVisible();
  await expect(tile).toBeFocused();
  expect(writes.some((write) => write.path === "tag-actions")).toBe(false);
});
