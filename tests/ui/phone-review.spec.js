import { randomUUID } from "node:crypto";
import { test, expect } from "./fixtures.js";
import { fixture, card, alt } from "../helpers/import-page-fixture.js";
import { mockVisualReading } from "./visual-fixture.js";

const payload = (count) => ({
  id: randomUUID(),
  kind: "scan",
  rows: Array.from({ length: count }, () => ({
    id: randomUUID(),
    name: card.name,
    printing_id: card.id,
    quantity: 1,
    finish: "nonfoil",
    condition: "NM",
  })),
});

test("UC-SCAN-IMPORT Home Scan waits for saved captures before accepting the first tap", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.route("**/review-cache.js", async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = "read: async (key) => {";
    expect(source).toContain(marker);
    await route.fulfill({
      response,
      body: source.replace(
        marker,
        marker +
          " await new Promise(resolve => { window.releaseCaptureRead = resolve; });",
      ),
    });
  });
  try {
    await page.goto("/", { waitUntil: "commit" });
    await expect
      .poll(() => page.evaluate(() => typeof window.releaseCaptureRead))
      .toBe("function");
    await expect(page.locator("#scan")).toBeVisible();
    await expect(page.locator("#scan")).toBeDisabled();
    await expect(page.locator("#scan")).toHaveAttribute("aria-busy", "true");
    await page.evaluate(() => window.releaseCaptureRead());
    await expect(page.locator("#scan")).toBeEnabled();
    await page.locator("#scan").click();
    await expect(page.locator(".scanner-dialog")).toBeVisible();
    await expect(page.locator("#scan-count")).toHaveText("0 queued · 0 copies");
    expect(await f.tagged.list("test")).toEqual([]);
  } finally {
    f.db.close();
  }
});

test("UC-SCAN-IMPORT mobile fifty-line shared Import survives lost Add response, double tap and reload without duplicates", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await fixture(page);
  try {
    const staged = await f.drafts.stageDraft("test", payload(50));
    const other = await f.drafts.stageDraft("test", payload(1));
    await page.goto("/#import=" + staged.draft.id);
    await expect(page.locator(".draft-row")).toHaveCount(50);
    await expect(page.locator(".draft-date-group")).toHaveCount(1);
    await expect(page.locator("[data-draft]")).toHaveCount(2);
    expect(await f.tagged.list("test")).toEqual([]);
    expect(
      await page.locator(".batch-dialog, #review-page, #save-batch").count(),
    ).toBe(0);
    f.loseAddResponse();
    await page.locator("#draft-add").dblclick();
    await expect(page.locator(".import-status")).toContainText(
      "Response interrupted",
    );
    await expect(page.locator(".draft-row")).toHaveCount(50);
    expect(f.counts().ownedWrites).toBe(1);
    expect((await f.tagged.list("test"))[0].quantity).toBe(50);
    const reads = f.counts().collectionReads;
    await page.locator("#draft-add").click();
    await expect(page.locator(".import-status")).toContainText(
      "Added 50 new copies",
    );
    expect(f.counts().collectionReads - reads).toBe(0);
    expect((await f.tagged.list("test"))[0].quantity).toBe(50);
    await page.locator(`[data-draft="${other.draft.id}"]`).click();
    await expect(page.locator(".draft-row")).toHaveCount(1);
    await page.reload();
    await expect(page.locator(".draft-row")).toHaveCount(1);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath("shared-import-mobile.png"),
      fullPage: true,
    });
  } finally {
    f.db.close();
  }
});

test("UC-SCAN-IMPORT scanner hands off to saved Import with condition editing; Back restores origin", async ({
  page,
}) => {
  const f = await fixture(page);
  await mockVisualReading(page, { card });
  try {
    await page.goto("/#collection");
    await page.locator("#scan").click();
    const png = await page.screenshot();
    await page.locator("#photo").setInputFiles({
      name: "controlled.png",
      mimeType: "image/png",
      buffer: png,
    });
    await expect(page.locator("#scan-count")).toHaveText("1 queued · 1 copies");
    await page.locator("#scan-review").click();
    await expect(page).toHaveURL(/#import=/);
    await expect(page.locator(".scanner-dialog")).not.toBeVisible();
    await expect(page.locator(".draft-row")).toHaveCount(1);
    expect(await f.tagged.list("test")).toEqual([]);
    await page.getByLabel("Quantity for line 1", { exact: true }).fill("2");
    await page.getByLabel("Quantity for line 1", { exact: true }).press("Tab");
    await expect(page.locator("#draft-add")).toBeEnabled();
    await page
      .getByLabel("Condition for line 1", { exact: true })
      .selectOption("LP");
    await expect(page.locator("#draft-add")).toBeEnabled();
    await page.locator("#draft-back").click();
    await expect(page).toHaveURL(/#collection$/);
    await page.locator("#import-nav").click();
    await expect(
      page.getByLabel("Quantity for line 1", { exact: true }),
    ).toHaveValue("2");
    await page.reload();
    await expect(
      page.getByLabel("Condition for line 1", { exact: true }),
    ).toHaveValue("LP");
    await page.locator("#draft-add").click();
    await expect(page.locator(".import-status")).toContainText(
      "Added 2 new copies",
    );
    const [owned] = await f.tagged.list("test");
    expect(owned.quantity).toBe(2);
    expect(owned.condition).toBe("LP");
    expect(owned.created_at).toBeTruthy();
    expect(owned.updated_at).toBeTruthy();
    await page.goto(
      `/#card=${card.id}&oracle=${card.oracle_id}&entry=${encodeURIComponent(owned.id)}`,
    );
    await expect(page.locator("#remove")).toBeVisible();
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#remove").click();
    await expect.poll(async () => (await f.tagged.list("test")).length).toBe(0);
    await page.reload();
    expect(await f.tagged.list("test")).toEqual([]);
  } finally {
    f.db.close();
  }
});

test("UC-IMPORT-TEXT limits and unresolved printings cannot add ownership; correction and Clear use Import", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    await page.goto("/#import");
    await page.locator("#draft-show-text").click();
    await page
      .locator("#import-text")
      .fill(Array(51).fill("1 Draft Test Card").join("\n"));
    await page.locator("#draft-text-form button").click();
    await expect(page.locator(".import-status")).toContainText("1–50 valid");
    await page.locator("#import-text").fill("2 Draft Test Card");
    await page.locator("#draft-text-form button").click();
    await expect(page.locator(".draft-row")).toHaveCount(1);
    await expect(page.locator("#draft-add")).toBeDisabled();
    await page.getByRole("button", { name: "Change printing" }).click();
    await expect(page.locator(".draft-printing-choice")).toHaveCount(2);
    await page.locator(".draft-printing-choice").first().click();
    await expect(page.locator("#draft-add")).toBeEnabled();
    expect(await f.tagged.list("test")).toEqual([]);
    await page.locator("#draft-clear").click();
    await expect(page.locator(".draft-row")).toHaveCount(0);
  } finally {
    f.db.close();
  }
});

