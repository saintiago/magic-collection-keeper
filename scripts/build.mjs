import { mkdir, cp, writeFile, access, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { build } from "esbuild";
await mkdir("public/vendor/core", { recursive: true });
await mkdir("public/vendor/ort", { recursive: true });
for (const name of [
  "ort.webgpu.min.mjs",
  "ort.wasm.min.mjs",
  "ort-wasm-simd-threaded.asyncify.mjs",
  "ort-wasm-simd-threaded.asyncify.wasm",
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.wasm",
]) {
  await cp(
    `node_modules/onnxruntime-web/dist/${name}`,
    `public/vendor/ort/${name}`,
  );
}
await mkdir("public/vendor/lang", { recursive: true });
const runtimeFile = "ort-wasm-simd-threaded.wasm";
const runtimeBytes = await readFile(`public/vendor/ort/${runtimeFile}`);
await writeFile(
  "public/vendor/ort/runtime.json",
  JSON.stringify({
    version: "1.29.0",
    file: runtimeFile,
    bytes: runtimeBytes.length,
    sha256: createHash("sha256").update(runtimeBytes).digest("hex"),
  }),
);
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
