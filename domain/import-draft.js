import { ApplicationError, validateQuantity } from "./inventory.js";
import { validateAssignments } from "./tags.js";

export { IMPORT_PENDING_TAG } from "./system-tags.js";
export const MAX_DRAFT_ROWS = 150;
export function moxfieldSource(urlText) {
  let url;
  try {
    url = new URL(urlText);
  } catch {
    /* Use the same input error below. */
  }
  const match = url?.pathname.match(/^\/decks\/([A-Za-z0-9_-]{16,80})\/?$/);
  if (
    !url ||
    url.protocol !== "https:" ||
    !["moxfield.com", "www.moxfield.com"].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    !match
  )
    throw new ApplicationError(
      "Enter a public HTTPS Moxfield deck link, without extra parameters.",
    );
  return {
    provider: "moxfield",
    source_id: match[1],
    url: `https://moxfield.com/decks/${match[1]}`,
  };
}
export function printingSummary(card) {
  return card
    ? {
        id: card.id,
        oracle_id: card.oracle_id,
        name: card.name,
        flavor_name: card.flavor_name || null,
        set: card.set,
        collector_number: card.collector_number,
        lang: card.lang,
        finishes: card.finishes,
        digital: Boolean(card.digital),
        paper: card.games?.includes("paper") !== false,
        image:
          card.image_uris?.small ||
          card.card_faces?.[0]?.image_uris?.small ||
          null,
      }
    : null;
}
export function sameCard(original, card) {
  const normalize = (value) =>
    String(value || "")
      .normalize("NFKC")
      .toLowerCase()
      .trim();
  return (
    card &&
    (original.oracle_id
      ? original.oracle_id === card.oracle_id
      : [card.name, card.flavor_name, card.printed_name].some(
          (name) => normalize(name) === normalize(original.name),
        ))
  );
}
export function validateDraftRows(draft, rows, tags) {
  if (!Array.isArray(rows) || rows.length > MAX_DRAFT_ROWS)
    throw new ApplicationError("A draft supports at most 150 card lines.");
  const originals = new Map(draft.rows.map((row) => [row.id, row]));
  const used = new Set();
  const validated = rows.map((row) => {
    if (!row || typeof row !== "object")
      throw new ApplicationError("Each draft line must be a card entry.");
    const previous = originals.get(row.id);
    if (!previous || used.has(row.id))
      throw new ApplicationError(
        "Draft lines changed. Reload the draft and retry.",
        409,
      );
    used.add(row.id);
    validateQuantity(row.quantity);
    if (!["nonfoil", "foil", "etched"].includes(row.finish))
      throw new ApplicationError("Choose a supported finish.");
    const assigned = validateAssignments(row, {}, tags);
    return {
      ...previous,
      quantity: row.quantity,
      finish: row.finish,
      in_deck: row.in_deck !== false,
      locations: assigned.locations,
      tag_ids: assigned.tag_ids,
    };
  });
  const selectedTags = new Set(
    validated.flatMap((row) => [
      ...row.tag_ids,
      ...row.locations.map((a) => a.tag_id),
    ]),
  );
  if (selectedTags.size > 30)
    throw new ApplicationError(
      "Choose at most 30 distinct tags across one draft.",
    );
  return validated;
}
export function draftProblems(draft, tags) {
  const errors = [];
  if (!draft.rows.length)
    errors.push("The draft is empty. Clear it or load a deck after clearing.");
  for (const row of draft.rows) {
    if (
      !row.card ||
      !row.card.paper ||
      row.card.digital ||
      !row.card.finishes.includes(row.finish)
    )
      errors.push(
        `${row.original.name}: choose an available paper printing and finish.`,
      );
    try {
      validateAssignments(row, {}, tags);
    } catch {
      errors.push(
        `${row.original.name}: a selected tag is unavailable. Edit its tags.`,
      );
    }
  }
  return errors;
}
export function draftDeck(draft) {
  return {
    provider: draft.provider,
    source_id: draft.source_id,
    name: draft.name,
    url: draft.url,
    folder: "Reviewed URL imports",
    retrieved_at: draft.retrieved_at,
    excluded: draft.original.excluded,
    pending: [],
    entries: draft.rows.map((row) => ({
      printing_id: row.printing_id,
      finish: row.finish,
      section: row.original.section,
      quantity: row.quantity,
    })),
  };
}
