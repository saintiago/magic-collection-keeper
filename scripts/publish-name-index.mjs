import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
const manifest = JSON.parse(
  await readFile("build/catalog/current.json", "utf8"),
);
const bucket = process.env.WEBSITE_BUCKET;
if (!bucket || !/^[a-f0-9]{64}$/.test(manifest.version))
  throw Error(
    "Catalog publication requires the configured site bucket and validated index",
  );
let previous;
try {
  previous = JSON.parse(
    execFileSync(
      "aws",
      ["s3", "cp", `s3://${bucket}/catalog/current.json`, "-"],
      { stdio: "pipe" },
    ),
  );
} catch (error) {
  if (!String(error.stderr || "").includes("404")) throw error;
}
if (
  previous &&
  Date.parse(previous.updated_at) > Date.parse(manifest.updated_at)
) {
  console.log("A newer catalog is already published; keeping it.");
} else {
  if (
    manifest.browser?.schema !== 1 ||
    !/^[a-f0-9]{64}$/.test(manifest.browser.version)
  )
    throw Error("Validated browser index required");
  execFileSync(
    "aws",
    [
      "s3",
      "cp",
      `build/catalog/${manifest.browser.version}.names.gz`,
      `s3://${bucket}/catalog/${manifest.browser.version}.names.gz`,
      "--content-type",
      "application/gzip",
      "--cache-control",
      "public,max-age=31536000,immutable",
      "--no-progress",
    ],
    { stdio: "pipe" },
  );
  execFileSync(
    "aws",
    [
      "s3",
      "cp",
      `build/catalog/${manifest.version}.json.gz`,
      `s3://${bucket}/catalog/${manifest.version}.json.gz`,
      "--content-type",
      "application/gzip",
      "--cache-control",
      "public,max-age=31536000,immutable",
      "--no-progress",
    ],
    { stdio: "pipe" },
  );
  execFileSync(
    "aws",
    [
      "s3",
      "cp",
      "build/catalog/current.json",
      `s3://${bucket}/catalog/current.json`,
      "--content-type",
      "application/json",
      "--cache-control",
      "no-cache,no-store,must-revalidate",
      "--no-progress",
    ],
    { stdio: "pipe" },
  );
  console.log(
    `Published ${manifest.identities} English identities with catalog date ${manifest.updated_at}.`,
  );
}
