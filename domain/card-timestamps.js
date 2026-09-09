// SQLite's historical UTC format has no suffix; never interpret it as local time.
export function utcTimestamp(value) {
  if (typeof value !== "string" || !value) return null;
  const date = new Date(
    /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value)
      ? value.replace(" ", "T") + "Z"
      : value,
  );
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}
export function cardTimestamps(components, edits = []) {
  const created = components.map((row) => utcTimestamp(row.created_at));
  const modified = [...components, ...edits]
    .map((row) => utcTimestamp(row?.updated_at))
    .filter(Boolean)
    .sort();
  return {
    created_at:
      created.length && created.every(Boolean) ? created.sort()[0] : null,
    updated_at: modified.at(-1) || null,
  };
}
