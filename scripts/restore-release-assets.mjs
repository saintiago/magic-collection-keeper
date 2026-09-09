import { readFile } from "node:fs/promises";
import { restoreVendorAssets } from "./release-assets.mjs";
const { plan, base } = JSON.parse(await readFile("build/release-plan.json"));
if (plan.mode !== "frontend")
  throw Error("Only an eligible frontend release may reuse vendor assets");
console.log(
  JSON.stringify(
    await restoreVendorAssets({
      publicRoot: "public",
      siteUrl: process.env.WEBSITE_URL,
      assets: base.assets,
    }),
  ),
);
