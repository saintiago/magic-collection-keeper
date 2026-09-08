import { test, expect } from "@playwright/test";

async function fixture(page, { failFirst = false, slow = false } = {}) {
  await page.route("**/api/collection", (r) => r.fulfill({ json: [] }));
  await page.route("**/api/search?*", (r) =>
    r.fulfill({
      json: {
        cards: [
          {
            id: "scan-test",
            name: "Lightning Bolt",
            set: "m11",
            collector_number: "149",
            lang: "en",
            finishes: ["nonfoil"],
          },
        ],
        hasMore: false,
      },
    }),
  );
  await page.route("**/recognition.js", (r) =>
    r.fulfill({
      contentType: "text/javascript",
      body: `let count=0; export async function stopRecognition(){window.stoppedOCR=true;} export async function recognizeCard(){count++; ${slow ? "await new Promise(r=>setTimeout(r,3000));" : ""} if (${failFirst} && count===1) throw new Error("Unclear card"); return {name:"Lightning Bolt",text:"Lightning Bolt",confidence:95,exact:{set:"m11",number:"149",language:"en"}};}`,
    }),
  );
  await page.addInitScript(() => {
    const ActualAudio = window.AudioContext;
    window.cueNotes = [];
    window.AudioContext = class extends ActualAudio {
      createOscillator() {
        const oscillator = super.createOscillator(),
          start = oscillator.start.bind(oscillator);
        oscillator.start = (time) => {
          window.cueNotes.push(oscillator.frequency.value);
          start(time);
        };
        return oscillator;
      }
    };
    navigator.mediaDevices.getUserMedia = async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 800;
      canvas.height = 1000;
      window.paintCard = (mode) => {
        const context = canvas.getContext("2d");
        context.fillStyle = "#888";
        context.fillRect(0, 0, 800, 1000);
        if (mode !== "blank")
          for (let i = 0; i < 20; i++) {
            context.fillStyle = i % 2 ? "#ddd" : "#222";
            if (mode === "other") context.fillRect(0, i * 50, 800, 50);
            else context.fillRect(i * 40, 0, 40, 1000);
          }
      };
      window.paintCard("first");
      window.testStream = canvas.captureStream(15);
      return window.testStream;
    };
  });
  await page.goto("/#collection");
  await page.locator("#scan").click();
  await page.locator("#camera-start").click();
}
async function nextIdentical(page) {
  await page.evaluate(() => window.paintCard("blank"));
  await page.waitForTimeout(500);
  await page.evaluate(() => window.paintCard("first"));
}
test("UC-14 hands-free identical copies, stationary suppression, error cue recovery and safe review", async ({
  page,
}) => {
  await fixture(page, { failFirst: true });
  await expect(page.locator(".scan-option")).toHaveCount(1);
  await expect(page.locator("#scan-status")).toContainText(
    "Recognition failed",
  );
  await page.waitForTimeout(1700);
  await expect(page.locator(".scan-option")).toHaveCount(1);
  expect(await page.evaluate(() => window.cueNotes)).toEqual([230, 170]);
  await nextIdentical(page);
  await expect(page.locator(".scan-option")).toHaveCount(2);
  await expect(page.locator("#scan-status")).toContainText("matched");
  expect(await page.evaluate(() => window.cueNotes)).toEqual([
    230, 170, 660, 880,
  ]);
  await nextIdentical(page);
  await expect(page.locator(".scan-option")).toHaveCount(3);
  await expect(
    page.locator('.scan-option[aria-selected="true"]'),
  ).toHaveAttribute("data-index", "2");
  await page.locator("#scan-back").click();
  expect(
    await page.evaluate(() => window.testStream.getTracks()[0].readyState),
  ).toBe("ended");
  await expect(page.locator(".scanner-dialog")).not.toBeVisible();
  await expect(page.locator(".review-row")).toHaveCount(3);
  await expect(page.locator(".candidate").first()).toHaveValue("");
  await expect(page.locator("#save-batch")).toBeDisabled();
});
test("UC-15 chronological wheel snaps at edges, selected-only quantity/remove controls and mute", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page);
  await expect(page.locator("#scan-status")).toContainText("matched");
  for (let i = 0; i < 4; i++) {
    await nextIdentical(page);
    await expect(page.locator(".scan-option")).toHaveCount(i + 2);
    await expect(page.locator("#scan-status")).toContainText("matched");
  }
  await expect(
    page.locator('.scan-option[aria-selected="true"]'),
  ).toHaveAttribute("data-index", "4");
  expect(
    await page
      .locator(".scan-option")
      .evaluateAll((elements) => elements.map((e) => e.id)),
  ).toEqual([1, 2, 3, 4, 5].map((n) => `scan-row-${n}`));
  await expect(page.locator("#scan-controls .scan-plus")).toHaveCount(1);
  await page.locator(".scan-plus").click();
  await expect(page.locator("#scan-controls output")).toHaveText("2");
  await page.locator("#scan-wheel").focus();
  await page.keyboard.press("Home");
  await expect(
    page.locator('.scan-option[aria-selected="true"]'),
  ).toHaveAttribute("data-index", "0");
  await expect(page.locator(".scan-minus")).toBeDisabled();
  await expect
    .poll(() => page.locator("#scan-wheel").evaluate((el) => el.scrollTop))
    .toBeLessThan(2);
  await page
    .locator("#scan-wheel")
    .evaluate((el) => el.scrollBy({ top: 77, behavior: "smooth" }));
  await expect
    .poll(() =>
      page
        .locator('.scan-option[aria-selected="true"]')
        .getAttribute("data-index"),
    )
    .toBe("2");
  await expect
    .poll(() =>
      page.locator("#scan-wheel").evaluate((el) => {
        const row = el.querySelector('[aria-selected="true"]');
        return Math.abs(
          row.offsetTop +
            row.offsetHeight / 2 -
            el.scrollTop -
            el.clientHeight / 2,
        );
      }),
    )
    .toBeLessThan(2);
  await page.locator(".scan-remove").click();
  await expect(page.locator(".scan-option")).toHaveCount(4);
  await page.locator("#scan-wheel").focus();
  await page.keyboard.press("End");
  await expect(page.locator("#scan-controls output")).toHaveText("2");
  await page.locator(".scan-minus").click();
  await expect(page.locator("#scan-controls output")).toHaveText("1");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.locator("#scan-wheel").focus();
  await page.keyboard.press("Home");
  await expect
    .poll(() => page.locator("#scan-wheel").evaluate((el) => el.scrollTop))
    .toBeLessThan(2);
  const touch = await page.context().newCDPSession(page);
  const box = await page.locator("#scan-wheel").boundingBox();
  const x = box.x + box.width / 2,
    y = box.y + box.height * 0.75;
  await touch.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y }],
  });
  for (let step = 1; step <= 6; step++) {
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y: y - step * 12 }],
    });
    await page.waitForTimeout(25);
  }
  await touch.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await expect
    .poll(async () =>
      Number(
        await page
          .locator('.scan-option[aria-selected="true"]')
          .getAttribute("data-index"),
      ),
    )
    .toBeGreaterThan(0);
  await expect
    .poll(() =>
      page.locator("#scan-wheel").evaluate((el) => {
        const row = el.querySelector('[aria-selected="true"]');
        return Math.abs(
          row.offsetTop +
            row.offsetHeight / 2 -
            el.scrollTop -
            el.clientHeight / 2,
        );
      }),
    )
    .toBeLessThan(2);
  await page.locator("#scan-mute").click();
  const notes = await page.evaluate(() => window.cueNotes.length);
  await nextIdentical(page);
  await expect(page.locator(".scan-option")).toHaveCount(5);
  await expect(page.locator("#scan-status")).toContainText("matched");
  expect(await page.evaluate(() => window.cueNotes.length)).toBe(notes);
  const layout = await page.evaluate(() => ({
    width: document.querySelector(".scanner-dialog").getBoundingClientRect()
      .width,
    stage: document.querySelector(".scan-stage").getBoundingClientRect().height,
    height: innerHeight,
  }));
  expect(layout.width).toBe(390);
  expect(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).overflow,
    ),
  ).toBe("hidden");
  expect(layout.stage / layout.height).toBeCloseTo(0.75, 2);
  await page.screenshot({ path: "test-results/scanner-mobile.png" });
});
test("UC-14 back cancels in-flight recognition and background shuts down capture", async ({
  page,
}) => {
  await fixture(page, { slow: true });
  await expect(page.locator(".scan-option")).toHaveCount(1);
  await page.locator("#scan-back").click();
  await expect(page.locator(".review-row")).toHaveCount(1);
  expect(
    await page.evaluate(() =>
      document.documentElement.classList.contains("scanning"),
    ),
  ).toBe(false);
  await page.waitForTimeout(3200);
  await expect(page.locator(".candidate")).toHaveValue("");
  expect(
    await page.evaluate(() => window.testStream.getTracks()[0].readyState),
  ).toBe("ended");
  page.once("dialog", (d) => d.accept());
  await page.locator("#batch-close").click();
  await page.locator("#scan").click();
  await page.locator("#camera-start").click();
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.locator("#scan-status")).toContainText("background");
  expect(
    await page.evaluate(() => window.testStream.getTracks()[0].readyState),
  ).toBe("ended");
  await expect(page.locator("#camera-start")).toBeEnabled();
});

