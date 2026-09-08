import { test, expect } from "@playwright/test";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
  buildCompactNames,
  encodeCompactNames,
} from "../../domain/compact-names.js";
const oracle = "11111111-1111-1111-1111-111111111111",
  printing = "22222222-2222-2222-2222-222222222222";
const rows = [
  [
    oracle,
    "Lightning Bolt",
    printing,
    [
      ["Relámpago", "es"],
      ["稲妻", "ja"],
    ],
  ],
  [
    "33333333-3333-3333-3333-333333333333",
    "Fire // Ice",
    "44444444-4444-4444-4444-444444444444",
    [
      ["Fire", "en"],
      ["Fuego", "es"],
      ["火", "ja"],
      ["Ice", "en"],
    ],
  ],
];
const card = {
  id: printing,
  oracle_id: oracle,
  name: "Lightning Bolt",
  lang: "en",
  games: ["paper"],
  set: "tst",
  set_name: "Test",
  collector_number: "1",
  finishes: ["nonfoil"],
  color_identity: ["R"],
  oracle_text: "Three damage.",
};
function snapshot(data = rows) {
  const bytes = gzipSync(encodeCompactNames(buildCompactNames(data)));
  return {
    bytes,
    manifest: {
      schema: 1,
      version: "a".repeat(64),
      updated_at: new Date().toISOString(),
      identities: data.length,
      browser: {
        schema: 1,
        bytes: bytes.length,
        version: createHash("sha256").update(bytes).digest("hex"),
      },
    },
  };
}
async function setup(page, options = {}) {
  let remote = snapshot(),
    downloads = 0,
    suggestions = 0,
    details = 0,
    manifestReads = 0;
  await page.addInitScript(() => {
    window.searchMetrics = [];
    window.addEventListener("keeper-search-metric", (e) =>
      window.searchMetrics.push(e.detail),
    );
  });
  await page.route("**/catalog/current.json", (r) => {
    manifestReads++;
    return options.offline ? r.abort() : r.fulfill({ json: remote.manifest });
  });
  await page.route("**/catalog/*.names.gz", (r) => {
    downloads++;
    return r.fulfill({
      body: options.corrupt ? Buffer.from("bad") : remote.bytes,
      contentType: "application/gzip",
    });
  });
  await page.route("**/api/collection", (r) => r.fulfill({ json: [] }));
  await page.route("**/api/tags", (r) => r.fulfill({ json: [] }));
  await page.route("**/api/suggest?*", (r) => {
    suggestions++;
    return r.fulfill({
      json: {
        suggestions: [
          {
            name: card.name,
            oracle_id: oracle,
            printing_id: printing,
            matched_name: "Relámpago",
            matched_language: "es",
          },
        ],
        catalog: { version: "server" },
      },
    });
  });
  await page.route("**/api/discover?*", (r) => {
    details++;
    return options.detailsFail
      ? r.fulfill({ status: 503, json: { error: "Printing unavailable" } })
      : r.fulfill({ json: { cards: [card], total: 1, hasMore: false } });
  });
  return {
    get counts() {
      return { downloads, suggestions, details, manifestReads };
    },
    update() {
      remote = snapshot(
        rows.map((r) =>
          r[0] === oracle ? [r[0], "Updated Lightning Bolt", r[2], r[3]] : r,
        ),
      );
    },
  };
}
const ready = (page) =>
  expect
    .poll(() =>
      page.evaluate(() =>
        window.searchMetrics.some((m) => m.type === "state" && m.ready),
      ),
    )
    .toBe(true);
