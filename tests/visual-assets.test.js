import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { verifiedAsset } from "../public/visual-assets.js";

test("public model cache survives release URLs and repairs corrupt equal-size bytes", async (t) => {
  const bytes = new Uint8Array([1, 2, 3]);
  const spec = {
    bytes: 3,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const saved = new Map();
  const cache = {
    match: async (key) => saved.get(String(key))?.clone(),
    put: async (key, response) => saved.set(String(key), response.clone()),
  };
  let downloads = 0;
  t.mock.method(globalThis, "fetch", async () => {
    downloads++;
    return new Response(bytes);
  });
  const first = await verifiedAsset(
    new URL("https://app.test/releases/one/model"),
    spec,
    cache,
  );
  assert.equal(first.hit, false);
  const second = await verifiedAsset(
    new URL("https://app.test/releases/two/model"),
    spec,
    cache,
  );
  assert.equal(second.hit, true);
  assert.equal(downloads, 1);
  saved.set([...saved.keys()][0], new Response(new Uint8Array([9, 9, 9])));
  assert.equal(
    (
      await verifiedAsset(
        new URL("https://app.test/releases/three/model"),
        spec,
        cache,
      )
    ).hit,
    false,
  );
  assert.equal(downloads, 2);
});

test("unverified runtime/model downloads never enter the cache", async (t) => {
  let writes = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(new Uint8Array([9])),
  );
  await assert.rejects(
    verifiedAsset(
      new URL("https://app.test/model"),
      { bytes: 1, sha256: "0".repeat(64) },
      { match: async () => undefined, put: async () => writes++ },
    ),
    /integrity/,
  );
  assert.equal(writes, 0);
});
