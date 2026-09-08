import { mkdir, cp, writeFile, access } from "node:fs/promises";
import { build } from "esbuild";
await mkdir("public/vendor/core", { recursive: true });
await mkdir("public/vendor/lang", { recursive: true });
await build({
  entryPoints: ["public/name-worker-entry.js"],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: "public/vendor/name-worker.js",
  minify: true,
});
await build({
  stdin: {
    contents: "export { createWorker } from 'tesseract.js';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: "public/vendor/ocr.js",
  minify: true,
});
await cp(
  "node_modules/tesseract.js/dist/worker.min.js",
  "public/vendor/worker.min.js",
);
await cp("node_modules/tesseract.js-core", "public/vendor/core", {
  recursive: true,
});
const lang = "public/vendor/lang/eng.traineddata.gz";
try {
  await access(lang);
} catch {
  const r = await fetch(
    "https://tessdata.projectnaptha.com/4.0.0/eng.traineddata.gz",
  );
  if (!r.ok) throw new Error("Could not download OCR English model");
  await writeFile(lang, Buffer.from(await r.arrayBuffer()));
}
await build({
  entryPoints: ["cloud.mjs"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  outfile: "build/cloud.mjs",
  external: ["@aws-sdk/*"],
});
console.log("Frontend OCR assets and Lambda package built.");
