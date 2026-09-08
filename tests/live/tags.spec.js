import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

test("LIVE-03 typed tags and source imports persist with soft allocation consistency", async ({
  page,
  request,
}) => {
  test.setTimeout(180000);
  expect(process.env.KEEPER_TAGS_USER).toBe("keeper-tags");
  const config = await (
    await request.get(`${process.env.LIVE_URL}/config.json`)
  ).json();
  await page.goto("/");
  await page
    .getByLabel("Username", { exact: true })
    .fill(process.env.KEEPER_TAGS_USER);
  await page
    .getByLabel("Password", { exact: true })
    .fill(process.env.KEEPER_TAGS_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".auth-dialog")).toHaveCount(0);
  await expect(page.locator("#sign-out")).toBeVisible();
  const token = await page.evaluate(
    () => JSON.parse(sessionStorage.getItem("keeper-session")).IdToken,
  );
  const headers = { Authorization: `Bearer ${token}` };
  const api = async (path, method = "GET", data) => {
    const result = await request.fetch(`${config.apiUrl}/api/${path}`, {
      method,
      headers,
      data,
    });
    expect(
      result.ok(),
      `${method} ${path}: ${await result.text()}`,
    ).toBeTruthy();
    return result.json();
  };
  // This third profile intentionally retains source history across runs.
  const search = await api(
    `search?q=${encodeURIComponent('!"Lightning Bolt" set:m11 lang:en')}`,
  );
  const printing = search.cards[0];
  expect(printing.id).toBeTruthy();
  for (const row of await api("collection"))
    if (!row.source_managed) {
      await api("tag-assignments", "PUT", {
        inventory_id: row.id,
        locations: [],
        tag_ids: [],
      });
      await api(`collection/${row.id}`, "DELETE");
    }
  let rows = await api("collection", "POST", {
    printing_id: printing.id,
    quantity: 5,
    finish: "nonfoil",
    condition: "NM",
    operation_id: randomUUID(),
  });
  const native = rows.find((r) => !r.source_managed);
  // Clearly synthetic contents in the reserved test profile exercise the provider
  // path; this is not verification of a physical or official deck's contents.
  const official = {
    provider: "wizards-precon",
    source_id: "wizards:40k:keeper-test-fixture:standard:en",
    name: "Synthetic Wizards source fixture",
    url: "https://magic.wizards.com/en/news/announcements/warhammer-40000-commander-decklists",
    folder: "Isolated test fixtures",
    entries: [
      {
        printing_id: printing.id,
        quantity: 1,
        finish: "foil",
        section: "commanders",
      },
    ],
  };
  const officialPreview = await api("deck-imports/preview", "POST", official);
  await api("deck-imports", "POST", {
    ...official,
    expected_version: officialPreview.existing_version,
  });
  const officialRepeat = await api("deck-imports/preview", "POST", official);
  expect(officialRepeat.additions).toBe(0);
  expect(officialRepeat.unchanged).toBe(true);
  expect(
    (
      await api("deck-imports", "POST", {
        ...official,
        expected_version: officialRepeat.existing_version,
      })
    ).unchanged,
  ).toBe(true);
  for (const [source_id, name, quantity] of [
    ["keeper_test_deck_alpha", "Test source Alpha", 2],
    ["keeper_test_deck_beta_", "Test source Beta", 1],
  ]) {
    const deck = {
      provider: "moxfield",
      source_id,
      name,
      folder: "Isolated test fixtures",
      entries: [
        {
          printing_id: printing.id,
          quantity,
          finish: "nonfoil",
          section: "mainboard",
        },
      ],
      excluded: [{ section: "maybeboard", quantity: 1 }],
      pending: [
        {
          name: "Test pending printing",
          quantity: 1,
          reason: "Synthetic review fixture",
          set: "tst",
          collector_number: "1",
          finish: "nonfoil",
        },
      ],
    };
    let preview = await api("deck-imports/preview", "POST", deck);
    await api("deck-imports", "POST", {
      ...deck,
      expected_version: preview.existing_version,
    });
    preview = await api("deck-imports/preview", "POST", deck);
    expect(preview.additions).toBe(0);
    expect(preview.unchanged).toBe(true);
    expect(
      (
        await api("deck-imports", "POST", {
          ...deck,
          expected_version: preview.existing_version,
        })
      ).unchanged,
    ).toBe(true);
  }
  rows = await api("collection");
  const compressed = await request.get(`${config.apiUrl}/api/collection`, {
    headers: { ...headers, "Accept-Encoding": "gzip" },
  });
  expect(compressed.headers()["content-encoding"]).toBe("gzip");
  expect(await compressed.json()).toEqual(rows);
  let imported = rows.find((r) => r.source_managed && r.finish === "nonfoil");
  expect(rows.find((r) => r.id === native.id).quantity).toBe(5);
  const allSources = await api("deck-imports");
  const sources = allSources.filter((d) => d.provider === "moxfield");
  const officialStored = allSources.find(
    (d) => d.source_id === official.source_id,
  );
  expect(officialStored.provider).toBe("wizards-precon");
  expect(officialStored.url).toBe(official.url);
  expect(
    rows.find((r) => r.source_managed && r.finish === "foil").quantity,
  ).toBe(1);
  expect(
    (await api("tags")).find((t) => t.id === officialStored.tag_id).source
      .provider,
  ).toBe("wizards-precon");
  const locations = sources.map((d) => ({
    tag_id: d.tag_id,
    quantity: d.lots.reduce((n, l) => n + l.allocated_quantity, 0),
  }));
  await api(`collection/${encodeURIComponent(imported.id)}`, "PATCH", {
    quantity: 2,
  });
  await api("tag-assignments", "PUT", {
    inventory_id: imported.id,
    locations,
    tag_ids: [],
  });
  await page.reload();
  await expect(page.locator(".card .allocation-warning")).toHaveText(
    "3 assigned · 2 owned",
  );
  await page
    .locator(".card")
    .filter({ has: page.locator(".allocation-warning") })
    .click();
  await page.locator("#quantity").fill("1");
  await page.getByRole("button", { name: "Save quantity" }).click();
  await expect(page.locator(".card .allocation-warning")).toHaveText(
    "3 assigned · 1 owned",
  );
  await page.reload();
  await expect(page.locator(".card .allocation-warning")).toHaveText(
    "3 assigned · 1 owned",
  );
  await page
    .locator(".card")
    .filter({ has: page.locator(".allocation-warning") })
    .click();
  await page.locator("#edit-card-tags").click();
  await page.getByRole("button", { name: "Remove location 1" }).click();
  await page.getByLabel("Copies at location 1").fill("1");
  await page.locator("#save-tags").click();
  await expect(page.locator(".card .allocation-warning")).toHaveCount(0);
  const label = `Draw ${randomUUID().slice(0, 8)}`;
  await page.locator("#manage-tags").click();
  await page.locator("#tag-type").selectOption("role");
  await page.locator("#tag-label").fill(label);
  await page.locator("#create-tag button").click();
  await expect(page.getByText("Tag created.", { exact: true })).toBeVisible();
  const role = (await api("tags")).find((t) => t.label === label);
  const otherLogin = await request.post(
    `https://cognito-idp.${config.region}.amazonaws.com/`,
    {
      headers: {
        "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
        "Content-Type": "application/x-amz-json-1.1",
      },
      data: {
        AuthFlow: "USER_PASSWORD_AUTH",
        ClientId: config.clientId,
        AuthParameters: {
          USERNAME: process.env.KEEPER_OTHER_USER,
          PASSWORD: process.env.KEEPER_OTHER_PASSWORD,
        },
      },
    },
  );
  expect(otherLogin.ok()).toBeTruthy();
  const otherHeaders = {
    Authorization: `Bearer ${(await otherLogin.json()).AuthenticationResult.IdToken}`,
  };
  expect(
    (
      await request.patch(`${config.apiUrl}/api/tags/${role.id}`, {
        headers: otherHeaders,
        data: { label: "Forbidden" },
      })
    ).status(),
  ).toBe(404);
  expect(
    await (
      await request.get(`${config.apiUrl}/api/deck-imports`, {
        headers: otherHeaders,
      })
    ).json(),
  ).toEqual([]);
  await api("tag-assignments", "PUT", {
    inventory_id: imported.id,
    locations,
    tag_ids: [role.id],
  });
  await page.getByLabel(`Rename ${label}`, { exact: true }).fill("Card Draw");
  await page
    .locator(".tag-record")
    .filter({ has: page.getByLabel(`Rename ${label}`, { exact: true }) })
    .getByRole("button", { name: "Rename", exact: true })
    .click();
  await expect(page.getByText("Tag renamed.", { exact: false })).toBeVisible();
  expect((await api("tags")).find((t) => t.id === role.id).label).toBe(
    "Card Draw",
  );
  await page
    .locator(`.tag-record[data-id="${role.id}"] a[data-tag-id]`)
    .click();
  await expect(page.locator("#tag-filter")).toHaveValue(role.id);
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(page.locator(".card")).toHaveCount(1);
  const inUse = await request.delete(`${config.apiUrl}/api/tags/${role.id}`, {
    headers,
  });
  expect(inUse.status()).toBe(409);
  await api("tag-assignments", "PUT", {
    inventory_id: imported.id,
    locations,
    tag_ids: [],
  });
  await api(`tags/${role.id}`, "DELETE");
  await api(`collection/${encodeURIComponent(imported.id)}`, "PATCH", {
    quantity: 3,
  });
  await api(`collection/${native.id}`, "DELETE");
  await page.reload();
  await page.locator("#clear-tag").click();
  await expect(page.locator("#total")).toHaveText("4");
  await expect(page.locator(".card .allocation-warning")).toHaveCount(0);
  const alpha = sources.find(
    (source) => source.source_id === "keeper_test_deck_alpha",
  );
  await page.locator(`.card a[data-tag-id="${alpha.tag_id}"]`).click();
  await expect(page.locator("#result-count")).toHaveText(
    "2 assigned copies · 1 distinct entry",
  );
  await expect(page.locator(".card-bottom b")).toHaveText("2 assigned here");
  await expect(page.locator(".owned-caption")).toHaveText(
    "3 owned across collection",
  );
  await expect(page.locator("#detail")).not.toBeVisible();
  await page.locator(".card-open").click();
  const beta = sources.find(
    (source) => source.source_id === "keeper_test_deck_beta_",
  );
  await page.locator(`#detail a[data-tag-id="${beta.tag_id}"]`).click();
  await expect(page.locator("#tag-filter")).toHaveValue(beta.tag_id);
  await expect(page.locator("#detail")).not.toBeVisible();
  await page.goBack();
  await expect(page.locator("#tag-filter")).toHaveValue(alpha.tag_id);
  await page.reload();
  await expect(page.locator("#tag-filter")).toHaveValue(alpha.tag_id);
  await expect(page.locator("#result-count")).toHaveText(
    "2 assigned copies · 1 distinct entry",
  );
  await page.locator("#manage-tags").click();
  await page.locator("#deck-sources").click();
  await expect(page.locator(".source-card")).toHaveCount(3);
  await expect(
    page.getByRole("link", { name: "Official Wizards decklist" }),
  ).toHaveAttribute("href", official.url);
  await expect(page.locator(".pending-source")).toHaveCount(2);
  await expect(
    page
      .locator(".source-card")
      .filter({
        has: page.getByRole("heading", {
          name: "Test source Alpha",
          exact: true,
        }),
      })
      .locator(".source-total"),
  ).toHaveText(
    "3 cards in source · 2 imported copies · 1 awaiting printing review",
  );
  await page.locator(`.source-card a[data-tag-id="${alpha.tag_id}"]`).click();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(page.locator("#tag-filter")).toHaveValue(alpha.tag_id);
  await expect(page.locator("#result-count")).toHaveText(
    "2 assigned copies · 1 distinct entry",
  );
  await page.locator("#sign-out").click();
});
