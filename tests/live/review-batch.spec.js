import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { liveApi } from "../helpers/backend-live.js";

test("LIVE-15 account-saved fifty-line Import, atomic Add, permanent retries, timestamps and isolation", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(180000);
  expect(process.env.KEEPER_TEST_USER).toBe("keeper-e2e");
  const signIn = async (target, user, password) => {
    await target.goto("/#collection");
    await target.getByLabel("Username", { exact: true }).fill(user);
    await target.getByLabel("Password", { exact: true }).fill(password);
    await target.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(target.locator(".auth-dialog")).toHaveCount(0);
  };
  await signIn(
    page,
    process.env.KEEPER_TEST_USER,
    process.env.KEEPER_TEST_PASSWORD,
  );
  expect(await liveApi(page, "/api/collection")).toEqual([]);
  const beforeDrafts = (
    await liveApi(page, "/api/import-draft")
  ).pending_drafts.map((draft) => draft.id);
  const card = (
    await liveApi(
      page,
      "/api/search?q=" +
        encodeURIComponent('!"Lightning Bolt" set:m11 lang:en'),
    )
  ).cards[0];
  const payload = (quantity = 1) => ({
    id: randomUUID(),
    kind: "scan",
    rows: Array.from({ length: 50 }, () => ({
      id: randomUUID(),
      name: card.name,
      printing_id: card.id,
      quantity,
      finish: "nonfoil",
      condition: "NM",
    })),
  });
  const stage = (input) =>
    liveApi(page, "/api/import-draft/stage", {
      method: "POST",
      body: JSON.stringify(input),
    });
  const add = (draft) =>
    liveApi(page, "/api/import-draft/add", {
      method: "POST",
      body: JSON.stringify({
        id: draft.id,
        version: draft.version,
        kind: "capture",
      }),
    });
  const created = new Set(),
    timings = {};
  try {
    const input = payload();
    created.add(input.id);
    let started = performance.now();
    const saved = await stage(input);
    timings.stage50Ms = performance.now() - started;
    expect(saved.draft.rows).toHaveLength(50);
    expect(
      saved.draft.rows.every((row) => row.created_at && row.updated_at),
    ).toBe(true);
    expect(await liveApi(page, "/api/collection")).toEqual([]);
    expect((await stage(input)).draft.version).toBe(saved.draft.version);
    const unchanged = await liveApi(page, "/api/import-draft", {
      method: "PATCH",
      body: JSON.stringify({
        id: saved.draft.id,
        kind: "capture",
        version: saved.draft.version,
        rows: saved.draft.rows,
      }),
    });
    expect(unchanged.draft).toEqual(saved.draft);
    await expect(
      stage({ ...input, owner: "unverified-body-owner" }),
    ).rejects.toThrow();
    await expect(
      stage({
        ...input,
        rows: input.rows.map((row) => ({ ...row, quantity: 2 })),
      }),
    ).rejects.toThrow(/different lines/);
    const otherContext = await browser.newContext({
      baseURL: process.env.LIVE_URL,
    });
    try {
      const other = await otherContext.newPage();
      await signIn(
        other,
        process.env.KEEPER_OTHER_USER,
        process.env.KEEPER_OTHER_PASSWORD,
      );
      expect(
        (await liveApi(other, "/api/import-draft?id=" + input.id)).draft,
      ).toBeNull();
    } finally {
      await otherContext.close();
    }
    started = performance.now();
    expect((await add(saved.draft)).additions).toBe(50);
    timings.add50Ms = performance.now() - started;
    const [owned] = await liveApi(page, "/api/collection");
    expect(owned.quantity).toBe(50);
    expect(owned.created_at).toBeTruthy();
    expect(owned.updated_at).toBeTruthy();
    started = performance.now();
    expect((await add(saved.draft)).replayed).toBe(true);
    timings.retry50Ms = performance.now() - started;
    expect((await stage(input)).draft).toBeNull();
    expect((await liveApi(page, "/api/collection"))[0]).toEqual(owned);
    const invalid = payload(5000);
    created.add(invalid.id);
    const overfull = await stage(invalid);
    expect(overfull.summary.can_add).toBe(false);
    await expect(add(overfull.draft)).rejects.toThrow(/100,000/);
    expect((await liveApi(page, "/api/collection"))[0].quantity).toBe(50);
    await page.goto("/#import=" + invalid.id);
    await expect(page.locator(".draft-row")).toHaveCount(50);
    await expect(page.locator("#draft-add")).toBeDisabled();
    await page.reload();
    await expect(page.locator(".draft-row")).toHaveCount(50);
    await page.locator("#draft-clear").click();
    await expect(page.locator(".draft-row")).toHaveCount(0);
    await testInfo.attach("actual-cloud-import-timings", {
      body: JSON.stringify(timings),
      contentType: "application/json",
    });
    console.info("LIVE-15 actual cloud import timings", timings);
  } finally {
    for (const descriptor of (await liveApi(page, "/api/import-draft"))
      .pending_drafts)
      if (created.has(descriptor.id)) {
        const { draft } = await liveApi(
          page,
          "/api/import-draft?id=" + descriptor.id,
        );
        await liveApi(page, "/api/import-draft/clear", {
          method: "POST",
          body: JSON.stringify({
            id: draft.id,
            version: draft.version,
            kind: "capture",
          }),
        });
      }
    for (const row of await liveApi(page, "/api/collection"))
      await liveApi(page, "/api/collection/" + row.id, { method: "DELETE" });
    expect(await liveApi(page, "/api/collection")).toEqual([]);
    expect(
      (await liveApi(page, "/api/import-draft")).pending_drafts
        .map((draft) => draft.id)
        .sort(),
    ).toEqual(beforeDrafts.sort());
    await page.locator("#sign-out").click();
  }
});
