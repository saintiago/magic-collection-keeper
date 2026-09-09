import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const required = [
  "vendor/name-worker.js",
  "vendor/ort/ort.wasm.min.mjs",
  "vendor/ort/ort-wasm-simd-threaded.mjs",
  "vendor/ort/ort-wasm-simd-threaded.wasm",
  "vendor/ort/runtime.json",
  "vendor/visual/manifest.json",
];
const allowed = (path) =>
  required.includes(path) ||
  /^vendor\/visual\/[a-f0-9]{64}\.(?:onnx|gz)$/.test(path);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function validateReferencedAssets(verified) {
  const byPath = new Map(verified.map((file) => [file.path, file.bytes]));
  const visual = JSON.parse(byPath.get("vendor/visual/manifest.json"));
  const runtime = JSON.parse(byPath.get("vendor/ort/runtime.json"));
  const matches = (path, spec) => {
    const bytes = byPath.get(path);
    return (
      bytes && bytes.length === spec.bytes && digest(bytes) === spec.sha256
    );
  };
  if (
    visual.schema !== 1 ||
    visual.rows !== 112049 ||
    visual.dims !== 128 ||
    ["cornelius", "milo", "embeddings", "records"].some((name) => {
      const spec = visual.assets?.[name];
      return (
        !spec ||
        !allowed("vendor/visual/" + spec.file) ||
        !matches("vendor/visual/" + spec.file, spec)
      );
    }) ||
    runtime.file !== "ort-wasm-simd-threaded.wasm" ||
    !matches("vendor/ort/" + runtime.file, runtime)
  ) {
    throw Error(
      "Immutable manifests reference missing or inconsistent model/runtime assets",
    );
  }
}

export function validateVendorManifest(manifest) {
  if (
    manifest?.schema !== 1 ||
    !Array.isArray(manifest.files) ||
    manifest.files.length < required.length ||
    manifest.files.length > 32
  ) {
    throw Error("Invalid immutable vendor manifest");
  }
  const seen = new Set();
  let total = 0;
  for (const file of manifest.files) {
    if (
      !allowed(file.path) ||
      seen.has(file.path) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes <= 0 ||
      file.bytes > 100_000_000 ||
      !/^[a-f0-9]{64}$/.test(file.sha256 || "")
    ) {
      throw Error("Invalid immutable vendor file");
    }
    total += file.bytes;
    seen.add(file.path);
  }
  if (total > 160_000_000 || required.some((path) => !seen.has(path))) {
    throw Error("Incomplete or oversized immutable vendor manifest");
  }
  return manifest;
}

export async function describeVendorAssets(publicRoot) {
  const paths = [...required];
  const visual = JSON.parse(
    await readFile(join(publicRoot, "vendor/visual/manifest.json")),
  );
  for (const spec of Object.values(visual.assets || {})) {
    const path = "vendor/visual/" + spec.file;
    if (!allowed(path)) throw Error("Invalid model asset reference");
    if (!paths.includes(path)) paths.push(path);
  }
  const files = [],
    verified = [];
  for (const path of paths.sort()) {
    const bytes = await readFile(join(publicRoot, path));
    verified.push({ path, bytes });
    files.push({ path, bytes: bytes.length, sha256: digest(bytes) });
  }
  const manifest = validateVendorManifest({ schema: 1, files });
  validateReferencedAssets(verified);
  const bytes = Buffer.from(JSON.stringify(manifest));
  return { manifest, bytes, sha256: digest(bytes) };
}

async function boundedBytes(response, maximum) {
  const parts = [];
  let size = 0;
  for await (const part of response.body) {
    size += part.length;
    if (size > maximum)
      throw Error("Published asset exceeds its declared bound");
    parts.push(part);
  }
  return Buffer.concat(parts);
}

export async function restoreVendorAssets({
  publicRoot,
  siteUrl,
  assets,
  fetch: fetchAsset = fetch,
}) {
  if (
    !/^r[1-9]\d*-a[1-9]\d*$/.test(assets?.id || "") ||
    !/^[a-f0-9]{64}$/.test(assets?.manifestSha256 || "")
  ) {
    throw Error("Verified immutable asset identity required");
  }
  const origin = new URL(siteUrl);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw Error("HTTPS site origin required for asset reuse");
  }
  const prefix = new URL(`/releases/${assets.id}/`, origin);
  const response = await fetchAsset(new URL("vendor-manifest.json", prefix), {
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw Error("Published vendor manifest unavailable");
  const bytes = await boundedBytes(response, 32000);
  if (bytes.length > 32_000 || digest(bytes) !== assets.manifestSha256) {
    throw Error("Published vendor manifest integrity mismatch");
  }
  const manifest = validateVendorManifest(JSON.parse(bytes));
  // Validate every response before writing any model/runtime file. A failed
  // reuse must never leave a partly replaced bundle available to the build.
  const verified = await Promise.all(
    manifest.files.map(async (file) => {
      const response = await fetchAsset(new URL(file.path, prefix), {
        redirect: "error",
        signal: AbortSignal.timeout(120000),
      });
      if (!response.ok)
        throw Error("Published vendor asset unavailable: " + file.path);
      const bytes = await boundedBytes(response, file.bytes);
      if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) {
        throw Error("Published vendor asset integrity mismatch: " + file.path);
      }
      return { path: file.path, bytes };
    }),
  );
  validateReferencedAssets(verified);
  for (const file of verified) {
    const target = join(publicRoot, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.bytes);
  }
  return {
    files: verified.length,
    bytes: verified.reduce((sum, file) => sum + file.bytes.length, 0),
    sourceRelease: assets.id,
  };
}
