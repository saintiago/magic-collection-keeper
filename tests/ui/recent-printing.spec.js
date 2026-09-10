import { test, expect } from "./fixtures.js";
import { randomUUID } from "node:crypto";
import {
  fixture as importFixture,
  card as importedCard,
  alt as importedAlt,
} from "../helpers/import-page-fixture.js";
import { moxfieldSource } from "../../domain/import-draft.js";

test("RECENT-01 Import records receipt-confirmed additions after a lost response; unchanged reimport leaves cleared history empty", async ({
  page,
}) => {
  const f = await importFixture(page, { lines: 1 });
  try {
    const staged = await f.drafts.stageDraft("test", {
      id: randomUUID(),
      kind: "scan",
      rows: [importedCard, importedAlt, importedCard].map((card) => ({
        id: randomUUID(),
        name: card.name,
        printing_id: card.id,
        quantity: 1,
        finish: "nonfoil",
        condition: "UNK",
      })),
    });
    await page.goto("/#import=" + staged.draft.id);
    await expect(page.locator("#draft-add")).toBeEnabled();
    expect(await historyPrintings(page)).toEqual([]);
    f.loseAddResponse();
    await page.locator("#draft-add").click();
    await expect(page.locator("#import-page")).toContainText(
      "Response interrupted after commit",
    );
    expect(await historyPrintings(page)).toEqual([]);
    await page.locator("#draft-add").click();
    await expect
      .poll(() => historyPrintings(page))
      .toEqual([importedCard.id, importedAlt.id]);
    const owned = await f.tagged.list("test");
    expect(
      owned.find((row) => row.printing_id === importedCard.id).quantity,
    ).toBe(2);
    expect(
      owned.find((row) => row.printing_id === importedAlt.id).quantity,
    ).toBe(1);
    await page.locator("#home-nav").click();
    await expect(page.locator(".home-card")).toHaveCount(2);
    await page.locator("#clear-home-history").click();
    const url = "https://moxfield.com/decks/keeper_import_ui_0001";
    await f.tagged.importDeck("test", {
      ...moxfieldSource(url),
      name: "Existing source",
      expected_version: 0,
      entries: [
        {
          printing_id: importedCard.id,
          quantity: 1,
          finish: "nonfoil",
          condition: "UNK",
          section: "mainboard",
        },
      ],
    });
    const pending = await f.drafts.fetchDraft("test", { url });
    await page.goto("/#import=" + pending.draft.id);
    await expect(page.locator("#draft-add")).toBeEnabled();
    await page.locator("#draft-add").click();
    await expect(page.locator("#import-page")).toContainText(
      "Added 0 new copies",
    );
    expect(await historyPrintings(page)).toEqual([]);
    await page.locator("#home-nav").click();
    await expect(page.locator(".home-card")).toHaveCount(0);
  } finally {
    f.db.close();
  }
});

test("RECENT-01 an older import receipt without printing metadata never guesses activity from its aggregate count", async ({
  page,
}) => {
  const f = await importFixture(page, { lines: 1 });
  try {
    const staged = await f.drafts.stageDraft("test", {
      id: randomUUID(),
      kind: "catalog",
      rows: [
        {
          id: randomUUID(),
          name: importedCard.name,
          printing_id: importedCard.id,
          quantity: 1,
          finish: "nonfoil",
          condition: "UNK",
        },
      ],
    });
    await page.route("**/api/import-draft/add", async (route) => {
      const result = await f.drafts.addDraft(
        "test",
        route.request().postDataJSON(),
      );
      delete result.added_printings;
      return route.fulfill({ json: result });
    });
    await page.goto("/#import=" + staged.draft.id);
    await expect(page.locator("#draft-add")).toBeEnabled();
    await page.locator("#draft-add").click();
    await expect(page.locator("#import-page")).toContainText(
      "Added 1 new copies",
    );
    expect((await f.tagged.list("test"))[0].quantity).toBe(1);
    expect(await historyPrintings(page)).toEqual([]);
  } finally {
    f.db.close();
  }
});

