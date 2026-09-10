import { esc } from "./view.js";

export function inspectorView(item, src) {
  return `<span class="artwork-safe-area" aria-hidden="true"></span><div class="artwork-inspector"><div class="artwork-stage"><div class="artwork-viewport"><div class="artwork-open-reveal"><div class="artwork-open-orientation">${src ? `<img class="artwork-full-image" src="${esc(src)}" alt="${esc(item.card.name)}" draggable="false" decoding="async">` : `<div class="artwork-full-image artwork-placeholder">Artwork unavailable</div>`}</div></div></div></div><aside class="artwork-tags" aria-label="Card tags"></aside></div>`;
}
