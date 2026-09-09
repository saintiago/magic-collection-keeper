import { esc, finishName } from "./view.js";
import { printingLabel } from "./card-tile-view.js";
import { tagBadges, allocationWarning } from "./tag-view.js";

export function inspectorDetails(item) {
  const c = item.card,
    row = item.row;
  return `<h3>${esc(c.name)}</h3><p>${esc(c.type_line || "")}</p><p>${esc(c.set_name || "")}<br>${esc(printingLabel(c))}</p><p class="oracle">${esc(c.oracle_text || c.card_faces?.map((f) => `${f.name}\n${f.oracle_text || ""}`).join("\n\n") || "Open Card details for complete printing information.")}</p>${item.kind === "owned" ? `<p>${row.quantity} owned · ${esc(finishName[row.finish] || row.finish)} · ${esc(row.condition)}</p><div class="card-tags">${tagBadges(row)}</div>${allocationWarning(row)}${(row.provenance_list || []).map((p) => `<p class="hint">Source: ${esc(p.name)} · ${esc(p.section)}</p>`).join("")}` : `<p>${item.kind === "pending" ? "Pending review — no copies added yet." : "Review the exact printing, language and finish before adding."}</p>`}`;
}

export function inspectorControls(item) {
  return `${item.kind === "owned" ? `<form class="artwork-quantity"><label>Owned quantity<input name="quantity" type="number" min="1" max="100000" step="1" required value="${item.row.quantity}"></label><button type="submit">Save quantity</button><p role="status"></p></form>` : ""}<button data-artwork="edit">${item.kind === "owned" ? "Edit locations & tags" : item.kind === "pending" ? "Edit pending tags" : "Review & add"}</button><button data-artwork="details">${item.kind === "pending" ? "Review line" : "Card details"}</button><p class="hint">Drag the card from its tile to organize it. Keyboard: Shift+F10.</p>`;
}
