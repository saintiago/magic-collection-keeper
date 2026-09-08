// SPDX-License-Identifier: AGPL-3.0-only
import { resolveRecognition } from "./recognition-candidates.js";
export function createBackendRecognition({ request, path = "/api/recognize" }) {
  let active = false;
  return {
    kind: path.endsWith("sagemaker") ? "sagemaker" : "lambda",
    async recognize(canvas, { signal, attempt }) {
      signal?.throwIfAborted();
      if (active) throw new Error("Scanner busy. Retry this card.");
      if (!Number.isInteger(attempt) || attempt < 1 || attempt > 100000)
        throw new Error("Invalid attempt");
      if (
        canvas.width * canvas.height > 4000000 ||
        Math.min(canvas.width, canvas.height) < 100
      )
        throw new Error("Unsupported image dimensions");
      active = true;
      try {
        const blob = await new Promise((resolve) =>
          canvas.toBlob(resolve, "image/jpeg", 0.86),
        );
        signal?.throwIfAborted();
        if (!blob || blob.size > 524288)
          throw new Error("Image too large. Retry a smaller crop.");
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = "";
        for (let i = 0; i < bytes.length; i += 32768)
          binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
        signal?.throwIfAborted();
        const data = await request(path, {
          method: "POST",
          body: JSON.stringify({ image: btoa(binary), attempt }),
          signal,
        });
        signal?.throwIfAborted();
        return resolveRecognition(data, { request, signal, attempt });
      } finally {
        active = false;
      }
    },
  };
}
