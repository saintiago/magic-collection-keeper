// Controlled UI fixtures; actual model accuracy is tested separately.
export async function mockVisualReading(
  page,
  { card, delayMs = 0, failFirst = false, failAlways = false },
) {
  await page.route("**/browser-recognition.js", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `export function createBrowserRecognition(){let count=0;return {kind:"browser-onnx",prepare:async()=>({}),dispose(){},async recognize(canvas,{signal}){count++;if(${delayMs})await new Promise(r=>setTimeout(r,${delayMs}));signal?.throwIfAborted();if(${failAlways}||(${failFirst}&&count===1))throw Error("Controlled recognition failure");const card=${JSON.stringify(card)};return {name:card?.name,status:card?"possible":"unknown",candidates:card?[card]:[],selected:null};}}}`,
    }),
  );
}
export async function choosePossible(page) {
  const panel = page.locator("#scan-possible");
  await panel.waitFor({ state: "visible" });
  if (!(await panel.evaluate((element) => element.open)))
    await panel.locator("summary").click();
  await panel.locator("[data-candidate]").first().click();
}
