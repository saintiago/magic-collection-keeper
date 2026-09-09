import {
  expectInspectorFit,
  expectInspectorSides,
} from "../helpers/artwork-fit.js";
import { test, expect } from "@playwright/test";

test.describe("touch viewport changes", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  test("UC-CARD-PROTOTYPE canceled pinch leaves bounded pan and resize retains source-relative zoom", async ({
    page,
  }) => {
    await page.goto("/");
    const tile = page.locator("#grid .card-open").first();
    const source = await tile.boundingBox();
    await tile.tap();
    const photo = page.locator(".artwork-full-image");
    await expect(page.locator(".artwork-open-reveal")).toHaveCSS(
      "transform",
      "none",
    );
    const pointer = (pointerId, clientX, clientY) => ({
      pointerId,
      clientX,
      clientY,
      pointerType: "touch",
      bubbles: true,
      buttons: 1,
    });
    await photo.dispatchEvent("pointerdown", pointer(41, 170, 580));
    await photo.dispatchEvent("pointerdown", pointer(42, 220, 640));
    await photo.dispatchEvent("pointermove", pointer(42, 260, 680));
    await photo.dispatchEvent("pointercancel", pointer(41, 170, 580));
    await photo.dispatchEvent("pointercancel", pointer(42, 260, 680));
    await expect(page.locator(".artwork-viewer")).toBeVisible();
    await page.getByRole("button", { name: "Reset zoom" }).tap();
    await expectInspectorFit(page);
    await page.setViewportSize({ width: 844, height: 390 });
    await expect
      .poll(
        async () => (await page.locator(".artwork-stage").boundingBox()).height,
      )
      .toBe(390);
    await expectInspectorFit(page);
    expect(
      await photo.evaluate((el) => getComputedStyle(el).transform),
    ).not.toContain("NaN");
    await page.getByLabel("Close artwork").tap();
    await expect(page.locator(".artwork-viewer")).not.toBeVisible();
    await expect(tile).toBeFocused();
  });
});

const svg = (width, height) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#294535"/><text x="30" y="120" fill="white" font-size="30">Sample full card</text></svg>`;

test("UC-CARD-TILES immediate info, 299/300ms hover boundary and cancellation restart", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
  await page.clock.install();
  await page.clock.pauseAt(Date.now() + 1000);
  await page.evaluate(() => {
    const original = window.setTimeout;
    window.setTimeout = (callback, delay, ...args) => {
      if (delay === 300) window.hoverScheduledAt = performance.now();
      return original(callback, delay, ...args);
    };
  });
  const tile = page.locator("#grid .card-open").first();
  const b = await tile.boundingBox();
  const enter = async () => {
    await tile.dispatchEvent("pointermove", {
      pointerType: "mouse",
      clientX: b.x + b.width / 2,
      clientY: b.y + b.height / 2,
      bubbles: true,
    });
    await page.clock.runFor(17);
    await expect(tile.locator("..").locator(".card-hover-info")).toBeVisible();
    const elapsed = await page.evaluate(
      () => performance.now() - window.hoverScheduledAt,
    );
    expect(elapsed).toBeLessThan(18);
    await page.clock.runFor(299 - elapsed);
    await expect(page.locator(".artwork-hover")).not.toBeVisible();
  };
  await enter();
  await page.evaluate(() => {
    window.departedLift = false;
    const preview = document.querySelector(".artwork-hover");
    new MutationObserver((records) => {
      if (
        records.some(
          (record) =>
            record.attributeName === "hidden" && record.oldValue !== null,
        )
      )
        window.departedLift = true;
    }).observe(preview, {
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ["hidden"],
    });
  });
  await page.locator("body").dispatchEvent("pointermove", {
    pointerType: "mouse",
    clientX: 5,
    clientY: 5,
    bubbles: true,
  });
  await page.clock.runFor(17);
  await page.clock.runFor(350);
  await expect(page.locator(".artwork-hover")).not.toBeVisible();
  expect(await page.evaluate(() => window.departedLift)).toBe(false);
  await enter();
  await page.clock.runFor(1);
  await expect(page.locator(".artwork-hover")).toBeVisible();
  expect(
    (await page.locator(".artwork-hover").boundingBox()).width / b.width,
  ).toBeCloseTo(2, 2);
  await page.dispatchEvent("body", "pointercancel");
  await page.clock.runFor(350);
  await expect(page.locator(".artwork-hover")).not.toBeVisible();
});

