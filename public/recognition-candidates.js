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
  const cards = [],
    started = performance.now();
  let cacheHits = 0,
    lookups = 0;
  for (const candidate of candidates.filter((c) => c.oracle_id === primary)) {
    signal?.throwIfAborted();
    const key = candidate.id + ":" + candidate.oracle_id;
    const saved = cache?.get(key);
    if (saved) {
      cards.push(saved);
      cacheHits++;
      continue;
    }
    lookups++;
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
    name: cards[0]?.name || "Unclear reading",
    candidates: cards,
    selected: null,
    finish: "nonfoil",
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
