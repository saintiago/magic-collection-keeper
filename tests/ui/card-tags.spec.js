import { test, expect } from "@playwright/test";
import { fixture, card } from "../helpers/import-page-fixture.js";
import { savePrinting } from "../../db.js";

async function setup(page) {
  page.on("pageerror", (error) => console.log("Tag UI error:", error.message));
  const f = await fixture(page);
  savePrinting(f.db, {
    ...card,
    image_uris: { normal: "http://127.0.0.1:3100/tag-card.svg" },
  });
  await page.route("**/tag-card.svg", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="488" height="680"><rect width="488" height="680" fill="#627960"/><text x="20" y="300" font-size="28" fill="white">Tag controls fixture</text></svg>',
    }),
  );
  await f.tagged.add("test", {
    printing_id: card.id,
    quantity: 9,
    finish: "nonfoil",
    condition: "NM",
  });
  const [row] = await f.tagged.list("test");
  const box = (await f.tagged.tags("test")).find(
    (tag) => tag.type === "location",
  );
  await f.tagged.assign("test", row.id, {
    locations: [{ tag_id: box.id, quantity: 5 }],
    tag_ids: [],
  });
  await page.goto("/#collection");
  await expect(page.locator("#grid .card-open")).toBeVisible();
  await expect(
    page.locator(`#tag-filter option[value="${box.id}"]`),
  ).toHaveCount(1);
  return { ...f, box };
}

test("UC-CARD-TAG-TOGGLE plain tags persist, preserve owned totals and return to the replaced source tile", async ({
  page,
}) => {
  const f = await setup(page);
  const source = page.locator("#grid .card-open");
  await source.click();
  const viewer = page.locator(".artwork-viewer");
  const box = viewer.getByRole("button", { name: "Draft Box", exact: true });
  await expect(box).toHaveAttribute("aria-pressed", "true");
  await expect(
    viewer.locator("input,select,.artwork-info,.artwork-zoom,.artwork-close"),
  ).toHaveCount(0);
  await box.click();
  await expect(box).toHaveAttribute("aria-pressed", "false");
  await expect(box).toHaveAttribute("aria-busy", "false");
  await expect(source).toHaveClass(/artwork-source-lifted/);
  await box.click();
  await expect(box).toHaveAttribute("aria-pressed", "true");
  await expect(box).toHaveAttribute("aria-busy", "false");
  const [row] = await f.tagged.list("test");
  expect(row.quantity).toBe(9);
  expect(
    row.locations.find((entry) => entry.tag_id === f.box.id).quantity,
  ).toBe(5);
  await page.keyboard.press("Escape");
  await expect(viewer).not.toBeVisible();
  await expect(source).not.toHaveClass(/artwork-source-lifted/);
  await page.reload();
  await source.click();
  await expect(box).toHaveAttribute("aria-pressed", "true");
  expect(f.counts().ownedWrites).toBe(0);
  f.db.close();
});

test("UC-SHARED-CARD-TAGS a hover tag save stays open and carries the assigned state into click enlargement", async ({
  page,
}) => {
  const f = await setup(page);
  const source = page.locator("#grid .card-open");
  await source.scrollIntoViewIfNeeded();
  await expect(source).toBeInViewport({ ratio: 0.9 });
  await page.mouse.move(0, 0);
  await source.hover();
  const preview = page.locator(".artwork-hover");
  await expect(preview).toBeVisible();
  const role = preview.getByRole("button", { name: "Draw", exact: true });
  await expect(role).toHaveAttribute("aria-pressed", "false");
  await role.click();
  await expect(role).toHaveAttribute("aria-busy", "false");
  await expect(role).toHaveAttribute("aria-pressed", "true");
  await expect(preview).toBeVisible();
  await expect(page.locator("#grid .card-open")).toHaveClass(
    /artwork-source-lifted/,
  );
  await preview
    .locator(".artwork-hover-visual")
    .click({ position: { x: 30, y: 30 } });
  await expect(
    page
      .locator(".artwork-viewer")
      .getByRole("button", { name: "Draw", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  const [row] = await f.tagged.list("test");
  expect(row.quantity).toBe(9);
  expect(row.locations[0].quantity).toBe(5);
  f.db.close();
});

test("UC-CARD-TAG-TOGGLE the affected tag retries a lost owned response with the same operation", async ({
  page,
}) => {
  const f = await setup(page);
  const writes = [];
  await page.route("**/api/tag-actions", async (route) => {
    const payload = route.request().postDataJSON();
    writes.push(payload);
    const result = await f.tagged.applyTagAction("test", payload);
    await route.fulfill(
      writes.length === 1
        ? {
            status: 503,
            json: { error: "Response interrupted after saving." },
          }
        : { json: result },
    );
  });
  await page.locator("#grid .card-open").click();
  const viewer = page.locator(".artwork-viewer");
  const role = viewer.getByRole("button", { name: "Draw", exact: true });
  await expect(role).toHaveAttribute("aria-pressed", "false");
  await role.click();
  await expect(
    viewer.locator(".card-tag-error").filter({ hasText: "interrupted" }),
  ).toBeVisible();
  await expect(role).toHaveAttribute("aria-pressed", "false");
  await role.click();
  await expect(role).toHaveAttribute("aria-pressed", "true");
  await expect(role).toHaveAttribute("aria-busy", "false");
  await expect(viewer.locator(".card-tag-error:visible")).toHaveCount(0);
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  const [row] = await f.tagged.list("test");
  expect(row.quantity).toBe(9);
  expect(row.locations[0].quantity).toBe(5);
  f.db.close();
});
