import { test, expect } from "./fixtures.js";
import { fixture, card } from "../helpers/import-page-fixture.js";
import { savePrinting } from "../../db.js";
const art = {
  ...card,
  image_uris: { normal: "http://127.0.0.1:3100/fixture-card.svg" },
};
test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) =>
    console.log("Card interaction error:", error.message),
  );
  await page.addInitScript(() => {
    window.cardPointerEvents = [];
    for (const type of [
      "pointerdown",
      "pointermove",
      "pointercancel",
      "scroll",
    ])
      document.addEventListener(
        type,
        (event) => {
          window.cardPointerEvents.push({
            type,
            target: event.target.tagName,
            cls: event.target.className,
            x: event.clientX,
            y: event.clientY,
            scroll: scrollY,
          });
          if (window.cardPointerEvents.length > 20)
            window.cardPointerEvents.shift();
        },
        true,
      );
  });
});
test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus)
    console.log(
      "Card gesture observations",
      JSON.stringify(
        await page.evaluate(() => ({
          events: window.cardPointerEvents,
          viewport: [innerWidth, innerHeight],
          image: document
            .querySelector("#grid img")
            ?.getBoundingClientRect()
            .toJSON(),
        })),
      ),
    );
});
async function setup(page, quantity = 0) {
  const f = await fixture(page);
  savePrinting(f.db, art);
  await page.route("**/fixture-card.svg", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="488" height="680"><rect width="488" height="680" rx="24" fill="#192e23"/><rect x="22" y="22" width="444" height="390" rx="12" fill="#72947b"/><text x="40" y="470" font-size="30" fill="white">Draft Test Card</text></svg>',
    }),
  );
  await page.route("**/api/search?*", (route) =>
    route.fulfill({ json: { cards: [art], total: 1, hasMore: false } }),
  );
  await page.route("**/api/discover?*", (route) =>
    route.fulfill({ json: { cards: [art], total: 1, hasMore: false } }),
  );
  if (quantity)
    await f.tagged.add("test", {
      printing_id: card.id,
      quantity,
      finish: "nonfoil",
      condition: "NM",
    });
  return f;
}
async function catalogue(page) {
  await page.goto("/#catalog");
  await page.locator("#search").fill(card.name);
  await page.locator("#search-submit").click();
  await expect(page.locator("#grid .card")).toHaveCount(1);
}

