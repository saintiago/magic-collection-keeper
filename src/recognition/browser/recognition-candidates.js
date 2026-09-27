// SPDX-License-Identifier: AGPL-3.0-only
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function resolveRecognition(
  data,
  { request, signal, attempt, cache },
) {
  if (
    data.contractVersion !== 1 ||
    data.attempt !== attempt ||
    !["unknown", "possible"].includes(data.status)
  )
    throw new Error("Recognition response is not approved");
  const candidates = (
    data.status === "possible" && Array.isArray(data.candidates)
      ? data.candidates
      : []
  )
    .slice(0, 5)
    .filter(
      (c) =>
        uuid.test(c.id) &&
        uuid.test(c.oracle_id) &&
        typeof c.name === "string" &&
        c.name.length <= 200,
    );
  const primary = candidates[0]?.oracle_id;
  const exact =
    data.evidence?.exactPrintingId || data.evidence?.printingReferenceId;
  const language = [
    "en",
    "es",
    "fr",
    "de",
    "it",
    "pt",
    "ja",
    "ko",
    "ru",
    "zhs",
    "zht",
  ].includes(data.evidence?.titleLanguage)
    ? data.evidence.titleLanguage
    : null;
  // Footer corroboration first; otherwise choose a regular numbered printing.
  // This is an editable suggestion, never a claim that its edition is recognized.
  const ranked = candidates
    .filter((c) => c.oracle_id === primary)
    .sort(
      (a, b) =>
        Number(b.id === exact) - Number(a.id === exact) ||
        Number(!/^\d+$/.test(a.collector_number || "")) -
          Number(!/^\d+$/.test(b.collector_number || "")) ||
        Number(!(a.finishes || []).includes("nonfoil")) -
          Number(!(b.finishes || []).includes("nonfoil")) ||
        Number(a.lang !== "en") - Number(b.lang !== "en"),
    );
  const cards = [],
    started = performance.now();
  let cacheHits = 0,
    lookups = 0;
  for (const candidate of ranked.slice(0, 1)) {
    signal?.throwIfAborted();
    const key =
      candidate.id + ":" + candidate.oracle_id + ":" + (language || "");
    const saved = cache?.get(key);
    if (saved) {
      cards.push(saved);
      cacheHits++;
      continue;
    }
    lookups++;
    if (
      language &&
      language !== candidate.lang &&
      /^[a-z0-9]{2,8}$/.test(candidate.set || "") &&
      /^[0-9a-z]{1,10}$/.test(candidate.collector_number || "")
    ) {
      const translated = await request(
        `/api/search?${new URLSearchParams({ q: `oracleid:${primary} set:${candidate.set} cn:${candidate.collector_number} lang:${language}` })}`,
        { signal },
      );
      signal?.throwIfAborted();
      const card = translated.cards?.find(
        (c) =>
          uuid.test(c.id) &&
          c.oracle_id === primary &&
          c.lang === language &&
          c.set === candidate.set &&
          c.collector_number === candidate.collector_number &&
          c.finishes?.length,
      );
      if (card) {
        cards.push(card);
        if (cache) {
          cache.set(key, card);
          if (cache.size > 100) cache.delete(cache.keys().next().value);
        }
        continue;
      }
      lookups++;
    }
    const result = await request(
      `/api/card?${new URLSearchParams({ printing: candidate.id, oracle: candidate.oracle_id })}`,
      { signal },
    );
    signal?.throwIfAborted();
    const card = result.cards?.[0];
    if (
      card?.id === candidate.id &&
      card.oracle_id === candidate.oracle_id &&
      Array.isArray(card.finishes) &&
      card.finishes.length
    ) {
      cards.push(card);
      if (cache) {
        cache.set(key, card);
        if (cache.size > 100) cache.delete(cache.keys().next().value);
      }
    }
  }
  return {
    status: data.status,
    waitingForSingleCard: ["multiple", "ambiguous"].includes(
      data.evidence?.visual?.cardPresence?.state,
    ),
    name: cards[0]?.name || "Unclear reading",
    candidates: cards,
    selected: cards[0] || null,
    suggested: Boolean(cards[0]),
    query: primary ? `oracleid:${primary} lang:${language || "en"}` : "",
    note: "Suggested printing. Check set, collector number and language; use Find to see other printings.",
    finish: cards[0]?.finishes.includes("nonfoil")
      ? "nonfoil"
      : cards[0]?.finishes[0] || "nonfoil",
    condition: "NM",
    quantity: 1,
    measurement: {
      processing: data.timings,
      evidence: data.evidence,
      versions: data.versions,
      cacheHits,
      lookups,
      hydrateMs: performance.now() - started,
    },
  };
}
