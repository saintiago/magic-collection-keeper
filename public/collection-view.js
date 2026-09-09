import { esc, picture, finishName } from "./view.js";
import { displayedQuantity } from "./collection-counts.js";
import { cardHoverInfo } from "./card-tile-view.js";
export function collectionCard(row, index, tag) {
  const alias = row.card.discovery?.matched_name
    ? `, matched ${row.card.discovery.matched_name} · ${row.card.discovery.matched_language?.toUpperCase() || ""}`
    : "";
  const ownership = row.id
    ? `, ${finishName[row.finish] || row.finish} ${row.condition}, ${row.quantity} owned${tag?.type === "location" ? `, ${displayedQuantity(row, tag)} assigned here` : ""}`
    : "";
  return `<article class="card card-tile" data-card-key="${esc(String(row.id || row.card.id))}"><button class="card-open" data-index="${index}" aria-label="Open ${esc(row.card.name)} printing ${esc(row.card.set)} ${esc(row.card.collector_number)}${esc(alias + ownership)}" title="View card · drag to organize · Shift+F10 for keyboard pickup"><div class="card-image">${picture(row.card)}</div></button>${cardHoverInfo(row, tag)}</article>`;
}
