import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { verifySourceDownload } from "../helpers/source-bundle.js";
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
  const expectedCommit =
    process.env.KEEPER_VERIFY_COMMIT || process.env.GITHUB_SHA;
  if (expectedCommit) expect(metadata.commit).toBe(expectedCommit);
  const explicitRelease = process.env.KEEPER_VERIFY_RELEASE;
  const explicitParts = explicitRelease?.match(/^r([1-9]\d*)-a([1-9]\d*)$/);
  if (explicitRelease) {
    expect(explicitParts).not.toBeNull();
    expect(id).toBe(explicitRelease);
  }
  const { version: baseVersion } = JSON.parse(
    await readFile("package.json", "utf8"),
  );
  const runNumber = explicitParts?.[1] || process.env.GITHUB_RUN_NUMBER;
  const runAttempt = explicitParts?.[2] || process.env.GITHUB_RUN_ATTEMPT;
  if (runNumber)
    expect(metadata.version).toBe(
      `${baseVersion}+deploy.${runNumber}.${runAttempt}`,
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
  expect(identity.headers()["x-keeper-version"]).toBe(
    metadata.api?.version || metadata.version,
  );
  expect(identity.headers()["x-keeper-commit"]).toBe(
    metadata.api?.commit || metadata.commit,
  );
  // Read-only test identity; close the sign-in modal to inspect public release details.
  await page.evaluate(() => document.querySelector(".auth-dialog").close());
  await page.locator("#app-version").click();
  await expect(
    page.getByText("Commit: " + metadata.commit, { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close about" }).click();
  await expect(page.locator(".release-dialog")).toHaveCount(0);
  if (metadata.sourceOverlay) {
    // Use the already authenticated read-only identity; no inventory mutations.
    const blob = await page.evaluate(
      async ({ token, config, metadata }) => {
        const module = document.querySelector('script[type="module"]').src;
        const { downloadSourcePackage } = await import(
          new URL("source-package.js", module).href
        );
        const result = await downloadSourcePackage({
          release: metadata,
          api: async (path) => {
            const r = await fetch(config.apiUrl + path, {
              headers: { Authorization: "Bearer " + token },
            });
            if (!r.ok) throw Error("Authenticated source download failed");
            return r.blob();
          },
        });
        const bytes = new Uint8Array(await result.blob.arrayBuffer());
        let binary = "";
        for (let i = 0; i < bytes.length; i += 8192)
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        return btoa(binary);
      },
      { token: AuthenticationResult.IdToken, config, metadata },
    );
    verifySourceDownload(
      Buffer.from(blob, "base64"),
      metadata,
      process.env.RECOGNITION_SOURCE_SHA256,
    );
  }
});
