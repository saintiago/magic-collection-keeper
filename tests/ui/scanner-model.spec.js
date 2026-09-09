import { readFile } from "node:fs/promises";
import { test, expect } from "./fixtures.js";
import { installSyntheticCardCamera } from "../helpers/synthetic-camera.js";
test.use({ realCardPresence: true });
test("UC-14 guide crop feeds real browser ONNX without manual capture", async ({
  page,
  browserName,
}) => {
  test.setTimeout(60000);
  await page.addInitScript(() => {
    window.overlayMetrics = [];
    window.addEventListener("keeper-overlay-measurement", (event) =>
      window.overlayMetrics.push(event.detail),
    );
  });
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
  if (browserName === "webkit") {
    // Windows WebKit lacks canvas.captureStream. Use actual image input and
    // model workers; this is explicitly not a camera-stream verification.
    await page
      .locator("#photo")
      .setInputFiles("recognition/artifacts/public-card-frame.jpg");
  } else await page.locator("#camera-start").click();
  await expect(page.locator("#scan-wheel")).toContainText(
    "Adaptive Training Post",
    { timeout: 45000 },
  );
  await expect(page.locator("#scan-count")).toHaveText("1 queued · 1 copies");
  await page.screenshot({ path: "test-results/scanner-desktop-synthetic.png" });
  await page.locator("#scan-back").click();
  const [metrics] = await page.evaluate(() => window.overlayMetrics);
  expect(metrics.meanDrawMs).toBeLessThan(5);
  await test.info().attach("actual-workers-overlay-draw", {
    body: JSON.stringify(metrics),
    contentType: "application/json",
  });
  await expect(page.locator(".draft-row")).toContainText(
    "Adaptive Training Post",
  );
});