test("UC-IMPORT-TEXT an interrupted stage survives reload without replacing another draft", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    await f.drafts.stageDraft("test", payload(1));
    await page.goto("/#import");
    await page.locator(".new-import summary").click();
    await page.locator("#draft-show-text").click();
    await page.locator("#import-text").fill("2 Draft Test Card");
    f.loseStageResponse();
    await page.locator("#draft-text-form button").click();
    await expect(page.locator(".import-status")).toContainText(
      "Stage response interrupted",
    );
    await expect(page.locator("#import-text")).toBeDisabled();
    await page.reload();
    await expect(page.locator("[data-draft]")).toHaveCount(2);
    await expect(page.locator("#import-text")).toHaveValue("2 Draft Test Card");
    await page.locator("#draft-text-form button").click();
    await expect(
      page.getByLabel("Quantity for line 1", { exact: true }),
    ).toHaveValue("2");
    await page.reload();
    await expect(page.locator("[data-draft]")).toHaveCount(2);
    expect(await f.tagged.list("test")).toEqual([]);
  } finally {
    f.db.close();
  }
});

test("UC-SCAN-IMPORT corrupt capture storage blocks new scans while saved account imports remain usable", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    await f.drafts.stageDraft("test", payload(1));
    await page.addInitScript(() => {
      const get = Storage.prototype.getItem;
      Storage.prototype.getItem = function (key) {
        if (key.startsWith("keeper-review-journal:"))
          return JSON.stringify({
            id: "preserve",
            revision: 999,
            rows: { invalid: true },
          });
        if (key.startsWith("keeper-pending-text:"))
          throw new DOMException("Blocked", "SecurityError");
        return get.call(this, key);
      };
    });
    await page.goto("/#import");
    await expect(page.locator(".draft-row")).toHaveCount(1);
    await expect(page.locator("#draft-add")).toBeEnabled();
    await page
      .getByRole("button", { name: "View collection", exact: true })
      .click();
    await page.locator("#scan").click();
    await expect(page.locator(".scanner-dialog")).not.toBeVisible();
    await expect(
      page.getByText(
        "Saved captures are invalid. Reload before starting another scan.",
        { exact: true },
      ),
    ).toBeVisible();
    expect(await f.tagged.list("test")).toEqual([]);
  } finally {
    f.db.close();
  }
});

test("UC-SCAN-RACE late alternatives preserve edited quantity and printing without another capture", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.route("**/scan-recognition.js", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `
    const first=${JSON.stringify(card)},later=${JSON.stringify(alt)};
    export function createScanRecognition(){return {kind:'hybrid',prepare:async()=>{},dispose(){},recognize:async(canvas,{onUpdate})=>{
      window.deliverLate=()=>onUpdate({name:later.name,status:'possible',selected:later,candidates:[first,later],suggested:true,finish:'foil',recognition:[{printing_id:first.id,provider:'browser-onnx',evidence:'visual'},{printing_id:later.id,provider:'lambda',evidence:'visible-title-ocr'}]});
      return {name:first.name,status:'possible',selected:first,candidates:[first],suggested:true,finish:'nonfoil'};
    }};}`,
    }),
  );
  try {
    await page.goto("/#collection");
    await page.locator("#scan").click();
    await page.locator("#photo").setInputFiles({
      name: "controlled.png",
      mimeType: "image/png",
      buffer: await page.screenshot(),
    });
    await expect(page.locator("#scan-count")).toHaveText("1 queued · 1 copies");
    await page.locator(".scan-plus").click();
    await page.evaluate(() => window.deliverLate());
    await expect(page.locator("#scan-count")).toHaveText("1 queued · 2 copies");
    await page.locator("#scan-review").click();
    await expect(page.locator(".draft-row")).toHaveCount(1);
    await expect(
      page.getByLabel("Finish for line 1", { exact: true }),
    ).toHaveValue("nonfoil");
    await expect(
      page.getByLabel("Quantity for line 1", { exact: true }),
    ).toHaveValue("2");
    const before = await f.drafts.getDraft("test");
    expect(before.draft.rows[0].printing_id).toBe(card.id);
    expect(before.draft.rows[0].recognition_candidates).toHaveLength(2);
    await page.evaluate(() => window.deliverLate());
    await page.reload();
    await expect(
      page.getByLabel("Quantity for line 1", { exact: true }),
    ).toHaveValue("2");
    expect(await f.tagged.list("test")).toEqual([]);
  } finally {
    f.db.close();
  }
});
