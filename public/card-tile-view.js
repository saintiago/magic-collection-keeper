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
  const card = row.card;
  if (pending)
    return `<div class="card-hover-info"><strong>${esc(card.name)}</strong><small>${esc(printingLabel(card))}</small><small>${row.quantity} pending · review before Add</small></div>`;
  return `<div class="card-hover-info"><strong class="card-title">${esc(card.name)}</strong><small>${esc(printingLabel(card))}</small>${row.id ? `<small>${esc(finishName[row.finish] || row.finish)} · ${esc(row.condition)} · ${row.quantity} owned${tag?.type === "location" ? ` · ${displayedQuantity(row, tag)} assigned here` : ""}</small><div class="card-hover-tags">${tagBadges(row)}</div>${allocationWarning(row)}` : "<small>Review printing before adding</small>"}</div>`;
}
