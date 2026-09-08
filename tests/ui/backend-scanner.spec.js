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
async function setup(page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/config.json", (r) =>
    r.fulfill({ json: { local: true, backendRecognition: true } }),
  );
  await page.route("**/api/collection", (r) => r.fulfill({ json: [] }));
  await page.route("**/api/card?*", (r) =>
    r.fulfill({ json: { cards: [card], total: 1, hasMore: false } }),
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
  await expect(
    page.getByText("Card crops are sent securely", { exact: false }),
  ).toBeVisible();
  await page.route("**/api/recognition/source", (r) =>
    r.fulfill({
      contentType: "application/zip",
      body: "synthetic source download test",
    }),
  );
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Recognition source (AGPL-3.0)" })
    .click();
  expect((await download).suggestedFilename()).toBe(
    "keeper-recognition-source.zip",
  );
  await page.locator("#photo").setInputFiles(photo);
  await expect(page.locator("#scan-possible")).toBeVisible();
  await expect(page.locator("#scan-count")).toHaveText("0 matched · 0 copies");
  await page.locator("#scan-possible summary").click();
  await page.getByRole("button", { name: "Sol Ring · cmm #396 · en" }).click();
  await expect(page.locator("#scan-count")).toHaveText("1 matched · 1 copies");
  await page.screenshot({
    path: test.info().outputPath("backend-candidate-selected.png"),
  });
  await page.locator("#scan-review").click();
  await expect(page.locator(".batch-dialog")).toBeVisible();
  expect(writes).toBe(0);
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
    await expect(page.locator("#scan-status")).toContainText(
      "Reading card securely",
    );
    response.release();
    await response.finished;
    await expect(page.locator("#scan-status")).toContainText("No copy counted");
    await expect(page.locator("#scan-count")).toHaveText(
      "0 matched · 0 copies",
    );
    await expect(page.locator("#scan-possible")).toBeHidden();
  }
  mode = "late";
  const lateResponse = holdNextResponse();
  await page.locator("#photo").setInputFiles(photo);
  await lateResponse.started;
  await expect(page.locator("#scan-status")).toContainText(
    "Reading card securely",
  );
  await page.locator("#scan-back").click();
  lateResponse.release();
  await lateResponse.finished;
  await page.locator("#scan").click();
  await expect(page.locator("#scan-count")).toHaveText("0 matched · 0 copies");
  await expect(page.locator("#scan-possible")).toBeHidden();
});