test("UC-CARD-ART catalogue is artwork-only; hover, zoom, outside dismissal and detail Back preserve the originating search", async ({
  page,
}) => {
  const f = await setup(page);
  try {
    await catalogue(page);
    await expect(page.locator("#grid .card-info")).toHaveCount(0);
    const button = page.locator("#grid .card-open"),
      img = button.locator("img");
    await img.hover();
    await expect(page.locator(".artwork-hover")).toBeVisible();
    await button.click();
    await expect(page.locator(".artwork-viewer")).toBeVisible();
    await expect(page.locator(".artwork-viewer output")).toHaveText("300%");
    await page.locator(".artwork-stage").hover();
    await page.mouse.wheel(0, -400);
    await expect(page.locator(".artwork-viewer output")).not.toHaveText("300%");
    await page.keyboard.press("Escape");
    await expect(page.locator(".artwork-viewer")).not.toBeVisible();
    await expect(button).toBeFocused();
    await button.click();
    await page.locator('[data-artwork="details"]').click();
    await expect(page.locator("#detail")).toBeVisible();
    await page.locator("#close").click();
    await expect(page).toHaveURL(/#catalog$/);
    await expect(page.locator("#search")).toHaveValue(card.name);
    await expect(button).toBeVisible();
    await button.click();
    for (let i = 0; i < 6; i++)
      await page.locator('[data-artwork="out"]').click();
    const area = await page.locator(".artwork-stage").boundingBox();
    await page.mouse.click(area.x + 3, area.y + 3);
    await expect(page.locator(".artwork-viewer")).not.toBeVisible();
    await expect(page.locator("#detail")).not.toBeVisible();
    expect(await f.tagged.list("test")).toEqual([]);
  } finally {
    f.db.close();
  }
});

test("UC-CARD-ACTIONS drag keeps a small offset copy, frozen targets and one-copy location changes; Escape cancels without navigation", async ({
  page,
}) => {
  const f = await setup(page, 3);
  try {
    const box = (await f.tagged.tags("test")).find(
      (t) => t.type === "location",
    );
    const target = (
      await f.tagged.createTag("test", {
        label: "Target deck",
        type: "location",
        kind: "deck",
      })
    ).find((t) => t.label === "Target deck");
    const [row] = await f.tagged.list("test");
    await f.tagged.assign("test", row.id, {
      locations: [{ tag_id: box.id, quantity: 2 }],
      tag_ids: [],
    });
    await page.goto("/#tag=" + box.id);
    await expect(
      page.locator(`#tag-filter option[value="${target.id}"]`),
    ).toHaveCount(1);
    const img = page.locator("#grid .card-open img");
    await expect(img).toBeVisible();
    await expect(async () => {
      await img.scrollIntoViewIfNeeded();
      await expect(img).toBeInViewport({ ratio: 0.9 });
    }).toPass({ timeout: 5000 });
    const b = await img.boundingBox(),
      start = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 15, start.y);
    await expect(page.locator(".card-drag-copy")).toBeVisible();
    expect((await page.locator(".card-drag-copy").boundingBox()).width).toBe(
      48,
    );
    await expect(img).toBeVisible();
    const refreshedTags = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/tags") &&
        response.request().method() === "GET",
    );
    await page.evaluate(() => {
      window.heldCard = document.querySelector("#grid .card");
      document.querySelector("#refresh").click();
    });
    await refreshedTags;
    await page.evaluate(() => new Promise(requestAnimationFrame));
    expect(
      await page.evaluate(
        () => window.heldCard === document.querySelector("#grid .card"),
      ),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect(page.locator(".card-action-layer")).not.toBeVisible();
    await expect(page.locator("#detail")).not.toBeVisible();
    expect((await f.tagged.list("test"))[0].locations[0].quantity).toBe(2);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 15, start.y);
    const targetButton = page.locator(
      `.card-action-target[data-tag-id="${target.id}"]`,
    );
    const fixed = await targetButton.evaluate((el) => [
      el.style.left,
      el.style.top,
    ]);
    await page.mouse.move(parseFloat(fixed[0]), parseFloat(fixed[1]), {
      steps: 6,
    });
    expect(
      await targetButton.evaluate((el) => [el.style.left, el.style.top]),
    ).toEqual(fixed);
    await page.mouse.up();
    await expect(page.locator(".card-action-status")).toContainText(
      "Card tags saved",
    );
    const [saved] = await f.tagged.list("test");
    expect(saved.quantity).toBe(3);
    await page.locator(".card-actions-trigger").click();
    await page
      .getByRole("menuitem", { name: "Edit tags", exact: true })
      .click();
    await expect(page.locator(".tag-dialog #save-tags")).toBeVisible();
    expect(saved.locations.find((a) => a.tag_id === box.id).quantity).toBe(1);
    expect(saved.locations.find((a) => a.tag_id === target.id).quantity).toBe(
      1,
    );
  } finally {
    f.db.close();
  }
});

test("UC-CARD-ACTIONS ambiguous save survives reload and retries the same operation without another copy", async ({
  page,
}) => {
  const f = await setup(page, 3);
  const ids = [];
  let lost = true;
  await page.route("**/api/tag-actions", async (route) => {
    const input = route.request().postDataJSON();
    ids.push(input.operation_id);
    const result = await f.tagged.applyTagAction("test", input);
    if (lost) {
      lost = false;
      await route.fulfill({
        status: 503,
        json: { error: "Response lost after commit" },
      });
    } else await route.fulfill({ json: result });
  });
  try {
    await page.goto("/#collection");
    await page.locator(".card-actions-trigger").click();
    await page
      .getByRole("menuitem", { name: "Draft Box", exact: true })
      .click();
    await expect(page.locator(".card-action-status")).toContainText(
      "Response lost",
    );
    await page.reload();
    await page.getByRole("button", { name: "Retry card action" }).click();
    await expect(page.locator(".card-action-status")).toContainText(
      "Card tags saved",
    );
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    const [saved] = await f.tagged.list("test");
    expect(saved.quantity).toBe(3);
    expect(saved.allocated_quantity).toBe(1);
  } finally {
    f.db.close();
  }
});

