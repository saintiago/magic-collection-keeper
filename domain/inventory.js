export class ApplicationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
export function validateQuantity(quantity) {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100000)
    throw new ApplicationError(
      "Quantity must be a whole number from 1 to 100,000.",
    );
}
export function validateEntry(input, printing) {
  if (input.operation_id && !/^[a-f0-9-]{36}$/.test(input.operation_id))
    throw new ApplicationError("Invalid operation identifier.");
  validateQuantity(input.quantity);
  if (!printing)
    throw new ApplicationError(
      "Find this printing in the catalog again before adding it.",
    );
  if (!["NM", "LP", "MP", "HP", "DMG"].includes(input.condition))
    throw new ApplicationError("Choose a valid condition.");
  if (!printing.finishes.includes(input.finish))
    throw new ApplicationError(
      "This finish is not available for this printing.",
    );
}
export function validateSearch(query, page) {
  if (
    !query ||
    query.length > 900 ||
    !Number.isInteger(page) ||
    page < 1 ||
    page > 10000
  )
    throw new ApplicationError("Enter a valid card search and page.");
}
