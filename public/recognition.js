// OCR is deliberately independent from camera capture and catalog resolution.
export function parseRecognition(text) {
  const lines = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const setNumber = text.match(
    /\b([A-Z0-9]{3,6})\s*[•·|\-]?\s+(?:EN|ES|FR|DE|IT|PT|JA|KO|RU|ZHS|ZHT)\b[\s\S]{0,40}?\b(\d{1,4}[a-z]?)\b/i,
  );
  const numberSet = text.match(
    /\b(?:[CURM]\s+)?(\d{1,4}[a-z]?)\s*(?:\/\s*\d{1,4})?\s*[\r\n ]+([A-Z0-9]{3,6})\s*[•·|\-]?\s+(EN|ES|FR|DE|IT|PT|JA|KO|RU|ZHS|ZHT)\b/i,
  );
  const simple = text.match(/\b([A-Z]{3,5})\s+(\d{1,4}[a-z]?)\b/);
  const exact = numberSet
    ? { set: numberSet[2], number: numberSet[1], language: numberSet[3] }
    : setNumber
      ? { set: setNumber[1], number: setNumber[2] }
      : simple
        ? { set: simple[1], number: simple[2] }
        : null;
  const name =
    lines
      .find(
        (s) =>
          /^[A-Za-zÀ-ž]/.test(s) && s.replace(/[^A-Za-zÀ-ž]/g, "").length >= 4,
      )
      ?.replace(/\s+[({\d].*$/, "")
      .trim() || "";
  return { text, name, exact };
}
let worker;
export async function recognizeCard(canvas, onProgress = () => {}) {
  if (!worker) {
    const { createWorker } = await import("/vendor/ocr.js");
    worker = await createWorker("eng", 1, {
      workerPath: "/vendor/worker.min.js",
      corePath: "/vendor/core",
      langPath: "/vendor/lang",
      logger: (m) => onProgress(m.status),
    });
  }
  const { data } = await worker.recognize(canvas);
  return { ...parseRecognition(data.text), confidence: data.confidence };
}
export async function stopRecognition() {
  if (worker) {
    await worker.terminate();
    worker = undefined;
  }
}
