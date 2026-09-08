// SPDX-License-Identifier: AGPL-3.0-only
import { resolveRecognition } from "./recognition-candidates.js";
export function createBrowserRecognition({ request, enableWebGpu = false }) {
  let worker, preparation, pending, ready, metrics;
  function dispose() {
    worker?.terminate();
    worker = null;
    preparation = null;
    const error = new DOMException("Reading cancelled", "AbortError");
    pending?.reject(error);
    ready?.reject(error);
    pending = ready = null;
  }
  function prepare() {
    if (preparation) return preparation;
    worker = new Worker(new URL("./visual-worker.js", import.meta.url), {
      type: "module",
    });
    preparation = new Promise((resolve, reject) => {
      ready = { resolve, reject };
    });
    worker.onmessage = ({ data }) => {
      if (data.type === "ready") {
        metrics = data.metrics;
        ready?.resolve(metrics);
        ready = null;
      }
      if (data.type === "result") {
        pending?.resolve(data.result);
        pending = null;
      }
      if (data.type === "error") {
        const error = new Error(data.message);
        pending?.reject(error);
        ready?.reject(error);
        pending = ready = null;
        worker?.terminate();
        worker = null;
        preparation = null;
      }
    };
    worker.onerror = () => {
      pending?.reject(new Error("Visual worker failed"));
      ready?.reject(new Error("Visual worker failed"));
      pending = ready = null;
      worker?.terminate();
      worker = null;
      preparation = null;
    };
    worker.postMessage({ type: "init", enableWebGpu });
    return preparation;
  }
  return {
    kind: "browser-onnx",
    prepare,
    dispose,
    async recognize(canvas, { attempt, signal }) {
      if (pending) throw new Error("Scanner busy. Retry this card.");
      signal?.throwIfAborted();
      const cancel = () => dispose();
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        const started = performance.now();
        await prepare();
        signal?.throwIfAborted();
        const bitmap = await createImageBitmap(canvas);
        signal?.throwIfAborted();
        const result = await new Promise((resolve, reject) => {
          pending = { resolve, reject };
          worker.postMessage({ type: "frame", bitmap, attempt }, [bitmap]);
        });
        signal?.throwIfAborted();
        const row = await resolveRecognition(result, {
          request,
          signal,
          attempt,
        });
        return {
          ...row,
          measurement: {
            ...row.measurement,
            prepare: metrics,
            adapterMs: performance.now() - started,
          },
        };
      } finally {
        signal?.removeEventListener("abort", cancel);
      }
    },
  };
}
