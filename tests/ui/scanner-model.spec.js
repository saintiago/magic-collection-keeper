import { readFile } from "node:fs/promises";
import { test, expect } from "./fixtures.js";
import { installSyntheticCardCamera } from "../helpers/synthetic-camera.js";
test("UC-14 guide crop feeds real browser ONNX without manual capture", async ({
  page,
}) => {
  test.setTimeout(60000);
  await page.addInitScript(
    installSyntheticCardCamera,
    "data:image/jpeg;base64," +
      (await readFile("recognition/artifacts/public-card-frame.jpg")).toString(
        "base64",
      ),
  );
  await page.route("**/api/collection", (r) => r.fulfill({ json: [] }));
  await page.route("**/api/card?*", (r) =>
    r.fulfill({
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
        hasMore: false,
      },
    }),
  );
  await page.goto("/#collection");
  await page.locator("#scan").click();
  await page.locator("#camera-start").click();
  await expect(page.locator("#scan-possible")).toContainText(
    "Adaptive Training Post",
    { timeout: 45000 },
  );
  await expect(page.locator("#scan-count")).toHaveText("0 matched · 0 copies");
  await page.locator("#scan-possible summary").click();
  await page
    .getByRole("button", { name: "Adaptive Training Post · tdc #58 · en" })
    .click();
  await page.screenshot({ path: "test-results/scanner-desktop-synthetic.png" });
  await page.locator("#scan-back").click();
  await expect(page.locator(".candidate")).toHaveValue(
    "4796e5e4-515c-4d89-92da-b2d5b5b39557",
  );
});
