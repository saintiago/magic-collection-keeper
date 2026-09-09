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

test("UC-SHARED-CARD-TAGS drag from hover freezes Remove intent and never increments an already assigned location", async ({
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
  await expect(
    preview.getByRole("button", { name: "Draft Box", exact: true }),
  ).toBeEnabled();
  await preview
    .locator(".artwork-hover-reveal")
    .evaluate((element) =>
      Promise.all(
        element.getAnimations().map((animation) => animation.finished),
      ),
    );
  const image = await preview.boundingBox();
  await page.evaluate(() => {
    window.pickupTrace = [];
    for (const type of [
      "pointerdown",
      "pointermove",
      "pointercancel",
      "lostpointercapture",
      "gotpointercapture",
      "scroll",
    ])
      document.addEventListener(
        type,
        (event) =>
          window.pickupTrace.push({
            type,
            target: event.target.className,
            x: event.clientX,
            y: event.clientY,
            layer: document.querySelector(".card-action-layer").hidden,
          }),
        true,
      );
  });
  await page.mouse.move(image.x + 30, image.y + 30);
  await page.mouse.down();
  await page.mouse.move(image.x + 50, image.y + 50);
  const target = page.locator(`.card-action-layer [data-tag-id="${f.box.id}"]`);
  try {
    await expect(target).toHaveText("Remove Draft Box");
  } catch (error) {
    console.log(await page.evaluate(() => window.pickupTrace));
    throw error;
  }
  // A different session changes the assignment after pickup. The frozen action
  // remains Remove, rather than becoming an inferred toggle or increment.
  const [before] = await f.tagged.list("test");
  await f.tagged.assign("test", before.id, { locations: [], tag_ids: [] });
  const point = await target.boundingBox();
  const request = page.waitForRequest((request) =>
    request.url().endsWith("/api/tag-actions"),
  );
  const response = page.waitForResponse((response) =>
    response.url().endsWith("/api/tag-actions"),
  );
  await page.mouse.move(point.x + point.width / 2, point.y + point.height / 2);
  await page.mouse.up();
  expect((await request).postDataJSON()).toMatchObject({
    selected: false,
    quantity: 5,
    tag_id: f.box.id,
  });
  expect((await response).ok()).toBe(true);
  await expect(page.locator(".card-action-layer")).not.toBeVisible();
  await expect
    .poll(async () => (await f.tagged.list("test"))[0].locations.length)
    .toBe(0);
  expect((await f.tagged.list("test"))[0].quantity).toBe(9);
  await expect(page.locator(".artwork-viewer")).not.toBeVisible();
  f.db.close();
});

test("UC-SHARED-CARD-TAGS dropping on a tag link preserves the frozen Remove action and location quantity", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await setup(page);
  const writes = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/tag-actions"))
      writes.push(request.postDataJSON());
  });
  // An ordinary tag-navigation link outside the wheel exercises the legacy
  // direct-drop route without relying on a particular grid's tag placement.
  await page.evaluate((id) => {
    const link = document.createElement("a");
    link.href = "#tag=" + id;
    link.dataset.tagId = id;
    link.textContent = "Draft Box";
    link.style.cssText =
      "position:fixed;right:8px;bottom:8px;z-index:1000;padding:12px";
    link.id = "outside-tag-link";
    document.body.append(link);
  }, f.box.id);
  const source = page.locator("#grid .card-open");
  await source.scrollIntoViewIfNeeded();
  const bounds = await source.boundingBox();
  await page.mouse.move(bounds.x + 30, bounds.y + 30);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 50, bounds.y + 50);
  await expect(
    page.getByRole("menuitem", { name: "Remove Draft Box", exact: true }),
  ).toBeVisible();
  const [before] = await f.tagged.list("test");
  await f.tagged.assign("test", before.id, { locations: [], tag_ids: [] });
  const link = await page.locator("#outside-tag-link").boundingBox();
  await page.mouse.move(link.x + link.width / 2, link.y + link.height / 2);
  await page.mouse.up();
  await expect(page.locator(".card-action-layer")).not.toBeVisible();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({
    selected: false,
    quantity: 5,
    tag_id: f.box.id,
  });
  const [after] = await f.tagged.list("test");
  expect(after.quantity).toBe(9);
  expect(after.locations).toEqual([]);
  expect(page.url()).not.toContain("#tag=");
  f.db.close();
});

