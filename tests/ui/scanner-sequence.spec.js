import { test, expect } from "./fixtures.js";

test("SCAN-10 stable unchanged camera accepts A,B,A, suppresses consecutive identity jitter and ignores late identity changes", async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName === "webkit",
    "Windows WebKit does not provide canvas captureStream",
  );
  await page.route("**/scan-audio.js", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `export function createScanAudio(){return {activate:async()=>{},close:async()=>{},setMuted(){},cue(kind){window.sequenceCues.push(kind)}}}`,
    }),
  );
  await page.goto("/#collection");
  await page.evaluate(async () => {
    window.sequenceCues = [];
    window.sequenceRows = [];
    window.sequenceCalls = 0;
    window.sequencePeak = 0;
    let active = 0;
    const a = {
      id: "printing-a",
      oracle_id: "oracle-a",
      name: "Card A",
      finishes: ["nonfoil"],
    };
    window.sequenceNext = a;
    navigator.mediaDevices.getUserMedia = async () => {
      const c = document.createElement("canvas");
      c.width = 720;
      c.height = 960;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, 720, 960);
      ctx.fillStyle = "black";
      for (let y = 0; y < 960; y += 40) ctx.fillRect(100, y, 500, 20);
      return c.captureStream(15);
    };
    const reading = (card) => ({
      selected: card,
      candidates: card ? [card] : [],
      name: card?.name,
      status: card ? "possible" : "unknown",
      suggested: !!card,
    });
    window.sequenceReading = reading;
    const { createScanner } = await import("/scanner.js");
    createScanner({
      api: () => {},
      onReview: () => {},
      onRows: (rows) => (window.sequenceRows = structuredClone(rows)),
      recognition: {
        kind: "test",
        prepare: async () => {},
        dispose() {},
        async recognize(canvas, options) {
          window.sequenceCalls++;
          active++;
          window.sequencePeak = Math.max(active, window.sequencePeak);
          if (window.sequenceCalls === 1)
            window.sequenceLate = options.onUpdate;
          const card = window.sequenceNext;
          await new Promise((r) => setTimeout(r, 80));
          active--;
          return reading(card);
        },
      },
    }).open();
  });
  await page.locator("#camera-start").click();
  await expect(page.locator("#scan-count")).toHaveText("1 queued · 1 copies");
  await page.evaluate(
    () =>
      (window.sequenceNext = {
        id: "other-printing-a",
        oracle_id: "oracle-a",
        name: "Card A",
        finishes: ["foil"],
      }),
  );
  await expect(page.locator("#scan-status")).toContainText("Same card ignored");
  await expect(page.locator("#scan-count")).toHaveText("1 queued · 1 copies");
  await page.evaluate(() => (window.sequenceNext = null));
  await expect(page.locator("#scan-status")).toContainText("No copy counted");
  await page.evaluate(
    () =>
      (window.sequenceNext = {
        id: "printing-b",
        oracle_id: "oracle-b",
        name: "Card B",
        finishes: ["nonfoil"],
      }),
  );
  await expect(page.locator("#scan-count")).toHaveText("2 queued · 2 copies");
  await page.evaluate(() =>
    window.sequenceLate(window.sequenceReading(window.sequenceNext)),
  );
  expect(
    await page.evaluate(() =>
      window.sequenceRows.map((r) => r.selected.oracle_id),
    ),
  ).toEqual(["oracle-a", "oracle-b"]);
  await page.evaluate(
    () =>
      (window.sequenceNext = {
        id: "printing-a",
        oracle_id: "oracle-a",
        name: "Card A",
        finishes: ["nonfoil"],
      }),
  );
  await expect(page.locator("#scan-count")).toHaveText("3 queued · 3 copies");
  await page.locator("#scan-back").click();
  expect(
    await page.evaluate(() =>
      window.sequenceRows.map((r) => r.selected.oracle_id),
    ),
  ).toEqual(["oracle-a", "oracle-b", "oracle-a"]);
  expect(
    await page.evaluate(
      () => window.sequenceCues.filter((k) => k === "success").length,
    ),
  ).toBe(3);
  expect(await page.evaluate(() => window.sequencePeak)).toBe(1);
  const calls = await page.evaluate(() => window.sequenceCalls);
  await page.waitForTimeout(1200);
  expect(await page.evaluate(() => window.sequenceCalls)).toBe(calls);
});
