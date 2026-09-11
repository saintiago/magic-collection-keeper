// Only geometry; never searches names, artwork, ownership or a provider.
export function createCardPresence() {
  let worker, preparation, ready, pending, analysisCanvas;
  function dispose() {
    worker?.terminate();
    worker = null;
    preparation = null;
    const error = new DOMException("Card check cancelled", "AbortError");
    ready?.reject(error);
    pending?.reject(error);
    ready = pending = null;
    analysisCanvas = null;
  }
  function prepare() {
    if (preparation) return preparation;
    const created = new Worker(
      new URL("./card-presence-worker.js", import.meta.url),
      { type: "module" },
    );
    worker = created;
    preparation = new Promise((resolve, reject) => {
      ready = { resolve, reject };
    });
    const failed = () => {
      if (worker !== created) return;
      const error = Error("Card geometry check unavailable. Reload and retry.");
      ready?.reject(error);
      pending?.reject(error);
      ready = pending = null;
      created.terminate();
      worker = preparation = null;
    };
    created.onerror = failed;
    created.onmessage = ({ data }) => {
      if (worker !== created) return;
      if (data.type === "ready") {
        ready?.resolve();
        ready = null;
      } else if (data.type === "result") {
        pending?.resolve(data.result);
        pending = null;
      } else if (data.type === "error") failed();
    };
    created.postMessage({ type: "init" });
    return preparation;
  }
  return {
    prepare,
    dispose,
    async inspect(canvas, { signal } = {}) {
      signal?.throwIfAborted();
      const abort = () => dispose();
      signal?.addEventListener("abort", abort, { once: true });
      try {
        if (pending) throw Error("Card check busy");
        const small = (analysisCanvas ||= document.createElement("canvas"));
        if (small.width !== 384) small.width = 384;
        if (small.height !== 384) small.height = 384;
        const context = small.getContext("2d", { willReadFrequently: true });
        context.drawImage(canvas, 0, 0, 384, 384);
        const frame = context.getImageData(0, 0, 384, 384);
        // Snapshot before waiting: the caller may reuse its analysis surface.
        await prepare();
        signal?.throwIfAborted();
        if (pending) throw Error("Card check busy");
        return await new Promise((resolve, reject) => {
          pending = { resolve, reject };
          worker.postMessage(
            {
              type: "frame",
              frame: { width: 384, height: 384, data: frame.data },
            },
            [frame.data.buffer],
          );
        });
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    },
  };
}
