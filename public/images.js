// Replace this adapter to add another image source or an owned image cache.
export function cardImage(card, face = 0) {
  return (
    card.image_uris?.normal || card.card_faces?.[face]?.image_uris?.normal || ""
  );
}