async function selectionFixture(page) {
  const cards = [1, 2, 3].map((index) => ({
    id: `${index}${index}${index}${index}${index}${index}${index}${index}-1111-4111-8111-111111111111`,
    oracle_id: `${index}${index}${index}${index}${index}${index}${index}${index}-2222-4222-8222-222222222222`,
    name: `Selection ${index}`,
    set: "tst",
    set_name: "Test",
    collector_number: String(index),
    lang: "en",
    finishes: ["nonfoil"],
    type_line: "Artifact",
    image_uris: { normal: `https://cards.scryfall.io/selection-${index}.jpg` },
  }));
  let owned = [],
    failAdd = true;
  await page.route("https://cards.scryfall.io/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="488" height="680"><rect width="488" height="680" fill="green"/></svg>',
    }),
  );
  await page.route("**/api/tags", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/collection", (route) => {
    if (route.request().method() === "POST") {
      if (failAdd)
        return route.fulfill({
          status: 503,
          json: { error: "Fixture rejected addition" },
        });
      const input = route.request().postDataJSON(),
        card = cards.find((card) => card.id === input.printing_id);
      owned = [
        {
          ...input,
          id: "added-fixture",
          card,
          locations: [],
          tags: [],
          tag_ids: [],
        },
      ];
    }
    return route.fulfill({ json: owned });
  });
  await page.route("**/api/suggest?*", (route) => {
    const query = new URL(route.request().url()).searchParams.get("q") || "";
    return route.fulfill({
      json: {
        suggestions: cards
          .filter((card) =>
            card.name.toLowerCase().includes(query.toLowerCase()),
          )
          .map((card) => ({
            name: card.name,
            printing_id: card.id,
            oracle_id: card.oracle_id,
          })),
      },
    });
  });
  await page.route("**/api/discover?*", (route) => {
    const params = new URL(route.request().url()).searchParams;
    return route.fulfill({
      json: {
        cards: cards.filter(
          (card) =>
            card.id === params.get("printing") ||
            card.oracle_id === params.get("oracle"),
        ),
        total: 1,
        hasMore: false,
      },
    });
  });
  await page.goto("/");
  await expect(page.locator("#collection-nav")).toBeVisible();
  return {
    cards,
    succeed: () => {
      failAdd = false;
    },
  };
}

async function historyPrintings(page) {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find((key) =>
      key.startsWith("keeper-home-v1:"),
    );
    return key
      ? JSON.parse(localStorage.getItem(key))
          .entries.filter((entry) => entry.kind === "card")
          .map((entry) => entry.printing_id)
      : [];
  });
}

for (const input of ["mouse", "touch", "keyboard"])
  test.describe(`RECENT-04 ${input}`, () => {
    test.use({ hasTouch: true });
    test("confirmed selection updates exact history; typing, highlighting and restoring an older card do not", async ({
      page,
    }) => {
      const { cards } = await selectionFixture(page);
      if (input === "touch")
        await page.setViewportSize({ width: 390, height: 844 });
      for (const card of cards.slice(0, 2)) {
        await page.locator("#search").fill(card.name);
        const option = page
          .locator("#suggestion-panel")
          .getByRole("option")
          .first();
        await expect(option).toContainText(card.name);
        const before = await historyPrintings(page);
        await page.locator("#search").press("ArrowDown");
        expect(await historyPrintings(page)).toEqual(before);
        if (input === "keyboard") await page.locator("#search").press("Enter");
        else if (input === "touch") await option.tap();
        else await option.click();
        await expect(page.locator("#inventory-form")).toBeVisible();
        await expect
          .poll(() => historyPrintings(page))
          .toEqual(
            card === cards[0] ? [cards[0].id] : [cards[1].id, cards[0].id],
          );
        await page.locator("#home-nav").click();
      }
      await page.goto(`/#card=${cards[0].id}&oracle=${cards[0].oracle_id}`);
      await expect(page.locator("#inventory-form")).toBeVisible();
      expect(await historyPrintings(page)).toEqual([cards[1].id, cards[0].id]);
      await page.reload();
      await expect(page.locator("#inventory-form")).toBeVisible();
      expect(await historyPrintings(page)).toEqual([cards[1].id, cards[0].id]);
      await page.goto(`/#card=${cards[2].id}&oracle=${cards[2].oracle_id}`);
      await expect(page.locator("#inventory-form")).toBeVisible();
      expect(await historyPrintings(page)).toEqual([cards[1].id, cards[0].id]);
    });
  });

test("RECENT-01 explicit successful Add records the printing, while a failed Add and page restoration leave history empty", async ({
  page,
}) => {
  const fixture = await selectionFixture(page),
    card = fixture.cards[0];
  await page.goto(`/#card=${card.id}&oracle=${card.oracle_id}`);
  await expect(page.locator("#inventory-form")).toBeVisible();
  expect(await historyPrintings(page)).toEqual([]);
  await page
    .getByRole("button", { name: "+ Add to collection", exact: true })
    .click();
  await expect(page.locator("#detail-message")).toHaveText(
    "Fixture rejected addition",
  );
  expect(await historyPrintings(page)).toEqual([]);
  fixture.succeed();
  await page
    .getByRole("button", { name: "+ Add to collection", exact: true })
    .click();
  await expect.poll(() => historyPrintings(page)).toEqual([card.id]);
  await page.locator("#home-nav").click();
  await expect(page.locator(".home-card")).toHaveCount(1);
  await expect(page.locator(".home-card button")).toHaveAccessibleName(/Owned/);
});

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
