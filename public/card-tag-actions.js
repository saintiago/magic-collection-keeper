// Concrete browser tag I/O. Owned and pending mutations use separate targeted,
// idempotent ports; catalogue tags stage one durable review, never ownership.
export function createCardTagActions({ api, save, tags }) {
  let key = null,
    generation = 0,
    refs = [],
    storageError = "";
  function remember(ref, saved = false) {
    const next = [
      ref,
      ...refs.filter((entry) => entry.printingId !== ref.printingId),
    ].slice(0, 50);
    if (!key)
      throw Error(storageError || "Verify your account before changing tags.");
    try {
      sessionStorage.setItem(key, JSON.stringify(next));
    } catch {
      throw Error(
        saved
          ? "Your tag was saved, but this browser could not remember the pending review. Open Import to continue."
          : "This browser could not protect the pending selection. No new capture was staged.",
      );
    }
    refs = next;
  }
  function pendingItem(item, draft, row) {
    item.kind = "pending";
    item.row = row;
    item.draftId = draft.id;
    item.draftKind = draft.provider === "reviewed-capture" ? "capture" : "url";
    item.sourceId = draft.source_id;
    return item;
  }
  function decorate(item) {
    if (!["catalog", "reference"].includes(item.kind)) return item;
    // Stored references locate a server review; cached row contents are never
    // rendered or treated as evidence that the review is still pending.
    return item;
  }
  return {
    start(account) {
      generation++;
      key = "keeper-catalog-tags-v1:" + account;
      refs = [];
      storageError = "";
      try {
        const raw = sessionStorage.getItem(key);
        if (raw && raw.length >= 250000)
          throw Error("Pending references too large");
        const parsed = raw ? JSON.parse(raw) : [];
        if (
          !Array.isArray(parsed) ||
          parsed.length > 50 ||
          parsed.some(
            (ref) =>
              !ref ||
              !validId(ref.printingId) ||
              !validId(ref.draftId) ||
              !validId(ref.rowId),
          )
        )
          throw Error("Invalid pending references");
        refs = parsed.map(({ printingId, draftId, rowId }) => ({
          printingId,
          draftId,
          rowId,
        }));
      } catch {
        key = null;
        storageError =
          "Saved pending selections could not be read. Reload before changing catalogue tags.";
      }
    },
    stop() {
      generation++;
      key = null;
      refs = [];
    },
    decorate,
    async load(item) {
      const turn = generation;
      const available = await api("/api/tags");
      if (turn !== generation)
        throw new DOMException("Account changed", "AbortError");
      const ref = refs.find((ref) => ref.printingId === item.card.id);
      if (ref && (!item.draftId || item.draftId === ref.draftId)) {
        let result;
        try {
          result = await api(
            "/api/import-draft?" + new URLSearchParams({ id: ref.draftId }),
          );
        } catch (error) {
          if (error.status !== 404) throw error;
          result = { draft: null };
        }
        if (turn !== generation)
          throw new DOMException("Account changed", "AbortError");
        const row = result.draft?.rows.find((row) => row.id === ref.rowId);
        if (row) pendingItem(item, result.draft, row);
        else {
          refs = refs.filter((entry) => entry !== ref);
          if (item.draftId === ref.draftId) {
            item.kind = "catalog";
            item.row = { card: item.card };
            delete item.draftId;
            delete item.draftKind;
            delete item.sourceId;
            delete item.sourceTagId;
          }
          if (key) sessionStorage.setItem(key, JSON.stringify(refs));
        }
      }
      item.sourceTagId = available.find(
        (tag) => tag.source?.id && tag.source.id === item.sourceId,
      )?.id;
      return available;
    },
    async toggle(item, tag, selected, quantity = 1) {
      const turn = generation;
      if (["catalog", "reference"].includes(item.kind)) await this.load(item);
      let intent;
      if (item.kind === "owned")
        intent = {
          kind: "owned",
          itemKey: "owned:" + item.row.id,
          payload: {
            operation_id: crypto.randomUUID(),
            inventory_id: String(item.row.id),
            tag_id: tag.id,
            selected,
            quantity,
          },
        };
      else if (item.kind === "pending")
        intent = {
          kind: "pending",
          itemKey: "pending:" + item.draftId + ":" + item.row.id,
          payload: {
            operation_id: crypto.randomUUID(),
            id: item.draftId,
            kind:
              item.draftKind ||
              (item.row.original?.capture_kind ? "capture" : "url"),
            row_id: item.row.id,
            tag_id: tag.id,
            selected,
            quantity,
          },
        };
      else {
        if (!selected) return item;
        let card = item.card;
        if (!card.finishes?.length) {
          const result = await api(
            "/api/card?" +
              new URLSearchParams({
                oracle: card.oracle_id || "",
                printing: card.id,
              }),
          );
          if (turn !== generation)
            throw new DOMException("Account changed", "AbortError");
          card = result.cards?.find((entry) => entry.id === item.card.id);
          if (!card)
            throw Error(
              "This printing could not be verified. Open its card page.",
            );
        }
        const prior = refs.find((ref) => ref.printingId === card.id);
        const ref = prior || {
          printingId: card.id,
          draftId: crypto.randomUUID(),
          rowId: crypto.randomUUID(),
        };
        remember(ref);
        intent = {
          kind: "catalog",
          itemKey: "catalog:" + card.id,
          payload: {
            id: ref.draftId,
            kind: "catalog",
            tag_id: tag.id,
            rows: [
              {
                id: ref.rowId,
                name: card.name,
                printing_id: card.id,
                quantity: 1,
                finish: card.finishes.includes("nonfoil")
                  ? "nonfoil"
                  : card.finishes[0],
                condition: "UNK",
              },
            ],
          },
        };
      }
      const outcome = await save({ ...intent, tag: tag.id, inline: true });
      if (turn !== generation || outcome?.cancelled)
        throw new DOMException("Account changed", "AbortError");
      if (!outcome?.result)
        throw Error(
          outcome?.error ||
            "The tag could not be confirmed. Retry the same action.",
        );
      const { result } = outcome;
      if (intent.kind === "owned") {
        const row = result.find(
          (row) => String(row.id) === String(item.row.id),
        );
        if (!row)
          throw Error(
            "This owned entry is no longer available. Refresh the collection.",
          );
        item.row = row;
      } else {
        const rowId =
          outcome.intent.kind === "catalog"
            ? outcome.intent.payload.rows[0].id
            : outcome.intent.payload.row_id;
        const row = result.draft?.rows.find((row) => row.id === rowId);
        if (!row)
          throw Error("This review is already processed. Reload Import.");
        pendingItem(item, result.draft, row);
        if (
          refs.some(
            (ref) =>
              ref.printingId === item.card.id &&
              ref.draftId === result.draft.id,
          )
        )
          remember(
            {
              printingId: item.card.id,
              draftId: result.draft.id,
              rowId: row.id,
            },
            true,
          );
      }
      item.sourceTagId = tags().find(
        (entry) => entry.source?.id && entry.source.id === item.sourceId,
      )?.id;
      return item;
    },
  };
}

function validId(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}
