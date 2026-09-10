const validText = (value, max = 200) =>
  typeof value === "string" && value.length > 0 && value.length <= max;
export function activityEntry(value) {
  if (value?.kind === "tag" && validText(value.id, 100))
    return { kind: "tag", id: value.id };
  if (!validText(value?.name) || !validText(value.printing_id, 100))
    return null;
  return {
    kind: "card",
    name: value.name,
    printing_id: value.printing_id,
    ...(validText(value.oracle_id, 100) ? { oracle_id: value.oracle_id } : {}),
    ...(typeof value.image_url === "string" &&
    /^https:\/\/cards\.scryfall\.io\//.test(value.image_url) &&
    value.image_url.length < 1000
      ? { image_url: value.image_url }
      : {}),
  };
}
export function activityEntries(values) {
  const seen = new Set(),
    counts = { card: 0, tag: 0 };
  return (Array.isArray(values) ? values : [])
    .slice(0, 100)
    .map(activityEntry)
    .filter((item) => {
      if (!item) return false;
      const key = `${item.kind}:${item.kind === "tag" ? item.id : item.printing_id}`;
      if (seen.has(key) || counts[item.kind] >= 12) return false;
      seen.add(key);
      counts[item.kind]++;
      return true;
    });
}
export function createHomeHistory({
  storage = {
    read: (key) => localStorage.getItem(key),
    write: (key, value) => localStorage.setItem(key, value),
    remove: (key) => localStorage.removeItem(key),
  },
  onChange = () => {},
} = {}) {
  let key = null,
    state = { entries: [], status: "loading", error: "" };
  function publish(next) {
    state = { ...state, ...next };
    onChange(state);
  }
  return {
    start(account) {
      if (!account) throw Error("Verified account required for home activity.");
      const next = `keeper-home-v1:${account}`;
      if (key === next) return;
      key = next;
      publish({ entries: [], status: "ready", error: "" });
      try {
        const raw = storage.read(key);
        const saved = raw && raw.length < 50000 ? JSON.parse(raw) : null;
        publish({
          entries: saved?.schema === 1 ? activityEntries(saved.entries) : [],
        });
      } catch {
        publish({
          error:
            "Recent activity is unavailable on this browser. New activity will appear for this visit.",
        });
      }
    },
    remember(value) {
      if (!key) return;
      const item = activityEntry(value);
      if (!item) return;
      const entries = activityEntries([item, ...state.entries]);
      let error = "";
      try {
        storage.write(key, JSON.stringify({ schema: 1, entries }));
      } catch {
        error = "Recent activity is saved for this visit only.";
      }
      publish({ entries, error });
    },
    clear() {
      if (!key) return;
      try {
        storage.remove(key);
        publish({ entries: [], error: "" });
      } catch {
        publish({ error: "Could not clear recent activity. Please retry." });
      }
    },
    stop() {
      key = null;
      publish({ entries: [], status: "locked", error: "" });
    },
    unavailable() {
      key = null;
      publish({
        entries: [],
        status: "unavailable",
        error: "Verify your account to load recent activity.",
      });
    },
    get state() {
      return state;
    },
  };
}
