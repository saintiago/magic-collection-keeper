import { test, expect } from "@playwright/test";
const rows = [
  {
    id: "saved",
    printing_id: "p",
    quantity: 4094,
    language: "en",
    finish: "nonfoil",
    condition: "UNK",
    card: {
      id: "p",
      name: "Saved collection",
      set: "tst",
      set_name: "Test",
      collector_number: "1",
      lang: "en",
      color_identity: [],
    },
  },
];
test("UC-17 first load never claims zero and cards render before slow tags", async ({
  page,
}) => {
  let releaseCollection, releaseTags;
  await page.route("**/api/collection", async (route) => {
    await new Promise((resolve) => {
      releaseCollection = resolve;
    });
    await route.fulfill({ json: rows });
  });
  await page.route("**/api/tags", async (route) => {
    await new Promise((resolve) => {
      releaseTags = resolve;
    });
    await route.fulfill({ json: [] });
  });
  await page.goto("/");
  await expect.poll(() => Boolean(releaseCollection)).toBe(true);
  await expect(page.locator("#total")).toHaveText("—");
  await expect(page.getByText("Your collection begins here")).not.toBeVisible();
  releaseCollection();
  await expect.poll(() => Boolean(releaseTags)).toBe(true);
  await expect(page.locator("#total")).toHaveText("4,094");
  await expect(page.locator(".card")).toHaveCount(1);
  releaseTags();
});
test("UC-17 first-load failure is unavailable, retry may confirm a truly empty collection", async ({
  page,
}) => {
  let fail = true;
  await page.route("**/api/collection", (route) =>
    route.fulfill(
      fail
        ? { status: 502, contentType: "text/plain", body: "Bad gateway" }
        : { json: [] },
    ),
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Collection unavailable" }),
  ).toBeVisible();
  await expect(page.locator("#total")).toHaveText("—");
  await expect(page.getByText("Your collection begins here")).not.toBeVisible();
  fail = false;
  await page.getByRole("button", { name: "Retry collection" }).click();
  await expect(page.locator("#total")).toHaveText("0");
  await expect(page.getByText("Your collection begins here")).toBeVisible();
});

async function cacheReady(page) {
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { snapshotStore, snapshotKey } =
          await import("/collection-cache.js");
        const { collectionIdentity } = await import("/auth.js");
        return Boolean(
          await snapshotStore.read(snapshotKey(await collectionIdentity())),
        );
      }),
    )
    .toBe(true);
}
test("UC-17 large warm snapshot remains visible through refresh failure and reconciles true empty", async ({
  page,
}) => {
  const many = Array.from({ length: 2870 }, (_, i) => ({
    ...rows[0],
    id: "row-" + i,
    printing_id: "printing-" + i,
    quantity: i === 0 ? 1225 : 1,
  }));
  let outcome = "saved",
    release;
  await page.route("**/api/collection", async (route) => {
    if (outcome === "wait") {
      await new Promise((resolve) => (release = resolve));
      return route.fulfill({
        status: 502,
        json: { error: "Temporary service failure" },
      });
    }
    return route.fulfill({ json: outcome === "empty" ? [] : many });
  });
  await page.goto("/");
  await expect(page.locator("#total")).toHaveText("4,094");
  await cacheReady(page);
  outcome = "wait";
  await page.reload();
  await expect(page.locator("#total")).toHaveText("4,094");
  await expect(page.locator("#collection-status-text")).toContainText(
    "Showing saved snapshot from",
  );
  await expect(page.locator("#collection-status-text")).toContainText(
    "Updating",
  );
  await expect(page.locator(".card")).toHaveCount(2870);
  await expect.poll(() => Boolean(release)).toBe(true);
  release();
  await expect(page.locator("#collection-status-text")).toContainText(
    "Update failed",
  );
  await expect(page.locator("#total")).toHaveText("4,094");
  outcome = "empty";
  await page.getByRole("button", { name: "Retry collection" }).click();
  await expect(page.locator("#total")).toHaveText("0");
  await expect(page.getByText("Your collection begins here")).toBeVisible();
});
test("UC-17 verified accounts isolate snapshots and sign-out clears them", async ({
  page,
}) => {
  let owner = "one",
    delay = false,
    release;
  await page.route("**/config.json", (route) =>
    route.fulfill({
      json: { region: "us-east-1", clientId: "test", apiUrl: "" },
    }),
  );
  await page.route("**/api/session", (route) =>
    route.fulfill({ json: { owner } }),
  );
  await page.route("**/api/collection", async (route) => {
    if (delay) await new Promise((resolve) => (release = resolve));
    return route.fulfill({ json: owner === "one" ? rows : [] });
  });
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("initialized")) {
      sessionStorage.setItem("initialized", "yes");
      sessionStorage.setItem(
        "keeper-session",
        JSON.stringify({
          IdToken: "fixture-one",
          expires: Date.now() + 3600000,
        }),
      );
    }
  });
  await page.goto("/");
  await expect(page.locator("#total")).toHaveText("4,094");
  await cacheReady(page);
  owner = "two";
  delay = true;
  await page.evaluate(() =>
    sessionStorage.setItem(
      "keeper-session",
      JSON.stringify({ IdToken: "fixture-two", expires: Date.now() + 3600000 }),
    ),
  );
  await page.reload();
  await expect.poll(() => Boolean(release)).toBe(true);
  await expect(page.locator("#total")).toHaveText("—");
  await expect(page.locator(".card")).toHaveCount(0);
  release();
  await expect(page.locator("#total")).toHaveText("0");
  await page.locator("#sign-out").click();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
  const count = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const r = indexedDB.open("keeper-display-v1", 1);
        r.onsuccess = () => {
          const db = r.result;
          const q = db
            .transaction("snapshots")
            .objectStore("snapshots")
            .count();
          q.onsuccess = () => {
            resolve(q.result);
            db.close();
          };
        };
      }),
  );
  expect(count).toBe(0);
});
test("UC-16 local version details are usable on mobile and close with Escape", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Local development" }).click();
  await expect(
    page.getByRole("heading", { name: "About this app" }),
  ).toBeVisible();
  await expect(page.getByText("Commit: Local working copy")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.locator(".release-dialog")).toHaveCount(0);
});
