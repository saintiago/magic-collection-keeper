import { esc, finishName } from "./view.js";
import { tagBadges, allocationWarning } from "./tag-view.js";
import { displayedQuantity } from "./collection-counts.js";

export function printingLabel(card) {
  return [
    card.set?.toUpperCase(),
    card.collector_number && `#${card.collector_number}`,
    card.lang?.toUpperCase(),
  ]
    .filter(Boolean)
    .join(" · ");
}

export function cardHoverInfo(row, tag, { pending = false } = {}) {
  if (pending)
    return `<div class="card-hover-info"><small>${row.quantity} pending · review before Add</small><div class="card-hover-tags">${tagBadges(row)}</div></div>`;
  return row.id
    ? `<div class="card-hover-info"><small>${esc(finishName[row.finish] || row.finish)} · ${esc(row.condition)} · ${row.quantity} owned${tag?.type === "location" ? ` · ${displayedQuantity(row, tag)} assigned here` : ""}</small><div class="card-hover-tags">${tagBadges(row)}</div>${allocationWarning(row)}</div>`
    : "";
}
