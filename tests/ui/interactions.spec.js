import { test, expect } from "./fixtures.js";
const a = {
  id: "a",
  oracle_id: "oa",
  name: "Alpha",
  set: "one",
  set_name: "Set One",
  collector_number: "1",
  lang: "en",
  finishes: ["nonfoil", "foil"],
  rarity: "rare",
  type_line: "Creature",
  color_identity: ["G"],
  scryfall_uri: "https://scryfall.com/card/one/1/alpha",
  card_faces: [
    {
      name: "Alpha",
      image_uris: { normal: "https://cards.scryfall.io/front.png" },
    },
    {
      name: "Omega",
      image_uris: { normal: "https://cards.scryfall.io/back.png" },
    },
  ],
};
const b = {
  ...a,
  id: "b",
  name: "Beta",
  set: "two",
  set_name: "Set Two",
  lang: "es",
  color_identity: [],
  card_faces: undefined,
};
async function collection(page, rows = []) {
  await page.route("**/api/collection", (r) => r.fulfill({ json: rows }));
}
test("UC-02/03 collection filters, every sort, refresh success and failure", async ({
  page,
}) => {
  let fail = false;
  const rows = [
    {
      id: 1,
      printing_id: "b",
      quantity: 5,
      finish: "foil",
      condition: "LP",
      language: "es",
      card: b,
    },
    {
      id: 2,
      printing_id: "a",
      quantity: 2,
      finish: "nonfoil",
      condition: "NM",
      language: "en",
      card: a,
    },
  ];
  await page.route("**/api/collection", (r) =>
    r.fulfill(
      fail ? { status: 503, json: { error: "Offline test" } } : { json: rows },
    ),
  );
  await page.goto("/#collection");
  await expect(page.locator("#total")).toHaveText("7");
  await expect(page.locator("#foils")).toHaveText("5");
  await expect(page.locator("#unique")).toHaveText("2");
  await page.locator("#search").fill("Alpha");
  // Shared card search does not silently filter the owned library by a different rule.
  await expect(page.locator(".card")).toHaveCount(2);
  await page.locator("#search").fill("");
  await page.locator("#set-filter").selectOption("two");
  await expect(page.locator(".card-title")).toHaveText("Beta");
  await page.locator("#set-filter").selectOption("");
  await page.locator("#finish-filter").selectOption("nonfoil");
  await expect(page.locator(".card-title")).toHaveText("Alpha");
  await page.locator("#finish-filter").selectOption("");
  await page.locator("#color").selectOption("C");
  await expect(page.locator(".card-title")).toHaveText("Beta");
  await page.locator("#color").selectOption("");
  await page.locator("#sort").selectOption("quantity");
  await expect(page.locator(".card-title").first()).toHaveText("Beta");
  await page.locator("#sort").selectOption("recent");
  await expect(page.locator(".card-title").first()).toHaveText("Beta");
  await page.locator("#sort").selectOption("name");
  await expect(page.locator(".card-title").first()).toHaveText("Alpha");
  fail = true;
  await page.locator("#refresh").click();
  await expect(page.getByText("Offline test")).toBeVisible();
  await expect(page.locator(".card")).toHaveCount(2);
  fail = false;
  await page.locator("#refresh").click();
  await expect(
    page.getByText("Collection is up to date.", { exact: false }),
  ).toBeVisible();
});
test("UC-04 catalog blank, no-result, error, pagination, example and detail fields", async ({
  page,
}) => {
  await collection(page);
  let outcome = "empty";
  await page.route("**/api/discover?*", (r) =>
    r.fulfill(
      outcome === "error"
        ? { status: 429, json: { error: "Scryfall is busy" } }
        : {
            json: {
              cards: outcome === "empty" ? [] : [outcome === "second" ? b : a],
              total: outcome === "empty" ? 0 : 2,
              hasMore: outcome === "first",
            },
          },
    ),
  );
  await page.goto("/#collection");
  await page.locator("#catalog-nav").click();
  await page.locator("#search-submit").click();
  await expect(
    page.getByText("Enter a card name or a set and collector number."),
  ).toBeVisible();
  await page.locator("#search").fill("nonsense");
  await page.locator("#search-submit").click();
  await expect(page.getByText("No cards found")).toBeVisible();
  outcome = "error";
  await page.locator("#search-submit").click();
  await expect(page.getByText("Scryfall is busy")).toBeVisible();
  outcome = "first";
  await page.locator("#example").click();
  await expect(page.locator(".card")).toHaveCount(1);
  outcome = "second";
  await page.locator("#more").click();
  await expect(page.locator(".card")).toHaveCount(2);
  await page.locator(".card").first().click();
  await page.locator("#flip").click();
  await expect(page.locator(".detail-image img")).toHaveAttribute(
    "alt",
    "Omega",
  );
  await page.locator("#finish").selectOption("foil");
  await page.locator("#condition").selectOption("HP");
  await page.locator("#quantity").fill("0");
  await page.locator("#inventory-form button[type=submit]").click();
  await expect(page.locator("#detail")).toBeVisible();
  await expect(page.locator(".scryfall-link")).toHaveAttribute(
    "href",
    a.scryfall_uri,
  );
  await page.locator("#close").click();
  await expect(page.locator("#detail")).not.toBeVisible();
  await page.locator(".card").last().click();
  await expect(page.locator("#detail .image-missing")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#detail")).not.toBeVisible();
});
test("UC-05 add failure, retry, remove cancellation and remove failure", async ({
  page,
}) => {
  let rows = [],
    fail = true;
  await page.route("**/api/discover?*", (r) =>
    r.fulfill({ json: { cards: [a], total: 1, hasMore: false } }),
  );
  await page.route(/\/api\/collection(?:\/1)?$/, (r) => {
    const method = r.request().method();
    if (method !== "GET" && fail)
      return r.fulfill({
        status: 400,
        json: { error: "Please retry this change" },
      });
    if (method === "POST")
      rows = [{ ...r.request().postDataJSON(), id: 1, card: a }];
    return r.fulfill({ json: rows });
  });
  await page.goto("/#collection");
  await page.locator("#add").click();
  await page.locator("#search").fill("Alpha");
  await page.locator("#search-submit").click();
  await page.locator(".card").click();
  await page.locator("#inventory-form button[type=submit]").click();
  await expect(page.locator("#detail-message")).toHaveText(
    "Please retry this change",
  );
  fail = false;
  await page.locator("#inventory-form button[type=submit]").click();
  await page.locator("#collection-nav").click();
  await page.locator(".card").click();
  page.once("dialog", (d) => d.dismiss());
  await page.locator("#remove").click();
  await expect(page.locator("#detail")).toBeVisible();
  fail = true;
  page.once("dialog", (d) => d.accept());
  await page.locator("#remove").click();
  await expect(page.locator("#detail-message")).toHaveText(
    "Please retry this change",
  );
});
test("UC-07 import limits, unresolved correction, choices, attributes, partial failure and retry", async ({
  page,
}) => {
  let writes = 0,
    fail = true;
  await page.route("**/api/collection", (r) => {
    if (r.request().method() === "POST") {
      writes++;
      if (writes === 2 && fail)
        return r.fulfill({
          status: 503,
          json: { error: "Temporary write error" },
        });
    }
    return r.fulfill({ json: [] });
  });
  await page.route("**/api/search?*", (r) =>
    r.fulfill({ json: { cards: [a, b], total: 2, hasMore: false } }),
  );
  await page.goto("/#collection");
  await page.locator("#import-nav").click();
  await page.locator("#import-list").click();
  await page.locator("#preview").click();
  await expect(page.getByText("Paste at least one card line.")).toBeVisible();
  await page.locator("#import-text").fill(Array(51).fill("1 Alpha").join("\n"));
  await page.locator("#preview").click();
  await expect(
    page.getByText("Please split this list", { exact: false }),
  ).toBeVisible();
  await page.locator("#import-text").fill("2 Alpha\nbad line");
  await page.locator("#preview").click();
  await expect(
    page.getByText("Review matches below.", { exact: false }),
  ).toBeVisible();
  await page.locator(".candidate").first().selectOption("a");
  await page.locator(".review-qty").first().fill("3");
  await page.locator(".review-finish").first().selectOption("foil");
  await page.locator(".review-condition").first().selectOption("MP");
  await page.locator(".review-search input").last().fill("Beta");
  await page.locator(".resolve").last().click();
  await page.locator(".candidate").last().selectOption("b");
  await page.locator("#ownership").check();
  await page.locator("#save-batch").click();
  await expect(
    page.getByText("1 entries saved before an error:", { exact: false }),
  ).toBeVisible();
  fail = false;
  await page.locator("#save-batch").click();
  await expect(
    page.getByText("1 reviewed entries added.", { exact: false }),
  ).toBeVisible();
  expect(writes).toBe(3);
  await page.locator("#batch-close").click();
  await expect(page.locator(".batch-dialog")).not.toBeVisible();
});
test("UC-08 missing camera and uploaded photo recognition failure", async ({
  page,
}) => {
  await collection(page);
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException("None", "NotFoundError");
    };
  });
  await page.route("**/recognition.js", (r) =>
    r.fulfill({
      contentType: "text/javascript",
      body: 'export async function stopRecognition(){}; export async function recognizeCard(){throw new Error("Model unavailable")};',
    }),
  );
  await page.goto("/#collection");
  await page.locator("#scan").click();
  await page.locator("#camera-start").click();
  await expect(
    page.getByText("No camera found.", { exact: false }),
  ).toBeVisible();
  const png = await page.screenshot();
  await page
    .locator("#photo")
    .setInputFiles({ name: "card.png", mimeType: "image/png", buffer: png });
  await expect(
    page.getByText("Recognition failed:", { exact: false }),
  ).toBeVisible();
});
test("UC-09 mobile layout remains within viewport with working navigation", async ({
  page,
}) => {
  await collection(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#collection");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.locator("#add").click();
  await expect(page.locator("#search-submit")).toBeVisible();
  await page.locator("#collection-nav").click();
  await page.locator("#scan").click();
  await expect(page.locator("#camera-start")).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        document.querySelector(".scanner-dialog").getBoundingClientRect()
          .width <= innerWidth,
    ),
  ).toBe(true);
});
