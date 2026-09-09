import { test, expect } from "./fixtures.js";
import { publicCardFrame } from "../helpers/public-frame.js";
const card = {
  id: "11111111-1111-1111-1111-111111111111",
  oracle_id: "22222222-2222-2222-2222-222222222222",
  name: "Lightning Bolt",
  set: "m11",
  set_name: "Magic 2011",
  collector_number: "149",
  lang: "en",
  finishes: ["nonfoil", "foil"],
  rarity: "common",
  type_line: "Instant",
  color_identity: ["R"],
  scryfall_uri: "https://scryfall.com",
  oracle_text: "Lightning Bolt deals 3 damage to any target.",
};
test("empty collection, catalog review, quantity edit, filtering and removal", async ({
  page,
}) => {
  let rows = [];
  await page.route("**/api/discover?*", (r) =>
    r.fulfill({ json: { cards: [card], total: 1, hasMore: false } }),
  );
  await page.route(/\/api\/collection(?:\/\d+)?$/, async (route) => {
    const req = route.request();
    if (req.method() === "POST") {
      const input = req.postDataJSON();
      rows = [{ ...input, id: 1, language: "en", card }];
    }
    if (req.method() === "PATCH")
      rows[0].quantity = req.postDataJSON().quantity;
    if (req.method() === "DELETE") rows = [];
    await route.fulfill({ json: rows });
  });
  await page.goto("/#collection");
  await expect(page.getByText("Your collection begins here")).toBeVisible();
  await page.getByRole("button", { name: "Find your first card" }).click();
  await page
    .getByRole("combobox", { name: "Search cards" })
    .fill("Lightning Bolt");
  await page.getByRole("button", { name: "Search cards", exact: true }).click();
  await page.locator(".card").click();
  await page.locator('[data-artwork="details"]').click();
  await page.locator("#quantity").fill("4");
  await page
    .getByRole("button", { name: "Add to collection", exact: false })
    .last()
    .click();
  await page.locator("#collection-nav").click();
  await expect(page.locator("#total")).toHaveText("4");
  await page.locator(".card").click();
  await page.locator('[data-artwork="details"]').click();
  await page.locator("#quantity").fill("2");
  await page.getByRole("button", { name: "Save quantity" }).click();
  await expect(page.locator("#total")).toHaveText("2");
  await page.getByLabel("Filter by color").selectOption("G");
  await expect(page.getByText("No cards match these filters")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await page.locator(".card").click();
  await page.locator('[data-artwork="details"]').click();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Remove this entry" }).click();
  await expect(page.getByText("Your collection begins here")).toBeVisible();
});

test("camera permission error offers photo fallback", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => {
          throw new DOMException("Denied", "NotAllowedError");
        },
      },
    });
  });
  await page.goto("/#collection");
  await page.getByRole("button", { name: "Scan cards" }).click();
  await page.getByRole("button", { name: "Start camera", exact: true }).click();
  await expect(
    page.getByText("Camera permission was denied.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("Upload photo", { exact: true })).toBeVisible();
});
test("real browser ONNX recognizes the frozen public fixture without selecting ownership", async ({
  page,
}) => {
  test.setTimeout(120000);
  await page.route("**/api/card?*", (route) =>
    route.fulfill({
      json: {
        cards: [
          {
            id: "4796e5e4-515c-4d89-92da-b2d5b5b39557",
            oracle_id: "a6657fcf-f08c-4b03-8ec8-cb0b194eb553",
            name: "Adaptive Training Post",
            set: "tdc",
            collector_number: "58",
            lang: "en",
            finishes: ["nonfoil"],
          },
        ],
      },
    }),
  );
  await page.goto("/#collection");
  await page.locator("#scan").click();
  const frame = await publicCardFrame(page);
  await page
    .locator("#photo")
    .setInputFiles({
      name: "verified-public-fixture.jpg",
      mimeType: "image/jpeg",
      buffer: Buffer.from(frame.split(",")[1], "base64"),
    });
  await expect(page.locator("#scan-wheel")).toContainText(
    "Adaptive Training Post",
    { timeout: 30000 },
  );
  await expect(page.locator("#scan-count")).toHaveText("1 queued · 1 copies");
  await expect(page.locator("#scan-mode")).toHaveCount(0);
});
