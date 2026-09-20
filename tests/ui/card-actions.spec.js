import {
  expectInspectorFit,
  expectInspectorSides,
} from "../helpers/artwork-fit.js";
import { test, expect } from "./fixtures.js";
import { fixture, card } from "../helpers/import-page-fixture.js";
import { savePrinting } from "../../db.js";
import { randomUUID } from "node:crypto";
import { checkCardActions } from "../helpers/card-actions-live.js";
const art = {
  ...card,
  image_uris: { normal: "http://127.0.0.1:3100/fixture-card.svg" },
};
const otherArt = {
  ...art,
  id: "33333333-3333-4333-8333-333333333333",
  oracle_id: "44444444-4444-4444-8444-444444444444",
  name: "Zulu Test Card",
  collector_number: "2",
};

for (const mobile of [false, true])
  test.describe(mobile ? "touch live scenario" : "mouse live scenario", () => {
    test.use({
      hasTouch: mobile,
      viewport: mobile
        ? { width: 390, height: 844 }
        : { width: 1280, height: 720 },
    });
    test("UC-CARD-ACTIONS complete deployed scenario rehearses owned retry, pending replay and catalogue confirmation", async ({
      page,
      browser,
    }) => {
      const f = await fixture(page);
      try {
        for (const tag of await f.tagged.tags("test"))
          await f.tagged.deleteTag("test", tag.id);
        savePrinting(f.db, art);
        await page.route("**/fixture-card.svg", (route) =>
          route.fulfill({
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="488" height="680"><rect width="488" height="680" fill="green"/></svg>',
          }),
        );
        for (const path of ["search", "discover"])
          await page.route(`**/api/${path}?*`, (route) =>
            route.fulfill({ json: { cards: [art], total: 1, hasMore: false } }),
          );
        await page.route("**/api/card?*", (route) =>
          route.fulfill({ json: { card: art, source: "fixture" } }),
        );
        await page.goto("/#collection");
        await checkCardActions({ page, browser }, test, mobile, {
          verifyOtherOwner: false,
          realCloud: false,
          commitTagAction: async (route) => ({
            json: await f.tagged.applyTagAction(
              "test",
              route.request().postDataJSON(),
            ),
          }),
          clearData: async (_page, beforeDrafts) => {
            for (const descriptor of (await f.drafts.getDraft("test"))
              .pending_drafts) {
              if (beforeDrafts.has(descriptor.id)) continue;
              const { draft } = await f.drafts.getDraft("test", {
                id: descriptor.id,
              });
              await f.drafts.clearDraft("test", {
                id: draft.id,
                version: draft.version,
                kind: "capture",
              });
            }
            for (const row of await f.tagged.list("test"))
              await f.tagged.remove("test", row.id);
            expect(await f.tagged.list("test")).toEqual([]);
          },
        });
      } finally {
        f.db.close();
      }
    });
  });
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
      "pointerup",
      "click",
      "scroll",
    ])
      document.addEventListener(
        type,
        (event) => {
          window.cardPointerEvents.push({
            type,
            pointerType: event.pointerType,
            pointerId: event.pointerId,
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
  await expect(
    page.locator("#tag-filter option").filter({ hasText: "Draft Box" }),
  ).toHaveCount(1);
}
async function openSavedReview(page, f) {
  await expect
    .poll(async () => (await f.drafts.getDraft("test")).draft?.rows.length || 0)
    .toBe(1);
  const { draft } = await f.drafts.getDraft("test");
  await page.goto("/#import=" + draft.id);
  await expect(page.locator(".draft-row")).toHaveCount(1);
}

test("UC-CARD-RETURN a late tag refresh keeps the catalogue source hidden until artwork returns", async ({
  page,
}) => {
  const f = await setup(page);
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let waiting = false;
  await page.route("**/api/tags", async (route) => {
    waiting = true;
    await held;
    await route.fulfill({ json: await f.tagged.tags("test") });
  });
  try {
    await page.goto("/#catalog");
    await page.locator("#search").fill(card.name);
    await page.locator("#search-submit").click();
    const source = page.locator("#grid .card-open");
    await expect(source).toHaveCount(1);
    await expect.poll(() => waiting).toBe(true);
    await source.click();
    await expectInspectorFit(page);
    release();
    await expect(
      page.locator("#tag-filter option").filter({ hasText: "Draft Box" }),
    ).toHaveCount(1);
    await expect(source).toHaveClass(/artwork-source-lifted/);
    await expectInspectorFit(page);
    await page.keyboard.press("Escape");
    await expect(page.locator(".artwork-viewer")).not.toBeVisible();
    await expect(source).not.toHaveClass(/artwork-source-lifted/);
    await expect(source).toBeFocused();
    expect(await f.tagged.list("test")).toEqual([]);
  } finally {
    release();
    await page.unroute("**/api/tags");
    f.db.close();
  }
});

test("QUALITY-01 a post-return grid redraw preserves exact source focus", async ({
  page,
}) => {
  const f = await setup(page, 1);
  try {
    savePrinting(f.db, otherArt);
    await f.tagged.add("test", {
      printing_id: otherArt.id,
      quantity: 2,
      finish: "nonfoil",
      condition: "NM",
    });
    await page.goto("/#collection");
    const source = page.getByRole("button", {
      name: /Open Draft Test Card printing/,
    });
    const other = page.getByRole("button", {
      name: /Open Zulu Test Card printing/,
    });
    await expect(source).toHaveCount(1);
    await expect(other).toHaveCount(1);
    expect(await source.getAttribute("data-index")).toBe("0");
    await source.click();
    await expectInspectorFit(page);
    await page.keyboard.press("Escape");
    await expect(page.locator(".artwork-viewer")).not.toBeVisible();
    await expect(source).toBeFocused();

    await page.locator("#sort").evaluate((select) => {
      select.value = "quantity";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(await source.getAttribute("data-index")).toBe("1");
    await expect(source).toBeFocused();
    await expect(other).not.toBeFocused();

    const sort = page.locator("#sort");
    await sort.focus();
    await sort.evaluate((select) => {
      select.value = "name";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await expect(sort).toBeFocused();
    await expect(page.locator("#grid .card-open:focus")).toHaveCount(0);
  } finally {
    f.db.close();
  }
});

test("QUALITY-01 a tag refresh completing after artwork return retains source focus", async ({
  page,
}) => {
  const f = await setup(page);
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let waiting = false;
  await page.route("**/api/tags", async (route) => {
    waiting = true;
    await held;
    await route.fulfill({ json: await f.tagged.tags("test") });
  });
  try {
    await page.goto("/#catalog");
    await page.locator("#search").fill(card.name);
    await page.locator("#search-submit").click();
    const source = page.locator("#grid .card-open");
    await expect(source).toHaveCount(1);
    await expect.poll(() => waiting).toBe(true);
    await source.click();
    await expectInspectorFit(page);
    await page.keyboard.press("Escape");
    await expect(page.locator(".artwork-viewer")).not.toBeVisible();
    await expect(source).toBeFocused();

    release();

    await expect(
      page.locator("#tag-filter option").filter({ hasText: "Draft Box" }),
    ).toHaveCount(1);
    await expect(source).toBeFocused();
  } finally {
    release();
    await page.unroute("**/api/tags");
    f.db.close();
  }
});

test("UC-CARD-POINTER burst input coalesces, keeps layout out of hover handlers and stops after cancellation", async ({
  page,
}) => {
  const f = await setup(page, 1);
  try {
    await page.addInitScript(() => {
      const raf = requestAnimationFrame.bind(window),
        cancel = cancelAnimationFrame.bind(window),
        pending = new Set();
      const rect = Element.prototype.getBoundingClientRect;
      window.pointerWork = {
        synchronousReads: 0,
        dispatching: false,
        peak: 0,
        pending: 0,
      };
      Element.prototype.getBoundingClientRect = function () {
        if (window.pointerWork.dispatching)
          window.pointerWork.synchronousReads++;
        return rect.call(this);
      };
      window.requestAnimationFrame = (callback) => {
        const id = raf((time) => {
          pending.delete(id);
          window.pointerWork.pending = pending.size;
          callback(time);
        });
        pending.add(id);
        window.pointerWork.pending = pending.size;
        window.pointerWork.peak = Math.max(
          window.pointerWork.peak,
          pending.size,
        );
        return id;
      };
      window.cancelAnimationFrame = (id) => {
        pending.delete(id);
        window.pointerWork.pending = pending.size;
        cancel(id);
      };
    });
    await page.goto("/#collection");
    await expect(
      page.locator("#tag-filter option").filter({ hasText: "Draft Box" }),
    ).toHaveCount(1);
    const button = page.locator("#grid .card-open");
    await button.evaluate((el) => {
      const r = el.getBoundingClientRect();
      window.pointerWork.dispatching = true;
      for (let i = 0; i < 100; i++)
        el.dispatchEvent(
          new PointerEvent("pointermove", {
            bubbles: true,
            pointerType: "mouse",
            clientX: r.x + r.width * (0.2 + i / 200),
            clientY: r.y + r.height / 2,
          }),
        );
      window.pointerWork.dispatching = false;
    });
    expect(await page.evaluate(() => window.pointerWork.synchronousReads)).toBe(
      0,
    );
    await expect(page.locator(".artwork-hover")).toBeVisible();
    await page.mouse.move(2, 2);
    await expect(page.locator(".artwork-hover")).not.toBeVisible();
    await expect
      .poll(() => page.evaluate(() => window.pointerWork.pending))
      .toBe(0);
    expect(
      await page.evaluate(() => window.pointerWork.peak),
    ).toBeLessThanOrEqual(1);
    await button.focus();
    await page.keyboard.press("Shift+F10");
    await expect(page.locator(".card-action-layer")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect
      .poll(() => page.evaluate(() => window.pointerWork.pending))
      .toBe(0);
    expect((await f.tagged.list("test"))[0].quantity).toBe(1);
  } finally {
    f.db.close();
  }
});

test("UC-CARD-TILES owned deck tiles are image-only; visible 200% preview tilts continuously and fitted inspector preserves the route, tags and quantity", async ({
  page,
}) => {
  const f = await setup(page, 1);
  try {
    const [row] = await f.tagged.list("test"),
      box = (await f.tagged.tags("test")).find(
        (tag) => tag.type === "location",
      );
    await f.tagged.assign("test", row.id, {
      locations: [{ tag_id: box.id, quantity: 2 }],
      tag_ids: [],
    });
    await page.goto("/#tag=" + box.id);
    const tile = page.locator("#grid .card"),
      button = tile.locator(".card-open");
    await expect(button).toBeVisible();
    await expect(tile.locator(".card-hover-info")).not.toBeVisible();
    await expect(
      page.locator(
        '.card-actions-trigger,[data-action="card-actions"],[data-detail-card-actions]',
      ),
    ).toHaveCount(0);
    await expect(
      page.locator(`#tag-filter option[value="${box.id}"]`),
    ).toHaveCount(1);
    await button.scrollIntoViewIfNeeded();
    await expect(button).toBeInViewport({ ratio: 0.9 });
    const b = await button.boundingBox(),
      t = await tile.boundingBox();
    expect(Math.abs(t.height - b.height)).toBeLessThan(1);
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await expect(tile.locator(".card-hover-info")).toBeVisible();
    await expect(page.locator(".artwork-hover")).toBeVisible();
    const preview = page.locator(".artwork-hover"),
      visual = preview.locator(".artwork-hover-visual"),
      r = await preview.boundingBox();
    expect(r.width / b.width).toBeCloseTo(2, 1);
    const matrices = [];
    for (const [x, y] of [
      [0.15, 0.15],
      [0.85, 0.15],
      [0.85, 0.65],
      [0.15, 0.65],
      [0.5, 0.5],
    ]) {
      await page.mouse.move(r.x + r.width * x, r.y + r.height * y, {
        steps: 8,
      });
      await page.waitForTimeout(260);
      await expect(preview).toBeVisible();
      matrices.push(
        await visual.evaluate((el) => getComputedStyle(el).transform),
      );
      expect(await preview.boundingBox()).toEqual(r);
    }
    expect(new Set(matrices).size).toBe(5);
    await expect(page.locator(".artwork-hover-reveal")).toHaveCSS(
      "transform",
      "none",
    );
    await test.info().attach("visible-preview-matrices", {
      body: JSON.stringify(matrices),
      contentType: "application/json",
    });
    await page.screenshot({
      path: test.info().outputPath("owned-deck-hover.png"),
    });
    await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
    await expect(page).toHaveURL(new RegExp("#tag=" + box.id + "$"));
    await expectInspectorFit(page);
    const tag = page.locator(`.artwork-tags [data-inspector-tag="${box.id}"]`);
    await expect(tag).toHaveAttribute("aria-pressed", "true");
    await page.waitForTimeout(400);
    await expect(page.locator(".artwork-open-reveal")).toHaveCSS(
      "transform",
      "none",
    );
    const stage = await page.locator(".artwork-stage").boundingBox();
    await expectInspectorSides(page, (await expectInspectorFit(page)).image);
    expect(stage).toMatchObject({ x: 0, y: 0, width: 1280, height: 720 });
    await expectInspectorFit(page);
    await expect(
      page.locator(".artwork-viewer header,.artwork-viewer footer"),
    ).toHaveCount(0);
    await page.screenshot({
      path: test.info().outputPath("owned-inspector.png"),
    });
    await expect(page.getByLabel("Owned quantity")).toHaveCount(0);
    const role = page
      .locator(".artwork-tags")
      .getByRole("button", { name: "Draw", exact: true });
    await role.click();
    await expect(role).toHaveAttribute("aria-pressed", "true");
    await expect(role).toHaveAttribute("aria-busy", "false");
    const [saved] = await f.tagged.list("test");
    expect(saved.quantity).toBe(1);
    expect(saved.locations[0].quantity).toBe(2);
    expect(saved.allocation_shortfall).toBe(1);
    await page.keyboard.press("Escape");
    await expect(page.locator(".artwork-viewer")).not.toBeVisible();
    await expect(page.locator("#tag-filter")).toHaveValue(box.id);
    await page.reload();
    await button.click();
    await expect(role).toHaveAttribute("aria-pressed", "true");
    await page.goBack();
    await expect(page.locator(".artwork-viewer")).not.toBeVisible();
  } finally {
    f.db.close();
  }
});

test("UC-CARD-TILES ultrawide natural and physical-edge anchors preserve grid, scroll, filters and consumed dismissal", async ({
  page,
}) => {
  const f = await setup(page, 1);
  try {
    for (let i = 0; i < 79; i++) {
      const sample = {
        ...art,
        id: randomUUID(),
        name: `Anchor sample ${String(i).padStart(2, "0")}`,
      };
      savePrinting(f.db, sample);
      await f.tagged.add("test", {
        printing_id: sample.id,
        quantity: 1,
        finish: "nonfoil",
        condition: "NM",
      });
    }
    await page.setViewportSize({ width: 3799, height: 1905 });
    await page.goto("/#collection");
    const tiles = page.locator("#grid .card-open");
    await expect(tiles).toHaveCount(80);
    const firstRow = await tiles.evaluateAll((nodes) => {
      const firstY = nodes[0].getBoundingClientRect().y;
      return nodes.filter((node) => node.getBoundingClientRect().y === firstY)
        .length;
    });
    for (const [name, index] of [
      ["left", 0],
      ["middle", Math.floor(firstRow / 2)],
      ["right", firstRow - 1],
      ["scrolled", firstRow * 6],
      ["physical-left", 0],
      ["physical-right", 1],
    ]) {
      const tile = tiles.nth(index);
      await tile.scrollIntoViewIfNeeded();
      if (name.startsWith("physical"))
        await tile.locator("..").evaluate((el, name) => {
          el.style.cssText = `position:fixed;top:450px;width:180px;z-index:3;${name === "physical-left" ? "left:8px" : "right:8px"}`;
        }, name);
      await page.mouse.move(5, 5);
      const before = await tiles.evaluateAll((nodes) =>
        nodes.map((node) => node.getBoundingClientRect().toJSON()),
      );
      const scroll = await page.evaluate(() => scrollY);
      const filter = await page.locator("#sort").inputValue();
      await tile.click();
      const fit = await expectInspectorFit(page);
      await expectInspectorSides(page, fit.image);
      expect(
        await tiles.evaluateAll((nodes) =>
          nodes.map((node) => node.getBoundingClientRect().toJSON()),
        ),
      ).toEqual(before);
      expect(
        await page
          .locator(".artwork-viewer")
          .evaluate((el) => getComputedStyle(el).backgroundColor),
      ).toBe("rgba(7, 19, 13, 0.267)");
      await page.screenshot({
        path: test.info().outputPath(`anchored-${name}.png`),
      });
      // Dismiss over an actual neighboring card, not only a blank gutter.
      const occupied = await page
        .locator(".artwork-full-image,.artwork-tags")
        .evaluateAll((nodes) =>
          nodes.map((node) => node.getBoundingClientRect().toJSON()),
        );
      const neighbor = before.find((r, i) => {
        const x = r.x + r.width / 2,
          y = r.y + r.height / 2;
        return (
          i !== index &&
          r.y >= 0 &&
          r.bottom < 1905 &&
          occupied.every(
            (o) =>
              x < o.x - 2 || x > o.right + 2 || y < o.y - 2 || y > o.bottom + 2,
          )
        );
      });
      expect(neighbor).toBeTruthy();
      await page.mouse.click(
        neighbor.x + neighbor.width / 2,
        neighbor.y + neighbor.height / 2,
      );
      await expect(page.locator(".artwork-viewer")).not.toBeVisible();
      await page.waitForTimeout(450);
      await expect(page.locator(".artwork-viewer")).not.toBeVisible();
      await expect(tile).toBeFocused();
      expect(await page.evaluate(() => scrollY)).toBe(scroll);
      expect(await tile.boundingBox()).toMatchObject({
        x: before[index].x,
        y: before[index].y,
      });
      await expect(page.locator("#sort")).toHaveValue(filter);
      await expect(page).toHaveURL(/#collection$/);
      await tile.locator("..").evaluate((el) => el.removeAttribute("style"));
    }
    expect(
      (await f.tagged.list("test")).reduce((sum, row) => sum + row.quantity, 0),
    ).toBe(80);
  } finally {
    f.db.close();
  }
});

test("UC-CARD-TILES dwell resets on early leave; reduced motion and touch keep zoom without hover animation", async ({
  page,
}) => {
  const f = await setup(page, 1);
  try {
    await page.goto("/#collection");
    const button = page.locator(".card-open");
    await button.hover();
    await page.waitForTimeout(60);
    await page.mouse.move(5, 5);
    await page.waitForTimeout(240);
    await expect(page.locator(".artwork-hover")).not.toBeVisible();
    await button.hover();
    await expect(page.locator(".artwork-hover")).toBeVisible();
    await page.mouse.move(5, 5);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await button.hover();
    await expect(page.locator(".artwork-hover")).toBeVisible();
    await expect(page.locator(".artwork-hover-reveal")).toHaveCSS(
      "animation-name",
      "none",
    );
    await page.locator(".artwork-hover img").click();
    await expectInspectorFit(page);
    await expect(page.locator(".artwork-open-reveal")).toHaveCSS(
      "animation-name",
      "none",
    );
    expect((await f.tagged.list("test"))[0].quantity).toBe(1);
  } finally {
    f.db.close();
  }
});

test("UC-CARD-WHEEL direct pickup fits full labels and translucent card at all viewport edges", async ({
  page,
}) => {
  const f = await setup(page, 3);
  try {
    await f.tagged.createTag("test", {
      label: "A very long deck name with readable wrapped words",
      type: "location",
      kind: "deck",
    });
    await page.goto("/#collection");
    await expect(
      page.locator("#tag-filter option").filter({
        hasText: "A very long deck name with readable wrapped words",
      }),
    ).toHaveCount(1);
    for (const size of [
      { width: 1280, height: 720 },
      { width: 390, height: 844 },
      { width: 320, height: 568 },
      { width: 844, height: 390 },
    ]) {
      await page.setViewportSize(size);
      for (const [name, x, y] of [
        ["top-left", 2, 2],
        ["top-right", size.width - 178, 2],
        ["bottom-left", 2, size.height - 248],
        ["bottom-right", size.width - 178, size.height - 248],
      ]) {
        // Place a real shared tile at the viewport edge; use native pointer pickup/release.
        await expect(async () => {
          const ready = await page.locator("#grid .card").evaluate(
            (el, { x, y }) => {
              el.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:176px;z-index:20`;
              const rect = el.getBoundingClientRect();
              return (
                rect.x === x &&
                rect.y === y &&
                rect.width === 176 &&
                el.contains(document.elementFromPoint(x + 88, y + 122))
              );
            },
            { x, y },
          );
          expect(ready).toBe(true);
        }).toPass({ timeout: 5000 });
        await page.mouse.move(x + 88, y + 122);
        await page.mouse.down();
        await page.mouse.move(x + 100, y + 122);
        const layer = page.locator(".card-action-layer");
        await expect(layer).toBeVisible();
        const geometry = await layer
          .locator(".card-action-target")
          .evaluateAll((nodes) =>
            nodes.map((el) => {
              const r = el.getBoundingClientRect();
              return {
                x: r.x,
                y: r.y,
                right: r.right,
                bottom: r.bottom,
                clipped:
                  (
                    el.querySelector(".card-action-label") || el
                  ).getBoundingClientRect().bottom >
                  r.bottom + 1,
                text: el.textContent,
              };
            }),
          );
        expect(
          geometry.every(
            (r) =>
              r.x >= 0 &&
              r.y >= 0 &&
              r.right <= size.width &&
              r.bottom <= size.height &&
              !r.clipped,
          ),
        ).toBe(true);
        const ghost = page.locator(".card-drag-copy");
        expect((await ghost.boundingBox()).width).toBe(176);
        expect(
          Number(await ghost.evaluate((el) => getComputedStyle(el).opacity)),
        ).toBeLessThan(0.4);
        await page.screenshot({
          path: test.info().outputPath(`wheel-${size.width}-${name}.png`),
        });
        await page.keyboard.press("Escape");
        await page.mouse.up();
        await expect(page.locator(".artwork-viewer")).not.toBeVisible();
      }
    }
    expect((await f.tagged.list("test"))[0].quantity).toBe(3);
  } finally {
    f.db.close();
  }
});

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
    await page.locator(".artwork-hover img").click();
    await expect(page.locator(".artwork-viewer")).toBeVisible();
    await expectInspectorFit(page);
    const openingPercent = await page
      .locator(".artwork-viewer")
      .getAttribute("data-zoom");
    await page.locator(".artwork-full-image").hover();
    await page.mouse.wheel(0, -400);
    await expect(page.locator(".artwork-viewer")).not.toHaveAttribute(
      "data-zoom",
      openingPercent,
    );
    await page.keyboard.press("Escape");
    await expect(page.locator(".artwork-viewer")).not.toBeVisible();
    await expect(button).toBeFocused();
    await button.press("Shift+F10");
    await page
      .getByRole("menuitem", { name: "More tags…", exact: true })
      .click();
    await page
      .locator(".card-action-more")
      .getByRole("button", { name: "Card details", exact: true })
      .click();
    await expect(page.locator("#detail")).toBeVisible();
    await page.locator("#close").click();
    await expect(page).toHaveURL(/#catalog$/);
    await expect(page.locator("#search")).toHaveValue(card.name);
    await expect(button).toBeVisible();
    await button.click();
    await page.locator(".artwork-full-image").hover();
    await page.mouse.wheel(0, 1200);
    const area = await page.locator(".artwork-stage").boundingBox();
    await page.mouse.click(area.x + 3, area.y + 3);
    await expect(page.locator(".artwork-viewer")).not.toBeVisible();
    await expect(page.locator("#detail")).not.toBeVisible();
    expect(await f.tagged.list("test")).toEqual([]);
  } finally {
    f.db.close();
  }
});

test("UC-CARD-ACTIONS drag keeps a full-size translucent copy, frozen targets and one-copy location changes; Escape cancels without navigation", async ({
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
      b.width,
    );
    await expect(img).toBeVisible();
    await expect(page.locator(".card-pickup")).toHaveCSS("user-select", "none");
    expect(
      await page.evaluate(() => {
        const event = new Event("selectstart", {
          bubbles: true,
          cancelable: true,
        });
        return document.body.dispatchEvent(event);
      }),
    ).toBe(false);
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
    expect(
      await page
        .locator("body")
        .evaluate((el) => getComputedStyle(el).userSelect),
    ).not.toBe("none");
    await expect(page.locator(".card-pickup")).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        document.body.dispatchEvent(
          new Event("selectstart", { bubbles: true, cancelable: true }),
        ),
      ),
    ).toBe(true);
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
    const savedResponse = page.waitForResponse((response) =>
      response.url().endsWith("/api/tag-actions"),
    );
    await page.mouse.up();
    expect((await savedResponse).ok()).toBe(true);
    const [saved] = await f.tagged.list("test");
    expect(saved.quantity).toBe(3);
    await page.locator("#grid .card-open").press("Shift+F10");
    const editTags = page.getByRole("menuitem", {
      name: "Edit tags",
      exact: true,
    });
    if (await editTags.count()) await editTags.click();
    else {
      await page
        .getByRole("menuitem", { name: "More tags…", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Edit tags", exact: true })
        .click();
    }
    await expect(page.locator(".tag-dialog #save-tags")).toBeVisible();
    expect(saved.locations.find((a) => a.tag_id === box.id).quantity).toBe(2);
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
    await page.locator("#grid .card-open").press("Shift+F10");
    await page
      .getByRole("menuitem", { name: "Add Draft Box", exact: true })
      .click();
    await expect(page.locator(".card-action-status")).toContainText(
      "Response lost",
    );
    await page.reload();
    await page.getByRole("button", { name: "Retry card action" }).click();
    await expect(page.locator(".card-action-status")).not.toBeVisible();
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
    await page.locator("#grid .card-open").press("Shift+F10");
    await page
      .getByRole("menuitem", { name: "Add Draft Box", exact: true })
      .click();
    await expect(page).toHaveURL(/#catalog$/);
    await openSavedReview(page, f);
    await expect(page.locator(".draft-row")).toHaveCount(1);
    expect(await f.tagged.list("test")).toEqual([]);
    const pendingUrl = page.url();
    await page.locator(".draft-artwork").click();
    await expectInspectorFit(page);
    await expect(
      page
        .locator(".artwork-tags")
        .getByRole("button", { name: "Draft Box", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(page.url()).toBe(pendingUrl);
    await page.keyboard.press("Escape");
    await expect(page.locator(".artwork-viewer")).not.toBeVisible();
    await page.locator(".draft-artwork").press("Shift+F10");
    await page.getByRole("menuitem", { name: "Add Draw", exact: true }).click();
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
    await expect(page.locator(".card-action-layer")).toBeVisible();
    expect(
      await page.locator(".card-action-target").count(),
    ).toBeLessThanOrEqual(10);
    expect(
      await page.locator(".card-action-target").count(),
    ).toBeGreaterThanOrEqual(3);
    await page
      .getByRole("menuitem", { name: "More tags…", exact: true })
      .click();
    await expect(page.locator(".card-action-more>div button")).toHaveCount(20);
    await page.getByLabel("Find a tag", { exact: true }).fill("Bulk 24");
    await page
      .locator(".card-action-more")
      .getByRole("button", { name: "Add Bulk 24", exact: true })
      .click();
    await expect
      .poll(async () =>
        (await f.tagged.list("test"))[0].tags.some(
          (tag) => tag.label === "Bulk 24",
        ),
      )
      .toBe(true);
    await page.locator("#grid .card-open").press("Shift+F10");
    await expect(
      page.locator('.card-action-target[data-target="0"]'),
    ).toHaveAccessibleName("Remove Bulk 24");
    await page.keyboard.press("Escape");
    await expect(page.locator("#grid .card-open")).toBeFocused();
    expect((await f.tagged.list("test"))[0].quantity).toBe(3);
  } finally {
    f.db.close();
  }
});

test("UC-CARD-ACTIONS phone overflow keeps catalogue review reachable without claiming ownership", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await setup(page);
  try {
    for (const label of ["Action Source 12345678", "Action Target 12345678"])
      await f.tagged.createTag("test", {
        label,
        type: "location",
        kind: "box",
      });
    await catalogue(page);
    await page.locator("#grid .card-open").press("Shift+F10");
    await expect(
      page.locator('.card-action-target[data-tag-id="edit"]'),
    ).toHaveCount(0);
    await page
      .getByRole("menuitem", { name: "More tags…", exact: true })
      .click();
    await page
      .locator(".card-action-more")
      .getByRole("button", { name: "Review & add", exact: true })
      .click();
    await expect(page.locator(".draft-row")).toHaveCount(1);
    expect(await f.tagged.list("test")).toEqual([]);
    await page.reload();
    await expect(page.locator(".draft-row")).toHaveCount(1);
    await page.locator("#draft-clear").click();
    await expect(page.locator(".draft-row")).toHaveCount(0);
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
    await page.locator("#grid .card-open").press("Shift+F10");
    await page
      .getByRole("menuitem", { name: "Add Draft Box", exact: true })
      .click();
    await expect(page.locator(".card-action-status")).toContainText(
      "action was rejected",
    );
    await page.locator("#grid .card-open").press("Shift+F10");
    await page
      .getByRole("menuitem", { name: "More tags…", exact: true })
      .click();
    await page
      .locator(".card-action-more")
      .getByRole("button", { name: "Review & add", exact: true })
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
  test("UC-CARD-TILES native owned and Home taps keep their routes and phone panels inside the viewport", async ({
    page,
  }) => {
    const f = await setup(page, 2);
    try {
      await page.goto("/#collection");
      await page.locator(".card-open").tap();
      await expect(page).toHaveURL(/#collection$/);
      await expectInspectorFit(page);
      await expect(page.getByLabel("Owned quantity")).toHaveCount(0);
      await expect(page.locator(".artwork-touch-wheel")).toBeVisible();
      await page.waitForTimeout(240);
      const panels = await page
        .locator(".artwork-inspector>aside")
        .evaluateAll((nodes) =>
          nodes.map((el) => {
            const r = el.getBoundingClientRect();
            return { x: r.x, right: r.right, bottom: r.bottom };
          }),
        );
      expect(
        panels.every((r) => r.x >= 0 && r.right <= 390 && r.bottom <= 844),
      ).toBe(true);
      await page.screenshot({
        path: test.info().outputPath("phone-owned-inspector.png"),
      });
      await page.touchscreen.tap(5, 5);
      await expect(page.locator(".artwork-viewer")).not.toBeVisible();
      await page.locator(".card-open").press("Shift+F10");
      await page
        .getByRole("menuitem", { name: "More tags…", exact: true })
        .tap();
      await page
        .locator(".card-action-more")
        .getByRole("button", { name: "Card details", exact: true })
        .tap();
      await expect(page.locator("#detail")).toBeVisible();
      const detailUrl = page.url();
      await page.locator(".detail-image img").tap();
      await expect(page.locator(".artwork-viewer")).toBeVisible();
      expect(page.url()).toBe(detailUrl);
      await page.touchscreen.tap(5, 5);
      await expect(page.locator(".artwork-viewer")).not.toBeVisible();
      await page.locator("#close").tap();
      await page.locator("#home-nav").tap();
      await page.locator(".home-card button").tap();
      await expect(page).toHaveURL(/#home$/);
      await expectInspectorFit(page);
      await expect(page.locator(".artwork-hover")).not.toBeVisible();
      await page.goBack();
      await expect(page.locator(".artwork-viewer")).not.toBeVisible();
      expect((await f.tagged.list("test"))[0].quantity).toBe(2);
    } finally {
      f.db.close();
    }
  });
  test("UC-CARD-TOUCH native tap opens artwork; controlled pinch, scroll cancellation and long press keep ownership explicit", async ({
    page,
  }) => {
    const f = await setup(page);
    try {
      await catalogue(page);
      await page.locator("#grid .card-open").tap();
      await expectInspectorFit(page);
      const openingPercent = Number(
        await page.locator(".artwork-viewer").getAttribute("data-zoom"),
      );
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
      await expect
        .poll(async () =>
          Number(
            await page.locator(".artwork-viewer").getAttribute("data-zoom"),
          ),
        )
        .toBeGreaterThan(openingPercent);
      await photo.dispatchEvent("pointerup", pointer(41, 120, 300));
      await photo.dispatchEvent("pointermove", pointer(42, 340, 330));
      await photo.dispatchEvent("pointerup", pointer(42, 340, 330));
      expect(
        await photo.evaluate((el) => getComputedStyle(el).transform),
      ).not.toContain("NaN");
      await page.touchscreen.tap(5, 5);
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
        .getByRole("menuitem", { name: "Add Draft Box", exact: true })
        .evaluate((el) => ({
          x: parseFloat(el.style.left),
          y: parseFloat(el.style.top),
        }));
      await img.dispatchEvent("pointermove", pointer(44, target.x, target.y));
      await img.dispatchEvent("pointerup", pointer(44, target.x, target.y));
      await openSavedReview(page, f);
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

test("UC-CARD-TAG-TOGGLE a late tag reply cannot replace another account's collection", async ({
  page,
}) => {
  await page.route("**/quantity-port-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Quantity port fixture</title>",
    }),
  );
  await page.goto("/quantity-port-fixture");
  const result = await page.evaluate(async () => {
    const { createCardActions } = await import("/card-actions.js");
    const { collectionCard } = await import("/collection-view.js");
    const row = {
      id: "account-a-entry",
      quantity: 2,
      finish: "nonfoil",
      condition: "NM",
      card: {
        id: "printing-a",
        name: "Private A",
        set: "tst",
        collector_number: "1",
        lang: "en",
        finishes: ["nonfoil"],
      },
    };
    document.body.innerHTML = `<div id="grid">${collectionCard(row, 0)}</div>`;
    let resolve;
    const updates = [];
    const tag = { id: "tag-a", label: "Role A", type: "role" };
    const actions = createCardActions({
      request: (path) =>
        path === "/api/tags"
          ? Promise.resolve([tag])
          : new Promise((r) => (resolve = r)),
      currentView: () => 1,
      onOwned: (rows) => updates.push(rows),
      onPending() {},
      getState: () => ({
        visibleCards: [row],
        mode: "collection",
        filterTags: [tag],
        activeTagId: "",
      }),
      home: { tag() {}, card() {}, recentTags: [], cardAction() {} },
      importPage: { cardAction() {} },
      cardPage: {},
      detail() {},
      editTags() {},
      navigateTag() {},
      remember() {},
      notify() {},
      onSettled() {},
    });
    actions.start("account-a");
    document.querySelector(".card-open").click();
    await new Promise((r) => setTimeout(r, 0));
    document.querySelector(".card-tag-toggle").click();
    actions.stop();
    window.dispatchEvent(new Event("keeper-sign-out"));
    actions.start("account-b");
    resolve([{ ...row, tag_ids: [tag.id], tags: [tag] }]);
    await new Promise((r) => setTimeout(r, 0));
    return { updates, open: document.querySelector(".artwork-viewer").open };
  });
  expect(result).toEqual({ updates: [], open: false });
});
