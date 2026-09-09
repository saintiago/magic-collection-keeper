import { execFileSync } from "node:child_process";
import { readFile, appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const awsCommand = (...args) =>
  execFileSync("aws", args, { encoding: "utf8", maxBuffer: 4_000_000 }).trim();
export async function publishFrontend({
  release,
  base,
  bucket,
  distribution,
  rollback = false,
  previousIndex,
  aws = awsCommand,
  published = async () => {},
}) {
  if (
    !/^[a-z0-9][a-z0-9.-]{2,62}$/.test(bucket || "") ||
    !/^E[A-Z0-9]+$/.test(distribution || "")
  )
    throw Error("Configured publication resources required");
  if (
    release.mode !== "frontend" ||
    release.api.codeSha256 !== base.api.codeSha256
  )
    throw Error("Only compatible frontend publication is allowed");
  const marker = (html) =>
    /name="keeper-release" content="([^"]+)"/.exec(html)?.[1];
  function check(expected) {
    const html = aws(
      "s3",
      "cp",
      `s3://${bucket}/index.html`,
      "-",
      "--no-progress",
    );
    if (marker(html) !== expected)
      throw Error(
        "Published frontend changed; refusing to overwrite another release",
      );
    const metadata = JSON.parse(
      aws(
        "s3",
        "cp",
        `s3://${bucket}/releases/${base.id}/version.json`,
        "-",
        "--no-progress",
      ),
    );
    if (JSON.stringify(metadata) !== JSON.stringify(base))
      throw Error("Immutable base metadata changed");
    const live = JSON.parse(
      aws(
        "lambda",
        "get-function-configuration",
        "--function-name",
        "magic-collection-keeper",
        "--query",
        "{CodeSha256:CodeSha256,LastUpdateStatus:LastUpdateStatus}",
      ),
    );
    if (
      live.CodeSha256 !== base.api.codeSha256 ||
      live.LastUpdateStatus !== "Successful"
    )
      throw Error("Live backend changed; publication stopped");
  }
  check(rollback ? release.id : base.id);
  if (!rollback) {
    aws(
      "s3",
      "sync",
      `build/site/releases/${release.id}/`,
      `s3://${bucket}/releases/${release.id}/`,
      "--cache-control",
      "public,max-age=31536000,immutable",
      "--no-progress",
    );
    check(base.id);
  } else if (marker(previousIndex) !== base.id)
    throw Error("Rollback page does not match verified base");
  aws(
    "s3",
    "cp",
    rollback ? "build/previous-index.html" : "build/site/index.html",
    `s3://${bucket}/index.html`,
    "--cache-control",
    "no-cache,no-store,must-revalidate",
    "--content-type",
    "text/html",
    "--no-progress",
  );
  if (!rollback) await published();
  const invalidation = aws(
    "cloudfront",
    "create-invalidation",
    "--distribution-id",
    distribution,
    "--paths",
    "/",
    "/index.html",
    "--query",
    "Invalidation.Id",
    "--output",
    "text",
  );
  aws(
    "cloudfront",
    "wait",
    "invalidation-completed",
    "--distribution-id",
    distribution,
    "--id",
    invalidation,
  );
  console.log(
    rollback
      ? "Restored previous frontend; backend and model assets were unchanged"
      : "Published frontend only; backend and model assets were unchanged",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await publishFrontend({
    release: JSON.parse(await readFile("build/release.json")),
    base: JSON.parse(await readFile("build/release-plan.json")).base,
    bucket: process.env.BUCKET,
    distribution: process.env.DISTRIBUTION,
    rollback: process.argv.includes("--rollback"),
    previousIndex: await readFile("build/previous-index.html", "utf8"),
    published: async () => {
      if (process.env.GITHUB_OUTPUT)
        await appendFile(process.env.GITHUB_OUTPUT, "published=true\n");
    },
  });
}
