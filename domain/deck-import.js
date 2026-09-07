import { ApplicationError, validateQuantity } from "./inventory.js";

export function normalizeDeck(input) {
  if (
    input?.provider !== "moxfield" ||
    !/^[A-Za-z0-9_-]{16,80}$/.test(input.source_id || "")
  )
    throw new ApplicationError("A verified Moxfield deck ID is required.");
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 100 || /[\u0000-\u001f]/.test(name))
    throw new ApplicationError(
      "A deck name of up to 100 printable characters is required.",
    );
  if (
    !Array.isArray(input.entries) ||
    !input.entries.length ||
    input.entries.length > 500
  )
    throw new ApplicationError(
      "Import 1–500 resolved printing lines per deck.",
    );
  const entries = input.entries.map((entry) => {
    validateQuantity(entry.quantity);
    if (
      !/^[a-f0-9-]{36}$/.test(entry.printing_id || "") ||
      !["nonfoil", "foil", "etched"].includes(entry.finish) ||
      !["mainboard", "commanders", "companions"].includes(entry.section)
    )
      throw new ApplicationError(
        "Every line needs a resolved printing, finish, and included deck section.",
      );
    return {
      printing_id: entry.printing_id,
      finish: entry.finish,
      section: entry.section,
      quantity: entry.quantity,
    };
  });
  const excluded = Array.isArray(input.excluded)
    ? input.excluded.map((section) => ({
        section: String(section.section).slice(0, 40),
        quantity: Number(section.quantity) || 0,
      }))
    : [];
  const provenance = {
    provider: "moxfield",
    source_id: input.source_id,
    name,
    url: `https://moxfield.com/decks/${input.source_id}`,
    folder: String(input.folder || "").slice(0, 100),
    retrieved_at: input.retrieved_at || null,
    excluded,
  };
  return { ...provenance, entries };
}
export function planDeck(previous, input, lineId) {
  const requested = new Map();
  for (const entry of input.entries) {
    const key = lineId(`${entry.printing_id}|${entry.finish}`);
    const old = requested.get(key);
    requested.set(key, {
      ...entry,
      line_id: key,
      quantity: entry.quantity + (old?.quantity || 0),
    });
  }
  const lots = new Map(
    (previous?.lots || []).map((lot) => [
      lot.line_id,
      { ...lot, allocated_quantity: 0 },
    ]),
  );
  let added = 0;
  for (const entry of requested.values()) {
    const old = lots.get(entry.line_id),
      owned = Math.max(entry.quantity, old?.owned_quantity || 0);
    validateQuantity(owned);
    added += owned - (old?.owned_quantity || 0);
    lots.set(entry.line_id, {
      ...entry,
      owned_quantity: owned,
      allocated_quantity: entry.quantity,
    });
  }
  const result = [...lots.values()].sort((a, b) =>
    a.line_id.localeCompare(b.line_id),
  );
  return {
    lots: result,
    added,
    allocated: result.reduce((n, l) => n + l.allocated_quantity, 0),
    retained: result.reduce(
      (n, l) => n + l.owned_quantity - l.allocated_quantity,
      0,
    ),
    owned: result.reduce((n, l) => n + l.owned_quantity, 0),
  };
}
export function deckRows(deck, cards, tag) {
  return deck.lots.flatMap((lot) => {
    const card = cards.get(lot.printing_id);
    if (!card)
      throw new ApplicationError(
        "A durable imported printing is missing. Contact the app administrator.",
        500,
      );
    const base = {
      printing_id: lot.printing_id,
      card,
      language: card.lang,
      condition: "UNK",
      finish: lot.finish,
      created_at: deck.created_at,
      updated_at: deck.updated_at,
      provenance: {
        provider: deck.provider,
        source_id: deck.source_id,
        name: deck.name,
        url: deck.url,
        section: lot.section,
        imported_at: deck.updated_at,
        folder: deck.folder,
      },
      tag_ids: [],
    };
    return [
      ...(lot.allocated_quantity
        ? [
            {
              ...base,
              id: `source:${deck.source_id}:${lot.line_id}`,
              quantity: lot.allocated_quantity,
              locations: [{ tag_id: tag.id, quantity: lot.allocated_quantity }],
            },
          ]
        : []),
      ...(lot.owned_quantity > lot.allocated_quantity
        ? [
            {
              ...base,
              id: `retained:${deck.source_id}:${lot.line_id}`,
              quantity: lot.owned_quantity - lot.allocated_quantity,
              locations: [],
              retained: true,
            },
          ]
        : []),
    ];
  });
}
