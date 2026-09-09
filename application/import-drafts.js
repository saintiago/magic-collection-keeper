import { ApplicationError } from "../domain/inventory.js";
import { captureInput, draftSlot } from "../domain/capture-draft.js";
import { sameStoredValue } from "../domain/stored-value.js";
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
  const active = (owner, input) =>
    store.get(owner, "import-drafts", draftSlot(input));
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
      try {
        const preview = await collection.previewDeck(owner, draftDeck(draft));
        additions = preview.additions;
        if (preview.existing_version !== draft.source_version)
          errors.push(
            "This source changed after the draft was fetched. Clear this draft and fetch the source again before adding.",
          );
      } catch (error) {
        if (!(error instanceof ApplicationError) || error.status !== 400)
          throw error;
        errors.push(error.message); // Keep an overfull draft readable and repairable.
      }
    }
    return {
      draft: {
        ...draft,
        created_at: draft.created_at || null,
        updated_at: draft.updated_at || null,
        rows: draft.rows.map((row) => ({
          ...row,
          created_at: row.created_at || null,
          updated_at: row.updated_at || null,
        })),
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
    async getDraft(owner, input = {}) {
      const records = (await store.list(owner, "import-drafts"))
        .filter((record) => record.value.state === "pending")
        .sort(
          (a, b) =>
            (b.value.created_at || "").localeCompare(
              a.value.created_at || "",
            ) || a.value.id.localeCompare(b.value.id),
        );
      const selected = input.id
        ? records.find((record) => record.value.id === input.id)
        : records[0];
      return {
        ...(await view(owner, selected)),
        pending_drafts: records.map(({ value }) => ({
          id: value.id,
          name: value.name,
          kind: value.provider === "reviewed-capture" ? "capture" : "url",
          created_at: value.created_at || null,
          updated_at: value.updated_at || null,
          copies: value.rows.reduce((n, row) => n + row.quantity, 0),
        })),
      };
    },
    async stageDraft(owner, raw) {
      const input = captureInput(raw);
      const staged = await store.get(owner, "import-stages", input.id);
      const slot = draftSlot({ kind: "capture", id: input.id });
      const previous = await store.get(owner, "import-drafts", slot);
      if (staged) {
        if (!sameStoredValue(staged.value.input, input))
          throw new ApplicationError(
            "This capture was already staged with different lines.",
            409,
          );
        return { ...(await view(owner, previous)), staged_id: input.id };
      }
      const ids = [
        ...new Set(
          input.rows
            .flatMap((row) => [
              row.printing_id,
              ...(row.recognition || []).map(
                (candidate) => candidate.printing_id,
              ),
            ])
            .filter(Boolean),
        ),
      ];
      const cards = [];
      for (let i = 0; i < ids.length; i += 8)
        cards.push(
          ...(await Promise.all(
            ids
              .slice(i, i + 8)
              .map(
                async (id) =>
                  (await repository.getPrinting(id)) ||
                  (await store.get(owner, "cards", id))?.value,
              ),
          )),
        );
      if (
        cards.some(
          (card) =>
            !card || card.digital || card.games?.includes("paper") === false,
        )
      )
        throw new ApplicationError(
          "Find a verified paper printing again before staging these cards.",
        );
      const canonical = new Map(cards.map((card) => [card.id, card]));
      const targetTag = input.tag_id
        ? (await registry(owner)).get(input.tag_id)
        : null;
      if (input.tag_id && !targetTag)
        throw new ApplicationError(
          "This tag is no longer available. Choose another before reviewing the card.",
          409,
        );
      const rows = input.rows.map((line) => {
        const card = canonical.get(line.printing_id);
        return {
          id: line.id,
          quantity: line.quantity,
          printing_id: card?.id || null,
          finish: line.finish,
          condition: line.condition,
          card: printingSummary(card),
          in_deck: false,
          locations:
            targetTag?.type === "location"
              ? [{ tag_id: targetTag.id, quantity: line.quantity }]
              : [],
          tag_ids:
            targetTag && targetTag.type !== "location" ? [targetTag.id] : [],
          created_at: now(),
          updated_at: now(),
          recognition_candidates: (line.recognition || []).map((candidate) => ({
            ...candidate,
            card: printingSummary(canonical.get(candidate.printing_id)),
          })),
          original: {
            source_line: line.id,
            section: "mainboard",
            name: card?.name || line.name,
            oracle_id: card?.oracle_id || null,
            quantity: line.quantity,
            printing_id: card?.id || null,
            set: card?.set || "",
            collector_number: card?.collector_number || "",
            language: card?.lang || "en",
            finish: line.finish,
            condition: line.condition,
            capture_kind: input.kind,
          },
        };
      });
      const draft = {
        id: input.id,
        state: "pending",
        system_tag_ids: [IMPORT_PENDING_TAG.id],
        provider: "reviewed-capture",
        source_id: "capture:" + input.id,
        url: "",
        name:
          input.kind === "scan"
            ? "Scanned cards"
            : input.kind === "catalog"
              ? "Catalogue selections"
              : "Pasted card list",
        source_version: 0,
        retrieved_at: now(),
        created_at: now(),
        updated_at: now(),
        original: {
          name:
            input.kind === "scan"
              ? "Camera suggestions"
              : input.kind === "catalog"
                ? "Catalogue selection"
                : "Pasted list",
          rows: rows.map((row) => row.original),
          total: rows.reduce((n, row) => n + row.quantity, 0),
          excluded: [],
        },
        rows,
      };
      await store.saveCards(owner, cards);
      await store.commit(owner, [
        change("import-drafts", slot, previous, draft),
        change("import-stages", input.id, null, { input }),
      ]);
      return {
        ...(await view(owner, {
          version: (previous?.version || 0) + 1,
          value: draft,
        })),
        staged_id: input.id,
      };
    },
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
          created_at: now(),
          updated_at: now(),
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
      const record = await active(owner, input);
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
            ((!sameCard(row.original, card) &&
              !row.recognition_candidates?.some(
                (candidate) => candidate.card.oracle_id === card?.oracle_id,
              )) ||
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
      for (const row of rows) {
        const previous = record.value.rows.find((old) => old.id === row.id);
        if (!sameStoredValue(row, previous)) row.updated_at = now();
      }
      if (sameStoredValue(rows, record.value.rows)) return view(owner, record);
      const draft = { ...record.value, rows, updated_at: now() };
      await store.commit(owner, [
        change("import-drafts", draftSlot(input), record, draft),
      ]);
      return view(owner, { version: record.version + 1, value: draft });
    },
    async clearDraft(owner, input) {
      const record = await active(owner, input);
      check(record, input);
      // Keep the slot's monotonic revision to prevent clear/refetch ABA races.
      await store.commit(owner, [
        change("import-drafts", draftSlot(input), record, {
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
        const record = await active(owner, input);
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
          change("import-drafts", draftSlot(input), record, {
            state: "empty",
            added_at: now(),
          }),
        ]);
        return result;
      });
    },
  };
}
