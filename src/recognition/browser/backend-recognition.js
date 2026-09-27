// SPDX-License-Identifier: AGPL-3.0-only
import { resolveRecognition } from "./recognition-candidates.js";
export function createBackendRecognition({
  request,
  endpoint = "/api/recognize",
  provider = "lambda",
}) {
  let active = false;
  const cache = new Map();
  const port = {
    kind: provider,
    async prepare({ signal } = {}) {
      const blank = document.createElement("canvas");
      blank.width = 200;
      blank.height = 300;
      const context = blank.getContext("2d");
      context.fillStyle = "white";
      context.fillRect(0, 0, 200, 300);
      // A fixed blank frame prepares the existing bounded inference path once
      // on session entry. No camera image, ownership data or success cue is used.
      await port.recognize(blank, { signal, attempt: 100000 });
    },
    async recognize(canvas, { signal, attempt, onStage }) {
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
        const started = performance.now();
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
        const encoded = performance.now();
        onStage?.({
          stage: provider === "bedrock-independent" ? "independent" : "backend",
          active: true,
        });
        const data = await request(endpoint, {
          method: "POST",
          body: JSON.stringify({ image: btoa(binary), attempt }),
          signal,
        });
        const received = performance.now();
        signal?.throwIfAborted();
        const row = await resolveRecognition(data, {
          request,
          signal,
          attempt,
          cache,
        });
        return {
          ...row,
          measurement: {
            ...row.measurement,
            encodeMs: encoded - started,
            transportMs: received - encoded,
            adapterMs: performance.now() - started,
          },
        };
      } finally {
        onStage?.({
          stage: provider === "bedrock-independent" ? "independent" : "backend",
          active: false,
        });
        active = false;
      }
    },
  };
  return port;
}
