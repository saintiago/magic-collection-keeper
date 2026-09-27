// SPDX-License-Identifier: AGPL-3.0-only
import { resolveRecognition } from "./recognition-candidates.js";
export function createBrowserRecognition({ request }) {
  let worker,
    preparation,
    pending,
    ready,
    metrics,
    active = false,
    initialized = false;
  const cache = new Map();
  function dispose() {
    worker?.terminate();
    worker = null;
    preparation = null;
    initialized = false;
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
    const created = worker;
    worker.onmessage = ({ data }) => {
      if (worker !== created) return;
      if (data.type === "ready") {
        initialized = true;
        metrics = data.metrics;
        ready?.resolve(metrics);
        ready = null;
      }
      if (data.type === "result") {
        pending?.onStage?.({ stage: "visual", active: false });
        pending?.resolve(data.result);
        pending = null;
      }
      if (data.type === "stage" && pending?.attempt === data.attempt)
        pending.onStage?.({ stage: data.stage, active: data.active });
      if (data.type === "error") {
        const error = new Error(data.message);
        pending?.reject(error);
        ready?.reject(error);
        pending = ready = null;
        worker?.terminate();
        worker = null;
        preparation = null;
        initialized = false;
      }
    };
    worker.onerror = () => {
      if (worker !== created) return;
      pending?.reject(new Error("Visual worker failed"));
      ready?.reject(new Error("Visual worker failed"));
      pending = ready = null;
      worker?.terminate();
      worker = null;
      preparation = null;
      initialized = false;
    };
    worker.postMessage({ type: "init" });
    return preparation;
  }
  return {
    kind: "browser-onnx",
    prepare,
    dispose,
    async recognize(canvas, { attempt, signal, onStage }) {
      if (active) throw new Error("Scanner busy. Retry this card.");
      signal?.throwIfAborted();
      active = true;
      const cancel = () => dispose();
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        const started = performance.now(),
          modelsReused = initialized;
        await prepare();
        const preparationWaitMs = performance.now() - started;
        signal?.throwIfAborted();
        const pixels = canvas
          .getContext("2d", { willReadFrequently: true })
          .getImageData(0, 0, canvas.width, canvas.height);
        signal?.throwIfAborted();
        const result = await new Promise((resolve, reject) => {
          pending = { resolve, reject, attempt, onStage };
          worker.postMessage(
            {
              type: "frame",
              frame: {
                width: pixels.width,
                height: pixels.height,
                data: pixels.data,
              },
              attempt,
            },
            [pixels.data.buffer],
          );
        });
        signal?.throwIfAborted();
        const row = await resolveRecognition(result, {
          request,
          signal,
          attempt,
          cache,
        });
        return {
          ...row,
          measurement: {
            ...row.measurement,
            prepare: metrics,
            modelsReused,
            preparationWaitMs,
            adapterMs: performance.now() - started,
          },
        };
      } finally {
        active = false;
        signal?.removeEventListener("abort", cancel);
      }
    },
  };
}
