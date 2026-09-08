export function locationQuantity(row, tagId) {
  return (row.locations ?? []).reduce(
    (sum, location) =>
      sum + (location.tag_id === tagId ? location.quantity : 0),
    0,
  );
}
export function displayedQuantity(row, tag) {
  return tag?.type === "location"
    ? locationQuantity(row, tag.id)
    : row.quantity;
}
export function collectionCountText(allRows, visibleRows, tag) {
  const sum = (rows) =>
    rows.reduce((total, row) => total + displayedQuantity(row, tag), 0);
  const count = sum(visibleRows),
    total = sum(allRows);
  const label = tag?.type === "location" ? "assigned copies" : "owned copies";
  return `${count.toLocaleString()} ${label}${count !== total ? ` of ${total.toLocaleString()}` : ""} · ${visibleRows.length.toLocaleString()} distinct ${visibleRows.length === 1 ? "entry" : "entries"}`;
}
export function sourceCounts(deck) {
  const imported = deck.lots.reduce(
    (sum, lot) => sum + lot.allocated_quantity,
    0,
  );
  const pending = (deck.pending ?? []).reduce(
    (sum, row) => sum + row.quantity,
    0,
  );
  return { total: imported + pending, imported, pending };
}
export function collectionTags(rows) {
  return [
    ...new Map(
      rows
        .flatMap((row) => [
          ...(row.locations ?? []).map((location) => location.tag),
          ...(row.tags ?? []),
        ])
        .filter((tag) => tag?.id)
        .map((tag) => [tag.id, tag]),
    ).values(),
  ];
}