test.beforeEach(async ({ page }) => {
  await page.route("https://cards.scryfall.io/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: route.request().url().includes("/large/")
        ? svg(672, 936)
        : svg(488, 680),
    }),
  );
});

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
  { width: 320, height: 568 },
  { width: 844, height: 390 },
]) {
  test(`UC-CARD-PROTOTYPE comfortable source scaling, dismissal gutters and side overlays ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/");
    for (const surface of ["deck", "owned", "catalog", "home"]) {
      await page.locator("#surface").selectOption(surface);
      const tile = page
        .locator(surface === "home" ? ".home-card button" : "#grid .card-open")
        .first();
      await tile.scrollIntoViewIfNeeded();
      await expect
        .poll(() => tile.locator("img").evaluate((el) => el.naturalWidth))
        .toBeGreaterThan(0);
      const base = await tile.boundingBox();
      await tile.hover();
      await expect(page.locator(".artwork-hover")).toBeVisible();
      const preview = await page.locator(".artwork-hover").boundingBox();
      const hoverZoom = Math.min(
        2,
        (viewport.width - 32) / base.width,
        (viewport.height - 32) / base.height,
      );
      expect(preview.width).toBeCloseTo(base.width * hoverZoom, 1);
      expect(preview.height).toBeCloseTo(base.height * hoverZoom, 1);
      expect(preview.x).toBeGreaterThanOrEqual(15.9);
      expect(preview.y).toBeGreaterThanOrEqual(15.9);
      await page.mouse.click(
        Math.max(1, preview.x + preview.width / 2),
        Math.max(1, preview.y + preview.height / 2),
      );
      await expect(page.locator(".artwork-viewer")).toBeVisible();
      await expect(page.locator(".artwork-open-reveal")).toHaveCSS(
        "transform",
        "none",
      );
      const enlarged = await page.locator(".artwork-full-image").boundingBox();
      await expectInspectorFit(page);

      await expect
        .poll(() =>
          page.locator(".artwork-full-image").evaluate((el) => el.naturalWidth),
        )
        .toBe(672);
      expect(await page.locator(".artwork-stage").boundingBox()).toMatchObject({
        x: 0,
        y: 0,
        ...viewport,
      });
      const left = await page.locator(".artwork-details").boundingBox();
      const right = await page.locator(".artwork-controls").boundingBox();
      await expectInspectorSides(page, enlarged);
      if (left)
        expect(left.y + left.height).toBeLessThanOrEqual(viewport.height);
      expect(right.y + right.height).toBeLessThanOrEqual(viewport.height);
      await expect(
        page.locator(".artwork-viewer header,.artwork-viewer footer"),
      ).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(page.locator(".artwork-viewer")).not.toBeVisible();
      await expect(tile).toBeFocused();
    }
    expect(errors).toEqual([]);
  });
}

test("UC-CARD-PROTOTYPE late full-card upgrade cannot replace a departed image", async ({
  page,
}) => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  let requested = false;
  await page.route("https://cards.scryfall.io/large/**", async (route) => {
    requested = true;
    await pending;
    await route.fulfill({ contentType: "image/svg+xml", body: svg(672, 936) });
  });
  await page.goto("/");
  const tile = page.locator("#grid .card-open").first();
  await tile.click();
  await expect.poll(() => requested).toBe(true);
  await expect(page.locator(".artwork-open-reveal")).toHaveCSS(
    "transform",
    "none",
  );
  await expect
    .poll(() =>
      page.locator(".artwork-full-image").evaluate((el) => el.naturalWidth),
    )
    .toBe(488);
  await page.evaluate(() => {
    window.departedArtwork = document.querySelector(".artwork-full-image");
  });
  await page.keyboard.press("Escape");
  await expect(page.locator(".artwork-viewer")).not.toBeVisible();
  release();
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.departedArtwork.src)).toContain(
    "/normal/",
  );
});

test("UC-CARD-PROTOTYPE failed full-card upgrade preserves image and source dimensions", async ({
  page,
}) => {
  await page.route("https://cards.scryfall.io/large/**", (route) =>
    route.abort(),
  );
  await page.goto("/");
  const tile = page.locator("#grid .card-open").first();
  await tile.click();
  await expect(page.locator(".artwork-open-reveal")).toHaveCSS(
    "transform",
    "none",
  );
  const base = await tile.boundingBox();
  const enlarged = await page.locator(".artwork-full-image").boundingBox();
  await expectInspectorFit(page);
  await expect
    .poll(() =>
      page.locator(".artwork-full-image").evaluate((el) => el.naturalWidth),
    )
    .toBe(488);
});

test("UC-CARD-PROTOTYPE dense grid handles interrupted hover spring and Back without stale overlays", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator("#density").selectOption("1000");
  await expect(page.locator("#grid .card-open")).toHaveCount(1000);
  const tile = page.locator("#grid .card-open").first();
  await tile.hover();
  await page.mouse.move(2, 2);
  await page.waitForTimeout(250);
  await expect(page.locator(".artwork-hover")).not.toBeVisible();
  await tile.hover();
  await expect(page.locator(".artwork-hover")).toBeVisible();
  const preview = await page.locator(".artwork-hover").boundingBox();
  await page.mouse.click(
    preview.x + preview.width / 2,
    preview.y + preview.height / 2,
  );
  await expect(page.locator(".artwork-viewer")).toBeVisible();
  await page.goBack();
  await expect(page.locator(".artwork-viewer")).not.toBeVisible();
  await expect(page.locator(".artwork-hover")).not.toBeVisible();
  await expect(tile).toHaveCSS("opacity", "1");
  await tile.press("Enter");
  await expect(page.locator(".artwork-open-reveal")).toHaveCSS(
    "transform",
    "none",
  );
  await expectInspectorFit(page);
  await page.keyboard.press("Escape");
  await expect(tile).toBeFocused();
});

test("UC-CARD-PROTOTYPE lift transfers one opaque image and restores the source after dismissal", async ({
  page,
}) => {
  await page.goto("/");
  const tile = page.locator("#grid .card-open").first();
  await tile.hover();
  await expect(page.locator(".artwork-hover")).toBeVisible();
  await expect(tile).toHaveCSS("opacity", "0");
  const opacity = await page
    .locator(".artwork-hover-reveal")
    .evaluate(async (el) => {
      const values = [];
      for (let i = 0; i < 18; i++) {
        await new Promise(requestAnimationFrame);
        values.push(getComputedStyle(el).opacity);
      }
      return values;
    });
  expect(opacity.every((value) => value === "1")).toBe(true);
  const preview = await page.locator(".artwork-hover").boundingBox();
  await page.mouse.click(
    preview.x + preview.width / 2,
    preview.y + preview.height / 2,
  );
  await expect(page.locator(".artwork-viewer")).toBeVisible();
  await expect(tile).toHaveCSS("opacity", "0");
  await expect(page.locator(".artwork-open-reveal")).toHaveCSS("opacity", "1");
  await page.keyboard.press("Escape");
  await expect(page.locator(".artwork-viewer")).not.toBeVisible();
  await expect(tile).toHaveCSS("opacity", "1");
});
