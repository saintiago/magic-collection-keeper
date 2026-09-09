import { test as base, expect } from "@playwright/test";
import { mockCaptureDrafts } from "../helpers/capture-draft-fixture.js";
// Existing interaction fixtures deliberately exercise the supported server path.
// hybrid-search.spec.js uses real workers and its own complete public index fixture.
export const test = base.extend({
  realCardPresence: [false, { option: true }],
  serverNames: [
    async ({ page, realCardPresence }, use, testInfo) => {
      if (realCardPresence)
        await page.addInitScript(() => {
          window.geometryMeasurements = [];
          const NativeWorker = window.Worker;
          window.geometryWorkerEvents = [];
          window.Worker = class extends NativeWorker {
            constructor(url, options) {
              super(url, options);
              if (String(url).includes("card-presence-worker")) {
                const began = performance.now();
                this.addEventListener("message", (event) => {
                  window.geometryWorkerEvents.push({
                    ms: performance.now() - began,
                    type: event.data.type,
                    state: event.data.result?.state,
                    workerMs: event.data.result?.elapsedMs,
                    message: event.data.message,
                  });
                  if (window.geometryWorkerEvents.length > 50)
                    window.geometryWorkerEvents.shift();
                });
                this.addEventListener("error", (event) =>
                  window.geometryWorkerEvents.push({
                    ms: performance.now() - began,
                    error: event.message,
                  }),
                );
              }
            }
          };
          window.addEventListener(
            "keeper-card-geometry-measurement",
            (event) => {
              window.geometryMeasurements.push(event.detail);
              if (window.geometryMeasurements.length > 100)
                window.geometryMeasurements.shift();
            },
          );
        });
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
      try {
        await use();
      } finally {
        if (realCardPresence) {
          const measurements = await page
            .evaluate(() => ({
              status: document.querySelector("#scan-status")?.textContent,
              preparation:
                document.querySelector("#scan-preparation")?.textContent,
              frames: window.geometryMeasurements || [],
              worker: window.geometryWorkerEvents || [],
            }))
            .catch(() => ({ unavailable: true }));
          console.log("Actual geometry timings", JSON.stringify(measurements));
          await testInfo.attach("geometry-timings", {
            body: JSON.stringify(measurements),
            contentType: "application/json",
          });
        }
      }
    },
    { auto: true },
  ],
});
export { expect };
