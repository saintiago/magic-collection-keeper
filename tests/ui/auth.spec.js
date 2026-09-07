import { test, expect } from "@playwright/test";
async function cloud(page) {
  await page.route("**/config.json", (r) =>
    r.fulfill({ json: { region: "us-east-1", clientId: "test" } }),
  );
  await page.route("**/api/collection", (r) => r.fulfill({ json: [] }));
}
test("UC-01 sign-in invalid credentials, initial password challenge, sign-out", async ({
  page,
}) => {
  await cloud(page);
  let phase = 0;
  await page.route("https://cognito-idp.us-east-1.amazonaws.com/", (r) => {
    phase++;
    return r.fulfill(
      phase === 1
        ? { status: 400, json: { message: "Incorrect username or password" } }
        : phase === 2
          ? {
              json: {
                ChallengeName: "NEW_PASSWORD_REQUIRED",
                Session: "challenge",
                ChallengeParameters: { USER_ID_FOR_SRP: "test-user" },
              },
            }
          : {
              json: {
                AuthenticationResult: {
                  IdToken: "test-token",
                  RefreshToken: "refresh",
                  ExpiresIn: 3600,
                },
              },
            },
    );
  });
  await page.goto("/");
  await page.getByLabel("Username", { exact: true }).fill("test-user");
  await page.getByLabel("Password", { exact: true }).fill("incorrect");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("Incorrect username or password")).toBeVisible();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByText("Choose a new password:", { exact: false }),
  ).toBeVisible();
  await page
    .getByLabel("Password", { exact: true })
    .fill("Synthetic-test-123!");
  await page.getByRole("button", { name: "Set password & continue" }).click();
  await expect(page.locator(".auth-dialog")).toHaveCount(0);
  await page.locator("#sign-out").click();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
});
test("UC-01 expired session refresh succeeds and revoked session returns to sign-in", async ({
  page,
}) => {
  await cloud(page);
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("test-initialized")) {
      sessionStorage.setItem(
        "keeper-session",
        JSON.stringify({ IdToken: "old", RefreshToken: "refresh", expires: 0 }),
      );
      sessionStorage.setItem("test-initialized", "yes");
    }
  });
  let revoked = false;
  await page.route("https://cognito-idp.us-east-1.amazonaws.com/", (r) =>
    r.fulfill(
      revoked
        ? { status: 400, json: { message: "Revoked" } }
        : {
            json: { AuthenticationResult: { IdToken: "new", ExpiresIn: 3600 } },
          },
    ),
  );
  await page.goto("/");
  await expect(
    page.getByText("Collection is up to date.", { exact: false }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => JSON.parse(sessionStorage.getItem("keeper-session")).IdToken,
    ),
  ).toBe("new");
  revoked = true;
  await page.evaluate(() => {
    const session = JSON.parse(sessionStorage.getItem("keeper-session"));
    session.expires = 0;
    sessionStorage.setItem("keeper-session", JSON.stringify(session));
  });
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
});
