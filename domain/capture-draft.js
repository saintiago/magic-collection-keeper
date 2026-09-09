import { ApplicationError, validateQuantity } from "./inventory.js";
import { validateTagId } from "./tags.js";

const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function captureInput(input) {
  if (
    !input ||
    Object.keys(input).some(
      (key) => !["id", "kind", "rows", "tag_id"].includes(key),
    ) ||
    !uuid.test(input.id) ||
    !["scan", "text", "catalog"].includes(input.kind) ||
    (input.tag_id !== undefined && input.kind !== "catalog") ||
    !Array.isArray(input.rows) ||
    !input.rows.length ||
    input.rows.length > 50
  )
    throw new ApplicationError(
      "Stage 1–50 reviewed scan, text or catalogue lines with a stable batch ID.",
    );
  const used = new Set();
  if (input.tag_id !== undefined) validateTagId(input.tag_id);
  return {
    id: input.id,
    kind: input.kind,
    ...(input.tag_id ? { tag_id: input.tag_id } : {}),
    rows: input.rows.map((row) => {
      if (
        !row ||
        Object.keys(row).some(
          (key) =>
            ![
              "id",
              "name",
              "printing_id",
              "quantity",
              "finish",
              "condition",
              "recognition",
            ].includes(key),
        ) ||
        !uuid.test(row.id) ||
        used.has(row.id) ||
        typeof row.name !== "string" ||
        !row.name.trim() ||
        row.name.length > 200 ||
        (row.printing_id !== null && !uuid.test(row.printing_id)) ||
        (input.kind === "catalog" && row.printing_id === null) ||
        !["nonfoil", "foil", "etched"].includes(row.finish) ||
        !["NM", "LP", "MP", "HP", "DMG", "UNK"].includes(row.condition)
      )
        throw new ApplicationError(
          "Each pending line needs a unique ID, name, quantity, finish and condition.",
        );
      if (
        row.recognition !== undefined &&
        (!Array.isArray(row.recognition) ||
          row.recognition.length > 3 ||
          row.recognition.some(
            (candidate) =>
              !candidate ||
              Object.keys(candidate).some(
                (key) => !["printing_id", "provider", "evidence"].includes(key),
              ) ||
              !uuid.test(candidate.printing_id) ||
              !["lambda", "browser-onnx", "bedrock-independent"].includes(
                candidate.provider,
              ) ||
              ![
                "visual",
                "visible-title-ocr",
                "visible-title-model",
                "independent-visible-title",
                "independent-artwork",
              ].includes(candidate.evidence),
          ))
      )
        throw new ApplicationError(
          "Recognition alternatives must be bounded catalog references with source evidence.",
        );
      used.add(row.id);
      validateQuantity(row.quantity);
      return {
        id: row.id,
        name: row.name.trim(),
        printing_id: row.printing_id,
        quantity: row.quantity,
        finish: row.finish,
        condition: row.condition,
        ...(row.recognition
          ? {
              recognition: row.recognition.map((candidate) => ({
                printing_id: candidate.printing_id,
                provider: candidate.provider,
                evidence: candidate.evidence,
              })),
            }
          : {}),
      };
    }),
  };
}

export function draftSlot(input = {}) {
  if (input.kind === undefined || input.kind === "url") return "active";
  if (input.kind === "capture" && uuid.test(input.id))
    return "capture:" + input.id;
  throw new ApplicationError("Choose the URL import or scanned/text cards.");
}
