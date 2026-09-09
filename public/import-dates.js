export function groupDraftDates(drafts, { now = new Date(), locale } = {}) {
  const key = (date) =>
    `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const groups = new Map();
  for (const draft of [...drafts].sort(
    (a, b) =>
      (b.created_at || "").localeCompare(a.created_at || "") ||
      a.id.localeCompare(b.id),
  )) {
    const date = new Date(draft.created_at || NaN),
      valid = !Number.isNaN(date.valueOf());
    const day = valid ? key(date) : "unknown";
    const label = !valid
      ? "Creation date unknown"
      : day === key(now)
        ? "Today"
        : day === key(yesterday)
          ? "Yesterday"
          : date.toLocaleDateString(locale, {
              year: "numeric",
              month: "short",
              day: "numeric",
            });
    if (!groups.has(day)) groups.set(day, { label, drafts: [] });
    groups.get(day).drafts.push(draft);
  }
  return [...groups.values()];
}
