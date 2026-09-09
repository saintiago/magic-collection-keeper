// SPDX-License-Identifier: AGPL-3.0-only
import { inspectCardRegions } from "./card-regions.js";
import { loadVisualRuntime, verifiedAsset } from "./visual-assets.js";
import { normalizedPixels } from "./visual-pixels.js";
let detector,
  ort,
  busy = false;
async function initialize() {
  ort = await import("./vendor/ort/ort.wasm.min.mjs");
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = new URL("./vendor/ort/", import.meta.url).href;
  const runtime = await loadVisualRuntime();
  ort.env.wasm.wasmBinary = runtime.buffer;
  const base = new URL("./vendor/visual/", import.meta.url);
  const response = await fetch(new URL("manifest.json", base));
  if (!response.ok) throw Error("Card geometry unavailable");
  const spec = (await response.json()).assets?.cornelius;
  if (
    !spec ||
    !/^[0-9a-f]{64}\.onnx$/.test(spec.file) ||
    spec.file !== `${spec.sha256}.onnx` ||
    !(spec.bytes > 0 && spec.bytes < 10000000)
  )
    throw Error("Invalid card geometry manifest");
  let cache;
  try {
    cache = await caches.open("keeper-visual-v1");
  } catch {
    /* Visit-only. */
  }
  const loaded = await verifiedAsset(new URL(spec.file, base), spec, cache);
  detector = await ort.InferenceSession.create(loaded.buffer, {
    executionProviders: ["wasm"],
  });
  self.postMessage({ type: "ready" });
}
async function detect(frame) {
  const input = new ort.Tensor(
    "float32",
    normalizedPixels(frame, 384),
    [1, 3, 384, 384],
  );
  let outputs;
  try {
    outputs = await detector.run({ [detector.inputNames[0]]: input });
    return detector.outputNames.map((name) =>
      Float32Array.from(outputs[name].data),
    );
  } finally {
    input.dispose();
    if (outputs) for (const value of Object.values(outputs)) value.dispose();
  }
}
self.onmessage = async ({ data }) => {
  if (busy) {
    self.postMessage({ type: "error", message: "Card check busy" });
    return;
  }
  busy = true;
  try {
    if (data.type === "init") await initialize();
    else if (data.type === "frame") {
      const began = performance.now();
      const result = await inspectCardRegions(data.frame, detect);
      self.postMessage({
        type: "result",
        result: { ...result, elapsedMs: performance.now() - began },
      });
    }
  } catch {
    self.postMessage({
      type: "error",
      message: "Card geometry check unavailable",
    });
  } finally {
    busy = false;
  }
};
