import { ApplicationError, validateQuantity } from "./inventory.js";
import { IMPORT_PENDING_TAG, isSystemTag } from "./system-tags.js";

export const TAG_TYPES = {
  location: ["deck", "binder", "box", "other"],
  role: ["role"],
  category: ["category"],
};
export function validateTagId(id) {
  if (id === IMPORT_PENDING_TAG.id)
    throw new ApplicationError(
      "System tags are managed by the import lifecycle.",
    );
  if (
    typeof id !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      id,
    )
  )
    throw new ApplicationError("Invalid tag ID.");
}
export function tagDefinition(input) {
  const label = typeof input?.label === "string" ? input.label.trim() : "";
  if (
    isSystemTag(input) ||
    /^system:/i.test(label) ||
    input?.key?.startsWith?.("system:")
  )
    throw new ApplicationError(
      "The system tag family is reserved for the app.",
    );
  if (!label || label.length > 100 || /[\u0000-\u001f\u007f]/.test(label))
    throw new ApplicationError(
      "Tag labels must contain 1–100 printable characters.",
    );
  if (!TAG_TYPES[input.type]?.includes(input.kind))
    throw new ApplicationError("Choose a supported tag type and kind.");
  return { label, type: input.type, kind: input.kind };
}
export function validateAssignments(input, row, tags) {
  const locations = input.locations ?? [],
    tagIds = input.tag_ids ?? [];
  if (
    !Array.isArray(locations) ||
    locations.length > 30 ||
    !Array.isArray(tagIds) ||
    tagIds.length > 30
  )
    throw new ApplicationError(
      "Choose at most 30 locations and classification tags.",
    );
  const used = new Set();
  for (const allocation of locations) {
    if (!allocation || typeof allocation !== "object")
      throw new ApplicationError(
        "Each location must include a tag and quantity.",
      );
    validateTagId(allocation.tag_id);
    validateQuantity(allocation.quantity);
    const tag = tags.get(allocation.tag_id);
    if (!tag || tag.type !== "location" || used.has(tag.id))
      throw new ApplicationError(
        "Each allocation must use a different location belonging to you.",
      );
    used.add(tag.id);
  }
  for (const id of tagIds) {
    validateTagId(id);
    const tag = tags.get(id);
    if (
      !tag ||
      !["role", "category"].includes(tag.type) ||
      isSystemTag(tag) ||
      used.has(id)
    )
      throw new ApplicationError(
        "Choose distinct role or category tags belonging to you.",
      );
    used.add(id);
  }
  return {
    locations: locations.map((a) => ({
      tag_id: a.tag_id,
      quantity: a.quantity,
    })),
    tag_ids: [...tagIds].sort(),
    locations_override: true,
  };
}
export function referencedTags(assignment) {
  return new Set([
    ...(assignment?.locations ?? []).map((a) => a.tag_id),
    ...(assignment?.tag_ids ?? []),
  ]);
}
