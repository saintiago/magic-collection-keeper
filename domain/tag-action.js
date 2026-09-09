import { ApplicationError, validateQuantity } from "./inventory.js";
import { validateTagId } from "./tags.js";

export function tagActionInput(input) {
  if (
    !input ||
    Object.keys(input).some(
      (key) =>
        ![
          "operation_id",
          "inventory_id",
          "tag_id",
          "from_tag_id",
          "quantity",
        ].includes(key),
    )
  )
    throw new ApplicationError("Choose a card and a tag action.");
  validateTagId(input.operation_id);
  validateTagId(input.tag_id);
  if (input.from_tag_id) validateTagId(input.from_tag_id);
  if (
    typeof input.inventory_id !== "string" ||
    !input.inventory_id ||
    input.inventory_id.length > 256
  )
    throw new ApplicationError("Choose an owned entry.");
  const quantity = input.quantity ?? 1;
  validateQuantity(quantity);
  return {
    operation_id: input.operation_id,
    inventory_id: input.inventory_id,
    tag_id: input.tag_id,
    from_tag_id: input.from_tag_id || null,
    quantity,
  };
}

// A drag changes allocations, never the owned total or source provenance.
export function planTagAction(row, tag, input) {
  const locations = (row.locations || []).map(({ tag_id, quantity }) => ({
    tag_id,
    quantity,
  }));
  const tag_ids = [...(row.tag_ids || [])];
  if (tag.type !== "location") {
    if (!tag_ids.includes(tag.id)) tag_ids.push(tag.id);
    return { locations, tag_ids };
  }
  if (input.from_tag_id === tag.id) return { locations, tag_ids };
  if (input.from_tag_id) {
    const source = locations.find((a) => a.tag_id === input.from_tag_id);
    if (!source || source.quantity < input.quantity)
      throw new ApplicationError(
        "That location no longer has these copies. Refresh and try again.",
        409,
      );
    source.quantity -= input.quantity;
  }
  const target = locations.find((a) => a.tag_id === tag.id);
  if (target) target.quantity += input.quantity;
  else locations.push({ tag_id: tag.id, quantity: input.quantity });
  return { locations: locations.filter((a) => a.quantity > 0), tag_ids };
}
