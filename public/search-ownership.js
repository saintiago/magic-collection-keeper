export function searchOwnership(state) {
  const identities = new Map(),
    printings = new Map();
  for (const row of state.rows ?? []) {
    if (row.card.oracle_id)
      identities.set(
        row.card.oracle_id,
        (identities.get(row.card.oracle_id) || 0) + row.quantity,
      );
    printings.set(
      row.printing_id,
      (printings.get(row.printing_id) || 0) + row.quantity,
    );
  }
  return {
    status: state.status,
    known: state.rows !== null,
    identities,
    printings,
  };
}

export function suggestionOwnership(item, ownership) {
  if (!ownership?.known)
    return {
      label:
        ownership?.status === "error"
          ? "Ownership unavailable"
          : "Checking ownership…",
      icon: ownership?.status === "error" ? "?" : "…",
      owned: false,
    };
  const count =
    ownership.identities.get(item.oracle_id) ??
    ownership.printings.get(item.printing_id) ??
    0;
  const saved = ownership.status !== "ready";
  return {
    label: saved
      ? `Saved: ${count ? "owned" : "not owned"} · ${ownership.status === "error" ? "update failed" : "updating"}`
      : count
        ? "Owned"
        : "Not owned",
    icon: saved ? "◷" : count ? "✓" : "○",
    owned: !saved && count > 0,
  };
}
