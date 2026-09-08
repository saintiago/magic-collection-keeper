import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

test("LIVE-08 Discover opens owned printings and persists tag add/remove without changing ownership or provenance", async ({
  page,
  request,
}) => {
  test.setTimeout(180000);
  expect(process.env.KEEPER_TAGS_USER).toBe("keeper-tags");
  await page.goto("/");
  await page
    .getByLabel("Username", { exact: true })
    .fill(process.env.KEEPER_TAGS_USER);
  await page
    .getByLabel("Password", { exact: true })
    .fill(process.env.KEEPER_TAGS_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".auth-dialog")).toHaveCount(0);
  const config = await (
    await request.get(`${process.env.LIVE_URL}/config.json`)
  ).json();
  const token = await page.evaluate(
    () => JSON.parse(sessionStorage.getItem("keeper-session")).IdToken,
  );
  async function api(path, method = "GET", data) {
    const response = await request.fetch(`${config.apiUrl}/api/${path}`, {
      method,
      data,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  }
  const before = await api("collection");
  const target = before.find(
    (row) =>
      row.card.name === "Lightning Bolt" &&
      row.finish === "nonfoil" &&
      row.source_managed,
  );
  expect(target).toBeTruthy();
  const original = {
    inventory_id: target.id,
    locations: target.locations.map(({ tag_id, quantity }) => ({
      tag_id,
      quantity,
    })),
    tag_ids: target.tag_ids,
  };
  const label = `Discover test ${randomUUID()}`;
  const registry = await api("tags", "POST", {
    label,
    type: "role",
    kind: "role",
  });
  const tag = registry.find((t) => t.label === label);
  expect(tag).toBeTruthy();
  const ownedCount = before
    .filter((row) => row.card.oracle_id === target.card.oracle_id)
    .reduce((sum, row) => sum + row.quantity, 0);
  async function open(keyboard = false) {
    await page.locator("#collection-nav").click();
    const input = page.getByRole("combobox", { name: "Search cards" });
    await input.fill("relampa");
    const suggestion = page
      .locator("#suggestion-panel")
      .getByRole("option")
      .first();
    await expect(suggestion).toContainText("Lightning Bolt", {
      timeout: 30000,
    });
    await expect(suggestion).toContainText(`${ownedCount} owned`);
    if (keyboard) {
      await input.press("ArrowDown");
      await input.press("Enter");
    } else await suggestion.click();
    await expect(page.locator("#detail")).toBeVisible({ timeout: 30000 });
    await expect(
      page.locator(".owned-printing").filter({ hasText: "Nonfoil" }),
    ).toHaveCount(1, { timeout: 30000 });
  }
  const ownedRow = () =>
    page.locator(".owned-printing").filter({ hasText: "Nonfoil" });
  try {
    await open(true);
    await expect(page.locator(".detail-ownership")).not.toContainText(
      "system:import-pending",
    );
    await ownedRow().getByRole("button").click();
    await page.getByLabel(`${label} (Role)`, { exact: true }).check();
    await page.getByRole("button", { name: "Save card tags" }).click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await page.reload();
    await open();
    await ownedRow().locator(`a[data-tag-id="${tag.id}"]`).click();
    await expect(page.locator("#tag-filter")).toHaveValue(tag.id);
    await expect(page.locator(".card")).toHaveCount(1);
    await open();
    await ownedRow().getByRole("button").click();
    await page.getByLabel(`${label} (Role)`, { exact: true }).uncheck();
    await page.getByRole("button", { name: "Save card tags" }).click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await page.reload();
    await open();
    await expect(ownedRow().locator(`a[data-tag-id="${tag.id}"]`)).toHaveCount(
      0,
    );
    expect(await api("collection")).toEqual(before);
  } finally {
    await api("tag-assignments", "PUT", original);
    await api(`tags/${tag.id}`, "DELETE");
  }
  expect(await api("collection")).toEqual(before);
  await page.locator("#close").click();
  await page.locator("#sign-out").click();
});
