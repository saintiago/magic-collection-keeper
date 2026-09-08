import { esc } from "./view.js";
import { tagHref } from "./tag-navigation.js";
export const TAG_STYLE = {
  deck: { icon: "▣", label: "Deck" },
  binder: { icon: "▤", label: "Binder" },
  box: { icon: "▧", label: "Box" },
  other: { icon: "⌖", label: "Other location" },
  role: { icon: "✧", label: "Role" },
  category: { icon: "◇", label: "Category" },
};
export function tagLink(tag, quantity) {
  if (!tag?.id) return '<span class="tag-badge">Unknown tag</span>';
  return `<a class="tag-badge tag-${esc(tag.kind || "other")}" href="${esc(tagHref(tag.id))}" data-tag-id="${esc(tag.id)}" data-tag-label="${esc(tag.label)}" data-tag-type="${esc(tag.type || "location")}" data-tag-kind="${esc(tag.kind || "other")}" aria-label="Show cards tagged ${esc(tag.label)} (${esc(TAG_STYLE[tag.kind]?.label || "Tag")})">${TAG_STYLE[tag.kind]?.icon || "◇"} ${esc(tag.label)}${quantity == null ? "" : ` <b>×${quantity}</b>`} </a>`;
}
export function tagBadges(row) {
  return [
    ...(row.locations ?? []).map((a) =>
      tagLink(
        {
          ...a.tag,
          id: a.tag_id,
          label: a.tag?.label || "Unknown location",
          type: "location",
        },
        a.quantity,
      ),
    ),
    ...(row.tags ?? []).map((t) => tagLink(t)),
  ].join("");
}
export function allocationWarning(row) {
  return row.allocation_shortfall
    ? `<span class="allocation-warning" role="note" title="Location assignments exceed the owned total by ${row.allocation_shortfall}. Edit tags or the owned total to resolve this; no allocations were removed.">${row.allocated_quantity} assigned · ${row.quantity} owned</span>`
    : "";
}
