import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
test("UC-13 source printing exceptions remain visible without claiming ownership", async ({
  page,
}) => {
  await page.route("**/api/collection", (r) => r.fulfill({ json: [] }));
  await page.route("**/api/tags", (r) => r.fulfill({ json: [] }));
  await page.route("**/api/deck-imports", (r) =>
    r.fulfill({
      json: [
        {
          name: "Test source",
          url: "https://moxfield.com/decks/fixture",
          folder: "Test",
          updated_at: "2026-09-08T00:00:00Z",
          lots: [{ allocated_quantity: 99, owned_quantity: 99 }],
          excluded: [],
          pending: [
            {
              name: "<Unresolved card>",
              quantity: 1,
              set: "prm",
              collector_number: "1",
              finish: "foil",
              reason: "Paper printing unknown",
            },
          ],
        },
      ],
    }),
  );
  await page.goto("/");
  await page.locator("#manage-tags").click();
  await page.locator("#deck-sources").click();
  await expect(page.locator(".source-card")).toContainText(
    "99 assigned from source",
  );
  await expect(page.locator(".pending-source")).toContainText(
    "<Unresolved card>",
  );
  await expect(page.locator(".pending-source")).toContainText(
    "Paper printing unknown",
  );
  await page.locator("#back-tags").click();
  await page.locator("#tags-close").click();
});
const card = {
  id: "p",
  name: "Test Card",
  set: "tst",
  set_name: "Test Set",
  collector_number: "1",
  lang: "en",
  finishes: ["nonfoil"],
  rarity: "common",
  type_line: "Artifact",
  color_identity: [],
  scryfall_uri: "https://scryfall.com",
};
test("UC-10 contextual typed tags, allocation shortfall, rename, filtering and safe deletion", async ({
  page,
}) => {
  let tags = [],
    quantity = 2,
    locations = [],
    tagIds = [];
  const rows = () => [
    {
      id: 1,
      printing_id: "p",
      quantity,
      card,
      language: "en",
      condition: "NM",
      finish: "nonfoil",
      locations: locations.map((a) => ({
        ...a,
        tag: tags.find((t) => t.id === a.tag_id),
      })),
      tag_ids: tagIds,
      tags: tags.filter((t) => tagIds.includes(t.id)),
      allocated_quantity: locations.reduce((n, a) => n + a.quantity, 0),
      allocation_shortfall: Math.max(
        0,
        locations.reduce((n, a) => n + a.quantity, 0) - quantity,
      ),
    },
  ];
  await page.route("**/api/collection", (r) => r.fulfill({ json: rows() }));
  await page.route("**/api/collection/1", (r) => {
    quantity = r.request().postDataJSON().quantity;
    return r.fulfill({ json: rows() });
  });
  await page.route("**/api/tags", (r) => {
    if (r.request().method() === "POST")
      tags.push({
        ...r.request().postDataJSON(),
        id: randomUUID(),
        references: 0,
      });
    return r.fulfill({ json: tags });
  });
  await page.route(/\/api\/tags\/[a-f0-9-]+$/, (r) => {
    const id = r.request().url().split("/").pop(),
      tag = tags.find((t) => t.id === id);
    if (r.request().method() === "PATCH")
      tag.label = r.request().postDataJSON().label;
    else {
      if (locations.some((a) => a.tag_id === id) || tagIds.includes(id))
        return r.fulfill({
          status: 409,
          json: { error: "This tag is in use." },
        });
      tags = tags.filter((t) => t.id !== id);
    }
    return r.fulfill({ json: tags });
  });
  await page.route("**/api/tag-assignments", (r) => {
    const input = r.request().postDataJSON();
    locations = input.locations;
    tagIds = input.tag_ids;
    return r.fulfill({ json: rows() });
  });
  await page.route("**/api/deck-imports", (r) => r.fulfill({ json: [] }));
  await page.goto("/");
  await page.locator("#manage-tags").click();
  await page.locator("#tag-label").fill("<Deck A>");
  await page.locator("#create-tag button").click();
  await expect(page.getByText("Tag created.", { exact: true })).toBeVisible();
  await page.locator("#tag-type").selectOption("role");
  await page.locator("#tag-label").fill("Card Draw");
  await page.locator("#create-tag button").click();
  await page.locator("#tags-close").click();
  await page.locator(".card").click();
  await page.locator("#edit-card-tags").click();
  await page.locator("#add-location").click();
  await page.getByLabel("Copies at location 1").fill("3");
  await page.getByLabel("Card Draw (Role)").check();
  await page.locator("#save-tags").click();
  await expect(page.locator(".card .allocation-warning")).toHaveText(
    "3 assigned · 2 owned",
  );
  await expect(page.locator(".card .card-tags")).toContainText("<Deck A>");
  await page.locator(".card").click();
  await page.locator("#quantity").fill("1");
  await page.getByRole("button", { name: "Save quantity" }).click();
  await expect(page.locator(".card .allocation-warning")).toHaveText(
    "3 assigned · 1 owned",
  );
  await page.reload();
  await expect(page.locator(".card .allocation-warning")).toHaveText(
    "3 assigned · 1 owned",
  );
  await page.locator("#tag-filter").selectOption(tags[0].id);
  await expect(page.locator(".card")).toHaveCount(1);
  await page.locator("#manage-tags").click();
  await page
    .locator(".tag-record")
    .first()
    .locator("input")
    .fill("Renamed deck");
  await page
    .locator(".tag-record")
    .first()
    .getByRole("button", { name: "Rename" })
    .click();
  await expect(page.getByText("Tag renamed.", { exact: false })).toBeVisible();
  await page.locator(".delete-tag").first().click();
  await expect(
    page.getByText("This tag is in use.", { exact: true }),
  ).toBeVisible();
  await page.locator("#deck-sources").click();
  await expect(page.getByText("No deck sources imported yet.")).toBeVisible();
  await page.locator("#back-tags").click();
  await page.locator("#tags-close").click();
  await page.locator(".card").click();
  await page.locator("#edit-card-tags").click();
  await page.getByRole("button", { name: "Remove location 1" }).click();
  await page.getByLabel("Card Draw (Role)").uncheck();
  await page.locator("#save-tags").click();
  await page.locator("#tag-filter").selectOption("");
  await expect(page.locator(".card .allocation-warning")).toHaveCount(0);
  await page.locator("#manage-tags").click();
  await page.locator(".delete-tag").first().click();
  await page.locator(".delete-tag").first().click();
  await expect(page.getByText("No tags yet.", { exact: false })).toBeVisible();
});
test("UC-10 tag creation failure stays editable at phone width", async ({
  page,
}) => {
  await page.route("**/api/collection", (r) => r.fulfill({ json: [] }));
  await page.route("**/api/tags", (r) =>
    r.fulfill(
      r.request().method() === "POST"
        ? { status: 400, json: { error: "Invalid tag label" } }
        : { json: [] },
    ),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.locator("#manage-tags").click();
  await page.locator("#tag-type").selectOption("category");
  await page.locator("#tag-label").fill("Keep");
  await page.locator("#create-tag button").click();
  await expect(page.getByText("Invalid tag label")).toBeVisible();
  await expect(page.locator("#create-tag button")).toBeEnabled();
  expect(
    await page.evaluate(
      () =>
        document.querySelector(".tag-dialog").scrollWidth <=
        document.querySelector(".tag-dialog").clientWidth,
    ),
  ).toBe(true);
});
