import { mkdir, cp, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { build } from "esbuild";
await mkdir("public/vendor/ort", { recursive: true });
for (const name of [
  "ort.wasm.min.mjs",
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.wasm",
]) {
  await cp(
    `node_modules/onnxruntime-web/dist/${name}`,
    `public/vendor/ort/${name}`,
  );
}
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
  entryPoints: ["cloud.mjs"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  outfile: "build/cloud.mjs",
  external: ["@aws-sdk/*"],
});
console.log("Verified browser runtime and Lambda package built.");
