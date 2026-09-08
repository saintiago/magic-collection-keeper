import { esc, finishName } from "./view.js";

export function draftRow(row, index, busy) {
  const card = row.card;
  return `<article class="draft-row" data-row="${esc(row.id)}">${card?.image ? `<img src="${esc(card.image)}" alt="${esc(card.name)}" loading="lazy">` : `<div class="draft-no-image">${card ? "Image unavailable" : "Printing needed"}</div>`}<div class="draft-card-body"><span class="eyebrow">LINE ${index + 1} · ${esc(row.original.section)}</span><h3>${esc(card?.name || row.original.name)}</h3><p>${card ? `${esc(card.set.toUpperCase())} #${esc(card.collector_number)} · ${esc(card.lang.toUpperCase())}` : "Choose an exact paper printing"}</p><p class="hint">Original: ${row.original.quantity} × ${esc(row.original.name)} · ${esc(row.original.set.toUpperCase())} #${esc(row.original.collector_number)} · ${esc(row.original.finish)}</p><div class="draft-controls"><label>Quantity<input data-field="quantity" type="number" min="1" max="100000" step="1" value="${row.quantity}" aria-label="Quantity for line ${index + 1}" ${busy ? "disabled" : ""}></label><label>Finish<select data-field="finish" aria-label="Finish for line ${index + 1}" ${busy ? "disabled" : ""}>${Object.entries(
    finishName,
  )
    .map(
      ([value, label]) =>
        `<option value="${value}" ${row.finish === value ? "selected" : ""}>${label}${card && !card.finishes.includes(value) ? " (unavailable)" : ""}</option>`,
    )
    .join(
      "",
    )}</select></label><button type="button" data-action="printing" ${busy ? "disabled" : ""}>Change printing</button><button type="button" data-action="tags" ${busy ? "disabled" : ""}>Edit tags</button><button type="button" data-action="remove" class="danger" aria-label="Delete line ${index + 1}" ${busy ? "disabled" : ""}>Delete</button></div><p class="hint draft-tag-summary">${row.in_deck ? "Deck location included" : "No default deck location"} · ${row.locations.length} other locations · ${row.tag_ids.length} classifications</p>${card && card.finishes.includes(row.finish) ? "" : '<p class="error">Resolve the printing and finish before Add.</p>'}</div></article>`;
}
export function importPageView({
  data,
  busy,
  message,
  error,
  url,
  rows,
  dirty,
}) {
  const draft = data?.draft,
    summary = data?.summary;
  return `<form id="draft-fetch-form" class="import-link-form"><label for="moxfield-url">Moxfield deck URL</label><div><input id="moxfield-url" type="url" required placeholder="https://moxfield.com/decks/…" value="${esc(url || draft?.url || "")}" ${busy || draft ? "disabled" : ""}><button class="primary" ${busy || draft ? "disabled" : ""}>Load deck</button></div><p class="hint">Public decks only. One saved import at a time. Existing text imports remain available from My collection.</p></form><div role="status" aria-live="polite" class="import-status ${error ? "error" : ""}">${esc(message || (busy ? "Loading…" : draft ? "Saved to your account. Changes are saved as you edit." : "No pending import. Load a deck to begin."))}</div><button id="draft-reload" class="secondary" type="button" ${busy ? "disabled" : ""}>Reload saved draft</button>${dirty ? `<button id="draft-retry-save" class="primary" ${busy ? "disabled" : ""}>Retry saving edits</button>` : ""}${draft ? `<div class="draft-heading"><span class="pending-chip">Pending import</span><h2>${esc(draft.name)}</h2><a href="${esc(draft.url)}" target="_blank" rel="noreferrer">Original Moxfield deck ↗</a><p>${summary.source_copies} copies in fetched source · ${(rows || draft.rows).reduce((n, r) => n + r.quantity, 0)} reviewed copies · ${summary.additions === null ? "printing review needed" : summary.additions + " new copies to add"}</p><p class="hint">Excluded source sections: ${draft.original.excluded.map((e) => `${esc(e.section)} (${e.quantity})`).join(", ") || "none"}. Condition: Unknown (imported). Existing assignments are preserved. New sources add their selected locations.</p>${summary.errors.length ? `<div class="error" role="note">${summary.errors.slice(0, 4).map(esc).join("<br>")}${summary.errors.length > 4 ? "<br>Resolve the other marked lines below." : ""}</div>` : ""}</div><div id="draft-rows">${(rows || draft.rows).map((row, index) => draftRow(row, index, busy)).join("") || "<p>The draft has no remaining lines.</p>"}</div>` : ""}<div class="draft-actions"><p>Add confirms you own the reviewed copies. Pending cards are excluded from your collection until Add succeeds.</p><button id="draft-add" class="primary" ${busy || dirty || !summary?.can_add ? "disabled" : ""}>Add</button><button id="draft-clear" class="secondary" ${busy || !draft ? "disabled" : ""}>Clear</button></div>`;
}
export function draftTagForm(row, draft, tags) {
  const locations = tags.filter(
      (t) => t.type === "location" && t.source?.id !== draft.source_id,
    ),
    classifications = tags.filter((t) => t.type !== "location");
  return `<button type="button" class="close" data-close aria-label="Close draft tags">×</button><h2>Tags for ${esc(row.original.name)}</h2><form id="draft-tag-form"><label class="draft-tag-choice"><input type="checkbox" name="in_deck" ${row.in_deck ? "checked" : ""}>Include ${esc(draft.name)} deck location (${row.quantity} copies)</label><h3>Other locations</h3>${
    locations
      .map((tag) => {
        const a = row.locations.find((a) => a.tag_id === tag.id);
        return `<div class="draft-location-choice"><label><input type="checkbox" data-location="${esc(tag.id)}" ${a ? "checked" : ""}>${esc(tag.label)}</label><input type="number" min="1" max="100000" step="1" data-location-quantity="${esc(tag.id)}" aria-label="Copies at ${esc(tag.label)}" value="${a?.quantity || row.quantity}"></div>`;
      })
      .join("") ||
    '<p class="hint">Create locations using Tags & locations in your collection.</p>'
  }<h3>Roles & categories</h3>${classifications.map((tag) => `<label class="draft-tag-choice"><input type="checkbox" data-classification="${esc(tag.id)}" ${row.tag_ids.includes(tag.id) ? "checked" : ""}>${esc(tag.label)}</label>`).join("") || '<p class="hint">No classifications created yet.</p>'}<p class="error" id="draft-tag-error" role="alert"></p><button class="primary">Save tags</button></form>`;
}
