export function createDetailCache({ now = Date.now } = {}) {
  const cards = new Map();
  const valid = (c) =>
    c?.id &&
    c.oracle_id &&
    c.lang === "en" &&
    !c.digital &&
    c.games?.includes("paper");
  function remember(items) {
    for (const card of items || [])
      if (valid(card)) {
        if (cards.size >= 100 && !cards.has(card.id))
          cards.delete(cards.keys().next().value);
        cards.set(card.id, { card, at: now() });
      }
  }
  return {
    remember,
    async load(oracle, printing, fetcher, signal) {
      const saved = cards.get(printing),
        t = performance.now();
      if (signal?.aborted) throw signal.reason;
      if (
        saved &&
        saved.card.oracle_id === oracle &&
        now() - saved.at < 86400000
      ) {
        return {
          cards: [saved.card],
          total: 1,
          hasMore: false,
          catalog: null,
          timing: { phase: "browser-detail-hit", ms: performance.now() - t },
        };
      }
      const result = await fetcher();
      if (signal?.aborted) throw signal.reason;
      remember(result.cards);
      return result;
    },
  };
}
