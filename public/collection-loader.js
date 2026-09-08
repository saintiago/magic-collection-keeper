export function validRows(rows) {
  return (
    Array.isArray(rows) &&
    rows.every(
      (row) =>
        row &&
        row.id != null &&
        typeof row.printing_id === "string" &&
        Number.isInteger(row.quantity) &&
        row.quantity > 0 &&
        typeof row.finish === "string" &&
        (row.locations == null ||
          (Array.isArray(row.locations) &&
            row.locations.every(
              (location) => location && typeof location.tag_id === "string",
            ))) &&
        (row.tags == null ||
          (Array.isArray(row.tags) &&
            row.tags.every((tag) => tag && typeof tag.label === "string"))) &&
        (row.tag_ids == null || Array.isArray(row.tag_ids)) &&
        row.card &&
        typeof row.card.name === "string" &&
        typeof row.card.set === "string" &&
        typeof row.card.set_name === "string" &&
        typeof row.card.lang === "string" &&
        (row.card.color_identity == null ||
          Array.isArray(row.card.color_identity)),
    )
  );
}
export function createCollectionLoader({
  load,
  cache,
  onChange,
  now = Date.now,
}) {
  let key,
    generation = 0,
    active = false;
  let state = { rows: null, status: "loading", savedAt: null, error: "" };
  // Serialize storage with account changes and invalidations so late writes cannot resurrect old data.
  let storage = Promise.resolve();
  function persist(action) {
    storage = storage.then(action).catch(() => {});
    return storage;
  }
  function publish(next) {
    state = { ...state, ...next };
    onChange(state);
  }
  async function start(nextKey) {
    const token = ++generation;
    active = true;
    key = nextKey;
    publish({ rows: null, status: "loading", savedAt: null, error: "" });
    let saved;
    try {
      saved = await cache.read(key);
    } catch {
      /* Storage denied or unavailable. */
    }
    if (token !== generation || !active) return;
    if (
      saved?.schema === 1 &&
      validRows(saved.rows) &&
      Number.isFinite(saved.savedAt) &&
      saved.savedAt > 0 &&
      saved.savedAt <= now() + 60000
    ) {
      publish({ rows: saved.rows, savedAt: saved.savedAt, status: "updating" });
    } else if (saved) {
      persist(() => cache.remove(nextKey));
    }
    return refresh();
  }
  async function refresh() {
    if (!active) return false;
    const token = ++generation;
    publish({
      status: state.rows === null ? "loading" : "updating",
      error: "",
    });
    try {
      const rows = await load();
      if (token !== generation || !active) return false;
      replace(rows);
      return true;
    } catch (error) {
      if (token === generation && active)
        publish({ status: "error", error: error.message });
      return false;
    }
  }
  function replace(rows) {
    if (!active) return;
    if (!validRows(rows))
      throw new Error("The collection response was incomplete. Please retry.");
    ++generation;
    const savedAt = now(),
      target = key;
    publish({ rows, savedAt, status: "ready", error: "" });
    persist(() => cache.write(target, { schema: 1, rows, savedAt }));
  }
  function invalidate() {
    ++generation;
    const target = key;
    if (active) persist(() => cache.remove(target));
  }
  function stop() {
    invalidate();
    active = false;
    publish({ rows: null, savedAt: null, status: "loading", error: "" });
    return storage;
  }
  return {
    start,
    refresh,
    replace,
    invalidate,
    stop,
    get state() {
      return state;
    },
    settled: () => storage,
  };
}
