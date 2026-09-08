export function normalizeName(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// Bulk records stay outside the browser. One English paper printing represents
// an identity; multilingual names are aliases, never additional result cards.
export function createNameIndexBuilder() {
  const identities = new Map();
  function preference(card) {
    return `${Number(!card.promo)}${Number(!card.textless)}${Number(!card.full_art)}${card.released_at || "0000-00-00"}${card.id}`;
  }
  return {
    add(card) {
      if (!card.oracle_id || card.digital || !card.games?.includes("paper"))
        return;
      let entry = identities.get(card.oracle_id);
      if (!entry)
        identities.set(
          card.oracle_id,
          (entry = { aliases: new Map(), english: null }),
        );
      if (
        card.lang === "en" &&
        (!entry.english || preference(card) > preference(entry.english))
      )
        entry.english = {
          id: card.id,
          name: card.name,
          promo: card.promo,
          textless: card.textless,
          full_art: card.full_art,
          released_at: card.released_at,
        };
      for (const [name, lang] of [
        [card.name, "en"],
        [card.printed_name, card.lang],
        ...(card.card_faces || []).flatMap((f) => [
          [f.name, "en"],
          [f.printed_name, card.lang],
        ]),
      ]) {
        if (typeof name === "string" && name.trim() && name.length <= 300)
          entry.aliases.set(`${lang}:${name}`, [name, lang]);
      }
    },
    finish() {
      return [...identities]
        .filter(([, entry]) => entry.english)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, entry]) => [
          id,
          entry.english.name,
          entry.english.id,
          [...entry.aliases.values()]
            .filter(([name]) => name !== entry.english.name)
            .sort(
              ([a, al], [b, bl]) => a.localeCompare(b) || al.localeCompare(bl),
            ),
        ]);
    },
  };
}

export function oneEdit(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0,
    j = 0,
    edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length === b.length && a[i] === b[j + 1] && a[i + 1] === b[j]) {
      i += 2;
      j += 2;
    } else if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + Number(i < a.length || j < b.length) <= 1;
}
function lexicalRank(name, query, words) {
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  const tokens = name.split(" ");
  if (words.every((word) => tokens.some((token) => token.startsWith(word))))
    return 2;
  if (name.includes(query)) return 3;
  return null;
}
export function createNameSearch(rows) {
  const entries = rows.map(([oracle_id, name, printing_id, aliases]) => ({
    oracle_id,
    name,
    printing_id,
    terms: [[name, "en"], ...aliases].map(([text, language]) => ({
      text,
      language,
      normalized: normalizeName(text),
    })),
  }));
  const byId = new Map(entries.map((e) => [e.oracle_id, e]));
  const prefixes = new Map();
  for (let i = 0; i < entries.length; i++) {
    const keys = new Set(
      entries[i].terms.flatMap((term) =>
        term.normalized.split(" ").map((word) => word.slice(0, 2)),
      ),
    );
    for (const key of keys) {
      if (!prefixes.has(key)) prefixes.set(key, []);
      prefixes.get(key).push(i);
    }
  }
  function dto(entry, match = entry.terms[0], rank = 0) {
    return {
      oracle_id: entry.oracle_id,
      name: entry.name,
      printing_id: entry.printing_id,
      matched_name: match.text === entry.name ? null : match.text,
      matched_language: match.text === entry.name ? null : match.language,
      rank,
      completion_length: match.normalized.length,
    };
  }
  return {
    identity(id) {
      const entry = byId.get(id);
      return entry ? dto(entry) : null;
    },
    search(text, { suggest = false } = {}) {
      const query = normalizeName(text);
      if (
        !query ||
        (suggest &&
          query.length < 2 &&
          !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
            query,
          ))
      )
        return [];
      const words = query.split(" ");
      const matches = new Map();
      const englishMatches = new Set();
      function inspect(entry) {
        let best = null;
        for (const term of entry.terms) {
          const rank = lexicalRank(term.normalized, query, words);
          if (rank === null) continue;
          if (term.language === "en") englishMatches.add(entry.oracle_id);
          if (
            !best ||
            rank < best.rank ||
            (rank === best.rank &&
              term.normalized.length < best.match.normalized.length) ||
            (rank === best.rank &&
              term.normalized.length === best.match.normalized.length &&
              term.language === "en" &&
              best.match.language !== "en")
          )
            best = { rank, match: term };
        }
        if (best)
          matches.set(entry.oracle_id, dto(entry, best.match, best.rank));
      }
      const candidates = suggest
        ? prefixes.get(words[0].slice(0, 2)) || []
        : entries.map((_, i) => i);
      candidates.forEach((i) => inspect(entries[i]));
      if (suggest && matches.size < 8)
        entries.forEach((entry) => {
          if (!matches.has(entry.oracle_id)) inspect(entry);
        });
      if (!matches.size && query.length >= 4) {
        for (const entry of entries) {
          const match = entry.terms.find(
            (term) =>
              oneEdit(query, term.normalized) ||
              term.normalized.split(" ").some((word) => oneEdit(query, word)),
          );
          if (match) matches.set(entry.oracle_id, dto(entry, match, 4));
        }
      }
      return [...matches.values()]
        .sort(
          (a, b) =>
            a.rank - b.rank ||
            (a.rank === 0
              ? Number(Boolean(a.matched_name)) -
                Number(Boolean(b.matched_name))
              : 0) ||
            a.completion_length - b.completion_length ||
            a.name.localeCompare(b.name, "en") ||
            a.oracle_id.localeCompare(b.oracle_id),
        )
        .map((match) =>
          // Explain only a foreign-only match, after sorting so display metadata
          // cannot change the established multilingual ranking.
          englishMatches.has(match.oracle_id) || match.matched_language === "en"
            ? { ...match, matched_name: null, matched_language: null }
            : match,
        );
    },
  };
}
