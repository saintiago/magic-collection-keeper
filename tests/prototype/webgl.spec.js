import { test, expect } from "@playwright/test";

test("UC-CARD-WEBGL unsupported context keeps accessible SVG actions and selection", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const get = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
      return kind === "webgl" ? null : get.call(this, kind, ...args);
    };
  });
  await page.goto("/?renderer=webgl");
  await page.locator("#grid .card-open").first().press("Shift+F10");
  await expect(page.locator("#renderer-status")).toContainText("unavailable");
  await page.getByRole("menuitem", { name: "Card Draw", exact: true }).click();
  await expect(page.locator("#prototype-status")).toContainText(
    "Card Draw selected",
  );
});

test("UC-CARD-WEBGL actual context renders, keeps fixed targets and falls back on context loss", async ({
  page,
}) => {
  await page.goto("/?renderer=webgl");
  await page.locator("#grid .card-open").first().press("Shift+F10");
  const status = await page.evaluate(() => window.prototypeRenderer);
  test.skip(
    status.renderer !== "webgl",
    "This browser host does not provide WebGL; explicit unsupported fallback is separately tested.",
  );
  const targets = page.locator(".card-action-target");
  const before = await targets.evaluateAll((nodes) =>
    nodes.map((el) => [
      el.style.left,
      el.style.top,
      el.style.width,
      el.style.height,
    ]),
  );
  await page.keyboard.press("ArrowRight");
  const after = await targets.evaluateAll((nodes) =>
    nodes.map((el) => [
      el.style.left,
      el.style.top,
      el.style.width,
      el.style.height,
    ]),
  );
  expect(after).toEqual(before);
  expect(
    (await page.evaluate(() => window.prototypeRenderer.drawCpuMs)).length,
  ).toBeGreaterThan(1);
  const lost = await page
    .locator(".card-action-webgl-canvas")
    .evaluate((canvas) => {
      const ext = canvas.getContext("webgl").getExtension("WEBGL_lose_context");
      if (!ext) return false;
      ext.loseContext();
      return true;
    });
  expect(lost).toBe(true);
  await expect(page.locator("#renderer-status")).toContainText("context lost");
  await expect(page.locator("svg.card-action-sectors")).toHaveCSS(
    "opacity",
    "1",
  );
  await page.getByRole("menuitem", { name: "Card Draw", exact: true }).click();
  await expect(page.locator("#prototype-status")).toContainText(
    "Card Draw selected",
  );
});
