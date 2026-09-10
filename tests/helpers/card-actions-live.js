import { expectInspectorFit } from "./artwork-fit.js";
import { openArtworkDetails } from "./artwork-actions.js";
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
  async function directDrop(tagId, selected = true) {
    if (!["edit", "details"].includes(tagId))
      await expect(
        page.locator(`#tag-filter option[value="${tagId}"]`),
      ).toHaveCount(1);
    const button = page.locator("#grid .card-open");
    await expect(page.locator("#card")).toBeHidden();
    let b;
    await expect(async () => {
      await button.scrollIntoViewIfNeeded();
      await expect(button).toBeInViewport({ ratio: 0.9 });
      b = await button.boundingBox();
      expect(b).not.toBeNull();
    }).toPass({ timeout: 5000 });
    const x = b.x + b.width / 2,
      y = b.y + b.height / 2;
    const pointer = (x, y) => ({
      pointerId: 71,
      pointerType: "touch",
      clientX: x,
      clientY: y,
      bubbles: true,
      buttons: 1,
      button: 0,
    });
    if (mobile) {
      // Controlled WebKit hold/move sequence; native tap is verified separately.
      await button.dispatchEvent("pointerdown", pointer(x, y));
    } else {
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 15, y);
    }
    await expect(page.locator(".card-drag-copy")).toBeVisible();
    const direct = page.locator(`.card-action-target[data-tag-id="${tagId}"]`);
    const overflow = (await direct.count()) === 0;
    const destination = overflow
      ? page.locator('.card-action-target[data-tag-id="more"]')
      : direct;
    const xy = await destination.evaluate((el) => [
      parseFloat(el.style.left),
      parseFloat(el.style.top),
    ]);
    const bounds = await page
      .locator(".card-action-target")
      .evaluateAll((nodes) =>
        nodes.map((el) => {
          const r = el.getBoundingClientRect();
          return {
            x: r.x,
            y: r.y,
            right: r.right,
            bottom: r.bottom,
            width: innerWidth,
            height: innerHeight,
            clipped:
              (
                el.querySelector(".card-action-label") || el
              ).getBoundingClientRect().bottom >
              r.bottom + 1,
          };
        }),
      );
    expect(
      bounds.every(
        (r) =>
          r.x >= 0 &&
          r.y >= 0 &&
          r.right <= r.width &&
          r.bottom <= r.height &&
          !r.clipped,
      ),
    ).toBe(true);
    await page.screenshot({
      path: test
        .info()
        .outputPath(
          `live-wheel-${mobile ? "webkit-touch" : "chromium"}-${tagId.slice(0, 8)}.png`,
        ),
    });
    if (mobile) {
      await button.dispatchEvent("pointermove", pointer(...xy));
      await button.dispatchEvent("pointerup", pointer(...xy));
    } else {
      await page.mouse.move(...xy, { steps: 5 });
      await page.mouse.up();
    }
    if (overflow) {
      await expect(page.locator(".card-action-more")).toBeVisible();
      const label =
        tagId === "edit"
          ? "Review & add"
          : tagId === "details"
            ? "Card details"
            : (selected ? "Add " : "Remove ") +
              created.find((tag) => tag.id === tagId)?.label;
      expect(label).toBeTruthy();
      if (!["edit", "details"].includes(tagId))
        await page.locator(".card-action-more input").fill(label);
      await activate(
        page.locator(".card-action-more").getByRole("button", {
          name: label,
          exact: true,
        }),
      );
    }
  }
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
    await expect(
      page.locator(`#tag-filter option[value="${target.id}"]`),
    ).toHaveCount(1);
    const tile = page.locator("#grid .card"),
      cardButton = tile.locator(".card-open");
    await expect(
      tile.locator(".card-info,.card-bottom,.card-actions-trigger"),
    ).toHaveCount(0);
    await expect(tile.locator(".card-hover-info")).not.toBeVisible();
    await activate(cardButton);
    await expect(page).toHaveURL(new RegExp("#tag=" + source.id + "$"));
    await expectInspectorFit(page);
    const viewer = page.locator(".artwork-viewer");
    const assignedTag = viewer.getByRole("button", {
      name: mobile ? "Remove " + source.label : source.label,
      exact: true,
    });
    if (mobile && (await assignedTag.count()) === 0) {
      await viewer
        .getByRole("button", { name: "More tags…", exact: true })
        .tap();
      await expect(
        viewer.getByRole("button", { name: source.label, exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
    } else await expect(assignedTag).toHaveAttribute("aria-pressed", "true");
    await page.screenshot({
      path: test
        .info()
        .outputPath(`live-owned-inspector-${mobile ? "phone" : "desktop"}.png`),
    });
    await openArtworkDetails(page, { mobile });
    await expect(page.locator("#quantity")).toHaveValue("3");
    await page.locator("#quantity").fill("4");
    await activate(
      page.getByRole("button", { name: "Save quantity", exact: true }),
    );
    await expect(page.locator("#detail")).not.toBeVisible();
    expect((await liveApi(page, "/api/collection"))[0].quantity).toBe(4);
    await page.reload();
    await activate(page.locator("#grid .card-open"));
    await openArtworkDetails(page, { mobile });
    await expect(page.locator("#quantity")).toHaveValue("4");
    await page.locator("#quantity").fill("3");
    await activate(
      page.getByRole("button", { name: "Save quantity", exact: true }),
    );
    await expect(page.locator("#detail")).not.toBeVisible();
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
    await directDrop(target.id);
    await expect(page.locator(".card-action-status")).toContainText(
      "delivery interruption",
    );
    await page.reload();
    await activate(page.getByRole("button", { name: "Retry card action" }));
    await expect(page.locator(".card-action-status")).not.toBeVisible();
    expect(operations).toHaveLength(2);
    expect(operations[0]).toEqual(operations[1]);
    expect(operations[0]).toMatchObject({ selected: true, quantity: 1 });
    await page.unroute("**/api/tag-actions");
    let [saved] = await liveApi(page, "/api/collection");
    expect(saved.quantity).toBe(3);
    expect(saved.locations.find((a) => a.tag_id === source.id).quantity).toBe(
      2,
    );
    expect(saved.locations.find((a) => a.tag_id === target.id).quantity).toBe(
      1,
    );
    const later = {
      ...operations[0],
      selected: false,
      operation_id: randomUUID(),
    };
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
    await expectInspectorFit(page);
    await openArtworkDetails(page, { mobile });
    await expect(page.locator("#inventory-form")).toBeVisible();
    await activate(page.locator("#close"));
    await expect(page.locator("#search")).toHaveValue(query);
    await directDrop(target.id);
    await expect
      .poll(
        async () =>
          (await liveApi(page, "/api/import-draft")).pending_drafts.filter(
            (d) => !beforeDrafts.has(d.id),
          ).length,
      )
      .toBe(1);
    const descriptor = (
      await liveApi(page, "/api/import-draft")
    ).pending_drafts.find((d) => !beforeDrafts.has(d.id));
    expect(descriptor).toBeTruthy();
    await page.goto("/#import=" + descriptor.id);
    await page.reload();
    await expect(page.locator(".draft-row")).toHaveCount(1);
    const { draft } = await liveApi(
      page,
      "/api/import-draft?id=" + descriptor.id,
    );
    expect(draft.rows[0].original.capture_kind).toBe("catalog");
    expect(draft.rows[0].locations).toEqual([
      { tag_id: target.id, quantity: 1 },
    ]);
    expect(await liveApi(page, "/api/collection")).toEqual([]);
    // Verify the new targeted draft route against actual JWT/Dynamo state,
    // including replay after a later opposite operation. Pending is never owned.
    const pendingRemove = {
      operation_id: randomUUID(),
      id: draft.id,
      kind: "capture",
      row_id: draft.rows[0].id,
      tag_id: target.id,
      selected: false,
      quantity: 1,
    };
    const removed = await post("/api/import-draft/tag", pendingRemove);
    expect(removed.draft.rows[0].locations).toEqual([]);
    const restored = await post("/api/import-draft/tag", {
      ...pendingRemove,
      operation_id: randomUUID(),
      selected: true,
    });
    const replayed = await post("/api/import-draft/tag", pendingRemove);
    expect(replayed.draft.rows[0]).toEqual(restored.draft.rows[0]);
    expect(replayed.draft.rows[0].quantity).toBe(1);
    expect(await liveApi(page, "/api/collection")).toEqual([]);
    await activate(page.locator("#draft-clear"));
    await expect(page.locator(".draft-row")).toHaveCount(0);
    // A second untagged selection verifies explicit Add without retaining a
    // temporary tag in permanent source provenance.
    await page.goto("/#catalog");
    await page.locator("#search").fill(query);
    await activate(page.locator("#search-submit"));
    await expect(page.locator("#grid .card")).toHaveCount(1);
    await directDrop("edit");
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
