import { normalizeName, oneEdit } from "./card-names.js";

function rankName(name, query, words) {
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  let all = true;
  for (const word of words) {
    let at = name.indexOf(word);
    while (at > 0 && name.charCodeAt(at - 1) !== 32)
      at = name.indexOf(word, at + 1);
    if (at < 0) {
      all = false;
      break;
    }
  }
  return all ? 2 : name.includes(query) ? 3 : 5;
}
function fuzzyName(name, query) {
  if (oneEdit(query, name)) return true;
  let start = 0;
  while (start < name.length) {
    let end = name.indexOf(" ", start);
    if (end < 0) end = name.length;
    if (
      Math.abs(end - start - query.length) <= 1 &&
      oneEdit(query, name.slice(start, end))
    )
      return true;
    start = end + 1;
  }
  return false;
}

// Flat numeric term records and shared strings avoid a per-alias object graph.
export function buildCompactNames(rows) {
  const strings = [],
    ids = new Map(),
    terms = [],
    cards = [];
  function intern(text) {
    if (!ids.has(text)) {
      ids.set(text, strings.length);
      strings.push(text);
    }
    return ids.get(text);
  }
  for (const [oracle, name, printing, aliases] of rows) {
    const start = terms.length;
    for (const [text, lang] of [[name, "en"], ...aliases]) {
      terms.push(intern(text), intern(lang));
    }
    cards.push([oracle, intern(name), printing, start, terms.length]);
  }
  return { schema: 1, strings, terms, cards };
}

export function createCompactSearch(data) {
  const { strings, cards, terms } = data || {};
  if (
    data?.schema !== 1 ||
    !Array.isArray(strings) ||
    !Array.isArray(cards) ||
    !(Array.isArray(terms) || terms instanceof Uint32Array) ||
    cards.length > 100000 ||
    terms.length > 3000000 ||
    strings.some((s) => typeof s !== "string" || s.length > 1000) ||
    terms.length % 2 ||
    terms.some((n) => !Number.isInteger(n) || n < 0 || n >= strings.length)
  )
    throw Error("Invalid compact catalog");
  let end = 0;
  for (const card of cards) {
    if (
      !Array.isArray(card) ||
      card.length !== 5 ||
      typeof card[0] !== "string" ||
      typeof card[2] !== "string" ||
      !Number.isInteger(card[1]) ||
      !strings[card[1]] ||
      card[3] !== end ||
      !Number.isInteger(card[4]) ||
      card[4] <= end ||
      card[4] > terms.length ||
      card[4] % 2
    )
      throw Error("Invalid catalog card");
    end = card[4];
  }
  if (end !== terms.length) throw Error("Invalid catalog terms");
  const normalized = strings.map(normalizeName),
    prefixes = Object.create(null);
  for (let i = 0; i < cards.length; i++) {
    const keys = new Set();
    for (let t = cards[i][3]; t < cards[i][4]; t += 2)
      for (const word of normalized[terms[t]].split(" "))
        keys.add(word.slice(0, 2));
    for (const key of keys) (prefixes[key] ||= []).push(i);
  }
  const byId = new Map(cards.map((c, i) => [c[0], i]));
  function dto(i, term = cards[i][3], rank = 0) {
    const c = cards[i],
      text = strings[terms[term]],
      name = strings[c[1]];
    return {
      oracle_id: c[0],
      name,
      printing_id: c[2],
      matched_name: text === name ? null : text,
      matched_language: text === name ? null : strings[terms[term + 1]],
      rank,
      completion_length: normalized[terms[term]].length,
    };
  }
  return {
    identity(id) {
      const i = byId.get(id);
      return i == null ? null : dto(i);
    },
    search(text, { suggest = false } = {}) {
      const q = normalizeName(text);
      if (
        !q ||
        (suggest &&
          q.length < 2 &&
          !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
            q,
          ))
      )
        return [];
      const words = q.split(" "),
        matches = new Map(),
        english = new Set();
      function inspect(i) {
        let best = -1,
          bestRank = 5,
          length = Infinity;
        for (let t = cards[i][3]; t < cards[i][4]; t += 2) {
          const n = normalized[terms[t]],
            lang = strings[terms[t + 1]];
          const rank = rankName(n, q, words);
          if (rank === 5) continue;
          if (lang === "en") english.add(i);
          if (
            rank < bestRank ||
            (rank === bestRank &&
              (n.length < length ||
                (n.length === length &&
                  lang === "en" &&
                  strings[terms[best + 1]] !== "en")))
          ) {
            best = t;
            bestRank = rank;
            length = n.length;
          }
        }
        if (best >= 0) matches.set(i, dto(i, best, bestRank));
      }
      if (suggest) (prefixes[words[0].slice(0, 2)] || []).forEach(inspect);
      if (!suggest || matches.size < 8)
        for (let i = 0; i < cards.length; i++) if (!matches.has(i)) inspect(i);
      if (!matches.size && q.length >= 4)
        for (let i = 0; i < cards.length; i++) {
          for (let t = cards[i][3]; t < cards[i][4]; t += 2) {
            const n = normalized[terms[t]];
            if (fuzzyName(n, q)) {
              matches.set(i, dto(i, t, 4));
              break;
            }
          }
        }
      return [...matches.entries()]
        .sort(
          ([, a], [, b]) =>
            a.rank - b.rank ||
            (a.rank === 0
              ? Number(Boolean(a.matched_name)) -
                Number(Boolean(b.matched_name))
              : 0) ||
            a.completion_length - b.completion_length ||
            a.name.localeCompare(b.name, "en") ||
            a.oracle_id.localeCompare(b.oracle_id),
        )
        .map(([i, m]) =>
          english.has(i) || m.matched_language === "en"
            ? { ...m, matched_name: null, matched_language: null }
            : m,
        );
    },
  };
}

export function encodeCompactNames(data) {
  const meta = new TextEncoder().encode(
    JSON.stringify({
      schema: data.schema,
      strings: data.strings,
      cards: data.cards,
    }),
  );
  const bytes = new Uint8Array(12 + meta.length + data.terms.length * 4),
    view = new DataView(bytes.buffer);
  view.setUint32(0, 0x4b4e3031);
  view.setUint32(4, meta.length, true);
  view.setUint32(8, data.terms.length, true);
  bytes.set(meta, 12);
  data.terms.forEach((n, i) =>
    view.setUint32(12 + meta.length + i * 4, n, true),
  );
  return bytes;
}
export function decodeCompactNames(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12 || view.getUint32(0) !== 0x4b4e3031)
    throw Error("Invalid catalog format");
  const size = view.getUint32(4, true),
    count = view.getUint32(8, true);
  if (count > 3000000 || bytes.length !== 12 + size + count * 4)
    throw Error("Invalid catalog length");
  const data = JSON.parse(
    new TextDecoder().decode(bytes.subarray(12, 12 + size)),
  );
  data.terms = new Uint32Array(count);
  for (let i = 0; i < count; i++)
    data.terms[i] = view.getUint32(12 + size + i * 4, true);
  return data;
}
