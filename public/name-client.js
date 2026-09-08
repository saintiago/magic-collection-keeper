export function createNameClient({
  api,
  makeWorker = () =>
    new Worker(new URL("./vendor/name-worker.js", import.meta.url), {
      type: "module",
    }),
}) {
  let worker,
    ready = false,
    version = "",
    nextId = 0;
  const pending = new Map();
  const metric = (data) =>
    window.dispatchEvent(
      new CustomEvent("keeper-search-metric", { detail: data }),
    );
  function fail() {
    ready = false;
    worker?.terminate();
    worker = null;
    for (const p of pending.values()) p.reject(Error("Worker unavailable"));
    pending.clear();
  }
  try {
    worker = makeWorker();
    worker.onerror = fail;
    worker.onmessageerror = fail;
    worker.onmessage = ({ data }) => {
      if (data.type === "state") {
        ready = data.ready;
        version = data.version || "";
        metric({ phase: "state", ...data });
      }
      if (data.type === "metric") metric(data);
      if (data.type === "result") {
        const p = pending.get(data.id);
        if (!p) return;
        pending.delete(data.id);
        data.error
          ? p.reject(Error("Names unavailable"))
          : p.resolve(data.result);
      }
    };
    worker.postMessage({ type: "start" });
  } catch {
    fail();
  }
  return {
    get ready() {
      return ready;
    },
    get version() {
      return version;
    },
    async suggest(query, { signal } = {}) {
      if (!ready) worker?.postMessage({ type: "check" });
      if (ready && worker)
        try {
          const id = ++nextId;
          const result = await new Promise((resolve, reject) => {
            const timer = setTimeout(
              () => finish(reject, Error("Worker search timed out")),
              1500,
            );
            const abort = () =>
              finish(reject, signal.reason || Error("Aborted"));
            function finish(fn, value) {
              clearTimeout(timer);
              signal?.removeEventListener("abort", abort);
              pending.delete(id);
              fn(value);
            }
            pending.set(id, {
              resolve: (v) => finish(resolve, v),
              reject: (e) => finish(reject, e),
            });
            if (signal?.aborted) return abort();
            signal?.addEventListener("abort", abort, { once: true });
            worker.postMessage({ type: "query", id, query });
          });
          metric(result.timing);
          return result;
        } catch {
          if (signal?.aborted) throw signal.reason;
        }
      const t = performance.now();
      const result = await api(
        `/api/suggest?${new URLSearchParams({ q: query })}`,
        { signal },
      );
      metric({ phase: "server-suggest", ms: performance.now() - t });
      if (result.timing) metric(result.timing);
      return result;
    },
    stop: fail,
  };
}
