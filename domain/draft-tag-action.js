import { ApplicationError } from "./inventory.js";
import { validateTagId } from "./tags.js";
import { tagActionInput } from "./tag-action.js";
import { draftSlot } from "./capture-draft.js";

export function draftTagActionInput(input) {
  if (
    !input ||
    Object.keys(input).some(
      (key) =>
        ![
          "id",
          "kind",
          "row_id",
          "tag_id",
          "operation_id",
          "selected",
          "quantity",
        ].includes(key),
    ) ||
    typeof input.selected !== "boolean"
  )
    throw new ApplicationError(
      "Choose a pending card and an explicit tag selection.",
    );
  validateTagId(input.id);
  draftSlot(input);
  const action = tagActionInput({
    inventory_id: input.row_id,
    tag_id: input.tag_id,
    operation_id: input.operation_id,
    selected: input.selected,
    quantity: input.quantity,
  });
  return {
    id: input.id,
    kind: input.kind || "url",
    row_id: action.inventory_id,
    tag_id: action.tag_id,
    operation_id: action.operation_id,
    selected: action.selected,
    quantity: action.quantity,
  };
}
