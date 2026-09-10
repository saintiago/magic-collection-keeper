import { expect } from "@playwright/test";

// Open the dedicated page through the current card menu, preserving the real
// return-to-source flow. Mobile uses native taps plus controlled long press.
export async function openArtworkDetails(page, { mobile = false } = {}) {
  const viewer = page.locator(".artwork-viewer");
  await expect(viewer).toBeVisible();
  if (mobile) await page.touchscreen.tap(5, 5);
  else await page.keyboard.press("Escape");
  await expect(viewer).not.toBeVisible();
  const source = page.locator(".card-open:focus,[data-home-card]:focus");
  await expect(source).toHaveCount(1);
  if (mobile) {
    const bounds = await source.boundingBox();
    const pointer = {
      pointerId: 97,
      pointerType: "touch",
      isPrimary: true,
      button: 0,
      buttons: 1,
      clientX: bounds.x + bounds.width / 2,
      clientY: bounds.y + bounds.height / 2,
    };
    await source.dispatchEvent("pointerdown", pointer);
    const more = page.getByRole("menuitem", {
      name: "More tags…",
      exact: true,
    });
    await expect(more).toBeVisible();
    const target = await more.boundingBox();
    const end = {
      ...pointer,
      clientX: target.x + target.width / 2,
      clientY: target.y + target.height / 2,
    };
    await source.dispatchEvent("pointermove", end);
    await source.dispatchEvent("pointerup", { ...end, buttons: 0 });
  } else {
    await source.press("Shift+F10");
    await page
      .getByRole("menuitem", { name: "More tags…", exact: true })
      .click();
  }
  const details = page.locator(".card-action-more").getByRole("button", {
    name: "Card details",
    exact: true,
  });
  if (mobile) await details.tap();
  else await details.click();
}
