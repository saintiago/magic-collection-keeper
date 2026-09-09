// Controlled UI fixtures; actual model accuracy is tested separately.
export async function mockVisualReading(
  page,
  { card, delayMs = 0, failFirst = false, failAlways = false },
) {
  await page.route("**/browser-recognition.js", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `export function createBrowserRecognition(){let count=0;return {kind:"browser-onnx",prepare:async()=>({}),dispose(){},async recognize(canvas,{signal}){count++;if(${delayMs})await new Promise(r=>setTimeout(r,${delayMs}));signal?.throwIfAborted();if(${failAlways}||(${failFirst}&&count===1))throw Error("Controlled recognition failure");const card=${JSON.stringify(card)};return {name:card?.name,status:card?"possible":"unknown",candidates:card?[card]:[],selected:card||null,suggested:Boolean(card),finish:card?.finishes[0]||"nonfoil"};}}}`,
    }),
  );
}
const queued = new WeakMap();
export async function choosePossible(page, expected) {
  const count = expected ?? (queued.get(page) || 0) + 1;
  await page
    .locator(".scan-option")
    .nth(count - 1)
    .waitFor({ state: "visible" });
  queued.set(page, count);
}
