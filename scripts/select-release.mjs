import { execFileSync } from "node:child_process";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { planRelease } from "./release-plan.mjs";
import { createHash } from "node:crypto";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
let base = null,
  plan;
try {
  const origin = new URL(process.env.WEBSITE_URL);
  if (
    origin.protocol !== "https:" ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  )
    throw Error("Invalid published origin");
  const response = await fetch(new URL("/index.html", origin), {
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw Error("Published page unavailable");
  const index = await response.text();
  const id = /name="keeper-release" content="(r[1-9]\d*-a[1-9]\d*)"/.exec(
    index,
  )?.[1];
  if (!id) throw Error("Published identity unavailable");
  const metadata = await fetch(
    new URL(`/releases/${id}/version.json`, origin),
    { redirect: "error", signal: AbortSignal.timeout(15000) },
  );
  if (!metadata.ok) throw Error("Published release metadata unavailable");
  base = await metadata.json();
  if (base.id !== id || !/^[a-f0-9]{40}$/.test(base.commit || ""))
    throw Error("Invalid published commit");
  git("merge-base", "--is-ancestor", base.commit, "HEAD");
  const changedPaths = git(
    "diff",
    "--name-only",
    "--no-renames",
    base.commit,
    "HEAD",
  )
    .split("\n")
    .filter(Boolean);
  plan = planRelease({
    changedPaths,
    base,
    redeployFrontend: process.env.REDEPLOY_FRONTEND === "true",
  });
  if (plan.mode === "frontend") {
    const config = JSON.stringify({
      region: "us-east-1",
      apiUrl: process.env.API_URL,
      clientId: process.env.CLIENT_ID,
      backendRecognition: process.env.BACKEND_RECOGNITION === "true",
    });
    if (
      createHash("sha256").update(config).digest("hex") !== base.configSha256 ||
      process.env.RECOGNITION_SOURCE_SHA256 !== base.recognition.sourceSha256
    )
      plan = {
        mode: "full",
        reason: "Published configuration or recognition identity changed",
      };
  }
} catch {
  plan = {
    mode: "full",
    reason: "Published compatibility or Git ancestry could not be verified",
  };
}
if (process.env.FORCE_FULL === "true")
  plan = { mode: "full", reason: "Full release explicitly requested" };
await mkdir("build", { recursive: true });
await writeFile("build/release-plan.json", JSON.stringify({ plan, base }));
if (process.env.GITHUB_OUTPUT)
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `mode=${plan.mode}\nbase=${base?.id || ""}\n`,
  );
console.log(JSON.stringify(plan));
