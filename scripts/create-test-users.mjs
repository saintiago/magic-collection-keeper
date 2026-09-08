import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
const out = JSON.parse(readFileSync("infra/outputs.json"));
const credentials = {};
const profiles = [
  ["TEST", "keeper-e2e"],
  ["OTHER", "keeper-isolation"],
  ["TAGS", "keeper-tags"],
  ["IMPORT", "keeper-import"],
];
const only = process.argv.includes("--only")
  ? process.argv[process.argv.indexOf("--only") + 1]
  : null;
if (
  process.argv.includes("--only") &&
  !profiles.some(([, name]) => name === only)
)
  throw new Error("Only reserved test profiles may be created or rotated.");
mkdirSync(".local-secrets", { recursive: true });
for (const [label, username] of profiles.filter(
  ([, name]) => !only || name === only,
)) {
  const password = `K!8a${randomBytes(24).toString("base64url")}`;
  const input = {
    UserPoolId: out.UserPoolId,
    Username: username,
    MessageAction: "SUPPRESS",
    UserAttributes: [
      { Name: "email", Value: `${username}@example.invalid` },
      { Name: "email_verified", Value: "true" },
    ],
  };
  writeFileSync(".local-secrets/user-input.json", JSON.stringify(input));
  try {
    execFileSync(
      "aws",
      [
        "cognito-idp",
        "admin-create-user",
        "--cli-input-json",
        "file://.local-secrets/user-input.json",
      ],
      { stdio: "pipe" },
    );
  } catch (e) {
    if (!e.stderr?.toString().includes("UsernameExistsException")) throw e;
  }
  writeFileSync(
    ".local-secrets/user-input.json",
    JSON.stringify({
      UserPoolId: out.UserPoolId,
      Username: username,
      Password: password,
      Permanent: true,
    }),
  );
  execFileSync(
    "aws",
    [
      "cognito-idp",
      "admin-set-user-password",
      "--cli-input-json",
      "file://.local-secrets/user-input.json",
    ],
    { stdio: "pipe" },
  );
  execFileSync("gh", ["secret", "set", `KEEPER_${label}_USER`], {
    input: username,
    stdio: ["pipe", "pipe", "pipe"],
  });
  execFileSync("gh", ["secret", "set", `KEEPER_${label}_PASSWORD`], {
    input: password,
    stdio: ["pipe", "pipe", "pipe"],
  });
  credentials[`KEEPER_${label}_USER`] = username;
  credentials[`KEEPER_${label}_PASSWORD`] = password;
}
unlinkSync(".local-secrets/user-input.json");
writeFileSync(".local-secrets/credentials.json", JSON.stringify(credentials), {
  mode: 0o600,
});
console.log(
  "Reserved test identities configured with suppressed email; credentials stored in GitHub Actions secrets and ignored local test file.",
);
