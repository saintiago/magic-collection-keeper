import { rankActionTags } from "./card-action-layout.js";

export function assignedTagIds(item) {
  return new Set([
    ...(item.row?.tag_ids || []),
    ...(item.row?.tags || []).map((tag) => tag.id),
    ...(item.row?.locations || [])
      .filter((entry) => entry.quantity > 0)
      .map((entry) => entry.tag_id),
    ...(item.sourceTagId && item.row?.in_deck ? [item.sourceTagId] : []),
  ]);
}
export function relevantCardTags(item, available, recent = []) {
  const all = new Map(
    [
      ...available,
      ...(item.row?.tags || []),
      ...(item.row?.locations || []).map((entry) => entry.tag).filter(Boolean),
    ].map((tag) => [tag.id, tag]),
  );
  return rankActionTags(
    [...all.values()].filter(
      (tag) =>
        tag.type !== "system" &&
        tag.family !== "system" &&
        tag.key !== "system:import-pending",
    ),
    recent,
    [...assignedTagIds(item)],
  );
}

// Both zoom presentations subscribe to the same per-open-card state. Intent is
// serialized and coalesced, while the server sets an explicit value by tag ID.
export function createCardTagState(item, { available, recent, load, toggle }) {
  const listeners = new Set(),
    quantities = new Map(
      (item.row?.locations || []).map((entry) => [
        entry.tag_id,
        entry.quantity,
      ]),
    );
  let tags = relevantCardTags(item, available(), recent()),
    confirmed = assignedTagIds(item),
    desired = new Map(),
    errors = new Map(),
    busy = null,
    loading = true,
    loadError = "";
  const publish = () => listeners.forEach((listener) => listener());
  async function drain() {
    if (busy || loading || loadError) return;
    const next = [...desired].find(
      ([id, value]) => confirmed.has(id) !== value,
    );
    if (!next) return;
    const [id, value] = next,
      tag = tags.find((tag) => tag.id === id);
    if (!tag) {
      desired.delete(id);
      return;
    }
    busy = id;
    errors.delete(id);
    publish();
    try {
      await toggle(item, tag, value, quantities.get(id) || 1);
      confirmed = assignedTagIds(item);
      for (const entry of item.row?.locations || [])
        quantities.set(entry.tag_id, entry.quantity);
      if (desired.get(id) === confirmed.has(id)) desired.delete(id);
    } catch (error) {
      desired.clear();
      errors.set(
        id,
        error.name === "AbortError"
          ? "Account changed. Reopen this card."
          : error.message,
      );
    } finally {
      busy = null;
      publish();
      void drain();
    }
  }
  async function prepare() {
    loading = true;
    loadError = "";
    publish();
    try {
      tags = relevantCardTags(item, await load(item), recent());
      confirmed = assignedTagIds(item);
      for (const entry of item.row?.locations || [])
        quantities.set(entry.tag_id, entry.quantity);
    } catch (error) {
      loadError = error.message;
    } finally {
      loading = false;
      publish();
    }
  }
  void prepare();
  return {
    subscribe(listener) {
      listeners.add(listener);
      listener();
      return () => listeners.delete(listener);
    },
    get view() {
      return { tags, confirmed, desired, errors, busy, loading, loadError };
    },
    select(id) {
      if (loading || loadError || !tags.some((tag) => tag.id === id)) return;
      desired.set(id, !(desired.has(id) ? desired.get(id) : confirmed.has(id)));
      errors.delete(id);
      publish();
      void drain();
    },
    retry: prepare,
  };
}
