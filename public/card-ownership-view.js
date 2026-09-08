import { esc, finishName } from "./view.js";
import { tagBadges, allocationWarning } from "./tag-view.js";

export function ownedPrintings(card, rows) {
  return rows.filter(
    (row) =>
      row.id &&
      (row.printing_id === card.id ||
        (card.oracle_id && row.card.oracle_id === card.oracle_id)),
  );
}

export function ownershipContent(rows) {
  if (!rows.length)
    return '<p class="hint">No owned copies of this card. Choose your exact printing and add it to your collection before assigning tags.</p>';
  return `<p class="hint">Add or remove tags for a specific owned printing below. Adding another copy uses the printing reviewed on this page.</p>${rows
    .map((row, index) => {
      const c = row.card;
      const label = `${c.set.toUpperCase()} #${c.collector_number} · ${c.lang.toUpperCase()} · ${finishName[row.finish] || row.finish} · ${row.condition}`;
      return `<div class="owned-printing"><p><b>${esc(label)}</b><br>${row.quantity} owned</p><div class="card-tags">${tagBadges(row)}</div>${allocationWarning(row)}<button type="button" class="secondary full" data-owned-tags="${index}" aria-label="Edit locations & tags for ${esc(label)}">Edit locations & tags</button></div>`;
    })
    .join("")}`;
}
