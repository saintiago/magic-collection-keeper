import { cardImage } from "./images.js";
export const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const finishName = {
  nonfoil: "Nonfoil",
  foil: "Foil",
  etched: "Etched",
};
export const conditions = {
  NM: "Near mint",
  LP: "Lightly played",
  MP: "Moderately played",
  HP: "Heavily played",
  DMG: "Damaged",
};

export const image = cardImage;
export function picture(card, index = 0) {
  const src = image(card, index);
  return src
    ? `<img src="${esc(src)}" alt="${esc(card.card_faces?.[index]?.name || card.name)}" loading="lazy">`
    : '<div class="image-missing">Card image unavailable</div>';
}