const options = (page) => page.locator("#suggestion-panel").getByRole("option");
test.use({ hasTouch: true });
test("UC-33 late worker replies, IME composition and cancelled touch never select stale input", async ({
  page,
}) => {
  const fixture = await setup(page);
  await page.route("**/vendor/name-worker.js", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body:
        "const send=self.postMessage.bind(self);self.postMessage=m=>m.type==='result'&&m.id===1?setTimeout(()=>send(m),500):send(m);\n" +
        (await response.text()),
    });
  });
  await page.goto("/");
  await ready(page);
  await page.locator("#search").fill("relampa");
  await page.waitForTimeout(25);
  await page.locator("#search").fill("Fuego");
  await expect(options(page).first()).toContainText("Fire // Ice");
  await page.waitForTimeout(550);
  await expect(options(page).first()).toContainText("Fire // Ice");
  await page.locator("#search").dispatchEvent("compositionstart");
  await page.locator("#search").fill("稲妻");
  await expect(page.locator("#suggestion-panel")).toBeHidden();
  await page.locator("#search").dispatchEvent("compositionend");
  await expect(options(page).first()).toContainText("Lightning Bolt");
  await options(page)
    .first()
    .evaluate((option) => {
      const point = {
        identifier: 1,
        target: option,
        clientX: 100,
        clientY: 100,
      };
      for (const type of ["touchstart", "touchcancel", "touchend"]) {
        const e = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperties(e, {
          touches: { value: type === "touchstart" ? [point] : [] },
          changedTouches: { value: [point] },
        });
        option.dispatchEvent(e);
      }
    });
  expect(fixture.counts.details).toBe(0);
  await expect(page.locator("#detail")).not.toBeVisible();
  await options(page).first().tap();
  await expect(page.locator("#detail")).toBeVisible();
  expect(fixture.counts.details).toBe(1);
  expect(fixture.counts.suggestions).toBe(0);
});
test("UC-33 worker multilingual suggestions, native tap, cached detail and verified reload avoid name network requests", async ({
  page,
}) => {
  const fixture = await setup(page);
  await page.goto("/");
  await ready(page);
  await page.locator("#search").fill("relampa");
  await expect(options(page).first()).toContainText("Relámpago");
  await options(page).first().tap();
  await expect(page.locator("#detail")).toBeVisible();
  await page.locator("#close").click();
  await page.locator("#search").fill("Lightning Bolt");
  await expect(options(page).first()).toContainText("Lightning Bolt");
  await options(page).first().tap();
  await expect(page.locator("#detail")).toBeVisible();
  expect(fixture.counts.details).toBe(1);
  await page.locator("#close").click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.searchMetrics.some((m) => m.phase === "refresh"),
      ),
    )
    .toBe(true);
  await page.reload();
  await ready(page);
  await page.locator("#search").fill("火");
  await expect(options(page).first()).toContainText("Fire // Ice");
  expect(fixture.counts.downloads).toBe(1);
  expect(fixture.counts.manifestReads).toBe(1);
  expect(fixture.counts.suggestions).toBe(0);
  await page.locator("#search").press("ArrowDown");
  await page.locator("#search").press("Escape");
  await expect(page.locator("#suggestion-panel")).toBeHidden();
  expect(
    await page.evaluate(() =>
      window.searchMetrics.some((m) => m.phase === "restore"),
    ),
  ).toBe(true);
});
test("UC-33 weekly background update swaps only complete data and stale good survives download corruption", async ({
  page,
}) => {
  const flags = {},
    fixture = await setup(page, flags);
  await page.goto("/");
  await ready(page);
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.searchMetrics.some((m) => m.phase === "refresh"),
      ),
    )
    .toBe(true);
  await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const r = indexedDB.open("keeper-public-catalog-v1", 1);
        r.onsuccess = () => {
          const db = r.result,
            tx = db.transaction("catalog", "readwrite"),
            store = tx.objectStore("catalog"),
            get = store.get("current");
          get.onsuccess = () =>
            store.put({ ...get.result, checked: 0 }, "current");
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
  fixture.update();
  await page.reload();
  await ready(page);
  await expect.poll(() => fixture.counts.downloads).toBe(2);
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.searchMetrics.some((m) => m.phase === "refresh"),
      ),
    )
    .toBe(true);
  await page.locator("#search").fill("Updated");
  await expect(options(page).first()).toContainText("Updated Lightning Bolt");
  flags.offline = true;
  await page.reload();
  await ready(page);
  await page.locator("#search").fill("稲妻");
  await expect(options(page).first()).toContainText("Updated Lightning Bolt");
  expect(fixture.counts.suggestions).toBe(0);
});
for (const failure of ["corrupt", "offline", "worker", "storage"])
  test(`UC-33 ${failure} failure keeps complete server fallback or usable in-memory index`, async ({
    page,
  }) => {
    const flags = { [failure]: true },
      fixture = await setup(page, flags);
    if (failure === "worker")
      await page.addInitScript(() => {
        window.Worker = class {
          constructor() {
            throw Error("unavailable");
          }
        };
      });
    if (failure === "storage")
      await page.route("**/vendor/name-worker.js", async (route) => {
        const response = await route.fetch();
        await route.fulfill({
          response,
          body:
            "Object.defineProperty(self,'indexedDB',{get(){throw Error('denied')}});\n" +
            (await response.text()),
        });
      });
    await page.goto("/");
    if (failure === "storage") await ready(page);
    await page.locator("#search").fill("relampa");
    await expect(options(page).first()).toContainText("Lightning Bolt");
    if (failure !== "storage")
      expect(fixture.counts.suggestions).toBeGreaterThan(0);
    await options(page).first().tap();
    await expect(page.locator("#detail")).toBeVisible();
    await page.locator("#close").click();
  });
