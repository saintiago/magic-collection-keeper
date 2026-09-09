import { test, expect } from "./fixtures.js";
const card = {
  id: "00000000-0000-4000-8000-000000000001",
  oracle_id: "00000000-0000-4000-8000-000000000002",
  name: "Sol Ring",
  set: "cmm",
  collector_number: "396",
  lang: "en",
  finishes: ["nonfoil"],
  games: ["paper"],
};
async function setup(page, browserBody) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/config.json", (r) =>
    r.fulfill({ json: { local: true, backendRecognition: true } }),
  );
  await page.route("**/api/collection", (r) => r.fulfill({ json: [] }));
  await page.route("**/api/card?*", (r) =>
    r.fulfill({ json: { cards: [card], total: 1, hasMore: false } }),
  );
  await page.route("**/browser-recognition.js", (r) =>
    r.fulfill({
      contentType: "text/javascript",
      body:
        browserBody ||
        `export function createBrowserRecognition(){return {kind:"browser-onnx",prepare:async()=>{throw Error("Controlled model failure")},dispose(){},recognize:async()=>{throw Error("Controlled model failure")}}}`,
    }),
  );
  await page.goto("/");
  await page.locator("#scan").click();
  const image = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 200;
    c.height = 300;
    return c.toDataURL("image/png").split(",")[1];
  });
  return {
    name: "synthetic.png",
    mimeType: "image/png",
    buffer: Buffer.from(image, "base64"),
  };
}
test("UC-36 backend candidates remain optional until printing choice and final ownership review", async ({
  page,
}) => {
  let writes = 0;
  page.on("request", (r) => {
    if (r.method() !== "GET" && r.url().includes("/api/collection")) writes++;
  });
  await page.route("**/api/recognize", (r) =>
    r.fulfill({
      json: {
        contractVersion: 1,
        attempt: r.request().postDataJSON().attempt,
        status: "possible",
        selected: null,
        candidates: [card],
      },
    }),
  );
  const photo = await setup(page);
  await expect(page.locator(".recognition-notice")).toHaveCount(0);
  await page.locator("#scan-back").click();
  await page.locator("#recognition-info").click();
  await page.route("**/api/recognition/source", (r) =>
    r.fulfill({
      contentType: "application/zip",
      body: "synthetic source download test",
    }),
  );
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download Recognition source (AGPL-3.0)" })
    .click();
  expect((await download).suggestedFilename()).toBe(
    "keeper-recognition-source.zip",
  );
  await page.getByRole("button", { name: "Close about" }).click();
  await page.locator("#scan").click();
  await page.locator("#photo").setInputFiles(photo);
  await expect(page.locator("#scan-count")).toHaveText("1 queued · 1 copies");
  await expect(page.locator("#scan-possible")).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath("backend-candidate-selected.png"),
  });
  await page.locator("#scan-review").click();
  await expect(page.locator("#import-page")).toBeVisible();
  expect(writes).toBe(0);
});
test("UC-37 stalled preparation and unavailable cloud allow a bounded retry then recover without counting an unresolved card", async ({
  page,
}) => {
  let writes = 0;
  page.on("request", (r) => {
    if (r.method() !== "GET" && r.url().includes("/api/collection")) writes++;
  });
  await page.route("**/api/recognize", (r) =>
    r.fulfill({
      status: 503,
      json: { error: "Controlled unavailable service" },
    }),
  );
  const photo = await setup(
    page,
    `export function createBrowserRecognition(){ const ready=new Promise(resolve=>window.finishModels=resolve); return {kind:"browser-onnx", prepare:()=>ready, dispose(){}, recognize:async()=>({status:"possible",selected:${JSON.stringify(card)},suggested:true,name:"Sol Ring",candidates:[${JSON.stringify(card)}]})}; }`,
  );
  await page.locator("#photo").setInputFiles(photo);
  await expect(page.locator("#scan-status")).toContainText(
    "Scanner is still preparing",
    { timeout: 15000 },
  );
  await expect(page.locator("#scan-count")).toHaveText("0 queued · 0 copies");
  await page.evaluate(() => window.finishModels());
  await expect(page.locator("#scan-preparation")).toContainText(
    "Scanner ready",
  );
  await page.locator("#photo").setInputFiles(photo);
  await expect(page.locator("#scan-count")).toHaveText("1 queued · 1 copies");
  expect(writes).toBe(0);
});
test("UC-37 a retry after transient cloud preparation failure clears the unavailable status", async ({
  page,
}) => {
  let requests = 0;
  await page.route("**/api/recognize", (r) => {
    if (requests++ === 0)
      return r.fulfill({
        status: 503,
        json: { error: "Controlled temporary failure" },
      });
    return r.fulfill({
      json: {
        contractVersion: 1,
        attempt: r.request().postDataJSON().attempt,
        status: "possible",
        selected: null,
        candidates: [card],
      },
    });
  });
  const photo = await setup(page);
  await expect(page.locator("#scan-preparation")).toContainText(
    "Recognition unavailable",
  );
  await page.locator("#photo").setInputFiles(photo);
  await expect(page.locator("#scan-count")).toHaveText("1 queued · 1 copies");
  await expect(page.locator("#scan-preparation")).toHaveText("Scanner ready.");
});
test("UC-36 busy, unknown and unapproved confirmations add no copy; closing cancels late recognition", async ({
  page,
}) => {
  let mode = "busy";
  let pending;
  function holdNextResponse() {
    let start, release, finish;
    const started = new Promise((resolve) => (start = resolve));
    const released = new Promise((resolve) => (release = resolve));
    const finished = new Promise((resolve) => (finish = resolve));
    pending = { start, released, finish };
    return { started, release, finished };
  }
  await page.route("**/api/recognize", async (r) => {
    if (r.request().postDataJSON().attempt === 100000)
      return r.fulfill({
        json: {
          contractVersion: 1,
          attempt: 100000,
          status: "unknown",
          candidates: [],
          selected: null,
        },
      });
    const responseMode = mode;
    const gate = pending;
    gate.start();
    await gate.released;
    await r
      .fulfill(
        responseMode === "busy"
          ? { status: 429, json: { error: "Scanner busy" } }
          : {
              json: {
                contractVersion: 1,
                attempt: r.request().postDataJSON().attempt,
                status:
                  responseMode === "confirmed"
                    ? "confirmed"
                    : responseMode === "late"
                      ? "possible"
                      : "unknown",
                candidates: [card],
              },
            },
      )
      .catch(() => {});
    gate.finish();
  });
  const photo = await setup(page);
  for (const next of ["busy", "unknown", "confirmed"]) {
    mode = next;
    const response = holdNextResponse();
    await page.locator("#photo").setInputFiles(photo);
    await response.started;
    await expect(page.locator("#scan-status")).toContainText("Reading card");
    response.release();
    await response.finished;
    await expect(page.locator("#scan-status")).toContainText(
      next === "unknown" ? "No copy counted" : "Recognition failed",
    );
    await expect(page.locator("#scan-count")).toHaveText("0 queued · 0 copies");
    await expect(page.locator("#scan-possible")).toBeHidden();
  }
  mode = "late";
  const lateResponse = holdNextResponse();
  await page.locator("#photo").setInputFiles(photo);
  await lateResponse.started;
  await expect(page.locator("#scan-status")).toContainText("Reading card");
  await page.locator("#scan-back").click();
  lateResponse.release();
  await lateResponse.finished;
  await page.locator("#scan").click();
  await expect(page.locator("#scan-count")).toHaveText("0 queued · 0 copies");
  await expect(page.locator("#scan-possible")).toBeHidden();
});
