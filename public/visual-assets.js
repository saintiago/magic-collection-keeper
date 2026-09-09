// SPDX-License-Identifier: AGPL-3.0-only
const base = new URL("./vendor/visual/", import.meta.url);
async function digest(buffer) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", buffer))]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
export async function verifiedAsset(url, spec, cache) {
  const key = new URL(`/__keeper_visual_cache/${spec.sha256}`, url);
  let buffer,
    hit = false;
  try {
    const saved = await cache?.match(key);
    if (saved) {
      buffer = await saved.arrayBuffer();
      hit =
        buffer.byteLength === spec.bytes &&
        (await digest(buffer)) === spec.sha256;
    }
  } catch {
    /* Corrupt or evicted public cache entries are repaired. */
  }
  if (!hit) {
    const result = await fetch(url);
    if (!result.ok) throw new Error("Visual asset download failed");
    buffer = await result.arrayBuffer();
    if (
      buffer.byteLength !== spec.bytes ||
      (await digest(buffer)) !== spec.sha256
    )
      throw new Error("Visual asset integrity check failed");
    try {
      await cache?.put(key, new Response(buffer));
    } catch {
      /* Visit-only. */
    }
  }
  return { buffer, hit };
}

export async function loadVisualRuntime() {
  const base = new URL("./vendor/ort/", import.meta.url);
  const response = await fetch(new URL("runtime.json", base));
  if (!response.ok) throw new Error("Visual runtime unavailable");
  const spec = await response.json();
  if (
    spec.version !== "1.29.0" ||
    spec.file !== "ort-wasm-simd-threaded.wasm" ||
    !/^[0-9a-f]{64}$/.test(spec.sha256) ||
    !(spec.bytes > 0 && spec.bytes < 40000000)
  )
    throw new Error("Unsupported visual runtime");
  let cache;
  try {
    cache = await caches.open("keeper-visual-v1");
  } catch {
    /* Visit-only. */
  }
  const started = performance.now();
  const { buffer, hit } = await verifiedAsset(
    new URL(spec.file, base),
    spec,
    cache,
  );
  return {
    buffer,
    metrics: {
      runtimeDownloadBytes: hit ? 0 : buffer.byteLength,
      runtimeCacheBytes: hit ? buffer.byteLength : 0,
      runtimeLoadMs: performance.now() - started,
    },
  };
}
export async function loadVisualAssets(onProgress) {
  const response = await fetch(new URL("manifest.json", base));
  if (!response.ok) throw new Error("Visual models unavailable");
  const manifest = await response.json();
  if (
    manifest.schema !== 1 ||
    manifest.rows !== 112049 ||
    manifest.dims !== 128
  )
    throw new Error("Unsupported visual catalog");
  let cache;
  try {
    cache = await caches.open("keeper-visual-v1");
  } catch {
    /* Visit-only cache. */
  }
  const assets = {},
    metrics = { downloadBytes: 0, cacheBytes: 0, assetMs: 0 };
  const started = performance.now();
  for (const name of ["cornelius", "milo", "embeddings", "records"]) {
    const spec = manifest.assets[name];
    if (
      !spec ||
      !/^[0-9a-f]{64}\.(onnx|gz)$/.test(spec.file) ||
      spec.file.split(".")[0] !== spec.sha256 ||
      !(spec.bytes > 0 && spec.bytes < 40000000)
    )
      throw new Error("Invalid visual asset manifest");
    const url = new URL(spec.file, base);
    let { buffer, hit } = await verifiedAsset(url, spec, cache);
    metrics[hit ? "cacheBytes" : "downloadBytes"] += buffer.byteLength;
    onProgress?.({ stage: name, cached: hit, bytes: buffer.byteLength });
    if (spec.file.endsWith(".gz")) {
      buffer = await new Response(
        new Blob([buffer])
          .stream()
          .pipeThrough(new DecompressionStream("gzip")),
      ).arrayBuffer();
    }
    assets[name] =
      name === "records"
        ? JSON.parse(new TextDecoder().decode(buffer))
        : buffer;
  }
  if (
    assets.embeddings.byteLength !== manifest.rows * manifest.dims * 2 ||
    assets.records.length !== manifest.rows
  )
    throw new Error("Visual catalog rows do not match");
  metrics.assetMs = performance.now() - started;
  return { assets, manifest, metrics };
}
