import { test, expect } from "./fixtures.js";
import { randomUUID } from "node:crypto";
import { fixture, card as draftCard } from "../helpers/import-page-fixture.js";
import { mockVisualReading } from "./visual-fixture.js";

const cards = [1, 2].map((value) => ({
  id: `${value}1111111-1111-4111-8111-111111111111`,
  oracle_id: `${value}2222222-2222-4222-8222-222222222222`,
  name: `Scan batch card ${value}`,
  finishes: ["nonfoil"],
  set: "tst",
  collector_number: String(value),
  lang: "en",
}));
async function batchStore(page) {
  const batches = new Map();
  let fail = true,
    calls = 0;
  await page.route("**/api/scan-session/batch", async (route) => {
    const input = route.request().postDataJSON();
    calls++;
    if (batches.has(input.batch.id))
      expect(input).toEqual(batches.get(input.batch.id));
    else batches.set(input.batch.id, input);
    if (fail) {
      fail = false;
      return route.fulfill({
        status: 503,
        json: { error: "Lost batch response" },
      });
    }
    return route.fulfill({
      json: {
        staged_id: input.batch.id,
        session_id: input.id,
        index: input.index,
      },
    });
  });
  await page.route("**/api/import-draft?*", async (route) => {
    const all = [...batches.values()];
    const input =
      batches.get(new URL(route.request().url()).searchParams.get("id")) ||
      all.at(-1);
    const rows = input.batch.rows.map((row) => ({
      ...row,
      card: cards.find((card) => card.id === row.printing_id),
      in_deck: false,
      locations: [],
      tag_ids: [],
      recognition_candidates: [],
      original: {
        ...row,
        name: row.name,
        section: "mainboard",
        set: "tst",
        collector_number: "1",
        capture_kind: "scan",
      },
    }));
    return route.fulfill({
      json: {
        draft: {
          id: input.batch.id,
          version: 1,
          provider: "reviewed-capture",
          name: `Scanned cards · batch ${input.index}`,
          rows,
          original: { total: rows.length, excluded: [] },
        },
        pending_drafts: [
          {
            id: input.id,
            kind: "capture",
            name: "Continuous scan",
            copies: all.reduce((n, x) => n + x.batch.rows.length, 0),
          },
        ],
        summary: {
          source_copies: rows.length,
          reviewed_copies: rows.length,
          additions: rows.length,
          errors: [],
          can_add: true,
        },
        scan_session: {
          id: input.id,
          batch_id: input.batch.id,
          index: input.index,
          batches: all.length,
          pending_batches: all.length,
          previous: all[input.index - 2]?.batch.id || null,
          next: all[input.index]?.batch.id || null,
        },
      },
    });
  });
  return { batches, calls: () => calls };
}
test("SCAN-12/13 photo batches recover a lost response, retain identity across rollover/reload and review bounded history", async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/collection", (route) => route.fulfill({ json: [] }));
  await mockVisualReading(page, { card: cards[0] });
  const store = await batchStore(page);
  await page.goto("/#home");
  await page.locator("#scan").click();
  const buffer = await page.screenshot();
  const upload = async (card) => {
    await expect(page.locator("#photo")).toBeEnabled();
    await page.evaluate((card) => {
      window.testRecognitionCard = card;
    }, card);
    await page
      .locator("#photo")
      .setInputFiles({ name: "card.png", mimeType: "image/png", buffer });
  };
  for (let i = 1; i <= 50; i++) {
    await upload(cards[(i - 1) % 2]);
    if (i < 50)
      await expect(page.locator("#scan-count")).toHaveText(
        `${i} queued · ${i} copies`,
      );
  }
  await expect(page.locator("#scan-save-retry")).toBeVisible();
  await expect(page.locator("#scan-count")).toHaveText("50 queued · 50 copies");
  await expect(page.locator("#photo")).toBeDisabled();
  await expect(page.locator(".scan-plus")).toBeDisabled();
  await page.screenshot({
    path: test.info().outputPath("paused-batch-mobile.png"),
  });
  await page.locator("#scan-save-retry").click();
  await expect(page.locator("#scan-count")).toHaveText("0 queued · 0 copies");
  expect(store.calls()).toBe(2);
  expect(store.batches.size).toBe(1);
  await expect(page.locator(".scan-option")).toHaveCount(10);
  await upload(cards[1]);
  await expect(page.locator("#scan-status")).toContainText("Same card ignored");
  await expect(page.locator("#scan-count")).toHaveText("0 queued · 0 copies");
  for (let i = 1; i <= 11; i++) {
    await upload(cards[(i - 1) % 2]);
    await expect(page.locator("#scan-count")).toHaveText(
      `${i} queued · ${i} copies`,
    );
  }
  await page.reload();
  await page.locator("#scan").click();
  await expect(page.locator("#scan-count")).toHaveText("11 queued · 11 copies");
  await upload(cards[0]);
  await expect(page.locator("#scan-status")).toContainText("Same card ignored");
  await expect(page.locator(".scan-option")).toHaveCount(21);
  await page.screenshot({
    path: test.info().outputPath("resumed-batch-mobile.png"),
  });
  await page.locator("#scan-review").click();
  await expect(page.locator(".draft-row")).toHaveCount(11);
  await page.getByRole("button", { name: "Previous batch" }).click();
  await expect(page.locator(".draft-row")).toHaveCount(50);
  await page.getByRole("button", { name: "Next batch" }).click();
  await expect(page.locator(".draft-row")).toHaveCount(11);
  await page.screenshot({
    path: test.info().outputPath("bounded-batch-review.png"),
    fullPage: true,
  });
  expect(store.batches.size).toBe(2);
  const ids = [...store.batches.values()].flatMap((x) =>
    x.batch.rows.map((r) => r.id),
  );
  expect(new Set(ids).size).toBe(61);
});