test("UC-CARD-ACTIONS catalogue tags enter pending Import; pending tag changes never add ownership", async ({
  page,
}) => {
  const f = await setup(page);
  try {
    await catalogue(page);
    await page.locator(".card-actions-trigger").click();
    await page
      .getByRole("menuitem", { name: "Draft Box", exact: true })
      .click();
    await expect(page).toHaveURL(/#import=/);
    await expect(page.locator(".draft-row")).toHaveCount(1);
    expect(await f.tagged.list("test")).toEqual([]);
    await page.locator('[data-action="card-actions"]').click();
    await page.getByRole("menuitem", { name: "Draw", exact: true }).click();
    await expect(page.locator(".draft-tag-summary")).toContainText(
      "1 classifications",
    );
    await page.reload();
    await expect(page.locator(".draft-tag-summary")).toContainText(
      "1 classifications",
    );
    expect(await f.tagged.list("test")).toEqual([]);
    await page.locator("#draft-clear").click();
    await expect(page.locator(".draft-row")).toHaveCount(0);
  } finally {
    f.db.close();
  }
});

test("UC-CARD-ACTIONS keyboard overflow is bounded, searchable and promotes the last used tag on the next wheel", async ({
  page,
}) => {
  const f = await setup(page, 3);
  try {
    for (let i = 0; i < 25; i++)
      await f.tagged.createTag("test", {
        label: `Bulk ${String(i).padStart(2, "0")}`,
        type: "role",
        kind: "role",
      });
    await page.goto("/#collection");
    const button = page.locator("#grid .card-open");
    await button.focus();
    await page.keyboard.press("Shift+F10");
    await expect(page.locator(".card-action-target")).toHaveCount(10);
    await page
      .getByRole("menuitem", { name: "More tags…", exact: true })
      .click();
    await expect(page.locator(".card-action-more>div button")).toHaveCount(20);
    await page.getByLabel("Find a tag", { exact: true }).fill("Bulk 24");
    await page
      .locator(".card-action-more")
      .getByRole("button", { name: "Bulk 24", exact: true })
      .click();
    await expect(page.locator(".card-action-status")).toContainText(
      "Card tags saved",
    );
    await page.locator(".card-actions-trigger").click();
    await expect(
      page.locator('.card-action-target[data-target="2"]'),
    ).toHaveText("Bulk 24");
    await page.keyboard.press("Escape");
    await expect(page.locator("#grid .card-open")).toBeFocused();
    expect((await f.tagged.list("test"))[0].quantity).toBe(3);
  } finally {
    f.db.close();
  }
});

test("UC-CARD-ACTIONS definite rejection permits a new choice; a late pending save cannot reopen a departed view", async ({
  page,
}) => {
  const f = await setup(page);
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  await page.route("**/api/import-draft/stage", async (route) => {
    const input = route.request().postDataJSON();
    if (input.tag_id)
      return route.fulfill({ status: 409, json: { error: "Tag deleted" } });
    const result = await f.drafts.stageDraft("test", input);
    await gate;
    await route.fulfill({ json: result });
  });
  try {
    await catalogue(page);
    await page.locator(".card-actions-trigger").click();
    await page
      .getByRole("menuitem", { name: "Draft Box", exact: true })
      .click();
    await expect(page.locator(".card-action-status")).toContainText(
      "action was rejected",
    );
    await page.locator(".card-actions-trigger").click();
    await page
      .getByRole("menuitem", { name: "Review & add", exact: true })
      .click();
    await expect(page.locator(".card-action-status")).toContainText(
      "Saving card action",
    );
    await page.locator("#home-nav").click();
    release();
    await expect(page.locator(".card-action-status")).toContainText(
      "Pending review saved",
    );
    await expect(page).toHaveURL(/#home$/);
    await expect(page.locator("#home-page")).toBeVisible();
    expect(await f.tagged.list("test")).toEqual([]);
  } finally {
    release();
    f.db.close();
  }
});

test.describe("phone card actions", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  test("UC-CARD-TOUCH native tap opens artwork; controlled pinch, scroll cancellation and long press keep ownership explicit", async ({
    page,
  }) => {
    const f = await setup(page);
    try {
      await catalogue(page);
      await page.locator("#grid .card-open").tap();
      await expect(page.locator(".artwork-viewer output")).toHaveText("300%");
      const photo = page.locator(".artwork-full-image"),
        pointer = (id, x, y) => ({
          pointerId: id,
          pointerType: "touch",
          clientX: x,
          clientY: y,
          bubbles: true,
          buttons: 1,
        });
      // Controlled pointer transitions exercise the state machine; the tap above is native WebKit/Chromium touch.
      await photo.dispatchEvent("pointerdown", pointer(41, 120, 300));
      await photo.dispatchEvent("pointerdown", pointer(42, 220, 300));
      await photo.dispatchEvent("pointermove", pointer(42, 320, 300));
      await expect(page.locator(".artwork-viewer output")).toHaveText("600%");
      await photo.dispatchEvent("pointerup", pointer(41, 120, 300));
      await photo.dispatchEvent("pointermove", pointer(42, 340, 330));
      await photo.dispatchEvent("pointerup", pointer(42, 340, 330));
      expect(
        await photo.evaluate((el) => getComputedStyle(el).transform),
      ).not.toContain("NaN");
      await page.locator('[data-artwork="close"]').tap();
      await expect(page.locator(".artwork-viewer")).not.toBeVisible();
      const img = page.locator("#grid .card-open img");
      await expect(async () => {
        await img.scrollIntoViewIfNeeded();
        await expect(img).toBeInViewport({ ratio: 0.9 });
      }).toPass({ timeout: 5000 });
      const r = await img.boundingBox(),
        x = r.x + r.width / 2,
        y = r.y + r.height / 2;
      await img.dispatchEvent("pointerdown", pointer(43, x, y));
      await img.dispatchEvent("pointermove", pointer(43, x, y + 40));
      await page.waitForTimeout(420);
      await expect(page.locator(".card-action-layer")).not.toBeVisible();
      await img.dispatchEvent("pointerup", pointer(43, x, y + 40));
      await img.dispatchEvent("pointerdown", pointer(44, x, y));
      await expect(page.locator(".card-action-layer")).toBeVisible();
      const targets = await page
        .locator(".card-action-target")
        .evaluateAll((nodes) =>
          nodes.map((el) => {
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
          }),
        );
      expect(
        targets.every(
          (r) => r.x >= 0 && r.right <= 390 && r.y >= 0 && r.bottom <= 844,
        ),
      ).toBe(true);
      await page.screenshot({
        path: test.info().outputPath("phone-card-wheel.png"),
      });
      const target = await page
        .getByRole("menuitem", { name: "Draft Box", exact: true })
        .evaluate((el) => ({
          x: parseFloat(el.style.left),
          y: parseFloat(el.style.top),
        }));
      await img.dispatchEvent("pointermove", pointer(44, target.x, target.y));
      await img.dispatchEvent("pointerup", pointer(44, target.x, target.y));
      await expect(page).toHaveURL(/#import=/);
      expect(await f.tagged.list("test")).toEqual([]);
    } finally {
      f.db.close();
    }
  });
});

test("UC-CARD-PERF one thousand catalogue cards have no idle animation loop or per-card promoted layers", async ({
  page,
}) => {
  const f = await setup(page);
  await page.addInitScript(() => {
    window.cardFrameCount = 0;
    const raf = window.requestAnimationFrame;
    window.requestAnimationFrame = function (callback) {
      return raf.call(window, (time) => {
        window.cardFrameCount++;
        callback(time);
      });
    };
  });
  await page.route("**/api/discover?*", (route) =>
    route.fulfill({
      json: {
        cards: Array.from({ length: 1000 }, (_, i) => ({
          ...art,
          name: `Card ${i}`,
        })),
        total: 1000,
        hasMore: false,
      },
    }),
  );
  try {
    await page.goto("/#catalog");
    await page.locator("#search").fill("stress fixture");
    const began = Date.now();
    await page.locator("#search-submit").click();
    await expect(page.locator("#grid .card")).toHaveCount(1000);
    const renderMs = Date.now() - began;
    await page.waitForTimeout(200);
    const before = await page.evaluate(() => window.cardFrameCount);
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => window.cardFrameCount)).toBe(before);
    expect(
      await page
        .locator("#grid img")
        .evaluateAll(
          (images) =>
            images.filter((img) => getComputedStyle(img).willChange !== "auto")
              .length,
        ),
    ).toBe(0);
    await page.locator("#grid img").first().hover();
    await expect(page.locator(".artwork-hover")).toBeVisible();
    await expect(page.locator(".artwork-hover")).toHaveCSS("opacity", "1");
    await page.screenshot({
      path: test.info().outputPath("catalogue-artwork-grid.png"),
    });
    await page.mouse.move(10, 10);
    await page.waitForTimeout(220);
    const stopped = await page.evaluate(() => window.cardFrameCount);
    await page.waitForTimeout(220);
    expect(await page.evaluate(() => window.cardFrameCount)).toBe(stopped);
    console.log(
      JSON.stringify({
        cardInteractionPerformance: true,
        fixtureCards: 1000,
        renderMs,
        desktopBrowser: true,
        physicalPhoneVerified: false,
        idleAnimationFrames: 0,
        perCardWillChange: 0,
      }),
    );
  } finally {
    f.db.close();
  }
});

