import { test, expect } from "./fixtures.js";
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
  await page.locator("#quantity").fill("4");
  await page
    .getByRole("button", { name: "Add to collection", exact: false })
    .last()
    .click();
  await page.locator("#collection-nav").click();
  await expect(page.locator("#total")).toHaveText("4");
  await page.locator(".card").click();
  await page.locator("#quantity").fill("2");
  await page.getByRole("button", { name: "Save quantity" }).click();
  await expect(page.locator("#total")).toHaveText("2");
  await page.getByLabel("Filter by color").selectOption("G");
  await expect(page.getByText("No cards match these filters")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await page.locator(".card").click();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Remove this entry" }).click();
  await expect(page.getByText("Your collection begins here")).toBeVisible();
});
test("import needs review and ownership confirmation; unresolved lines stay out", async ({
  page,
}) => {
  let writes = 0;
  await page.route("**/api/search?*", (r) =>
    r.fulfill({ json: { cards: [card], total: 1, hasMore: false } }),
  );
  await page.route("**/api/collection", (r) => {
    if (r.request().method() === "POST") writes++;
    return r.fulfill({ json: [] });
  });
  await page.goto("/#collection");
  await page.locator("#import-nav").click();
  await page.getByRole("button", { name: "Import list" }).click();
  await page
    .getByLabel("Moxfield card list")
    .fill("2 Lightning Bolt (M11) 149\ninvalid line");
  await page.getByRole("button", { name: "Preview matches" }).click();
  await expect(
    page.getByText("Review matches below.", { exact: false }),
  ).toBeVisible();
  expect(writes).toBe(0);
  await expect(
    page.getByRole("button", { name: "Add reviewed cards to collection" }),
  ).toBeDisabled();
  await page.locator("#ownership").check();
  await page
    .getByRole("button", { name: "Add reviewed cards to collection" })
    .click();
  await expect(
    page.getByText("1 reviewed entries added.", { exact: false }),
  ).toBeVisible();
  expect(writes).toBe(1);
});
test("camera permission error offers photo fallback", async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException("Denied", "NotAllowedError");
    };
  });
  await page.goto("/#collection");
  await page.getByRole("button", { name: "Scan cards" }).click();
  await page.getByRole("button", { name: "Start camera", exact: true }).click();
  await expect(
    page.getByText("Camera permission was denied.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("Upload photo", { exact: true })).toBeVisible();
});
test("real browser OCR reads a clear card title", async ({ page }) => {
  test.setTimeout(120000);
  await page.goto("/#collection");
  const result = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 700;
    canvas.height = 980;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, 700, 980);
    ctx.fillStyle = "black";
    ctx.font = "bold 46px Arial";
    ctx.fillText("Lightning Bolt", 35, 80);
    ctx.font = "30px Arial";
    ctx.fillText("Instant", 35, 620);
    ctx.fillText("149", 35, 870);
    ctx.fillText("M11 EN", 35, 920);
    const { recognizeCard, stopRecognition } = await import("/recognition.js");
    const result = await recognizeCard(canvas);
    await stopRecognition();
    return result;
  });
  expect(result.name).toContain("Lightning Bolt");
  expect(result.confidence).toBeGreaterThan(50);
});
