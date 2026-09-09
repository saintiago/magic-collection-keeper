import { readFile, writeFile, cp } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import {
  deploymentRelease,
  assertNewerRelease,
  packageWebsite,
} from "./release.mjs";
import { describeVendorAssets } from "./release-assets.mjs";
import { reusableRelease } from "./release-plan.mjs";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const { plan, base } = JSON.parse(await readFile("build/release-plan.json"));
if (!["full", "frontend"].includes(plan.mode))
  throw Error("Release mode must be full or frontend");
if (process.argv.includes("--package")) {
  const release = JSON.parse(await readFile("build/release.json"));
  const lambda = JSON.parse(await readFile("build/lambda-identity.json"));
  if (lambda.LastUpdateStatus !== "Successful")
    throw Error("API publication has not settled");
  if (plan.mode === "full") {
    release.api.codeSha256 = lambda.CodeSha256;
    release.recognition = JSON.parse(
      await readFile("build/backend-verification.json"),
    ).recognition;
  } else if (lambda.CodeSha256 !== release.api.codeSha256)
    throw Error("Reused API changed before packaging");
  await packageWebsite({
    source: "public",
    destination: "build/site",
    release,
    reuseAssets: plan.mode === "frontend",
  });
  const destination = `build/site/releases/${release.id}/`;
  await cp("build/frontend-source.zip", destination + "frontend-source.zip");
  if (plan.mode === "full")
    await cp(
      "build/vendor-manifest.json",
      destination + "vendor-manifest.json",
    );
  await writeFile("build/release.json", JSON.stringify(release));
  console.log("Packaged " + release.version + " with independent API identity");
} else {
  const { version } = JSON.parse(await readFile("package.json", "utf8"));
  const release = {
    ...deploymentRelease(version, process.env),
    schema: 1,
    mode: plan.mode,
  };
  const previous = await readFile("build/previous-index.html", "utf8");
  assertNewerRelease(release, previous);
  if (plan.mode === "frontend") {
    if (
      !reusableRelease(base) ||
      !previous.includes(`name="keeper-release" content="${base.id}"`)
    )
      throw Error("Published base changed; replan this deployment");
    release.api = base.api;
    release.assets = base.assets;
    release.recognition = base.recognition;
    if (hash(await readFile("public/config.json")) !== base.configSha256)
      throw Error("Configuration changed; use a full release");
  } else {
    release.api = { commit: release.commit, version: release.version };
    const vendor = await describeVendorAssets("public");
    await writeFile("build/vendor-manifest.json", vendor.bytes);
    release.assets = { id: release.id, manifestSha256: vendor.sha256 };
    if (!/^[a-f0-9]{64}$/.test(process.env.RECOGNITION_SOURCE_SHA256 || ""))
      throw Error("Corresponding recognition source digest required");
    release.recognition = {
      sourceSha256: process.env.RECOGNITION_SOURCE_SHA256,
    };
    await build({
      entryPoints: ["cloud.mjs"],
      bundle: true,
      platform: "node",
      target: "node24",
      format: "esm",
      outfile: "build/cloud.mjs",
      external: ["@aws-sdk/*"],
      define: { __KEEPER_RELEASE__: JSON.stringify(release.api) },
    });
  }
  release.configSha256 = hash(await readFile("public/config.json"));
  execFileSync(
    process.env.PYTHON || "python",
    ["scripts/frontend-source.py", "build/frontend-source.zip"],
    { stdio: "inherit" },
  );
  const source = await readFile("build/frontend-source.zip");
  release.sourceOverlay = {
    file: "frontend-source.zip",
    bytes: source.length,
    sha256: hash(source),
  };
  await writeFile("build/release.json", JSON.stringify(release));
  console.log("Prepared " + release.version + " (" + release.mode + ")");
}
