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
let worker,
  generation = 0,
  progress = () => {};
export async function recognizeCard(canvas, onProgress = () => {}) {
  progress = onProgress;
  const current = generation;
  if (!worker) {
    worker = import(new URL("./vendor/ocr.js", import.meta.url).href).then(
      ({ createWorker }) =>
        createWorker("eng", 1, {
          workerPath: new URL("./vendor/worker.min.js", import.meta.url).href,
          corePath: new URL("./vendor/core", import.meta.url).href,
          langPath: new URL("./vendor/lang", import.meta.url).href,
          logger: (m) => progress(m.status),
        }),
    );
  }
  let engine;
  try {
    engine = await worker;
  } catch (error) {
    if (current === generation) worker = undefined;
    throw error;
  }
  if (current !== generation) throw new Error("Reading cancelled.");
  const { data } = await engine.recognize(canvas);
  return { ...parseRecognition(data.text), confidence: data.confidence };
}
export async function stopRecognition() {
  generation++;
  progress = () => {};
  const previous = worker;
  worker = undefined;
  if (previous)
    await previous.then((engine) => engine.terminate()).catch(() => {});
}
