import { esc, picture, finishName } from "./view.js";
import { displayedQuantity } from "./collection-counts.js";
import { tagBadges, allocationWarning } from "./tag-view.js";
export function collectionCard(row, index, tag) {
  const local = row.id && tag?.type === "location";
  return `<article class="card"><button class="card-open" data-index="${index}" aria-label="Open ${esc(row.card.name)} printing ${esc(row.card.set)} ${esc(row.card.collector_number)}"><div class="card-image">${picture(row.card)}</div><div class="card-info"><div class="card-title">${esc(row.card.name)}</div>${row.card.discovery?.matched_name ? `<p class="matched-name">${esc(row.card.discovery.matched_name)} · ${esc(row.card.discovery.matched_language?.toUpperCase())}</p>` : ""}<div class="card-meta">${esc(row.card.set.toUpperCase())} · #${esc(row.card.collector_number)} <span>${esc(row.card.lang.toUpperCase())}</span></div><div class="card-bottom"><span>${row.id ? esc(`${finishName[row.finish]} · ${row.condition}`) : esc(row.card.rarity)}</span><b>${row.id ? (local ? `${displayedQuantity(row, tag)} assigned here` : `${row.quantity} owned`) : "Review card & printing"}</b></div>${local ? `<small class="owned-caption">${row.quantity} owned across collection</small>` : ""}</div></button>${row.id ? `<div class="card-tags">${tagBadges(row)}</div>${allocationWarning(row)}` : ""}</article>`;
}
