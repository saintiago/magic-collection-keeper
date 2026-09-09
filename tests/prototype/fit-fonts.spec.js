import { test, expect } from "@playwright/test";
import { expectInspectorFit } from "../helpers/artwork-fit.js";

test.beforeEach(async ({ page }) => {
  await page.route("https://cards.scryfall.io/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="488" height="680"><rect width="488" height="680" fill="#658b72"/></svg>',
    }),
  );
});

for (const viewport of [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 844, height: 390 },
]) {
  test.describe(`UC-CARD-ART dismissal ${viewport.width}`, () => {
    test.use({ viewport, hasTouch: true, isMobile: true });
    test("safe areas, browser chrome resize and zoom retain consumed outside tap", async ({
      page,
    }) => {
      await page.goto("/?card=animation-module");
      await page.evaluate(() => document.fonts.ready);
      const tile = page.locator("#grid .card-open").first();
      await tile.tap();
      await expectInspectorFit(page);
      await expect(page.locator(".artwork-details")).not.toContainText(
        "Animation Module",
      );
      await expect(page.locator(".artwork-details")).not.toContainText("194");
      await expect(page.locator(".artwork-details .tag-badge")).toHaveText(
        "Elesh Norn Artifacts",
      );
      await expect(page.locator(".artwork-full-image")).toHaveAttribute(
        "alt",
        "Animation Module",
      );
      await page.locator(".artwork-safe-area").evaluate((el) => {
        el.style.padding = "20px 12px 28px";
        window.dispatchEvent(new Event("resize"));
      });
      await expectInspectorFit(page);
      await page.setViewportSize({ ...viewport, height: viewport.height - 40 });
      await expectInspectorFit(page);
      await page.getByLabel("Zoom in", { exact: true }).tap();
      const input = page.locator(".artwork-viewport");
      const viewportBox = await input.boundingBox();
      expect(viewportBox.x).toBeGreaterThanOrEqual(36);
      await page.touchscreen.tap(12, (viewport.height - 40) / 2);
      await expect(page.locator(".artwork-viewer")).not.toBeVisible();
      await expect(page.locator(".card-action-layer")).not.toBeVisible();
      await expect(page.locator(".artwork-hover")).not.toBeVisible();
      await expect(page.locator("#prototype-status")).toHaveText(
        "Changes stay in this sample session.",
      );
      await expect(tile).toBeFocused();
    });
  });
}

for (const outcome of ["ready", "failed", "delayed"]) {
  test(`UC-FONTS ${outcome} self-hosted faces preserve card and active wheel geometry`, async ({
    page,
    browserName,
  }) => {
    const requests = [];
    page.on("request", (r) => {
      if (r.url().endsWith(".woff2")) requests.push(r.url());
    });
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    if (outcome !== "ready")
      await page.route("**/*.woff2", async (route) => {
        if (outcome === "failed") return route.abort();
        await gate;
        await route.continue();
      });
    await page.goto("/?card=animation-module", {
      waitUntil: outcome === "delayed" ? "domcontentloaded" : "load",
    });
    if (outcome !== "delayed") await page.evaluate(() => document.fonts.ready);
    const tile = page.locator("#grid .card-open").first();
    await tile.focus();
    await page.keyboard.press("Shift+F10");
    const layer = page.locator(".card-action-layer");
    await expect(layer).toBeVisible();
    const geometry = () =>
      page.locator(".card-action-target").evaluateAll((nodes) =>
        nodes.map((el) => ({
          r: el.getBoundingClientRect().toJSON(),
          text: el.textContent,
          font: getComputedStyle(el).fontFamily,
        })),
      );
    const before = await geometry();
    expect(before.every((t) => t.r.height >= 44 && t.text.length > 0)).toBe(
      true,
    );
    expect(
      await layer.evaluate((el) => el.style.getPropertyValue("--wheel-font")),
    ).toContain(outcome === "ready" ? "Inter" : "Arial");
    if (outcome === "delayed") {
      release();
      await page.evaluate(() => document.fonts.ready);
    }
    expect(await geometry()).toEqual(before);
    await page.keyboard.press("Escape");
    if (outcome !== "failed") {
      const faces = await page.evaluate(async () => ({
        display: (
          await document.fonts.load("600 24px Cinzel", "Card motion")
        ).every((f) => f.status === "loaded"),
        body: (
          await document.fonts.load("600 13px Inter", "Elesh Norn Artifacts")
        ).every((f) => f.status === "loaded"),
      }));
      expect(faces).toEqual({ display: true, body: true });
      if (browserName === "chromium") {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("DOM.enable");
        await cdp.send("CSS.enable");
        const { root } = await cdp.send("DOM.getDocument");
        const { nodeId } = await cdp.send("DOM.querySelector", {
          nodeId: root.nodeId,
          selector: ".prototype-header strong",
        });
        const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", {
          nodeId,
        });
        expect(
          fonts.some((f) => f.isCustomFont && f.familyName.includes("Cinzel")),
        ).toBe(true);
      }
    }
    await tile.press("Enter");
    await expectInspectorFit(page);
    await expect(page.getByLabel("Edit locations & tags")).toBeVisible();
    await expect(page.getByLabel("Close artwork")).toHaveText("×");
    expect(requests.length).toBeLessThanOrEqual(4);
    expect(
      requests.every((url) => new URL(url).origin === "http://127.0.0.1:3120"),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await tile.press("Shift+F10");
    expect(
      await layer.evaluate((el) => el.style.getPropertyValue("--wheel-font")),
    ).toContain(outcome === "failed" ? "Arial" : "Inter");
    await page.keyboard.press("Escape");
  });
}

test("UC-CARD-ART directional glass light and press spring preserve inspector fit", async ({
  page,
}) => {
  await page.goto("/?card=animation-module");
  await page.locator("#grid .card-open").first().click();
  await expectInspectorFit(page);
  const edit = page.getByLabel("Edit locations & tags");
  const bounds = await edit.boundingBox();
  await page.mouse.move(bounds.x + 4, bounds.y + 4);
  await expect(edit).toHaveAttribute("data-lit", "");
  await expect
    .poll(() =>
      edit.evaluate((el) => parseFloat(el.style.getPropertyValue("--glass-x"))),
    )
    .toBeLessThan(15);
  const first = await edit.evaluate(
    (el) => getComputedStyle(el).backgroundImage,
  );
  await page.mouse.move(
    bounds.x + bounds.width - 4,
    bounds.y + bounds.height - 4,
    { steps: 8 },
  );
  await expect
    .poll(() =>
      edit.evaluate((el) => parseFloat(el.style.getPropertyValue("--glass-x"))),
    )
    .toBeGreaterThan(85);
  expect(
    await edit.evaluate((el) => getComputedStyle(el).backgroundImage),
  ).not.toBe(first);
  expect(await edit.boundingBox()).toEqual(bounds);
  const reset = page.getByLabel("Reset zoom", { exact: true });
  await reset.hover();
  await page.mouse.down();
  await expect(reset).not.toHaveCSS("transform", "none");
  await page.mouse.up();
  await expect(reset).toHaveCSS("transform", "none");
  await expectInspectorFit(page);
  await page.mouse.move(12, 12);
  await expect(edit).not.toHaveAttribute("data-lit", "");
  await page.keyboard.press("Escape");
});
