import { esc, finishName } from "./view.js";
import { printingLabel } from "./card-tile-view.js";
import { tagBadges, allocationWarning } from "./tag-view.js";

export function inspectorDetails(item) {
  const c = item.card,
    row = item.row;
  return `<h3>${esc(c.name)}</h3><p>${esc(c.type_line || "")}</p><p>${esc(c.set_name || "")}<br>${esc(printingLabel(c))}</p><p class="oracle">${esc(c.oracle_text || c.card_faces?.map((f) => `${f.name}\n${f.oracle_text || ""}`).join("\n\n") || "Open Card details for complete printing information.")}</p>${item.kind === "owned" ? `<p>${row.quantity} owned · ${esc(finishName[row.finish] || row.finish)} · ${esc(row.condition)}</p><div class="card-tags">${tagBadges(row)}</div>${allocationWarning(row)}${(row.provenance_list || []).map((p) => `<p class="hint">Source: ${esc(p.name)} · ${esc(p.section)}</p>`).join("")}` : `<p>${item.kind === "pending" ? "Pending review — no copies added yet." : "Review the exact printing, language and finish before adding."}</p>`}`;
}

export function inspectorControls(item) {
  return `${item.kind === "owned" ? `<form class="artwork-quantity"><label><span>Owned quantity</span><input name="quantity" type="number" min="1" max="100000" step="1" required value="${item.row.quantity}"></label><button type="submit" class="artwork-save"><span>Save quantity</span></button><p role="status"></p></form>` : ""}<button data-artwork="edit"><span>${item.kind === "owned" ? "Edit locations & tags" : item.kind === "pending" ? "Edit pending tags" : "Review & add"}</span></button><button data-artwork="details"><span>${item.kind === "pending" ? "Review line" : "Card details"}</span></button><div class="artwork-zoom"><button data-artwork="out" aria-label="Zoom out"><span>−</span></button><output aria-label="Artwork zoom">300%</output><button data-artwork="in" aria-label="Zoom in"><span>+</span></button></div><button data-artwork="reset"><span>Reset zoom</span></button><button data-artwork="close" aria-label="Close artwork"><span>Close</span></button>`;
}

export function inspectorView(item, src) {
  return `<div class="artwork-inspector"><div class="artwork-stage"><div class="artwork-viewport"><div class="artwork-open-reveal"><div class="artwork-open-orientation">${src ? `<img class="artwork-full-image" src="${esc(src)}" alt="${esc(item.card.name)}" draggable="false" decoding="async">` : `<div class="artwork-full-image artwork-placeholder">Artwork unavailable</div>`}</div></div></div></div><aside class="artwork-details" aria-label="Card information">${inspectorDetails(item)}</aside><aside class="artwork-controls" aria-label="Card controls">${inspectorControls(item)}</aside></div>`;
}
