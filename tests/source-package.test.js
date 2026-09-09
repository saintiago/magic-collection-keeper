import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { downloadSourcePackage } from "../public/source-package.js";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const backend = Buffer.from("private authenticated source fixture");
const frontend = Buffer.from("exact public source fixture");
const release = {
  id: "r91-a1",
  commit: "a".repeat(40),
  version: "0.1.0+deploy.91.1",
  api: { commit: "b".repeat(40), version: "0.1.0+deploy.90.1" },
  recognition: { sourceSha256: digest(backend), version: "14" },
  sourceOverlay: {
    file: "frontend-source.zip",
    bytes: frontend.length,
    sha256: digest(frontend),
  },
};
const options = {
  release,
  api: async () => new Blob([backend]),
  fetch: async () => new Response(frontend),
};

test("DEPLOY-04 independent tarfile decoder verifies exact source entries and independent identities", async () => {
  const result = await downloadSourcePackage(options);
  assert.equal(result.filename, "keeper-source-r91-a1.tar");
  const decoded = spawnSync(
    process.env.PYTHON || "python",
    [
      "-c",
      "import sys,tarfile,io,json,base64; a=tarfile.open(fileobj=io.BytesIO(sys.stdin.buffer.read())); print(json.dumps({m.name:base64.b64encode(a.extractfile(m).read()).decode() for m in a.getmembers()}))",
    ],
    { input: Buffer.from(await result.blob.arrayBuffer()), encoding: "utf8" },
  );
  assert.equal(decoded.status, 0, decoded.stderr);
  const entries = Object.fromEntries(
    Object.entries(JSON.parse(decoded.stdout)).map(([name, data]) => [
      name,
      Buffer.from(data, "base64"),
    ]),
  );
  assert.deepEqual(Object.keys(entries), [
    "README.txt",
    "deployment.json",
    "backend-source.zip",
    "frontend-source.zip",
  ]);
  assert.deepEqual(entries["backend-source.zip"], backend);
  assert.deepEqual(entries["frontend-source.zip"], frontend);
  const manifest = JSON.parse(entries["deployment.json"]);
  assert.equal(manifest.frontend.commit, release.commit);
  assert.deepEqual(manifest.api, release.api);
  assert.match(entries["README.txt"].toString(), /including removed files/);
});

test("DEPLOY-04 corrupt, oversized, missing and aborted source downloads cannot produce a bundle", async () => {
  for (const change of [
    { fetch: async () => new Response("corrupt") },
    { fetch: async () => new Response(Buffer.alloc(frontend.length + 1)) },
    { fetch: async () => new Response("missing", { status: 404 }) },
    { api: async () => new Blob(["wrong backend"]) },
    {
      release: {
        ...release,
        sourceOverlay: { ...release.sourceOverlay, bytes: 4_000_001 },
      },
    },
  ])
    await assert.rejects(downloadSourcePackage({ ...options, ...change }));
  const controller = new AbortController();
  await assert.rejects(
    downloadSourcePackage({
      ...options,
      signal: controller.signal,
      api: async () => {
        controller.abort();
        return new Blob([backend]);
      },
    }),
    { name: "AbortError" },
  );
  let called = false;
  await assert.rejects(
    downloadSourcePackage({
      ...options,
      signal: controller.signal,
      api: async () => {
        called = true;
      },
    }),
    { name: "AbortError" },
  );
  assert.equal(called, false);
  assert.equal(
    (await downloadSourcePackage({ ...options, release: {} })).filename,
    "keeper-recognition-source.zip",
  );
});
