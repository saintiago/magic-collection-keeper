import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
test("LIVE-05 published HTML, loaded assets and API identify the deployment", async ({
  page,
  request,
}) => {
  const response = await page.goto("/#collection");
  expect(response.headers()["cache-control"]).toContain("no-store");
  const id = await page
    .locator('meta[name="keeper-release"]')
    .getAttribute("content");
  expect(id).toMatch(/^r\d+-a\d+$/);
  const prefix = "/releases/" + id + "/";
  await expect(page.locator('script[type="module"]')).toHaveAttribute(
    "src",
    prefix + "app.js",
  );
  const metadataResponse = await request.get(
    process.env.LIVE_URL + prefix + "version.json",
  );
  expect(metadataResponse.headers()["cache-control"]).toContain("immutable");
  const metadata = await metadataResponse.json();
  if (process.env.GITHUB_SHA)
    expect(metadata.commit).toBe(process.env.GITHUB_SHA);
  const { version: baseVersion } = JSON.parse(
    await readFile("package.json", "utf8"),
  );
  if (process.env.GITHUB_RUN_NUMBER)
    expect(metadata.version).toBe(
      `${baseVersion}+deploy.${process.env.GITHUB_RUN_NUMBER}.${process.env.GITHUB_RUN_ATTEMPT}`,
    );
  await expect(page.locator("#app-version")).toHaveText(
    "App " + metadata.version,
  );
  const config = await (
    await request.get(process.env.LIVE_URL + prefix + "config.json")
  ).json();
  const signIn = await request.post(
    "https://cognito-idp.us-east-1.amazonaws.com/",
    {
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
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
  const { AuthenticationResult } = await signIn.json();
  expect(Boolean(AuthenticationResult?.IdToken)).toBe(true);
  const identity = await request.get(config.apiUrl + "/api/session", {
    headers: { Authorization: "Bearer " + AuthenticationResult.IdToken },
  });
  expect(identity.ok()).toBe(true);
  expect(identity.headers()["x-keeper-version"]).toBe(metadata.version);
  expect(identity.headers()["x-keeper-commit"]).toBe(metadata.commit);
  // Read-only test identity; close the sign-in modal to inspect public release details.
  await page.evaluate(() => document.querySelector(".auth-dialog").close());
  await page.locator("#app-version").click();
  await expect(
    page.getByText("Commit: " + metadata.commit, { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close about" }).click();
  await expect(page.locator(".release-dialog")).toHaveCount(0);
});
