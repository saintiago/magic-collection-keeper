import { test as base, expect } from "@playwright/test";
// Existing interaction fixtures deliberately exercise the supported server path.
// hybrid-search.spec.js uses real workers and its own complete public index fixture.
export const test = base.extend({
  serverNames: [
    async ({ page }, use) => {
      await page.route("**/catalog/current.json", (route) =>
        route.fulfill({
          status: 503,
          json: { error: "Server fallback fixture" },
        }),
      );
      await use();
    },
    { auto: true },
  ],
});
export { expect };
