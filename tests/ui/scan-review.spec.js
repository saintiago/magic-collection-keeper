import { test, expect } from "./fixtures.js";
test("UC-07 completion waits for collection refresh before allowing close", async ({
  page,
}) => {
  let saved = false,
    release;
  await page.route("**/api/collection", async (r) => {
    if (r.request().method() === "POST") saved = true;
    else if (saved) await new Promise((resolve) => (release = resolve));
    await r.fulfill({ json: [] });
  });
  await page.route("**/api/search?*", (r) =>
    r.fulfill({ json: { cards: [card], total: 1, hasMore: false } }),
  );
  await page.goto("/#collection");
  await page.locator("#import-nav").click();
  await page.locator("#import-list").click();
  await page.locator("#import-text").fill("1 Scanned Card");
  await page.locator("#preview").click();
  await expect(page.locator(".candidate")).not.toHaveValue("");
  await page.locator("#ownership").check();
  await page.locator("#save-batch").click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await expect(
    page.getByText("1 reviewed entries added.", { exact: false }),
  ).not.toBeVisible();
  release();
  await expect(
    page.getByText("1 reviewed entries added.", { exact: false }),
  ).toBeVisible();
  await page.locator("#batch-close").click();
  await expect(page.locator(".batch-dialog")).not.toBeVisible();
});
test("UC-08 permission timeout and invalid uploaded photo give actionable errors", async ({
  page,
}) => {
  await page.route("**/api/collection", (r) => r.fulfill({ json: [] }));
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => new Promise(() => {});
  });
  await page.clock.install();
  await page.goto("/#collection");
  await page.locator("#scan").click();
  await page.locator("#camera-start").click();
  await expect(page.getByText("Waiting for camera permission…")).toBeVisible();
  await page.clock.runFor(16000);
  await expect(
    page.getByText("Camera unavailable: Permission request timed out.", {
      exact: false,
    }),
  ).toBeVisible();
  await page.locator("#photo").setInputFiles({
    name: "invalid.png",
    mimeType: "image/png",
    buffer: Buffer.from("not an image"),
  });
  await expect(
    page.getByText("Could not read that image:", { exact: false }),
  ).toBeVisible();
});
const card = {
  id: "scan-print",
  name: "Scanned Card",
  set: "tst",
  collector_number: "2",
  lang: "en",
  finishes: ["foil"],
  scryfall_uri: "https://scryfall.com",
};
test("UC-08 uploaded reading can be corrected, reviewed and saved as a scan batch", async ({
  page,
}) => {
  let writes = 0;
  await page.route("**/api/collection", (r) => {
    if (r.request().method() === "POST") {
      writes++;
      expect(r.request().postDataJSON().finish).toBe("foil");
      expect(r.request().postDataJSON().quantity).toBe(2);
    }
    return r.fulfill({ json: [] });
  });
  await page.route("**/recognition.js", (r) =>
    r.fulfill({
      contentType: "text/javascript",
      body: 'export async function stopRecognition(){}; export async function recognizeCard(){return {name:"",text:"",confidence:0};}',
    }),
  );
  await page.route("**/api/search?*", (r) =>
    r.fulfill({ json: { cards: [card], total: 1, hasMore: false } }),
  );
  await page.goto("/#collection");
  await page.locator("#scan").click();
  const png = await page.screenshot();
  await page
    .locator("#photo")
    .setInputFiles({ name: "card.png", mimeType: "image/png", buffer: png });
  await expect(
    page.getByText("Could not read a name or collector number.", {
      exact: false,
    }),
  ).toBeVisible();
  await page.locator("#scan-review").click();
  await page.locator(".review-search input").fill("set:tst cn:2");
  await page.locator(".resolve").click();
  await expect(page.locator(".candidate")).toHaveValue("scan-print");
  await page.locator(".review-qty").fill("2");
  await page.locator("#ownership").check();
  await page.locator("#save-batch").click();
  await expect(
    page.getByText("1 reviewed entries added.", { exact: false }),
  ).toBeVisible();
  expect(writes).toBe(1);
});
test("UC-07 failed lookup remains editable; an empty result can be retried", async ({
  page,
}) => {
  await page.route("**/api/collection", (r) => r.fulfill({ json: [] }));
  let attempt = 0;
  await page.route("**/api/search?*", (r) => {
    attempt++;
    return r.fulfill(
      attempt === 1
        ? { status: 503, json: { error: "Lookup unavailable" } }
        : { json: { cards: [], total: 0, hasMore: false } },
    );
  });
  await page.goto("/#collection");
  await page.locator("#import-nav").click();
  await page.locator("#import-list").click();
  await page.locator("#import-text").fill("1 Missing Card");
  await page.locator("#preview").click();
  await expect(page.getByText("Lookup unavailable")).toBeVisible();
  await page.locator(".resolve").click();
  await expect(
    page.getByText("No match. Edit the search text and try again."),
  ).toBeVisible();
  await page.locator("#ownership").check();
  await expect(page.locator("#save-batch")).toBeDisabled();
});
test("UC-04 loading search can be left without stale results replacing collection", async ({
  page,
}) => {
  await page.route("**/api/collection", (r) => r.fulfill({ json: [] }));
  let release;
  await page.route("**/api/discover?*", async (r) => {
    await new Promise((resolve) => (release = resolve));
    await r.fulfill({ json: { cards: [card], total: 1, hasMore: false } });
  });
  await page.goto("/#collection");
  await page.locator("#add").click();
  await page.locator("#search").fill("Scanned");
  await page.locator("#search-submit").click();
  await expect(page.getByText("Searching for matching cards…")).toBeVisible();
  await page.locator("#collection-nav").click();
  release();
  await expect(page.getByText("Your collection begins here")).toBeVisible();
  await expect(page.locator(".card")).toHaveCount(0);
});