test("UC-CARD-ACTIONS retry journals isolate accounts and reject late saves after account or view changes", async ({
  page,
}) => {
  await page.route("**/action-save-fixture", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Card action port fixture</title>",
    }),
  );
  await page.goto("/action-save-fixture");
  const result = await page.evaluate(async () => {
    const { createCardActionSave } = await import("/card-action-save.js");
    let resolve,
      view = 1;
    const effects = [],
      calls = [];
    const save = createCardActionSave({
      api: (path, options) => {
        calls.push({ path, payload: JSON.parse(options.body) });
        return new Promise((r) => (resolve = r));
      },
      currentView: () => view,
      onOwned: (rows) => effects.push(["owned", rows]),
      onPending: (id) => effects.push(["pending", id]),
      onUsed: (id) => effects.push(["tag", id]),
      notify: (text) => effects.push(["notice", text]),
    });
    const intent = {
      kind: "owned",
      tag: "tag-a",
      payload: { operation_id: "operation-a" },
    };
    save.start("account-a");
    const first = save.save(intent);
    save.stop();
    save.start("account-b");
    resolve([{ id: "a-private-row" }]);
    await first;
    const isolated = {
      effects: [...effects],
      hidden: document.querySelector(".card-action-status").hidden,
      savedA: JSON.parse(
        sessionStorage.getItem("keeper-card-action-v1:account-a"),
      ),
      savedB: sessionStorage.getItem("keeper-card-action-v1:account-b"),
    };
    save.stop();
    save.start("account-a");
    document.querySelector(".card-action-status button").click();
    resolve([{ id: "a-private-row" }]);
    await new Promise((r) => setTimeout(r, 0));
    const retried = {
      effects: [...effects],
      calls: [...calls],
      saved: sessionStorage.getItem("keeper-card-action-v1:account-a"),
    };
    effects.length = 0;
    const staged = save.save({
      kind: "catalog",
      payload: { id: "catalog-action" },
    });
    view++;
    resolve({ draft: { id: "pending-a" } });
    await staged;
    const departed = [...effects];
    return { isolated, retried, departed };
  });
  expect(result.isolated).toEqual({
    effects: [],
    hidden: true,
    savedA: {
      kind: "owned",
      tag: "tag-a",
      payload: { operation_id: "operation-a" },
    },
    savedB: null,
  });
  expect(result.retried.calls).toHaveLength(2);
  expect(result.retried.calls[0]).toEqual(result.retried.calls[1]);
  expect(result.retried.effects).toEqual([
    ["owned", [{ id: "a-private-row" }]],
    ["tag", "tag-a"],
  ]);
  expect(result.retried.saved).toBeNull();
  expect(result.departed).toEqual([]);
});

