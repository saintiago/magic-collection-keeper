// Concrete browser composition. Adapters remain independent of scanner controls.
import { createBrowserRecognition } from "./browser-recognition.js";
import { createBackendRecognition } from "./backend-recognition.js";
import { createHybridRecognition } from "./hybrid-recognition.js";
export function createScanRecognition(request, { cloudEnabled = true } = {}) {
  return createHybridRecognition({
    local: createBrowserRecognition({ request }),
    cloud: cloudEnabled ? createBackendRecognition({ request }) : null,
  });
}
