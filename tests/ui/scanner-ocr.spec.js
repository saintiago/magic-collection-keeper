import { test, expect } from "@playwright/test";
import { installSyntheticCardCamera } from "../helpers/synthetic-camera.js";
test("UC-14 guide crop feeds real OCR without manual capture", async ({
  page,
}) => {
  test.setTimeout(60000);
  await page.addInitScript(installSyntheticCardCamera);
  await page.route("**/api/collection", (r) => r.fulfill({ json: [] }));
  await page.route("**/api/search?*", (r) =>
    r.fulfill({
      json: {
        cards: [
          {
            id: "scan-target",
            name: "Lightning Bolt",
            set: "m11",
            collector_number: "149",
            lang: "en",
            finishes: ["nonfoil"],
          },
        ],
        hasMore: false,
      },
    }),
  );
  await page.goto("/");
  await page.locator("#scan").click();
  await page.locator("#camera-start").click();
  await expect(page.locator("#scan-status")).toContainText(
    "Lightning Bolt matched",
    { timeout: 45000 },
  );
  await page.screenshot({ path: "test-results/scanner-desktop-synthetic.png" });
  await page.locator("#scan-back").click();
  await expect(page.locator(".candidate")).toHaveValue("scan-target");
});
