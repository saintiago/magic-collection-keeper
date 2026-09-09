import { expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { liveApi, clearCaptureTestData } from "./backend-live.js";

async function signIn(page, user, password, url = "/#collection") {
  await page.goto(url);
  await page.getByLabel("Username", { exact: true }).fill(user);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".auth-dialog")).toHaveCount(0);
}

// Real JWT/Dynamo writes in the reserved empty profile. Only delivery of one
// committed response is disrupted; no service/database response is simulated.
export async function exerciseCardActions(
  { page, browser },
  test,
  mobile = false,
) {
  test.setTimeout(180000);
  expect(process.env.KEEPER_TEST_USER).toBe("keeper-e2e");
  await signIn(
    page,
    process.env.KEEPER_TEST_USER,
    process.env.KEEPER_TEST_PASSWORD,
  );
  expect(await liveApi(page, "/api/collection")).toEqual([]);
  const beforeDrafts = new Set(
    (await liveApi(page, "/api/import-draft")).pending_drafts.map((d) => d.id),
  );
  const beforeTags = new Set(
    (await liveApi(page, "/api/tags")).map((t) => t.id),
  );
  const created = [],
    operations = [];
  const post = (path, body, method = "POST") =>
    liveApi(page, path, { method, body: JSON.stringify(body) });
  const activate = (locator) => (mobile ? locator.tap() : locator.click());
  let otherContext;
  try {
    for (const name of ["Source", "Target"]) {
      const label = `Action ${name} ${randomUUID().slice(0, 8)}`;
      const tags = await post("/api/tags", {
        label,
        type: "location",
        kind: "box",
      });
      created.push(tags.find((t) => t.label === label));
    }
    const [source, target] = created;
    const query = '!"Lightning Bolt" set:m11 lang:en';
    const printing = (
      await liveApi(page, "/api/search?q=" + encodeURIComponent(query))
    ).cards[0];
    expect(printing.id).toBeTruthy();
    const [row] = await post("/api/collection", {
      printing_id: printing.id,
      quantity: 3,
      finish: "nonfoil",
      condition: "NM",
      operation_id: randomUUID(),
    });
    await post(
      "/api/tag-assignments",
      {
        inventory_id: row.id,
        locations: [{ tag_id: source.id, quantity: 2 }],
        tag_ids: [],
      },
      "PUT",
    );
    await page.goto("/#tag=" + source.id);
    await page.reload();
    await expect(page.locator("#grid .card")).toHaveCount(1);
    let loseResponse = true;
    await page.route("**/api/tag-actions", async (route) => {
      operations.push(route.request().postDataJSON());
      const response = await route.fetch();
      expect(response.ok()).toBeTruthy();
      if (loseResponse) {
        loseResponse = false;
        await route.fulfill({
          status: 503,
          json: {
            error: "Test delivery interruption after actual cloud commit",
          },
        });
      } else await route.fulfill({ response });
    });
    if (mobile) {
      await activate(page.locator(".card-actions-trigger"));
      await activate(
        page.locator(`.card-action-target[data-tag-id="${target.id}"]`),
      );
    } else {
      const img = page.locator("#grid img");
      await img.scrollIntoViewIfNeeded();
      const b = await img.boundingBox();
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await page.mouse.down();
      await page.mouse.move(b.x + b.width / 2 + 15, b.y + b.height / 2);
      await expect(page.locator(".card-drag-copy")).toBeVisible();
      const xy = await page
        .locator(`.card-action-target[data-tag-id="${target.id}"]`)
        .evaluate((el) => [
          parseFloat(el.style.left),
          parseFloat(el.style.top),
        ]);
      await page.mouse.move(...xy, { steps: 5 });
      await page.mouse.up();
    }
    await expect(page.locator(".card-action-status")).toContainText(
      "delivery interruption",
    );
    await page.reload();
    await activate(page.getByRole("button", { name: "Retry card action" }));
    await expect(page.locator(".card-action-status")).toContainText(
      "Card tags saved",
    );
    expect(operations).toHaveLength(2);
    expect(operations[0]).toEqual(operations[1]);
    await page.unroute("**/api/tag-actions");
    let [saved] = await liveApi(page, "/api/collection");
    expect(saved.quantity).toBe(3);
    expect(saved.locations.find((a) => a.tag_id === source.id).quantity).toBe(
      1,
    );
    expect(saved.locations.find((a) => a.tag_id === target.id).quantity).toBe(
      1,
    );
    const later = { ...operations[0], operation_id: randomUUID() };
    await post("/api/tag-actions", later);
    const beforeReplay = await liveApi(page, "/api/collection");
    expect(await post("/api/tag-actions", operations[0])).toEqual(beforeReplay);
    expect(beforeReplay[0].locations).toHaveLength(1);
    expect(beforeReplay[0].locations[0].quantity).toBe(2);
    if (!mobile) {
      expect(process.env.KEEPER_OTHER_USER).toBe("keeper-isolation");
      otherContext = await browser.newContext();
      const other = await otherContext.newPage();
      await signIn(
        other,
        process.env.KEEPER_OTHER_USER,
        process.env.KEEPER_OTHER_PASSWORD,
        process.env.LIVE_URL,
      );
      const rejected = await other.evaluate(
        async (payload) => {
          const module = document.querySelector('script[type="module"]').src;
          const { api } = await import(new URL("api.js", module).href);
          try {
            await api("/api/tag-actions", {
              method: "POST",
              body: JSON.stringify(payload),
            });
            return 200;
          } catch (e) {
            return e.status;
          }
        },
        { ...later, operation_id: randomUUID() },
      );
      expect(rejected).toBe(404);
      await otherContext.close();
      otherContext = null;
      expect(await liveApi(page, "/api/collection")).toEqual(beforeReplay);
    }
    await post(
      "/api/tag-assignments",
      { inventory_id: row.id, locations: [], tag_ids: [] },
      "PUT",
    );
    await liveApi(page, "/api/collection/" + row.id, { method: "DELETE" });
    await page.goto("/#catalog");
    await page.reload();
    await page.locator("#search").fill(query);
    await activate(page.locator("#search-submit"));
    await expect(page.locator("#grid .card")).toHaveCount(1);
    await activate(page.locator(".card-open"));
    await expect(page.locator(".artwork-viewer output")).toHaveText("300%");
    await activate(
      page.getByRole("button", { name: "Card details", exact: true }),
    );
    await expect(page.locator("#inventory-form")).toBeVisible();
    await activate(page.locator("#close"));
    await expect(page.locator("#search")).toHaveValue(query);
    await activate(page.locator(".card-actions-trigger"));
    await activate(
      page.locator(`.card-action-target[data-tag-id="${target.id}"]`),
    );
    await expect(page.locator(".draft-row")).toHaveCount(1);
    await page.reload();
    await expect(page.locator(".draft-row")).toHaveCount(1);
    const descriptor = (
      await liveApi(page, "/api/import-draft")
    ).pending_drafts.find((d) => !beforeDrafts.has(d.id));
    expect(descriptor).toBeTruthy();
    const { draft } = await liveApi(
      page,
      "/api/import-draft?id=" + descriptor.id,
    );
    expect(draft.rows[0].original.capture_kind).toBe("catalog");
    expect(draft.rows[0].locations).toEqual([
      { tag_id: target.id, quantity: 1 },
    ]);
    expect(await liveApi(page, "/api/collection")).toEqual([]);
    await activate(page.locator("#draft-clear"));
    // A second untagged selection verifies explicit Add without retaining a
    // temporary tag in permanent source provenance.
    await page.goto("/#catalog");
    await page.locator("#search").fill(query);
    await activate(page.locator("#search-submit"));
    await expect(page.locator("#grid .card")).toHaveCount(1);
    await activate(page.locator(".card-actions-trigger"));
    await activate(
      page.getByRole("menuitem", { name: "Review & add", exact: true }),
    );
    await expect(page.locator(".draft-row")).toHaveCount(1);
    expect(await liveApi(page, "/api/collection")).toEqual([]);
    await activate(page.locator("#draft-add"));
    await expect(
      page.getByText("Added 1 new copies", { exact: false }),
    ).toBeVisible();
    expect((await liveApi(page, "/api/collection"))[0].quantity).toBe(1);
    console.log(
      JSON.stringify({
        realCloudCardActions: true,
        mobileEngineEmulation: mobile,
        physicalDeviceVerified: false,
        ambiguousRetrySameId: true,
        catalogueExplicitAdd: true,
      }),
    );
  } finally {
    await otherContext?.close();
    await page.unroute("**/api/tag-actions");
    for (const row of await liveApi(page, "/api/collection"))
      await post(
        "/api/tag-assignments",
        { inventory_id: row.id, locations: [], tag_ids: [] },
        "PUT",
      );
    await clearCaptureTestData(page, beforeDrafts);
    for (const tag of created)
      await liveApi(page, "/api/tags/" + tag.id, { method: "DELETE" });
    expect(
      new Set((await liveApi(page, "/api/tags")).map((t) => t.id)),
    ).toEqual(beforeTags);
    await page.locator("#sign-out").click();
  }
}
