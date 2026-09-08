// Candidate browser adapter, not imported by the production app yet.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function createBackendRecognition({ request }) {
  let active = false;
  return {
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
        const data = await request("/api/recognize", {
          method: "POST",
          body: JSON.stringify({ image: btoa(binary), attempt }),
          signal,
        });
        signal?.throwIfAborted();
        if (
          data.attempt !== attempt ||
          !["unknown", "possible"].includes(data.status)
        )
          throw new Error("Recognition response is not approved");
        const candidates = (data.candidates || [])
          .slice(0, 5)
          .filter(
            (c) =>
              uuid.test(c.id) &&
              uuid.test(c.identifiers?.scryfall_oracle) &&
              typeof c.name === "string" &&
              c.name.length <= 200,
          );
        return { status: data.status, candidates, selected: null };
      } finally {
        active = false;
      }
    },
  };
}
