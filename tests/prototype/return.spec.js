import { test, expect } from "@playwright/test";
import { expectInspectorFit } from "../helpers/artwork-fit.js";

test.beforeEach(async ({ page }) => {
  await page.route("https://cards.scryfall.io/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="488" height="680"><rect width="488" height="680" fill="#658b72"/><rect x="18" y="18" width="452" height="644" fill="none" stroke="white" stroke-width="12"/></svg>',
    }),
  );
});

async function recordReturn(
  page,
  { replace = false, remove = false, scroll = false } = {},
) {
  await page.evaluate(
    ({ replace, remove, scroll }) => {
      const dialog = document.querySelector(".artwork-viewer");
      let tile = document.querySelector(".artwork-source-lifted");
      const image = dialog.querySelector(".artwork-full-image");
      window.returnFrames = [];
      window.returnImage = image;
      let changed = false;
      function sample() {
        if (!dialog.open) return;
        if (dialog.hasAttribute("data-closing")) {
          if (!changed && returnFrames.length >= 3) {
            changed = true;
            if (replace) {
              const replacement = tile.cloneNode(true);
              replacement.classList.remove("artwork-source-lifted");
              tile.replaceWith(replacement);
              tile = replacement;
            }
            if (remove) tile.closest("[data-card-key]").remove();
            if (scroll) window.scrollBy(0, 55);
          }
          returnFrames.push({
            image: image.getBoundingClientRect().toJSON(),
            source: tile.getBoundingClientRect().toJSON(),
            hidden: getComputedStyle(tile).opacity === "0",
            same: image === document.querySelector(".artwork-full-image"),
          });
        }
        requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    },
    { replace, remove, scroll },
  );
}

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
  { width: 320, height: 568 },
]) {
  test.describe(`CARD-10 return ${viewport.width}`, () => {
    test.use({
      viewport,
      hasTouch: viewport.width < 600,
      isMobile: viewport.width < 600,
    });
    for (const position of ["first", "edge"]) {
      test(`${position} outside dismissal paints shrinking frames then lands without a duplicate`, async ({
        page,
      }) => {
        await page.goto("/?card=animation-module");
        await page.evaluate(() => document.fonts.ready);
        const tile = page
          .locator("#grid .card-open")
          .nth(position === "first" ? 0 : 7);
        await tile.scrollIntoViewIfNeeded();
        if (viewport.width < 600) await tile.tap();
        else await tile.click();
        await expectInspectorFit(page);
        const opening = await page.locator(".artwork-full-image").boundingBox();
        await recordReturn(page);
        if (viewport.width < 600) await page.touchscreen.tap(4, 4);
        else await page.mouse.click(4, 4);
        await expect(page.locator(".artwork-viewer")).not.toBeVisible();
        const frames = await page.evaluate(() => returnFrames);
        expect(frames.length).toBeGreaterThan(5);
        expect(
          frames.every((frame) => frame.same && frame.hidden),
        ).toBeTruthy();
        expect(
          frames.some(
            (frame) =>
              frame.image.width < opening.width * 0.9 &&
              frame.image.width > frame.source.width * 1.1,
          ),
        ).toBeTruthy();
        const last = frames.at(-1);
        for (const key of ["x", "y", "width", "height"])
          expect(Math.abs(last.image[key] - last.source[key])).toBeLessThan(1);
        await expect(tile).toBeFocused();
        await expect(tile).toHaveCSS("visibility", "visible");
        await expect(page.locator(".artwork-source-lifted")).toHaveCount(0);
        await expect(page.locator(".artwork-hover")).not.toBeVisible();
        await expect(page.locator("#prototype-status")).toHaveText(
          "Changes stay in this sample session.",
        );
      });
    }
  });
}

test("CARD-10 a zoomed card returns to its replaced, scrolled source; repeated close inputs do not traverse history twice", async ({
  page,
}) => {
  await page.goto("/?card=animation-module");
  const tile = page.locator("#grid .card-open").nth(7);
  await tile.scrollIntoViewIfNeeded();
  await tile.click();
  await expectInspectorFit(page);
  await page.getByLabel("Zoom in", { exact: true }).click();
  await recordReturn(page, { replace: true, scroll: true });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.locator(".artwork-viewer")).not.toBeVisible();
  const frames = await page.evaluate(() => returnFrames);
  const last = frames.at(-1);
  for (const key of ["x", "y", "width", "height"])
    expect(Math.abs(last.image[key] - last.source[key])).toBeLessThan(1);
  await expect(page.locator(".artwork-source-lifted")).toHaveCount(0);
  await expect(tile).toBeFocused();
  expect(page.url()).toContain("?card=animation-module");
  expect(await page.evaluate(() => history.state?.keeperArtwork)).toBeFalsy();
});

test("CARD-10 early interruption and missing source finish safely; reduced motion and sign-out leave no returning image", async ({
  page,
}) => {
  await page.goto("/?card=animation-module");
  const tile = page.locator("#grid .card-open").first();
  await tile.click();
  await recordReturn(page, { remove: true });
  await page.keyboard.press("Escape");
  await expect(page.locator(".artwork-viewer")).not.toBeVisible();
  await expect(
    page.locator(".artwork-full-image,.artwork-source-lifted"),
  ).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await tile.click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".artwork-viewer")).not.toBeVisible();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await tile.click();
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.dispatchEvent(new Event("keeper-sign-out")));
  await expect(
    page.locator(".artwork-full-image,.artwork-source-lifted"),
  ).toHaveCount(0);
  await page.waitForTimeout(450);
  await expect(page.locator(".artwork-viewer")).not.toBeVisible();
});
