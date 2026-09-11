import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { liveApi, clearCaptureTestData } from "../helpers/backend-live.js";

test("LIVE-21 continuous scan batches persist separately, page in order, isolate accounts and commit ownership once", async ({
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
  const before = new Set(
    (await liveApi(page, "/api/import-draft")).pending_drafts.map((d) => d.id),
  );
  const card = (
    await liveApi(
      page,
      "/api/search?q=" +
        encodeURIComponent('!"Lightning Bolt" set:m11 lang:en'),
    )
  ).cards[0];
  const id = randomUUID(),
    batches = [],
    timings = [];
  const stage = (input) =>
    liveApi(page, "/api/scan-session/batch", {
      method: "POST",
      body: JSON.stringify(input),
    });
  try {
    for (const [offset, count] of [50, 50, 5].entries()) {
      const input = {
        id,
        index: offset + 1,
        last_oracle: card.oracle_id,
        batch: {
          id: randomUUID(),
          kind: "scan",
          rows: Array.from({ length: count }, () => ({
            id: randomUUID(),
            name: card.name,
            printing_id: card.id,
            quantity: 1,
            finish: "nonfoil",
            condition: "NM",
          })),
        },
      };
      batches.push(input);
      const start = performance.now(),
        receipt = await stage(input);
      timings.push({ rows: count, milliseconds: performance.now() - start });
      expect(receipt.staged_id).toBe(input.batch.id);
      expect(receipt.accepted).toBe(offset < 2 ? (offset + 1) * 50 : 105);
      expect(receipt.draft).toBeUndefined();
      expect(JSON.stringify(receipt).length).toBeLessThan(1000);
    }
    expect(await liveApi(page, "/api/collection")).toEqual([]);
    const latest = await liveApi(page, "/api/import-draft?id=" + id);
    expect(latest.pending_drafts.filter((d) => !before.has(d.id))).toHaveLength(
      1,
    );
    expect(latest.draft.rows).toHaveLength(5);
    expect(latest.scan_session.pending_copies).toBe(105);
    expect((await stage(batches[0])).accepted).toBe(105);
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
        (await liveApi(other, "/api/import-draft?id=" + batches[0].batch.id))
          .draft,
      ).toBeNull();
    } finally {
      await otherContext.close();
    }
    await page.goto("/#import=" + id);
    await expect(page.locator(".draft-row")).toHaveCount(5);
    await page
      .getByRole("button", { name: "Previous batch", exact: true })
      .click();
    await expect(page.locator(".draft-row")).toHaveCount(50);
    await page.reload();
    await expect(page.locator(".draft-row")).toHaveCount(50);
    const selected = await liveApi(
      page,
      "/api/import-draft?id=" + batches[1].batch.id,
    );
    const operation = {
      id: selected.draft.id,
      version: selected.draft.version,
      kind: "capture",
    };
    await page.locator("#draft-add").click();
    await expect(page.locator(".draft-row")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Previous batch", exact: true }),
    ).toBeEnabled();
    expect((await liveApi(page, "/api/collection"))[0].quantity).toBe(50);
    expect(
      (
        await liveApi(page, "/api/import-draft/add", {
          method: "POST",
          body: JSON.stringify(operation),
        })
      ).replayed,
    ).toBe(true);
    expect((await stage(batches[1])).accepted).toBe(105);
    expect(
      (await liveApi(page, "/api/import-draft?id=" + batches[1].batch.id))
        .draft,
    ).toBeNull();
    await page.getByRole("button", { name: "Next batch", exact: true }).click();
    await expect(page.locator(".draft-row")).toHaveCount(5);
    await page.locator("#draft-clear").click();
    await expect(page.locator(".draft-row")).toHaveCount(0);
    expect(
      (await liveApi(page, "/api/import-draft?id=" + id)).scan_session
        .pending_copies,
    ).toBe(50);
    expect((await liveApi(page, "/api/collection"))[0].quantity).toBe(50);
    await testInfo.attach("actual-cloud-scan-batch-timings", {
      body: JSON.stringify(timings),
      contentType: "application/json",
    });
  } finally {
    await clearCaptureTestData(page, before);
    expect(
      new Set(
        (await liveApi(page, "/api/import-draft")).pending_drafts.map(
          (d) => d.id,
        ),
      ),
    ).toEqual(before);
    await page.locator("#sign-out").click();
  }
});
