import { esc, finishName } from "./view.js";
import { tagBadges, allocationWarning } from "./tag-view.js";

export function inspectorDetails(item) {
  const row = item.row;
  const taggedNames = new Set([
    ...(row?.locations || []).map((entry) => entry.tag?.label),
    ...(row?.tags || []).map((tag) => tag.label),
  ]);
  const sources = (row?.provenance_list || []).filter(
    (source) => !taggedNames.has(source.name),
  );
  if (item.kind === "owned")
    return `<p>${row.quantity} owned · ${esc(finishName[row.finish] || row.finish)} · ${esc(row.condition)}</p><div class="card-tags">${tagBadges(row)}</div>${allocationWarning(row)}${sources.map((p) => `<p class="hint">Source: ${esc(p.name)} · ${esc(p.section)}</p>`).join("")}`;
  return item.kind === "pending"
    ? `<p>${row?.quantity || 1} pending · review before Add</p><div class="card-tags">${tagBadges(row || {})}</div>`
    : "";
}

export function inspectorControls(item) {
  return `${item.kind === "owned" ? `<form class="artwork-quantity"><label><span>Qty</span><input aria-label="Owned quantity" name="quantity" type="number" min="1" max="100000" step="1" required value="${item.row.quantity}"></label><button type="submit" class="artwork-save" aria-label="Save quantity"><span>Save</span></button><p role="status"></p></form>` : ""}<button data-artwork="edit" aria-label="${item.kind === "owned" ? "Edit locations & tags" : item.kind === "pending" ? "Edit pending tags" : "Review & add"}"><span>${item.kind === "owned" || item.kind === "pending" ? "Edit tags" : "Review & add"}</span></button><button data-artwork="details" aria-label="${item.kind === "pending" ? "Review line" : "Card details"}"><span>${item.kind === "pending" ? "Review" : "Details"}</span></button><div class="artwork-zoom"><button data-artwork="out" aria-label="Zoom out"><span>−</span></button><button data-artwork="reset" aria-label="Reset zoom"><output aria-label="Artwork zoom"></output></button><button data-artwork="in" aria-label="Zoom in"><span>+</span></button></div><button data-artwork="close" aria-label="Close artwork"><span aria-hidden="true">&times;</span></button>`;
}

export function inspectorView(item, src) {
  return `<span class="artwork-safe-area" aria-hidden="true"></span><div class="artwork-inspector"><div class="artwork-stage"><div class="artwork-viewport"><div class="artwork-open-reveal"><div class="artwork-open-orientation">${src ? `<img class="artwork-full-image" src="${esc(src)}" alt="${esc(item.card.name)}" draggable="false" decoding="async">` : `<div class="artwork-full-image artwork-placeholder">Artwork unavailable</div>`}</div></div></div></div><aside class="artwork-details" aria-label="Card information">${inspectorDetails(item)}</aside><aside class="artwork-controls" aria-label="Card controls">${inspectorControls(item)}</aside></div>`;
}
