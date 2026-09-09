import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const mode = process.argv[2];
if (!["full", "frontend"].includes(mode)) throw Error("Release mode required");
const { base } = JSON.parse(await readFile("build/release-plan.json"));
const config = JSON.parse(await readFile("public/config.json"));
const expectedSource =
  mode === "frontend"
    ? base.recognition.sourceSha256
    : process.env.RECOGNITION_SOURCE_SHA256;
if (!/^[a-f0-9]{64}$/.test(expectedSource || ""))
  throw Error("Verified source SHA-256 required");
if (process.env.KEEPER_TEST_USER !== "keeper-e2e")
  throw Error("Dedicated test identity required");
const auth = await fetch("https://cognito-idp.us-east-1.amazonaws.com/", {
  method: "POST",
  headers: {
    "Content-Type": "application/x-amz-json-1.1",
    "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
  },
  body: JSON.stringify({
    AuthFlow: "USER_PASSWORD_AUTH",
    ClientId: config.clientId,
    AuthParameters: {
      USERNAME: process.env.KEEPER_TEST_USER,
      PASSWORD: process.env.KEEPER_TEST_PASSWORD,
    },
  }),
  signal: AbortSignal.timeout(15000),
});
if (!auth.ok) throw Error("Dedicated release verification sign-in failed");
const token = (await auth.json()).AuthenticationResult?.IdToken;
if (!token) throw Error("Dedicated release verification token unavailable");
const headers = { Authorization: "Bearer " + token };
const identity = await fetch(config.apiUrl + "/api/session", {
  headers,
  signal: AbortSignal.timeout(15000),
});
if (!identity.ok) throw Error("Live application identity unavailable");
const live = {
  commit: identity.headers.get("x-keeper-commit"),
  version: identity.headers.get("x-keeper-version"),
};
const lambda = JSON.parse(await readFile("build/lambda-identity.json"));
if (lambda.LastUpdateStatus !== "Successful")
  throw Error("Application update is not settled");
if (
  mode === "frontend" &&
  (live.commit !== base.api.commit ||
    live.version !== base.api.version ||
    lambda.CodeSha256 !== base.api.codeSha256)
)
  throw Error(
    "Published API compatibility changed; a full release is required",
  );
const response = await fetch(config.apiUrl + "/api/recognition/source", {
  headers,
  signal: AbortSignal.timeout(35000),
});
if (!response.ok) throw Error("Authenticated corresponding source unavailable");
const pieces = [];
let bytes = 0;
for await (const part of response.body) {
  bytes += part.length;
  if (bytes > 4_000_000) throw Error("Source archive exceeds its bound");
  pieces.push(part);
}
const source = Buffer.concat(pieces),
  sourceSha256 = createHash("sha256").update(source).digest("hex");
if (sourceSha256 !== expectedSource)
  throw Error("Recognition source changed or failed integrity verification");
const recognitionVersion = response.headers.get("x-keeper-recognition-version");
if (
  !/^[1-9]\d*$/.test(recognitionVersion || "") ||
  response.headers.get("x-keeper-source-sha256") !== sourceSha256 ||
  (mode === "frontend" && recognitionVersion !== base.recognition.version)
)
  throw Error("Published recognition identity changed or is unavailable");
if (mode === "full") await writeFile("build/recognition-source.zip", source);
await writeFile(
  "build/backend-verification.json",
  JSON.stringify({
    api: { ...live, codeSha256: lambda.CodeSha256 },
    recognition: { sourceSha256, version: recognitionVersion },
    verifiedAt: new Date().toISOString(),
  }),
);
console.log(
  "Verified live API identity and authenticated recognition source; no inventory writes",
);
