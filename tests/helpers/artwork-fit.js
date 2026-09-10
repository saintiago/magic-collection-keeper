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
        source: document
          .querySelector(".artwork-source-lifted")
          .getBoundingClientRect()
          .toJSON(),
        sourceWidth: parseFloat(image.style.width),
        sourceHeight: parseFloat(image.style.height),
        requestedZoom: dialog.dataset.input === "touch" ? 2 : 3,
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
      source,
      requestedZoom,
    } = result;
    expect(image.x - left).toBeGreaterThanOrEqual(24 + safeX - 0.5);
    expect(width + left - image.right).toBeGreaterThanOrEqual(24 + safeX - 0.5);
    expect(image.y - top).toBeGreaterThanOrEqual(32 + safeY - 0.5);
    expect(height + top - image.bottom).toBeGreaterThanOrEqual(
      32 + safeY - 0.5,
    );
    const zoom = image.width / sourceWidth;
    expect(zoom).toBeLessThanOrEqual(requestedZoom + 0.001);
    expect(image.height / sourceHeight).toBeCloseTo(zoom, 3);
    expect(
      Math.abs(zoom - requestedZoom) < 0.001 ||
        Math.abs(image.width - (width - 48 - safeX * 2)) < 0.6 ||
        Math.abs(image.height - (height - 64 - safeY * 2)) < 0.6,
    ).toBe(true);
    // Keep the source center unless a dismissal gutter forces a minimal shift.
    const x = Math.max(
      left + 24 + safeX,
      Math.min(
        source.x + source.width / 2 - image.width / 2,
        left + width - 24 - safeX - image.width,
      ),
    );
    const y = Math.max(
      top + 32 + safeY,
      Math.min(
        source.y + source.height / 2 - image.height / 2,
        top + height - 32 - safeY - image.height,
      ),
    );
    expect(Math.abs(image.x - x)).toBeLessThan(0.6);
    expect(Math.abs(image.y - y)).toBeLessThan(0.6);
    expect(Number(await viewer.getAttribute("data-zoom"))).toBeCloseTo(zoom, 3);
    await expect(viewer.locator("output")).toHaveCount(0);
  }).toPass({ timeout: 3000 });
  const zoom = result.image.width / result.sourceWidth;
  return { ...result, zoom, percent: `${Math.round(zoom * 100)}%` };
}

export async function expectInspectorSides(page, image) {
  const panel = page.locator(".artwork-viewer .artwork-tags");
  const bounds = await panel.boundingBox();
  const viewport = page.viewportSize();
  expect(bounds.x).toBeGreaterThanOrEqual(23.5);
  expect(bounds.y).toBeGreaterThanOrEqual(31.5);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width - 23.5);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height - 31.5);
  const beside = bounds.x >= image.right || bounds.x + bounds.width <= image.x;
  if (beside) expect(Math.abs(bounds.y - image.y)).toBeLessThan(1);
  else expect(bounds.y).toBeGreaterThanOrEqual(image.y - 0.6);
  await expect(page.locator(".artwork-details,.artwork-controls")).toHaveCount(
    0,
  );
}
