import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  restoreVendorAssets,
  validateVendorManifest,
} from "../scripts/release-assets.mjs";

const names = [
  "vendor/name-worker.js",
  "vendor/ort/ort.wasm.min.mjs",
  "vendor/ort/ort-wasm-simd-threaded.mjs",
  "vendor/ort/ort-wasm-simd-threaded.wasm",
  "vendor/ort/runtime.json",
  "vendor/visual/manifest.json",
];
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const bodies = new Map(names.map((path) => [path, Buffer.from("safe")]));
const visual = { schema: 1, rows: 112049, dims: 128, assets: {} };
for (const name of ["cornelius", "milo", "embeddings", "records"]) {
  const body = Buffer.from(name),
    sha256 = sha(body);
  const file =
    sha256 + (["cornelius", "milo"].includes(name) ? ".onnx" : ".gz");
  visual.assets[name] = { file, bytes: body.length, sha256 };
  bodies.set("vendor/visual/" + file, body);
}
bodies.set("vendor/visual/manifest.json", Buffer.from(JSON.stringify(visual)));
bodies.set(
  "vendor/ort/runtime.json",
  Buffer.from(
    JSON.stringify({
      version: "1.29.0",
      file: "ort-wasm-simd-threaded.wasm",
      bytes: 4,
      sha256: sha("safe"),
    }),
  ),
);
const files = [...bodies].map(([path, body]) => ({
  path,
  bytes: body.length,
  sha256: sha(body),
}));
const manifest = Buffer.from(JSON.stringify({ schema: 1, files }));
const assets = { id: "r81-a1", manifestSha256: sha(manifest) };
const responseBody = (url) =>
  bodies.get(new URL(url).pathname.replace("/releases/r81-a1/", ""));

test("DEPLOY-01/04 immutable asset reuse checks every byte before materializing a bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "keeper-reuse-"));
  try {
    const urls = [];
    const result = await restoreVendorAssets({
      publicRoot: root,
      siteUrl: "https://example.test",
      assets,
      fetch: async (url, options) => {
        urls.push(String(url));
        assert.equal(options.redirect, "error");
        return new Response(
          String(url).endsWith("vendor-manifest.json")
            ? manifest
            : responseBody(url),
        );
      },
    });
    assert.equal(result.files, files.length);
    assert.equal(result.sourceRelease, "r81-a1");
    assert.ok(
      urls.every((url) =>
        url.startsWith("https://example.test/releases/r81-a1/"),
      ),
    );
    assert.equal(await readFile(join(root, names[0]), "utf8"), "safe");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("DEPLOY-04 corrupt/missing immutable assets never leave a partial reusable bundle", async () => {
  for (const failure of ["manifest", "body", "missing"]) {
    const root = await mkdtemp(join(tmpdir(), "keeper-reuse-failure-"));
    try {
      await assert.rejects(
        restoreVendorAssets({
          publicRoot: root,
          siteUrl: "https://example.test",
          assets,
          fetch: async (url) => {
            if (String(url).endsWith("vendor-manifest.json"))
              return new Response(
                failure === "manifest" ? "corrupt" : manifest,
              );
            if (String(url).endsWith(names.at(-1)))
              return failure === "missing"
                ? new Response("", { status: 503 })
                : new Response("evil");
            return new Response(responseBody(url));
          },
        }),
        /integrity mismatch|unavailable/,
      );
      await assert.rejects(readFile(join(root, names[0])), { code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("DEPLOY-02/04 manifests reject path escapes, duplicate entries and incomplete runtimes", () => {
  for (const invalid of [
    { schema: 1, files: files.slice(1) },
    { schema: 1, files: [...files, files[0]] },
    {
      schema: 1,
      files: [...files, { ...files[0], path: "vendor/../../credentials.json" }],
    },
    {
      schema: 1,
      files: files.map((file) => ({ ...file, bytes: 100_000_001 })),
    },
  ])
    assert.throws(() => validateVendorManifest(invalid), /Invalid|Incomplete/);
});
