// Concrete browser composition. Adapters remain independent of scanner controls.
import { createBrowserRecognition } from "./browser-recognition.js";
import { createBackendRecognition } from "./backend-recognition.js";
import { createHybridRecognition } from "./hybrid-recognition.js";
import { createIndependentRecognition } from "./independent-recognition.js";
export function createScanRecognition(request, { cloudEnabled = true } = {}) {
  const primary = createHybridRecognition({
    local: createBrowserRecognition({ request }),
    cloud: cloudEnabled ? createBackendRecognition({ request }) : null,
  });
  return cloudEnabled
    ? createIndependentRecognition({
        primary,
        independent: createBackendRecognition({
          request,
          endpoint: "/api/recognize-independent",
          provider: "bedrock-independent",
        }),
      })
    : primary;
}
