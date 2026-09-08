import { readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import {
  deploymentRelease,
  assertNewerRelease,
  packageWebsite,
} from "./release.mjs";
const { version } = JSON.parse(await readFile("package.json", "utf8"));
const release = deploymentRelease(version, process.env);
assertNewerRelease(
  release,
  await readFile("build/previous-index.html", "utf8"),
);
await packageWebsite({ source: "public", destination: "build/site", release });
await writeFile("build/release.json", JSON.stringify(release));
await build({
  entryPoints: ["cloud.mjs"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  outfile: "build/cloud.mjs",
  external: ["@aws-sdk/*"],
  define: { __KEEPER_RELEASE__: JSON.stringify(release) },
});
console.log("Prepared " + release.version + " for " + release.commit);
