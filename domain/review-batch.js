import { ApplicationError, validateQuantity } from "./inventory.js";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function batchId(id) {
  if (typeof id !== "string" || !uuid.test(id))
    throw new ApplicationError("Invalid review batch identifier.");
  return id.toLowerCase();
}
export function reviewBatch(input) {
  if (
    !input ||
    Object.keys(input).some((k) => !["batch_id", "items"].includes(k)) ||
    !Array.isArray(input.items) ||
    input.items.length < 1 ||
    input.items.length > 50
  )
    throw new ApplicationError("Review between 1 and 50 card lines.");
  const items = input.items.map((row) => {
    if (
      !row ||
      Object.keys(row).some(
        (k) =>
          ![
            "item_id",
            "printing_id",
            "quantity",
            "finish",
            "condition",
          ].includes(k),
      )
    )
      throw new ApplicationError("Invalid reviewed card details.");
    validateQuantity(row.quantity);
    if (
      !["nonfoil", "foil", "etched"].includes(row.finish) ||
      !["NM", "LP", "MP", "HP", "DMG"].includes(row.condition)
    )
      throw new ApplicationError("Choose a valid finish and condition.");
    return {
      item_id: batchId(row.item_id),
      printing_id: batchId(row.printing_id),
      quantity: row.quantity,
      finish: row.finish,
      condition: row.condition,
    };
  });
  if (new Set(items.map((r) => r.item_id)).size !== items.length)
    throw new ApplicationError(
      "Each reviewed line needs a distinct identifier.",
    );
  return { batch_id: batchId(input.batch_id), items };
}
