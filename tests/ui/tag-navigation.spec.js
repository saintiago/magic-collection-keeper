import { openArtworkDetails } from "../helpers/artwork-actions.js";
import { test, expect } from "./fixtures.js";
const tags = ["deck", "binder", "box", "other", "role", "category"].map(
  (kind, i) => ({
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    label: i === 0 ? "Shared name" : kind,
    kind,
    type: i < 4 ? "location" : kind,
    references: 1,
  }),
);
const duplicate = { ...tags[0], id: "00000000-0000-4000-8000-000000000007" };
const empty = {
  ...tags[4],
  id: "00000000-0000-4000-8000-000000000008",
  label: "Empty role",
  references: 0,
};
const card = {
  id: "p",
  name: "Alpha",
  set: "tst",
  set_name: "Test",
  collector_number: "1",
  lang: "en",
  finishes: ["nonfoil"],
  color_identity: ["R"],
};
const rows = [
  {
    id: "a",
    printing_id: "p",
    quantity: 10,
    finish: "nonfoil",
    condition: "NM",
    language: "en",
    card,
    locations: tags
      .slice(0, 4)
      .map((tag, i) => ({ tag_id: tag.id, tag, quantity: i + 1 })),
    tag_ids: tags.slice(4).map((t) => t.id),
    tags: tags.slice(4),
  },
  {
    id: "b",
    printing_id: "p2",
    quantity: 1,
    finish: "nonfoil",
    condition: "NM",
    language: "en",
    card: { ...card, id: "p2", name: "Beta" },
    locations: [{ tag_id: duplicate.id, tag: duplicate, quantity: 1 }],
    tag_ids: [],
    tags: [],
  },
];
async function fixture(page) {
  let registry = [...tags, duplicate, empty],
    writes = 0,
    delayed = false,
    release;
  await page.route("**/api/collection", async (route) => {
    if (delayed) await new Promise((resolve) => (release = resolve));
    await route.fulfill({ json: rows });
  });
  await page.route("**/api/tags", (route) => route.fulfill({ json: registry }));
  await page.route("**/api/tags/*", (route) => {
    writes++;
    const id = route.request().url().split("/").at(-1);
    if (route.request().method() === "DELETE")
      registry = registry.filter((t) => t.id !== id);
    else
      registry = registry.map((t) =>
        t.id === id ? { ...t, label: route.request().postDataJSON().label } : t,
      );
    return route.fulfill({ json: registry });
  });
  await page.route("**/api/tag-assignments", (route) => {
    writes++;
    return route.fulfill({ json: rows });
  });
  await page.route("**/api/deck-imports", (route) =>
    route.fulfill({
      json: [
        {
          tag_id: tags[0].id,
          name: tags[0].label,
          url: "https://moxfield.com/decks/test",
          folder: "Test",
          updated_at: "2026-09-08T00:00:00Z",
          lots: [{ allocated_quantity: 1, owned_quantity: 1 }],
          excluded: [],
          pending: [],
        },
      ],
    }),
  );
  return {
    writes: () => writes,
    delay: () => (delayed = true),
    release: () => {
      delayed = false;
      release?.();
    },
  };
}
test("UC-19 all six tag kinds navigate by ID; same-name tags, conflicts, back and clear", async ({
  page,
}) => {
  const data = await fixture(page);
  await page.goto("/#collection");
  for (const tag of [...tags, duplicate, empty]) {
    await page.locator("#search").fill("unrelated");
    await page.locator("#color").selectOption("G");
    await page.locator("#manage-tags").click();
    await page.locator(`.tag-registry a[data-tag-id="${tag.id}"]`).click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(page.locator("#tag-filter")).toHaveValue(tag.id);
    await expect(page.locator("#search")).toHaveValue("");
    await expect(page.locator("#color")).toHaveValue("");
    await expect(page.locator("#active-tag")).toContainText(tag.label);
    await expect(page.locator("#section-title")).toBeFocused();
    await expect(page.locator(".card-open")).toHaveCount(tag === empty ? 0 : 1);
    if (tag !== empty)
      await expect(page.locator(".card-open")).toHaveAccessibleName(
        new RegExp(
          "^Open " + (tag.id === duplicate.id ? "Beta" : "Alpha") + " printing",
        ),
      );
  }
  await expect(
    page.getByRole("heading", { name: "No cards match this tag" }),
  ).toBeVisible();
  await page.goBack();
  await expect(page.locator("#tag-filter")).toHaveValue(duplicate.id);
  await page.locator("#clear-tag").click();
  await expect(page.locator(".card")).toHaveCount(2);
  expect(data.writes()).toBe(0);
});
test("UC-19 card, detail, assignment and source links close cleanly without edits or nested controls", async ({
  page,
}) => {
  const data = await fixture(page);
  await page.goto("/#collection");
  await page.locator(".card-open").first().click();
  await openArtworkDetails(page);
  await page.locator(`#detail a[data-tag-id="${tags[0].id}"]`).click();
  await expect(page.locator("#detail")).not.toBeVisible();
  await expect(page.locator("#result-count")).toHaveText(
    "1 assigned copies · 1 distinct entry",
  );
  await page.locator(".card-open").click();
  await openArtworkDetails(page);
  const detailLink = page.locator(`#detail a[data-tag-id="${tags[4].id}"]`);
  await detailLink.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#detail")).not.toBeVisible();
  await expect(page.locator("#tag-filter")).toHaveValue(tags[4].id);
  await page.locator(".card-open").click();
  await openArtworkDetails(page);
  await page.locator("#edit-card-tags").click();
  await page
    .locator(`.classification-choice a[data-tag-id="${tags[5].id}"]`)
    .click();
  await expect(page.locator("#tag-filter")).toHaveValue(tags[5].id);
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await page.locator(".card-open").click();
  await openArtworkDetails(page);
  await page.locator("#edit-card-tags").click();
  await page.getByLabel("Copies at location 1").fill("99");
  await page.locator(`.assignment-tag a[data-tag-id="${tags[1].id}"]`).click();
  await expect(page.locator("#result-count")).toHaveText(
    "2 assigned copies · 1 distinct entry",
  );
  await page.locator("#manage-tags").click();
  await page.locator("#deck-sources").click();
  await page.locator(`.source-card a[data-tag-id="${tags[0].id}"]`).click();
  await expect(page.locator("#tag-filter")).toHaveValue(tags[0].id);
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  expect(
    await page.locator("button a, button button, a button, a a").count(),
  ).toBe(0);
  expect(data.writes()).toBe(0);
});
test("UC-19 deep links survive cache refresh and rename; deletion keeps an explicit empty selection", async ({
  page,
}) => {
  const data = await fixture(page);
  await page.goto("/#tag=" + tags[0].id);
  await expect(page.locator("#tag-filter")).toHaveValue(tags[0].id);
  await expect(page.locator(".card-open")).toHaveAccessibleName(
    /^Open Alpha printing/,
  );
  await page.locator("#manage-tags").click();
  await page
    .getByLabel("Rename Shared name", { exact: true })
    .first()
    .fill("Renamed deck");
  await page
    .locator(`.tag-record[data-id="${tags[0].id}"]`)
    .getByRole("button", { name: "Rename", exact: true })
    .click();
  await page.locator("#tags-close").click();
  await expect(page.locator("#active-tag")).toContainText("Renamed deck");
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
  data.delay();
  await page.reload();
  await expect(page.locator("#collection-status-text")).toContainText(
    "Showing saved snapshot",
  );
  await expect(page.locator("#tag-filter")).toHaveValue(tags[0].id);
  await expect(page.locator(".card-open")).toHaveAccessibleName(
    /^Open Alpha printing/,
  );
  data.release();
  await page.locator("#manage-tags").click();
  await page.locator(`.tag-record[data-id="${empty.id}"] a`).click();
  await page.locator("#manage-tags").click();
  await page.locator(`.tag-record[data-id="${empty.id}"] .delete-tag`).click();
  await page.locator("#tags-close").click();
  await expect(page.locator("#tag-filter")).toHaveValue(empty.id);
  await expect(
    page.getByRole("heading", { name: "Tag unavailable" }),
  ).toBeVisible();
  await expect(page.locator(".card")).toHaveCount(0);
  expect(data.writes()).toBe(2);
});

test("UC-19 closing a loading source view prevents its late response from reopening a dialog", async ({
  page,
}) => {
  await fixture(page);
  let release;
  await page.route("**/api/deck-imports", async (route) => {
    await new Promise((resolve) => (release = resolve));
    await route.fulfill({ json: [] });
  });
  await page.goto("/#collection");
  await page.locator("#manage-tags").click();
  await page.locator("#deck-sources").click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.locator("#tags-close").click();
  await page.locator(".card-open").first().click();
  await openArtworkDetails(page);
  await page.locator(`#detail a[data-tag-id="${tags[0].id}"]`).click();
  release();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(page.locator("#tag-filter")).toHaveValue(tags[0].id);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
