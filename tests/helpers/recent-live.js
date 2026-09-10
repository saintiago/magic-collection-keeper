import { expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { liveApi } from "./backend-live.js";

export async function exerciseRecentPrintings({ page }, test, mobile = false) {
  test.setTimeout(180000);
  expect(process.env.KEEPER_TEST_USER).toBe("keeper-e2e");
  await page.goto("/");
  await page
    .getByLabel("Username", { exact: true })
    .fill(process.env.KEEPER_TEST_USER);
  await page
    .getByLabel("Password", { exact: true })
    .fill(process.env.KEEPER_TEST_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".auth-dialog")).toHaveCount(0);
  try {
    await checkRecentPrintings(page, mobile);
  } finally {
    await page.locator("#sign-out").click();
  }
}

export async function checkRecentPrintings(page, mobile = false) {
  expect(await liveApi(page, "/api/collection")).toEqual([]);
  const beforeDrafts = (
    await liveApi(page, "/api/import-draft")
  ).pending_drafts.map((d) => d.id);
  const cards = [];
  for (const set of ["m11", "m10"]) {
    const result = await liveApi(
      page,
      "/api/search?q=" +
        encodeURIComponent(`!"Lightning Bolt" set:${set} lang:en`),
    );
    expect(result.cards).toHaveLength(1);
    cards.push(result.cards[0]);
  }
  expect(cards[0].id).not.toBe(cards[1].id);
  const id = randomUUID();
  const activate = (locator) => (mobile ? locator.tap() : locator.click());
  const home = () => page.locator("#home-nav").click();
  const history = () =>
    page.evaluate(async () => {
      const module = document.querySelector('script[type="module"]').src;
      const { collectionIdentity } = await import(
        new URL("auth.js", module).href
      );
      const { snapshotKey } = await import(
        new URL("collection-cache.js", module).href
      );
      const saved = JSON.parse(
        localStorage.getItem(
          "keeper-home-v1:" + snapshotKey(await collectionIdentity()),
        ) || "{}",
      );
      return (saved.entries || [])
        .filter((e) => e.kind === "card")
        .map((e) => e.printing_id);
    });
  try {
    const staged = await liveApi(page, "/api/import-draft/stage", {
      method: "POST",
      body: JSON.stringify({
        id,
        kind: "scan",
        rows: cards.map((card) => ({
          id: randomUUID(),
          name: card.name,
          printing_id: card.id,
          quantity: 1,
          finish: "nonfoil",
          condition: "UNK",
        })),
      }),
    });
    await page.goto("/#import=" + id);
    await expect(page.locator(".draft-row")).toHaveCount(2);
    expect(await history()).toEqual([]);
    await activate(page.locator(".draft-artwork").first());
    await expect(page.locator(".artwork-viewer")).toBeVisible();
    await expect.poll(history).toEqual([cards[0].id]);
    await page.keyboard.press("Escape");
    await expect(page.locator(".artwork-viewer")).not.toBeVisible();
    expect(await liveApi(page, "/api/collection")).toEqual([]);
    await home();
    await expect(page.locator(".home-card button")).toHaveAccessibleName(
      /Not owned/,
    );
    await page.locator("#clear-home-history").click();
    expect(await history()).toEqual([]);
    await page.goto("/#import=" + id);
    await expect(page.locator("#draft-add")).toBeEnabled();
    const response = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/import-draft/add") &&
        r.request().method() === "POST",
    );
    await activate(page.locator("#draft-add"));
    const committed = await (await response).json();
    expect(committed.additions).toBe(2);
    expect([...committed.added_printings].sort()).toEqual(
      cards.map((c) => c.id).sort(),
    );
    await expect.poll(history).toEqual(cards.map((c) => c.id).reverse());
    const replay = await liveApi(page, "/api/import-draft/add", {
      method: "POST",
      body: JSON.stringify({
        id,
        version: staged.draft.version,
        kind: "capture",
      }),
    });
    expect(replay.replayed).toBe(true);
    expect(replay.added_printings).toEqual(committed.added_printings);
    const owned = await liveApi(page, "/api/collection");
    expect(owned).toHaveLength(2);
    expect(owned.every((row) => row.quantity === 1)).toBe(true);
    await home();
    await expect(page.locator(".home-card")).toHaveCount(2);
    await page.reload();
    await expect(page.locator(".home-card")).toHaveCount(2);
    for (const [index, card] of [...cards].reverse().entries()) {
      const tile = page.locator(".home-card button").nth(index);
      await expect(tile).toHaveAccessibleName(/· Owned$/);
      await expect(tile.locator("img")).toHaveAttribute(
        "src",
        card.image_uris.normal,
      );
    }
    await activate(page.locator(".home-card button").last());
    await expect(page.locator(".artwork-full-image")).toHaveAttribute(
      "src",
      cards[0].image_uris.normal,
    );
    await expect.poll(history).toEqual(cards.map((c) => c.id));
    await page.keyboard.press("Escape");
    await expect(page.locator(".artwork-viewer")).not.toBeVisible();
    expect(await liveApi(page, "/api/collection")).toEqual(owned);
  } finally {
    const { draft } = await liveApi(page, "/api/import-draft?id=" + id);
    if (draft)
      await liveApi(page, "/api/import-draft/clear", {
        method: "POST",
        body: JSON.stringify({ id, version: draft.version, kind: "capture" }),
      });
    for (const row of await liveApi(page, "/api/collection")) {
      expect(cards.some((card) => card.id === row.printing_id)).toBe(true);
      await liveApi(page, "/api/collection/" + row.id, { method: "DELETE" });
    }
    expect(await liveApi(page, "/api/collection")).toEqual([]);
    expect(
      (await liveApi(page, "/api/import-draft")).pending_drafts
        .map((d) => d.id)
        .sort(),
    ).toEqual(beforeDrafts.sort());
    await page.goto("/#home");
    if (await page.locator("#clear-home-history").isVisible())
      await page.locator("#clear-home-history").click();
  }
}
