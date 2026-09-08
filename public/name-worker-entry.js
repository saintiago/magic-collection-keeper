import { createWorkerCatalog } from "./name-worker-runtime.js";
const catalog = createWorkerCatalog({
  emit: (message) => postMessage(message),
});
self.onmessage = ({ data }) => {
  if (data.type === "start")
    catalog.start().catch(() => postMessage({ type: "state", ready: false }));
  if (data.type === "query")
    try {
      postMessage({
        type: "result",
        id: data.id,
        result: catalog.search(data.query),
      });
    } catch {
      postMessage({ type: "result", id: data.id, error: true });
    }
  if (data.type === "check") void catalog.refresh();
};
