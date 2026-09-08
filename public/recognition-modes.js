// Temporary comparison composition. Removed after the measured final selection.
import { createBrowserRecognition } from "./browser-recognition.js";
import { createBackendRecognition } from "./backend-recognition.js";
export function comparisonModes(api) {
  return [
    { id: "ocr", label: "Browser OCR", create: () => null },
    {
      id: "lambda",
      label: "Lambda CollectorVision",
      create: () => createBackendRecognition({ request: api }),
    },
    {
      id: "sagemaker",
      label: "SageMaker Serverless",
      create: () =>
        createBackendRecognition({
          request: api,
          path: "/api/recognize/sagemaker",
        }),
    },
    {
      id: "browser-onnx",
      label: "Browser ONNX",
      create: () => createBrowserRecognition({ request: api }),
    },
  ];
}
