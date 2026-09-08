import { test, expect } from "./fixtures.js";
import { cardHref } from "../../public/card-route.js";
test.use({ hasTouch: true });
const a = {
  id: "11111111-1111-4111-8111-111111111111",
  oracle_id: "22222222-2222-4222-8222-222222222222",
  name: "Lightning Bolt",
  lang: "en",
  games: ["paper"],
  set: "m11",
  set_name: "Magic 2011",
  collector_number: "149",
  finishes: ["nonfoil", "foil"],
  oracle_text: "Lightning Bolt deals 3 damage to any target.",
  type_line: "Instant",
  color_identity: ["R"],
};
const b = {
  ...a,
  id: "33333333-3333-4333-8333-333333333333",
  oracle_id: "44444444-4444-4444-8444-444444444444",
  name: "Piracy",
};
const ref = (c) => ({
  printing_id: c.id,
  oracle_id: c.oracle_id,
  lang: c.lang,
});
async function setup(page, { rows = [] } = {}) {
  const calls = [],
    writes = [];
  let held = false,
    release,
    fail = false;
  await page.route("**/api/tags", (r) => r.fulfill({ json: [] }));
  await page.route("**/api/collection", (r) => {
    if (r.request().method() !== "GET") writes.push(r.request().postDataJSON());
    return r.fulfill({ json: rows });
  });
  await page.route("**/api/suggest?*", (r) => {
    const q = new URL(r.request().url()).searchParams.get("q");
    const c = q?.toLowerCase().includes("pira") ? b : a;
    return r.fulfill({
      json: { suggestions: [{ ...ref(c), name: c.name }], catalog: null },
    });
  });
  await page.route("**/api/discover?*", async (r) => {
    const p = new URL(r.request().url()).searchParams;
    calls.push(Object.fromEntries(p));
    if (held) await new Promise((resolve) => (release = resolve));
    if (fail)
      return r
        .fulfill({ status: 503, json: { error: "Card details unavailable" } })
        .catch(() => {});
    const cards = p.get("oracle")
      ? [a, b].filter((c) => c.oracle_id === p.get("oracle"))
      : [a, b];
    return r
      .fulfill({ json: { cards, total: cards.length, hasMore: false } })
      .catch(() => {});
  });
  await page.addInitScript(() => {
    window.cardMetrics = [];
    window.addEventListener("keeper-card-metric", (e) =>
      window.cardMetrics.push(e.detail),
    );
  });
  await page.goto("/");
  await expect(page.locator("#total")).toHaveText(
    String(rows.reduce((n, r) => n + r.quantity, 0)),
  );
  return {
    calls,
    writes,
    hold() {
      held = true;
    },
    release() {
      held = false;
      release?.();
    },
    fail(v) {
      fail = v;
    },
  };
}
async function choose(page, name = "relampa") {
  await page.locator("#search").fill(name);
  await page.locator("#suggestion-panel").getByRole("option").first().tap();
}
const ready = (page) => expect(page.locator("#inventory-form")).toBeVisible();
test("UC-35 autocomplete enters named card page before network, without singleton results or modal, and measures independent readiness", async ({
  page,
}) => {
  const f = await setup(page);
  f.hold();
  await choose(page);
  await expect(page.locator("#detail")).toBeVisible();
  await expect(page.locator("#card-heading")).toHaveText(a.name);
  await expect(page.locator("#card-heading")).toBeFocused();
  await expect(page.locator("#card-status")).toHaveText(
    "Opening Lightning Bolt…",
  );
  await expect(page.locator("#detail")).toHaveAttribute("aria-busy", "true");
  await expect(page.locator("dialog#detail")).toHaveCount(0);
  await expect(page.locator(".library")).toBeHidden();
  await expect(page.locator("#grid .card")).toHaveCount(0);
  await expect(page).toHaveURL(/#card=/);
  await expect.poll(() => f.calls.length).toBe(1);
  expect(f.calls[0].printing).toBe(a.id);
  f.release();
  await ready(page);
  await expect(page.locator("#detail")).toHaveAttribute("aria-busy", "false");
  expect(
    await page.evaluate(() =>
      window.cardMetrics.some((m) => m.phase === "page-visible"),
    ),
  ).toBe(true);
  await page.locator("#close").click();
  await expect(page.locator("#home-page")).toBeVisible();
  await choose(page);
  await ready(page);
  expect(f.calls.length).toBe(1);
  expect(
    await page.evaluate(() =>
      window.cardMetrics.some(
        (m) => m.phase === "details-visible" && m.source === "browser-cache",
      ),
    ),
  ).toBe(true);
  expect(f.writes).toEqual([]);
});
test("UC-35 real query keeps results, grid selection is immediate, Back restores query/results, and recent/Home share the page", async ({
  page,
}) => {
  const f = await setup(page);
  await page.locator("#search").fill("light");
  await page.locator("#search-submit").click();
  await expect(page.locator("#grid .card")).toHaveCount(2);
  await page.locator("#grid .card-open").first().click();
  await ready(page);
  expect(f.calls.length).toBe(1);
  await expect(page.locator("#title")).toHaveText("Card");
  await page.locator("#close").click();
  await expect(page.locator("#grid .card")).toHaveCount(2);
  await expect(page.locator("#search")).toHaveValue("light");
  await expect(page.locator("#grid .card-open").first()).toBeFocused();
  await page.locator("#home-nav").click();
  await page.locator("#home-page [data-home-card]").first().click();
  await ready(page);
  await page.locator("#close").click();
  await expect(page.locator("#home-page")).toBeVisible();
  await page.locator("#search").fill("");
  await page.locator("#search").focus();
  await page
    .locator("#suggestion-panel")
    .getByRole("option")
    .filter({ hasText: "Lightning Bolt" })
    .first()
    .click();
  await ready(page);
  expect(f.writes).toEqual([]);
});
test("UC-35 Back during loading cancels late response; rapid second selection wins and errors retry in place", async ({
  page,
}) => {
  const f = await setup(page);
  f.hold();
  await choose(page);
  await expect.poll(() => f.calls.length).toBe(1);
  await page.goBack();
  await expect(page.locator("#home-page")).toBeVisible();
  f.release();
  await expect(page.locator("#detail")).toBeHidden();
  f.fail(true);
  await choose(page, "Piracy");
  await expect(page.locator("#card-status")).toContainText(
    "Card details unavailable",
  );
  await expect(page.locator("#inventory-form")).toHaveCount(0);
  await expect(page.locator("#detail")).toBeVisible();
  f.fail(false);
  await page.getByRole("button", { name: "Retry opening card" }).click();
  await ready(page);
  await expect(page.locator("#card-heading")).toHaveText("Piracy");
  await page.locator("#close").click();
  f.hold();
  await choose(page);
  await expect.poll(() => f.calls.length).toBe(4);
  await choose(page, "Piracy");
  await ready(page);
  f.release();
  await expect(page.locator("#card-heading")).toHaveText("Piracy");
  expect(f.writes).toEqual([]);
});
test("UC-35 reload and Forward resolve identity directly; invalid links make no detail request and cannot add", async ({
  page,
}) => {
  const f = await setup(page);
  await choose(page);
  await ready(page);
  const url = page.url();
  await page.reload();
  await ready(page);
  await expect(page).toHaveURL(url);
  expect(f.calls.at(-1).printing).toBe(a.id);
  await page.goBack();
  await expect(page.locator("#home-page")).toBeVisible();
  await page.goForward();
  await ready(page);
  const count = f.calls.length;
  await page.goto("/#card=invalid&oracle=" + a.oracle_id);
  await expect(page.locator("#card-status")).toContainText("invalid");
  expect(f.calls.length).toBe(count);
  await expect(page.locator("#inventory-form")).toHaveCount(0);
  await page.locator("#close").click();
  await expect(page.locator("#home-page")).toBeVisible();
  expect(f.writes).toEqual([]);
});
test("UC-35 owned entry link refreshes only current account, preserves quantity and filters; absent entry never becomes Add", async ({
  page,
}) => {
  const row = {
    id: "owned-one",
    printing_id: a.id,
    card: a,
    quantity: 3,
    finish: "foil",
    condition: "NM",
    locations: [],
    tags: [],
    tag_ids: [],
  };
  const f = await setup(page, { rows: [row] });
  await page.locator("#collection-nav").click();
  await page.locator("#finish-filter").selectOption("foil");
  await page.locator("#grid .card-open").click();
  await ready(page);
  await expect(page.locator("#quantity")).toHaveValue("3");
  await page.locator("#close").click();
  await expect(page.locator("#finish-filter")).toHaveValue("foil");
  await page.locator("#grid .card-open").click();
  await page.reload();
  await ready(page);
  await expect(page.locator("#quantity")).toHaveValue("3");
  await expect(
    page.getByRole("button", { name: "Save quantity", exact: true }),
  ).toBeVisible();
  await page.goto("/" + cardHref({ ...ref(a), entry: "someone-elses-row" }));
  await expect(page.locator("#card-status")).toContainText(
    "no longer in your collection",
  );
  await expect(page.locator("#inventory-form")).toHaveCount(0);
  expect(f.writes).toEqual([]);
});
test("UC-35 selected foreign printing deep link keeps exact language and English rules with explicit Add", async ({
  page,
}) => {
  const f = await setup(page);
  const spanish = {
    ...a,
    id: "55555555-5555-4555-8555-555555555555",
    lang: "es",
    printed_name: "Relámpago",
  };
  await page.route("**/api/card?*", (r) =>
    r.fulfill({ json: { cards: [spanish], total: 1, hasMore: false } }),
  );
  await page.goto("/" + cardHref(ref(spanish)));
  await ready(page);
  await expect(page.locator("#detail .printing")).toContainText("ES");
  await expect(page.locator("#detail .oracle")).toHaveText(a.oracle_text);
  await expect(
    page.getByRole("button", { name: "+ Add to collection", exact: true }),
  ).toBeVisible();
  expect(f.writes).toEqual([]);
});

test("UC-35 a completed Add cannot navigate away from a newer card, and browser Back closes an auxiliary editor", async ({
  page,
}) => {
  await setup(page);
  let release, posted;
  await page.route("**/api/collection", async (r) => {
    if (r.request().method() === "POST") {
      posted = r.request().postDataJSON();
      await new Promise((resolve) => (release = resolve));
    }
    return r.fulfill({ json: [] }).catch(() => {});
  });
  await choose(page);
  await ready(page);
  await page
    .getByRole("button", { name: "+ Add to collection", exact: true })
    .click();
  await expect.poll(() => !!posted).toBe(true);
  expect(posted.quantity).toBe(1);
  expect(posted.printing_id).toBe(a.id);
  await choose(page, "Piracy");
  await ready(page);
  release();
  await expect(page.locator("#card-heading")).toHaveText("Piracy");
  await expect(page).toHaveURL(new RegExp(b.id));
  await page.route("**/api/search?*", (r) =>
    r.fulfill({ json: { cards: [b], total: 1, hasMore: false } }),
  );
  await page
    .getByRole("button", { name: "Change printing or language" })
    .click();
  await expect(page.locator(".printing-picker")).toBeVisible();
  await page.goBack();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(page.locator("#card-heading")).toHaveText("Lightning Bolt");
});
