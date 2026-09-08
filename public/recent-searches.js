const LIMIT = 10;
const text = (value, max = 200) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;
function entry(value) {
  if (!value) return null;
  if (value.kind === "query")
    return text(value.name, 900)
      ? { kind: "query", name: value.name.trim() }
      : null;
  if (!text(value.name)) return null;
  if (!text(value.oracle_id, 100) || !text(value.printing_id, 100)) return null;
  return {
    kind: "card",
    name: value.name.trim(),
    oracle_id: value.oracle_id,
    printing_id: value.printing_id,
    ...(text(value.matched_name) && text(value.matched_language, 10)
      ? {
          matched_name: value.matched_name,
          matched_language: value.matched_language,
        }
      : {}),
  };
}
const identity = (item) =>
  item.kind === "card"
    ? `card:${item.oracle_id}`
    : `query:${item.name.toLowerCase().replace(/\s+/g, " ")}`;
export function recentEntries(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set(),
    result = [];
  for (const value of values.slice(0, 100)) {
    const item = entry(value);
    if (!item || seen.has(identity(item))) continue;
    seen.add(identity(item));
    result.push(item);
    if (result.length === LIMIT) break;
  }
  return result;
}
export function createRecentSearches({
  storage = {
    read: (key) => localStorage.getItem(key),
    write: (key, value) => localStorage.setItem(key, value),
    remove: (key) => localStorage.removeItem(key),
  },
  onChange = () => {},
} = {}) {
  let key = null,
    state = { entries: [], status: "locked", error: "" };
  function publish(next) {
    state = { ...state, ...next };
    onChange(state);
  }
  function start(accountKey) {
    if (!accountKey)
      throw new Error("Verified account required for recent searches.");
    const nextKey = `keeper-recent-v1:${accountKey}`;
    if (key === nextKey) return;
    key = nextKey;
    publish({ entries: [], status: "ready", error: "" });
    try {
      const raw = storage.read(key);
      const saved = raw && raw.length <= 50000 ? JSON.parse(raw) : null;
      publish({
        entries: saved?.schema === 1 ? recentEntries(saved.entries) : [],
      });
    } catch {
      publish({
        error:
          "Recent searches are available for this visit only; browser storage is unavailable.",
      });
    }
  }
  function remember(value) {
    if (!key) return;
    const item = entry(value);
    if (!item) return;
    const entries = recentEntries([item, ...state.entries]);
    let error = "";
    try {
      storage.write(key, JSON.stringify({ schema: 1, entries }));
    } catch {
      error =
        "Recent searches are available for this visit only; browser storage is unavailable.";
    }
    publish({ entries, error });
  }
  function clear() {
    if (!key) return;
    try {
      storage.remove(key);
      publish({ entries: [], error: "" });
    } catch {
      publish({
        error:
          "Could not clear saved recent searches. Browser storage is unavailable; please retry.",
      });
    }
  }
  function stop() {
    key = null;
    publish({ entries: [], status: "locked", error: "" });
  }
  function unavailable() {
    key = null;
    publish({
      entries: [],
      status: "unavailable",
      error:
        "Recent searches unavailable until your account is verified. Retry Update collection.",
    });
  }
  return {
    start,
    remember,
    clear,
    stop,
    unavailable,
    get state() {
      return state;
    },
  };
}
