import { ApplicationError, validateQuantity } from "./inventory.js";

function deckSource(input) {
  if (
    input?.provider === "moxfield" &&
    /^[A-Za-z0-9_-]{16,80}$/.test(input.source_id || "")
  )
    return {
      provider: input.provider,
      source_id: input.source_id,
      url: `https://moxfield.com/decks/${input.source_id}`,
    };
  if (
    input?.provider === "wizards-precon" &&
    /^wizards:[a-z0-9-]{2,16}:[a-z0-9-]{1,60}:[a-z0-9-]{1,24}:[a-z]{2}$/.test(
      input.source_id || "",
    )
  ) {
    let url;
    try {
      url = new URL(input.url);
    } catch {
      /* Invalid URLs use the validation error below. */
    }
    if (
      url?.protocol === "https:" &&
      url.hostname === "magic.wizards.com" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      /^\/[a-z]{2}\/news\/[a-z0-9/-]+$/.test(url.pathname)
    )
      return {
        provider: input.provider,
        source_id: input.source_id,
        url: url.href,
      };
  }
  throw new ApplicationError(
    "A verified Moxfield deck or namespaced Wizards precon with an official decklist URL is required.",
  );
}

export function normalizeDeck(input) {
  const source = deckSource(input);
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
    ...source,
    name,
    folder: String(input.folder || "").slice(0, 100),
    retrieved_at: input.retrieved_at || null,
    excluded,
    pending: (Array.isArray(input.pending) ? input.pending : [])
      .slice(0, 500)
      .map((line) => {
        validateQuantity(line.quantity);
        return {
          name: String(line.name || "").slice(0, 200),
          quantity: line.quantity,
          reason: String(line.reason || "Printing needs review").slice(0, 300),
          set: String(line.set || "").slice(0, 20),
          collector_number: String(line.collector_number || "").slice(0, 40),
          finish: String(line.finish || "").slice(0, 20),
        };
      }),
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
      ...old,
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
        ...(lot.original_lines ? { original_lines: lot.original_lines } : {}),
        ...(deck.review
          ? { additive_default: Boolean(deck.review.additive_default) }
          : {}),
      },
      tag_ids: lot.tag_ids || [],
    };
    return [
      ...(lot.allocated_quantity
        ? [
            {
              ...base,
              id: `source:${deck.source_id}:${lot.line_id}`,
              quantity: lot.allocated_quantity,
              locations: lot.locations || [
                { tag_id: tag.id, quantity: lot.allocated_quantity },
              ],
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
