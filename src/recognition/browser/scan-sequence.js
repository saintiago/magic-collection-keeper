// Oracle identity is independent of suggested printing/language/finish.
// Only initial ordered capture results advance this sequence, never late updates.
export function createScanSequence(previous) {
  return {
    current: () => previous || null,
    accept(card) {
      const identity = card?.oracle_id;
      if (typeof identity !== "string" || !identity) return "unresolved";
      if (identity === previous) return "duplicate";
      previous = identity;
      return "accepted";
    },
  };
}
