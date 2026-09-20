import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const output = process.argv[2];
if (!output) throw Error("Corresponding-source output path required");
if (process.env.KEEPER_TEST_USER !== "keeper-e2e")
  throw Error("Dedicated test identity required");
if (!/^https:\/\/[^/]+$/.test(process.env.API_URL || ""))
  throw Error("Protected API origin required");
if (!/^[a-z0-9]+$/.test(process.env.CLIENT_ID || ""))
  throw Error("Cognito client ID required");
if (!/^[a-f0-9]{64}$/.test(process.env.RECOGNITION_SOURCE_SHA256 || ""))
  throw Error("Verified source SHA-256 required");

const auth = await fetch("https://cognito-idp.us-east-1.amazonaws.com/", {
  method: "POST",
  headers: {
    "Content-Type": "application/x-amz-json-1.1",
    "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
  },
  body: JSON.stringify({
    AuthFlow: "USER_PASSWORD_AUTH",
    ClientId: process.env.CLIENT_ID,
    AuthParameters: {
      USERNAME: process.env.KEEPER_TEST_USER,
      PASSWORD: process.env.KEEPER_TEST_PASSWORD,
    },
  }),
  signal: AbortSignal.timeout(15000),
});
if (!auth.ok) throw Error("Dedicated source-verification sign-in failed");
const token = (await auth.json()).AuthenticationResult?.IdToken;
if (!token) throw Error("Dedicated source-verification token unavailable");

const response = await fetch(process.env.API_URL + "/api/recognition/source", {
  headers: { Authorization: `Bearer ${token}` },
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
const source = Buffer.concat(pieces);
const digest = createHash("sha256").update(source).digest("hex");
if (
  digest !== process.env.RECOGNITION_SOURCE_SHA256 ||
  response.headers.get("x-keeper-source-sha256") !== digest
) {
  throw Error("Recognition source changed or failed integrity verification");
}
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, source);
console.log(
  `Downloaded verified corresponding source (${source.length} bytes)`,
);