test("UC-CARD-ACTIONS unavailable retry storage sends no write and corrupt journals block replacement", async ({
  page,
}) => {
  await page.route("**/action-save-fixture", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Card action port fixture</title>",
    }),
  );
  await page.goto("/action-save-fixture");
  const result = await page.evaluate(async () => {
    const { createCardActionSave } = await import("/card-action-save.js");
    const writes = [],
      notices = [];
    const save = createCardActionSave({
      api: (...args) => writes.push(args),
      currentView: () => 1,
      onOwned() {},
      onPending() {},
      onUsed() {},
      notify: (s) => notices.push(s),
    });
    save.start("storage-test");
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw Error("storage full");
    };
    await save.save({ kind: "owned", payload: { operation_id: "blocked" } });
    Storage.prototype.setItem = original;
    const failed = document.querySelector(".card-action-status").textContent;
    sessionStorage.setItem("keeper-card-action-v1:corrupt", "{");
    save.start("corrupt");
    await save.save({
      kind: "owned",
      payload: { operation_id: "replacement" },
    });
    return {
      writes,
      notices,
      failed,
      corrupt: sessionStorage.getItem("keeper-card-action-v1:corrupt"),
    };
  });
  expect(result.writes).toEqual([]);
  expect(result.failed).toContain("No request was sent");
  expect(result.notices[0]).toContain("retry storage must be ready");
  expect(result.corrupt).toBe("{");
});
