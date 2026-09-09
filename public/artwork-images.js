import { image } from "./view.js";

// Only full-card variants are eligible. Keep the current full-card image while
// the larger version loads/decodes, and never replace a departed/reused visual.
export function upgradeArtwork(target, card) {
  const initial = target.src;
  const faces = card.card_faces || [];
  const face = faces.find((face) =>
    Object.values(face.image_uris || {}).includes(initial),
  );
  const variants = face?.image_uris || card.image_uris || faces[0]?.image_uris;
  const src = variants?.large || variants?.png || image(card);
  if (!src || src === initial) return;
  const next = new Image();
  next.decoding = "async";
  next.onload = async () => {
    try {
      await next.decode();
    } catch {
      return;
    }
    if (
      target.isConnected &&
      target.src === initial &&
      next.naturalWidth >= target.naturalWidth
    )
      target.src = src;
  };
  next.onerror = () => {};
  next.src = src;
}
