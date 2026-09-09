import { expect } from "@playwright/test";

// Observe the rendered card, not the layout implementation, so this also checks
// released assets with their actual source tile and visual viewport dimensions.
export async function expectInspectorFit(page) {
  const viewer = page.locator(".artwork-viewer");
  await expect(viewer).toBeVisible();
  await expect(page.locator(".artwork-open-reveal")).toHaveCSS(
    "transform",
    "none",
  );
  let result;
  await expect(async () => {
    result = await viewer.evaluate((dialog) => {
      const image = dialog.querySelector(".artwork-full-image");
      const r = image.getBoundingClientRect();
      const safe = getComputedStyle(dialog.querySelector(".artwork-safe-area"));
      return {
        image: r.toJSON(),
        sourceWidth: parseFloat(image.style.width),
        sourceHeight: parseFloat(image.style.height),
        width: visualViewport.width,
        height: visualViewport.height,
        left: visualViewport.offsetLeft,
        top: visualViewport.offsetTop,
        safeX: Math.max(
          parseFloat(safe.paddingLeft),
          parseFloat(safe.paddingRight),
        ),
        safeY: Math.max(
          parseFloat(safe.paddingTop),
          parseFloat(safe.paddingBottom),
        ),
      };
    });
    const {
      image,
      sourceWidth,
      sourceHeight,
      width,
      height,
      left,
      top,
      safeX,
      safeY,
    } = result;
    expect(image.x - left).toBeGreaterThanOrEqual(24 + safeX - 0.5);
    expect(width + left - image.right).toBeGreaterThanOrEqual(24 + safeX - 0.5);
    expect(image.y - top).toBeGreaterThanOrEqual(32 + safeY - 0.5);
    expect(height + top - image.bottom).toBeGreaterThanOrEqual(
      32 + safeY - 0.5,
    );
    const zoom = image.width / sourceWidth;
    expect(zoom).toBeLessThanOrEqual(3.001);
    expect(image.height / sourceHeight).toBeCloseTo(zoom, 3);
    expect(
      Math.min(
        Math.abs(zoom - 3),
        Math.abs(image.width - (width - 48 - safeX * 2)),
        Math.abs(image.height - (height - 64 - safeY * 2)),
      ),
    ).toBeLessThan(0.6);
    await expect(viewer.locator("output")).toHaveText(
      `${Math.round(zoom * 100)}%`,
    );
  }).toPass({ timeout: 3000 });
  const zoom = result.image.width / result.sourceWidth;
  return { ...result, zoom, percent: `${Math.round(zoom * 100)}%` };
}