test("UC-34 fresh detail failure stays retryable and cannot create ownership", async ({
  page,
}) => {
  const flags = { detailsFail: true };
  await setup(page, flags);
  await page.goto("/");
  await ready(page);
  await page.locator("#search").fill("relampa");
  await options(page).first().tap();
  await expect(
    page.getByRole("button", { name: "Retry opening card" }),
  ).toBeVisible();
  await expect(page.locator("#detail")).not.toBeVisible();
  flags.detailsFail = false;
  await page.getByRole("button", { name: "Retry opening card" }).click();
  await expect(page.locator("#detail")).toBeVisible();
  await expect(page.locator("#total")).toHaveText("0");
});
test("UC-33 public worker cache survives account switch while private ownership and recent history do not leak", async ({
  page,
}) => {
  const fixture = await setup(page);
  let owner = "one";
  await page.route("**/config.json", (r) =>
    r.fulfill({
      json: { region: "us-east-1", clientId: "fixture", apiUrl: "" },
    }),
  );
  await page.route("**/api/session", (r) => r.fulfill({ json: { owner } }));
  await page.route("**/api/collection", (r) =>
    r.fulfill({
      json:
        owner === "one"
          ? [
              {
                id: "row",
                card,
                printing_id: printing,
                quantity: 1,
                language: "en",
                condition: "NM",
                finish: "nonfoil",
                tags: [],
                tag_ids: [],
                locations: [],
              },
            ]
          : [],
    }),
  );
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("initialized")) {
      sessionStorage.setItem("initialized", "1");
      sessionStorage.setItem(
        "keeper-session",
        JSON.stringify({ IdToken: "test-one", expires: Date.now() + 3600000 }),
      );
    }
  });
  await page.goto("/");
  await ready(page);
  await expect(page.locator("#total")).toHaveText("1");
  await page.locator("#search").fill("relampa");
  await expect(options(page).first()).toHaveAccessibleName(/Owned/);
  await options(page).first().tap();
  await expect(page.locator("#detail")).toBeVisible();
  await page.locator("#close").click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.searchMetrics.some((m) => m.phase === "refresh"),
      ),
    )
    .toBe(true);
  owner = "two";
  await page.evaluate(() =>
    sessionStorage.setItem(
      "keeper-session",
      JSON.stringify({ IdToken: "test-two", expires: Date.now() + 3600000 }),
    ),
  );
  await page.reload();
  await ready(page);
  await expect(page.locator("#total")).toHaveText("0");
  await expect(page.locator(".home-card")).toHaveCount(0);
  await page.locator("#search").fill("稲妻");
  await expect(options(page).first()).toHaveAccessibleName(/Not owned/);
  expect(fixture.counts.downloads).toBe(1);
  expect(fixture.counts.suggestions).toBe(0);
  const serialized = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const r = indexedDB.open("keeper-public-catalog-v1", 1);
        r.onsuccess = () => {
          const db = r.result,
            t = db.transaction("catalog"),
            g = t.objectStore("catalog").get("current");
          g.onsuccess = () => resolve(JSON.stringify(g.result));
          t.oncomplete = () => db.close();
        };
      }),
  );
  expect(serialized).not.toMatch(
    /test-one|test-two|quantity|condition|keeper-session/,
  );
});
