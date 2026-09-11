import { test, expect } from "./fixtures.js";
import { mockVisualReading, choosePossible } from "./visual-fixture.js";

test("UC-15 phone wheel puts newest beside controls and centers history with newer cards below", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/collection", (r) => r.fulfill({ json: [] }));
  await mockVisualReading(page, {
    cards: Array.from({ length: 6 }, (_, index) => ({
      id: `scan-test-${index}`,
      name: "Lightning Bolt",
      set: "m11",
      collector_number: "149",
      lang: "en",
      finishes: ["nonfoil"],
    })),
  });
  await page.route("**/api/search?*", (r) =>
    r.fulfill({
      json: {
        cards: [
          {
            id: "scan-test",
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
  await page.goto("/#home");
  await page.locator("#scan").click();
  const buffer = await page.screenshot();
  for (let i = 0; i < 6; i++) {
    await page
      .locator("#photo")
      .setInputFiles({ name: "fixture.png", mimeType: "image/png", buffer });
    await choosePossible(page);
    await expect(page.locator(".scan-option")).toHaveCount(i + 1);
  }
  const wheel = page.locator("#scan-wheel");
  await expect
    .poll(() =>
      wheel.evaluate((el) =>
        Math.abs(
          el.getBoundingClientRect().bottom -
            el.lastElementChild.getBoundingClientRect().bottom,
        ),
      ),
    )
    .toBeLessThan(2);
  await expect(
    page.locator('.scan-option[aria-selected="true"]'),
  ).toHaveAttribute("data-index", "5");
  await expect
    .poll(() =>
      wheel.evaluate((el) =>
        Math.abs(
          document.querySelector(".scan-footer").getBoundingClientRect().top -
            el.lastElementChild.getBoundingClientRect().bottom,
        ),
      ),
    )
    .toBeLessThan(2);
  await page.screenshot({
    path: test.info().outputPath("scanner-newest-bottom.png"),
  });
  await wheel.press("ArrowUp");
  await expect(
    page.locator('.scan-option[aria-selected="true"]'),
  ).toHaveAttribute("data-index", "4");
  await expect
    .poll(() =>
      wheel.evaluate((el) => {
        const row = el.querySelector('[aria-selected="true"]');
        return Math.abs(
          row.offsetTop +
            row.offsetHeight / 2 -
            el.scrollTop -
            el.clientHeight / 2,
        );
      }),
    )
    .toBeLessThan(2);
  expect(
    await wheel.evaluate((el) => {
      const row = el
          .querySelector('[aria-selected="true"]')
          .getBoundingClientRect(),
        next = el.lastElementChild.getBoundingClientRect();
      return (
        next.top >= row.bottom - 1 &&
        next.bottom <= el.getBoundingClientRect().bottom
      );
    }),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("scanner-older-centered.png"),
  });
  await page.locator(".scan-plus").click();
  await expect(page.locator("#scan-controls output")).toHaveText("2");
  await wheel.press("End");
  await expect(page.locator("#scan-controls output")).toHaveText("1");
  await expect
    .poll(() =>
      wheel.evaluate((el) =>
        Math.abs(
          el.getBoundingClientRect().bottom -
            el.lastElementChild.getBoundingClientRect().bottom,
        ),
      ),
    )
    .toBeLessThan(2);
  await page.locator("#scan-back").click();
  await expect(page.locator(".draft-row")).toHaveCount(6);
  await expect(page.locator("#draft-add")).toBeEnabled();
});