test("UC-14 sampling continues during slow OCR and removing the last queued reading leaves safe selection", async ({
  page,
}) => {
  await fixture(page, { slow: true });
  await expect(page.locator(".scan-option")).toHaveCount(1);
  await nextIdentical(page);
  await expect(page.locator(".scan-option")).toHaveCount(2);
  await expect(page.locator(".scan-option small").first()).toHaveText(
    "Reading…",
  );
  await expect(
    page.locator('.scan-option[aria-selected="true"]'),
  ).toHaveAttribute("data-index", "1");
  await page.locator(".scan-remove").click();
  await expect(
    page.locator('.scan-option[aria-selected="true"]'),
  ).toHaveAttribute("data-index", "0");
  await expect(page.locator("#scan-status")).toContainText("matched");
  await page.locator(".scan-remove").click();
  await expect(page.locator(".scan-option")).toHaveCount(0);
  await expect(page.locator("#scan-controls")).not.toBeVisible();
  await expect(page.locator("#scan-empty")).toBeVisible();
  await page.locator("#scan-back").click();
  await expect(page.locator(".batch-dialog")).not.toBeVisible();
});

test("UC-14 suspended audio cannot block hands-free capture", async ({
  page,
}) => {
  await page.addInitScript(() => {
    AudioContext.prototype.resume = () => new Promise(() => {});
  });
  await fixture(page);
  await expect(page.locator("#scan-status")).toContainText("matched");
  await expect(page.locator(".scan-option")).toHaveCount(1);
  await page.locator("#scan-back").click();
  expect(
    await page.evaluate(() => window.testStream.getTracks()[0].readyState),
  ).toBe("ended");
});
