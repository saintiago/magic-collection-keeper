import { ApplicationError } from "../domain/inventory.js";
import {
  IMPORT_PENDING_TAG,
  moxfieldSource,
  printingSummary,
  sameCard,
  validateDraftRows,
  draftProblems,
  draftDeck,
} from "../domain/import-draft.js";

export function createImportDraftService({
  store,
  provider,
  catalog,
  repository,
  collection,
  newId,
  now = () => new Date().toISOString(),
}) {
  const change = (space, id, record, value) => ({
    space,
    id,
    expected: record?.version || 0,
    value,
  });
  const active = (owner) => store.get(owner, "import-drafts", "active");
  const registry = async (owner) =>
    new Map((await collection.tags(owner)).map((tag) => [tag.id, tag]));
  function check(record, input) {
    if (
      !record ||
      record.value.state !== "pending" ||
      record.value.id !== input.id ||
      record.version !== input.version
    )
      throw new ApplicationError(
        "The saved draft changed in another session. Reload it before editing, adding or clearing.",
        409,
      );
  }
  async function view(owner, record) {
    if (!record || record.value.state !== "pending")
      return { draft: null, revision: record?.version || 0 };
    const draft = record.value,
      tags = await registry(owner),
      errors = draftProblems(draft, tags);
    let additions = null;
    if (!errors.length) {
      const preview = await collection.previewDeck(owner, draftDeck(draft));
      additions = preview.additions;
      if (preview.existing_version !== draft.source_version)
        errors.push(
          "This source changed after the draft was fetched. Clear this draft and fetch the source again before adding.",
        );
    }
    return {
      draft: {
        ...draft,
        version: record.version,
        status_tag: IMPORT_PENDING_TAG,
      },
      revision: record.version,
      summary: {
        source_copies: draft.original.total,
        reviewed_copies: draft.rows.reduce((n, r) => n + r.quantity, 0),
        additions,
        errors,
        can_add: errors.length === 0,
      },
    };
  }
  return {
    getDraft: async (owner) => view(owner, await active(owner)),
    async fetchDraft(owner, input) {
      const source = moxfieldSource(input.url),
        previous = await active(owner);
      if (previous?.value.state === "pending")
        throw new ApplicationError(
          "A saved import is already pending. Continue it or Clear it before fetching another deck.",
          409,
        );
      const fetched = await provider.fetchDeck(source.url);
      if (
        fetched.source_id !== source.source_id ||
        fetched.provider !== source.provider
      )
        throw new ApplicationError(
          "The fetched source does not match the requested deck.",
          502,
        );
      const cards = await catalog.resolve(
        fetched.rows.map((row) => row.printing_id).filter(Boolean),
      );
      const canonical = new Map(cards.map((card) => [card.id, card]));
      const rows = fetched.rows.map((original) => {
        const candidate = canonical.get(original.printing_id);
        const card = sameCard(original, candidate) ? candidate : null;
        return {
          id: newId(),
          original: {
            ...original,
            ...(card?.oracle_id ? { oracle_id: card.oracle_id } : {}),
          },
          quantity: original.quantity,
          printing_id: card?.id || null,
          card: printingSummary(card),
          finish: original.finish,
          in_deck: true,
          locations: [],
          tag_ids: [],
        };
      });
      const currentSource = await store.get(owner, "decks", source.source_id);
      // Durable catalog metadata is not ownership. Keep it available even if a
      // draft outlives the shared catalog cache; only Add publishes source lots.
      await store.saveCards(owner, cards);
      const draft = {
        id: newId(),
        state: "pending",
        system_tag_ids: [IMPORT_PENDING_TAG.id],
        ...source,
        name: fetched.name,
        retrieved_at: fetched.retrieved_at,
        created_at: now(),
        updated_at: now(),
        source_version: currentSource?.version || 0,
        original: {
          name: fetched.name,
          url: source.url,
          retrieved_at: fetched.retrieved_at,
          total: fetched.rows.reduce((n, r) => n + r.quantity, 0),
          rows: fetched.rows,
          excluded: fetched.excluded,
        },
        rows,
      };
      await store.commit(owner, [
        change("import-drafts", "active", previous, draft),
      ]);
      return view(owner, {
        version: (previous?.version || 0) + 1,
        value: draft,
      });
    },
    async saveDraft(owner, input) {
      const record = await active(owner);
      check(record, input);
      const tags = await registry(owner);
      const rows = validateDraftRows(record.value, input.rows, tags);
      for (let i = 0; i < rows.length; i++) {
        const requested = input.rows[i],
          row = rows[i];
        if (requested.printing_id !== row.printing_id) {
          const card = requested.printing_id
            ? (await repository.getPrinting(requested.printing_id)) ||
              (await store.get(owner, "cards", requested.printing_id))?.value
            : null;
          if (
            requested.printing_id &&
            (!sameCard(row.original, card) ||
              card.digital ||
              card.games?.includes("paper") === false)
          )
            throw new ApplicationError(
              "Choose a verified paper printing of the same card.",
            );
          row.printing_id = card?.id || null;
          row.card = printingSummary(card);
          if (card) await store.saveCards(owner, [card]);
        }
      }
      const draft = { ...record.value, rows, updated_at: now() };
      await store.commit(owner, [
        change("import-drafts", "active", record, draft),
      ]);
      return view(owner, { version: record.version + 1, value: draft });
    },
    async clearDraft(owner, input) {
      const record = await active(owner);
      check(record, input);
      // Keep the slot's monotonic revision to prevent clear/refetch ABA races.
      await store.commit(owner, [
        change("import-drafts", "active", record, {
          state: "empty",
          cleared_at: now(),
        }),
      ]);
      return { draft: null, revision: record.version + 1 };
    },
    async addDraft(owner, input) {
      if (typeof input.id !== "string" || !/^[a-f0-9-]{36}$/.test(input.id))
        throw new ApplicationError("A saved draft is required.");
      return store.withInventoryLock(owner, async () => {
        const receipt = await store.get(owner, "import-receipts", input.id);
        if (receipt) return { ...receipt.value, replayed: true };
        const record = await active(owner);
        check(record, input);
        const draft = record.value,
          tags = await registry(owner),
          errors = draftProblems(draft, tags);
        if (errors.length) throw new ApplicationError(errors[0]);
        const prepared = await collection.prepareDeckImport(
          owner,
          { ...draftDeck(draft), expected_version: draft.source_version },
          { original: draft.original, rows: draft.rows },
        );
        const result = {
          draft_id: draft.id,
          ...prepared.result,
          reviewed_copies: draft.rows.reduce((n, r) => n + r.quantity, 0),
          added_at: now(),
          replayed: false,
        };
        await store.commit(owner, [
          ...prepared.changes,
          change("import-receipts", draft.id, null, result),
          change("import-drafts", "active", record, {
            state: "empty",
            added_at: now(),
          }),
        ]);
        return result;
      });
    },
  };
}