test.describe("actual touch and hybrid input", () => {
  test.use({ hasTouch: true });
  for (const width of [320, 390, 1280]) {
    test(`UC-CARD-INPUT-MODES finger tap uses 200% radial tags at ${width}px and mouse retains its own presentation`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 900 });
      const f = await setup(page);
      const source = page.locator("#grid .card-open");
      await source.tap();
      const viewer = page.locator(".artwork-viewer");
      await expect(viewer).toHaveAttribute("data-input", "touch");
      await expect(viewer.locator(".artwork-touch-wheel")).toBeVisible();
      const add = viewer.getByRole("button", { name: "Add Draw", exact: true });
      await expect(add).toBeVisible();
      await viewer
        .locator(".artwork-open-reveal")
        .evaluate((element) =>
          Promise.all(
            element.getAnimations().map((animation) => animation.finished),
          ),
        );
      const centered = await viewer.evaluate((element) => {
        const image = element
          .querySelector(".artwork-open-reveal")
          .getBoundingClientRect();
        const ring = element
          .querySelector(".card-action-sectors")
          .getBoundingClientRect();
        return {
          x: Math.abs(image.x + image.width / 2 - ring.x - ring.width / 2),
          y: Math.abs(image.y + image.height / 2 - ring.y - ring.height / 2),
        };
      });
      expect(centered.x).toBeLessThan(3);
      expect(centered.y).toBeLessThan(3);
      const zoom = Number(await viewer.getAttribute("data-zoom"));
      expect(zoom).toBeLessThanOrEqual(2);
      expect(zoom).toBeGreaterThan(1);
      await add.tap();
      const remove = viewer.getByRole("button", {
        name: "Remove Draw",
        exact: true,
      });
      await expect(remove).toHaveAttribute("aria-pressed", "true");
      await expect(remove).toHaveAttribute("aria-busy", "false");
      const [row] = await f.tagged.list("test");
      expect(row.quantity).toBe(9);
      expect(row.locations[0].quantity).toBe(5);
      await info.attach("touch-tag-wheel", {
        body: await page.screenshot({
          path: info.outputPath("touch-tag-wheel.png"),
        }),
        contentType: "image/png",
      });
      await page.touchscreen.tap(5, 5);
      await expect(viewer).not.toBeVisible();
      await expect(source).not.toHaveClass(/artwork-source-lifted/);
      await source.click();
      await expect(viewer).toHaveAttribute("data-input", "mouse");
      await expect(viewer.locator(".artwork-touch-wheel")).toHaveCount(0);
      await expect(
        viewer.getByRole("button", { name: "Draw", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      f.db.close();
    });
  }

  test("UC-CARD-INPUT-MODES long tags remain reachable through touch wheel overflow", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 740 });
    const f = await setup(page);
    const label =
      "Long collection role with a deliberately complete descriptive label";
    await f.tagged.createTag("test", { label, type: "role", kind: "role" });
    await page.locator("#grid .card-open").tap();
    const viewer = page.locator(".artwork-viewer");
    await viewer.getByRole("button", { name: "More tags…", exact: true }).tap();
    const tag = viewer
      .locator(".card-wheel-overflow")
      .getByRole("button", { name: label, exact: true });
    await tag.tap();
    await expect(tag).toHaveAttribute("aria-pressed", "true");
    await expect(tag).toHaveAttribute("aria-busy", "false");
    await viewer.getByRole("button", { name: "Back to tag wheel" }).tap();
    await expect(viewer.locator(".card-tag-ring")).toBeVisible();
    expect((await f.tagged.list("test"))[0].quantity).toBe(9);
    f.db.close();
  });

  test("UC-CARD-INPUT-MODES a scrolling or cancelled touch cannot become an enlargement through a compatibility click", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 740 });
    const f = await setup(page);
    const source = page.locator("#grid .card-open");
    await source.scrollIntoViewIfNeeded();
    const bounds = await source.boundingBox();
    const pointer = {
      pointerId: 91,
      pointerType: "touch",
      isPrimary: true,
      button: 0,
      buttons: 1,
      clientX: bounds.x + 40,
      clientY: bounds.y + 40,
    };
    await source.dispatchEvent("pointerdown", pointer);
    await source.dispatchEvent("pointermove", {
      ...pointer,
      clientY: pointer.clientY + 30,
    });
    await source.dispatchEvent("pointerup", {
      ...pointer,
      buttons: 0,
      clientY: pointer.clientY + 30,
    });
    await source.dispatchEvent("click");
    await expect(page.locator(".artwork-viewer")).not.toBeVisible();
    await source.dispatchEvent("pointerdown", pointer);
    await source.dispatchEvent("pointercancel", pointer);
    await source.dispatchEvent("click");
    await expect(page.locator(".artwork-viewer")).not.toBeVisible();
    await source.tap();
    await expect(page.locator(".artwork-viewer")).toHaveAttribute(
      "data-input",
      "touch",
    );
    f.db.close();
  });

  for (const interruption of [
    "lost capture",
    "resize",
    "second finger",
    "sign out",
  ]) {
    test(`UC-CARD-INPUT-MODES ${interruption} cancels an enlarged touch drag without applying the target`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      const f = await setup(page);
      const writes = [];
      page.on("request", (request) => {
        if (request.url().endsWith("/api/tag-actions"))
          writes.push(request.postDataJSON());
      });
      await page.locator("#grid .card-open").tap();
      const viewer = page.locator(".artwork-viewer"),
        photo = viewer.locator(".artwork-full-image");
      await expect(
        viewer.getByRole("button", { name: "Add Draw", exact: true }),
      ).toBeEnabled();
      await viewer
        .locator(".artwork-open-reveal")
        .evaluate((element) =>
          Promise.all(
            element.getAnimations().map((animation) => animation.finished),
          ),
        );
      const bounds = await photo.boundingBox(),
        target = await viewer
          .getByRole("button", { name: "Add Draw", exact: true })
          .boundingBox();
      const start = {
        pointerId: 71,
        pointerType: "touch",
        isPrimary: true,
        buttons: 1,
        clientX: bounds.x + bounds.width / 2,
        clientY: bounds.y + bounds.height / 2,
      };
      const end = {
        ...start,
        clientX: target.x + target.width / 2,
        clientY: target.y + target.height / 2,
      };
      await photo.dispatchEvent("pointerdown", start);
      await photo.dispatchEvent("pointermove", end);
      await expect(viewer.locator(".artwork-touch-drag-copy")).toBeVisible();
      if (interruption === "lost capture")
        await photo.dispatchEvent("lostpointercapture", end);
      if (interruption === "resize")
        await page.setViewportSize({ width: 420, height: 844 });
      if (interruption === "sign out")
        await page.evaluate(() =>
          window.dispatchEvent(new Event("keeper-sign-out")),
        );
      if (interruption === "second finger") {
        const zoom = Number(await viewer.getAttribute("data-zoom"));
        const second = {
          ...end,
          pointerId: 72,
          isPrimary: false,
          clientX: end.clientX + 30,
        };
        await photo.dispatchEvent("pointerdown", second);
        await photo.dispatchEvent("pointermove", {
          ...second,
          clientX: second.clientX + 60,
        });
        await expect
          .poll(async () => Number(await viewer.getAttribute("data-zoom")))
          .toBeGreaterThan(zoom);
        await photo.dispatchEvent("pointerup", { ...second, buttons: 0 });
      }
      await expect(viewer.locator(".artwork-touch-drag-copy")).toHaveCount(0);
      await viewer.dispatchEvent("pointerup", { ...end, buttons: 0 });
      // Allow a queued frame or late release to run before checking for writes.
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      expect(writes).toEqual([]);
      const [row] = await f.tagged.list("test");
      expect(row.quantity).toBe(9);
      expect(row.locations[0].quantity).toBe(5);
      const role = (await f.tagged.tags("test")).find(
        (tag) => tag.label === "Draw",
      );
      expect((row.tags || []).map((tag) => tag.id)).not.toContain(role.id);
      if (interruption === "sign out") await expect(viewer).not.toBeVisible();
      else await expect(viewer).toBeVisible();
      f.db.close();
    });
  }

  test("UC-CARD-INPUT-MODES dragging the enlarged touch card applies its frozen tag once; cancellation leaves ownership and tags unchanged", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const f = await setup(page);
    const writes = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/api/tag-actions"))
        writes.push(request.postDataJSON());
    });
    await page.locator("#grid .card-open").tap();
    const viewer = page.locator(".artwork-viewer"),
      photo = viewer.locator(".artwork-full-image");
    await viewer
      .locator(".artwork-open-reveal")
      .evaluate((element) =>
        Promise.all(
          element.getAnimations().map((animation) => animation.finished),
        ),
      );
    const bounds = await photo.boundingBox();
    const target = viewer.getByRole("button", {
      name: "Remove Draft Box",
      exact: true,
    });
    await expect(target).toBeEnabled();
    const end = await target.boundingBox();
    const pointer = (x, y) => ({
      pointerId: 51,
      pointerType: "touch",
      isPrimary: true,
      button: 0,
      buttons: 1,
      clientX: x,
      clientY: y,
    });
    const start = pointer(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
    );
    await photo.dispatchEvent("pointerdown", start);
    await photo.dispatchEvent(
      "pointermove",
      pointer(end.x + end.width / 2, end.y + end.height / 2),
    );
    const ghost = viewer.locator(".artwork-touch-drag-copy");
    await expect(ghost).toBeVisible();
    expect((await ghost.boundingBox()).width).toBeCloseTo(bounds.width, 1);
    expect(await photo.boundingBox()).toEqual(bounds);
    await photo.dispatchEvent("pointerup", {
      ...pointer(end.x + end.width / 2, end.y + end.height / 2),
      buttons: 0,
    });
    await expect(ghost).toHaveCount(0);
    await expect(
      viewer.getByRole("button", { name: "Add Draft Box", exact: true }),
    ).toHaveAttribute("aria-busy", "false");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      selected: false,
      tag_id: f.box.id,
      quantity: 5,
    });
    expect((await f.tagged.list("test"))[0].quantity).toBe(9);
    const addRole = await viewer
      .getByRole("button", { name: "Add Draw", exact: true })
      .boundingBox();
    await photo.dispatchEvent("pointerdown", start);
    await photo.dispatchEvent(
      "pointermove",
      pointer(addRole.x + addRole.width / 2, addRole.y + addRole.height / 2),
    );
    await expect(ghost).toBeVisible();
    await photo.dispatchEvent(
      "pointercancel",
      pointer(addRole.x + addRole.width / 2, addRole.y + addRole.height / 2),
    );
    await expect(ghost).toHaveCount(0);
    await expect(
      viewer.getByRole("button", { name: "Add Draw", exact: true }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(writes).toHaveLength(1);
    await expect(viewer).toBeVisible();
    f.db.close();
  });
});
