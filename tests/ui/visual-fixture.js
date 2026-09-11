// Controlled UI fixtures; actual model accuracy is tested separately.
export async function mockVisualReading(
  page,
  { card, cards, delayMs = 0, failFirst = false, failAlways = false },
) {
  const readings = (cards || [card]).map((value) =>
    value ? { ...value, oracle_id: value.oracle_id || value.id } : null,
  );
  await page.route("**/browser-recognition.js", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `export function createBrowserRecognition(){let count=0;const readings=${JSON.stringify(readings)};return {kind:"browser-onnx",prepare:async()=>({}),dispose(){},async recognize(canvas,{signal}){count++;const card=window.testRecognitionCard||readings[Math.min(count-1,readings.length-1)];if(${delayMs})await new Promise(r=>setTimeout(r,${delayMs}));signal?.throwIfAborted();if(${failAlways}||(${failFirst}&&count===1))throw Error("Controlled recognition failure");return {name:card?.name,status:card?"possible":"unknown",candidates:card?[card]:[],selected:card||null,suggested:Boolean(card),finish:card?.finishes[0]||"nonfoil"};}}}`,
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
