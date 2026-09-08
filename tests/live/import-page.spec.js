import { test, expect } from "@playwright/test";
test("LIVE-06 durable import edits stay out of owned inventory and the real AWS Moxfield provider reports its access result", async ({
  page,
  request,
}) => {
  test.setTimeout(180000);
  expect(process.env.KEEPER_IMPORT_USER).toBe("keeper-import");
  await page.goto("/#import");
  await page
    .getByLabel("Username", { exact: true })
    .fill(process.env.KEEPER_IMPORT_USER);
  await page
    .getByLabel("Password", { exact: true })
    .fill(process.env.KEEPER_IMPORT_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".auth-dialog")).toHaveCount(0);
  const config = await (
    await request.get(`${process.env.LIVE_URL}/config.json`)
  ).json();
  const token = await page.evaluate(
    () => JSON.parse(sessionStorage.getItem("keeper-session")).IdToken,
  );
  const headers = { Authorization: `Bearer ${token}` };
  const api = async (path, options = {}) => {
    const result = await request.fetch(`${config.apiUrl}/api/${path}`, {
      headers,
      ...options,
    });
    expect(result.ok(), `${path}: ${await result.text()}`).toBeTruthy();
    return result.json();
  };
  const before = await api("collection"),
    sources = await api("deck-imports"),
    tags = await api("tags");
  expect(tags.every((t) => t.family !== "system" && t.type !== "system")).toBe(
    true,
  );
  const saved = await api("import-draft");
  expect(saved.draft.name).toBe("Synthetic persistent import fixture");
  await expect(page.locator(".draft-row")).toHaveCount(2);
  await page.getByLabel("Quantity for line 1", { exact: true }).fill("98");
  await page.getByLabel("Quantity for line 1", { exact: true }).press("Tab");
  await expect(page.locator("#draft-add")).toBeEnabled();
  await page.reload();
  await expect(
    page.getByLabel("Quantity for line 1", { exact: true }),
  ).toHaveValue("98");
  expect(await api("collection")).toEqual(before);
  expect(await api("deck-imports")).toEqual(sources);
  expect(await api("tags")).toEqual(tags);
  await page.getByLabel("Quantity for line 1", { exact: true }).fill("99");
  await page.getByLabel("Quantity for line 1", { exact: true }).press("Tab");
  await expect(page.locator("#draft-add")).toBeEnabled();
  const reserved = await request.post(`${config.apiUrl}/api/tags`, {
    headers,
    data: { label: "system:import-pending", type: "role", kind: "role" },
  });
  expect(reserved.status()).toBe(400);
  await page.locator("#sign-out").click();
  await expect(page.locator(".auth-dialog")).toHaveCount(1);
  // Probe via the deployed Lambda in the separate empty profile, never using
  // browser cookies for Moxfield. Its real denial is not a mocked success.
  await page
    .getByLabel("Username", { exact: true })
    .fill(process.env.KEEPER_TEST_USER);
  await page
    .getByLabel("Password", { exact: true })
    .fill(process.env.KEEPER_TEST_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".auth-dialog")).toHaveCount(0);
  await expect(page.locator(".draft-row")).toHaveCount(0);
  const otherToken = await page.evaluate(
    () => JSON.parse(sessionStorage.getItem("keeper-session")).IdToken,
  );
  const otherHeaders = { Authorization: `Bearer ${otherToken}` };
  const foreign = await request.post(
    `${config.apiUrl}/api/import-draft/clear`,
    {
      headers: otherHeaders,
      data: { id: saved.draft.id, version: saved.draft.version },
    },
  );
  expect(foreign.status()).toBe(409);
  const invalid = await request.post(
    `${config.apiUrl}/api/import-draft/fetch`,
    {
      headers: otherHeaders,
      data: { url: "https://127.0.0.1/decks/keeper_import_live_v1" },
    },
  );
  expect(invalid.status()).toBe(400);
  const result = await request.post(`${config.apiUrl}/api/import-draft/fetch`, {
    headers: otherHeaders,
    data: { url: "https://moxfield.com/decks/4RSndNojl0u5z1fVrFhnkg" },
  });
  const body = await result.json();
  console.log(
    JSON.stringify({
      liveMoxfieldStatus: result.status(),
      error: body.error || null,
      realAwsRequest: true,
    }),
  );
  if (result.ok()) {
    expect(body.draft.provider).toBe("moxfield");
    await request.post(`${config.apiUrl}/api/import-draft/clear`, {
      headers: otherHeaders,
      data: { id: body.draft.id, version: body.draft.version },
    });
  } else {
    expect([403, 404, 429, 502, 503]).toContain(result.status());
    expect(body.error).toMatch(/Moxfield/);
  }
  expect(
    await (
      await request.get(`${config.apiUrl}/api/collection`, {
        headers: otherHeaders,
      })
    ).json(),
  ).toEqual([]);
  await page.locator("#sign-out").click();
});
