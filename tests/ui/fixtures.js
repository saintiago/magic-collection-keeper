import { test as base, expect } from "@playwright/test";
import { mockCaptureDrafts } from "../helpers/capture-draft-fixture.js";
// Existing interaction fixtures deliberately exercise the supported server path.
// hybrid-search.spec.js uses real workers and its own complete public index fixture.
export const test = base.extend({
  realCardPresence: [false, { option: true }],
  serverNames: [
    async ({ page, realCardPresence }, use) => {
      if (!realCardPresence)
        await page.route("**/card-presence.js", (route) =>
          route.fulfill({
            contentType: "text/javascript",
            body: `import {signature} from '/camera.js'; import {hasDetail} from '/scan-transition.js'; export function createCardPresence(){return {prepare:async()=>{},dispose(){},inspect:async canvas=>({state:window.testCardState||(canvas.capturedAt!==undefined&&!hasDetail(signature(canvas))?'none':'single'),regions:window.testCardRegions||[[[.1,.1],[.9,.1],[.9,.9],[.1,.9]]]})};}`,
          }),
        );
      await mockCaptureDrafts(page);
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