test("SCAN-12 camera remains active across automatic 50-card rollover without a session attempt cutoff", async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName === "webkit",
    "Canvas camera stream is unavailable in Windows WebKit",
  );
  test.setTimeout(150000);
  await page.route("**/api/collection", (route) => route.fulfill({ json: [] }));
  const readings = Array.from({ length: 50 }, (_, i) => cards[i % 2]);
  readings.push(cards[1], cards[0], cards[1], cards[0]);
  await mockVisualReading(page, { cards: readings });
  const store = await batchStore(page);
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 480;
      canvas.height = 680;
      const context = canvas.getContext("2d");
      context.fillStyle = "white";
      context.fillRect(0, 0, 480, 680);
      context.fillStyle = "black";
      for (let y = 0; y < 680; y += 30) context.fillRect(80, y, 320, 15);
      window.batchStream = canvas.captureStream(15);
      return window.batchStream;
    };
  });
  await page.goto("/#home");
  await page.locator("#scan").click();
  await page.locator("#camera-start").click();
  await expect(page.locator("#scan-save-retry")).toBeVisible({
    timeout: 120000,
  });
  expect(
    await page.evaluate(() => window.batchStream.getTracks()[0].readyState),
  ).toBe("live");
  await page.locator("#scan-save-retry").click();
  await expect(page.locator("#scan-count")).toHaveText("3 queued · 3 copies", {
    timeout: 20000,
  });
  await expect(page.locator("#camera-start")).toBeHidden();
  await expect(page.locator(".scan-option")).toHaveCount(13);
  expect(store.batches.size).toBe(1);
  expect(
    await page.evaluate(() => window.batchStream.getTracks()[0].readyState),
  ).toBe("live");
  await page.locator("#scan-back").click();
  await expect(page.locator(".draft-row")).toHaveCount(3);
  expect(
    await page.evaluate(() => window.batchStream.getTracks()[0].readyState),
  ).toBe("ended");
});

test("SCAN-12 historical batch Add and Clear preserve navigation and atomic pending counters", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await fixture(page),
    id = randomUUID(),
    ids = [];
  try {
    for (const [offset, size] of [2, 3, 1].entries()) {
      const batchId = randomUUID();
      ids.push(batchId);
      await f.drafts.stageScanBatch("test", {
        id,
        index: offset + 1,
        last_oracle: draftCard.oracle_id,
        batch: {
          id: batchId,
          kind: "scan",
          rows: Array.from({ length: size }, () => ({
            id: randomUUID(),
            name: draftCard.name,
            printing_id: draftCard.id,
            quantity: 1,
            finish: "nonfoil",
            condition: "NM",
          })),
        },
      });
    }
    await page.goto("/#import=" + id);
    await expect(page.locator(".draft-row")).toHaveCount(1);
    await page
      .getByRole("button", { name: "Previous batch", exact: true })
      .click();
    await expect(page.locator(".draft-row")).toHaveCount(3);
    await page.locator("#draft-add").click();
    await expect(page.locator(".draft-row")).toHaveCount(0);
    expect((await f.tagged.list("test"))[0].quantity).toBe(3);
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Next batch", exact: true }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Next batch", exact: true }).click();
    await expect(page.locator(".draft-row")).toHaveCount(1);
    await page.locator("#draft-clear").click();
    await expect(page.locator(".draft-row")).toHaveCount(0);
    const latest = await f.drafts.getDraft("test", { id });
    expect(latest.scan_session.pending_batches).toBe(1);
    expect(latest.scan_session.pending_copies).toBe(2);
    expect((await f.tagged.list("test"))[0].quantity).toBe(3);
    await page.screenshot({
      path: test.info().outputPath("completed-batch-mobile.png"),
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Previous batch", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Previous batch", exact: true }),
    ).toBeEnabled();
    await page
      .getByRole("button", { name: "Previous batch", exact: true })
      .click();
    await expect(page.locator(".draft-row")).toHaveCount(2);
  } finally {
    f.db.close();
  }
});
