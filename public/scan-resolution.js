import { recognitionQuery, recognitionNameQuery } from "./catalog-query.js";
const normal = (s = "") => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
export function confidentPrinting(reading, data) {
  if (
    !reading.exact ||
    !Number.isFinite(reading.confidence) ||
    reading.confidence < 70 ||
    data.hasMore ||
    data.cards.length !== 1
  )
    return null;
  const card = data.cards[0],
    exact = reading.exact;
  const names = [
    card.name,
    card.printed_name,
    card.flavor_name,
    ...(card.card_faces || []).flatMap((f) => [
      f.name,
      f.printed_name,
      f.flavor_name,
    ]),
  ];
  return card.set.toLowerCase() === exact.set.toLowerCase() &&
    card.collector_number.replace(/^0+(?=\d)/, "") ===
      exact.number.replace(/^0+(?=\d)/, "") &&
    card.lang === (exact.language || "en").toLowerCase() &&
    names.some((name) => name && normal(name) === normal(reading.name))
    ? card
    : null;
}
export async function resolveScan(reading, api) {
  const row = {
    name: reading.name || "Unclear reading",
    quantity: 1,
    query: recognitionQuery(reading),
    finish: "nonfoil",
    condition: "NM",
    candidates: [],
    selected: null,
    ocr: reading.text,
    confidence: reading.confidence,
  };
  if (!row.query) {
    row.error =
      "Could not read a name or collector number. Move the card out, then try again.";
    return row;
  }
  try {
    let data = await api(
      `/api/search?${new URLSearchParams({ q: row.query })}`,
    );
    row.selected = confidentPrinting(reading, data);
    if (!data.cards.length && reading.exact && reading.name) {
      row.query = recognitionNameQuery(reading.name);
      data = await api(`/api/search?${new URLSearchParams({ q: row.query })}`);
    }
    row.candidates = data.cards;
    if (row.selected) {
      row.name = row.selected.name;
      if (!row.selected.finishes.includes(row.finish))
        row.finish = row.selected.finishes[0];
    } else
      row.error = data.cards.length
        ? "Printing needs review. Check the name, set, collector number and language before choosing."
        : "No match. Move the card out, then try again.";
  } catch (error) {
    row.error = error.message;
  }
  return row;
}
