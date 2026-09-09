import { ApplicationError, validateQuantity } from "../domain/inventory.js";
import {
  tagDefinition,
  validateTagId,
  validateAssignments,
  referencedTags,
} from "../domain/tags.js";
import { normalizeDeck, planDeck, deckRows } from "../domain/deck-import.js";
import { isSystemTag } from "../domain/system-tags.js";
import { cardTimestamps } from "../domain/card-timestamps.js";
import { sameStoredValue } from "../domain/stored-value.js";

export function createTaggedCollection({
  collection,
  repository,
  store,
  newId,
  hash,
  now = () => new Date().toISOString(),
}) {
  const change = (space, id, record, value) => ({
    space,
    id,
    expected: record?.version ?? 0,
    value,
  });
  const tagRecords = async (owner) =>
    new Map(
      (await store.list(owner, "tags"))
        .filter((record) => !isSystemTag(record.value))
        .map((record) => [record.id, record]),
    );
  async function list(owner) {
    const [native, decks, cards, tags, assignments, overrides] =
      await Promise.all([
        collection.list(owner),
        store.list(owner, "decks"),
        store.list(owner, "cards"),
        tagRecords(owner),
        store.list(owner, "assignments"),
        store.list(owner, "totals"),
      ]);
    const cardMap = new Map(cards.map((c) => [c.id, c.value])),
      assignmentMap = new Map(assignments.map((a) => [a.id, a.value])),
      overrideMap = new Map(overrides.map((o) => [o.id, o.value]));
    const sources = decks.flatMap((d) =>
      deckRows(d.value, cardMap, tags.get(d.value.tag_id)?.value),
    );
    const groups = new Map();
    for (const row of [...native, ...sources]) {
      const groupKey = [
        row.printing_id,
        row.language,
        row.finish,
        row.condition,
      ].join("|");
      const previous = groups.get(groupKey);
      if (!previous)
        groups.set(groupKey, {
          ...row,
          components: [row],
          locations: [...(row.locations ?? [])],
          provenance_list: row.provenance ? [row.provenance] : [],
        });
      else {
        previous.components.push(row);
        previous.quantity += row.quantity;
        previous.locations.push(...(row.locations ?? []));
        if (row.provenance) previous.provenance_list.push(row.provenance);
      }
    }
    return [...groups.values()]
      .map((row) => {
        if (row.provenance_list.length)
          row.id = `group:${hash([row.printing_id, row.language, row.finish, row.condition].join("|"))}`;
        row.quantity += overrideMap.get(String(row.id))?.delta ?? 0;
        const assigned = assignmentMap.get(String(row.id)) ?? {
          locations: [],
          tag_ids: [],
        };
        const totals = new Map();
        const uncovered = assigned.locations_override
          ? row.components.filter(
              (component) =>
                component.provenance?.additive_default &&
                !(assigned.source_ids || []).includes(
                  component.provenance.source_id,
                ),
            )
          : [];
        for (const allocation of assigned.locations_override
          ? [
              ...assigned.locations,
              ...uncovered.flatMap((component) => component.locations),
            ]
          : row.locations)
          totals.set(
            allocation.tag_id,
            (totals.get(allocation.tag_id) || 0) + allocation.quantity,
          );
        const locations = [...totals].map(([tag_id, quantity]) => ({
          tag_id,
          quantity,
          tag: tags.get(tag_id)?.value,
        }));
        const allocated = locations.reduce((n, a) => n + a.quantity, 0);
        const { components, ...display } = row;
        const classificationIds = assignmentMap.has(String(row.id))
          ? [
              ...new Set([
                ...assigned.tag_ids,
                ...uncovered.flatMap((component) => component.tag_ids || []),
              ]),
            ]
          : [
              ...new Set(
                components.flatMap((component) => component.tag_ids || []),
              ),
            ];
        return {
          ...display,
          ...cardTimestamps(components, [
            assignmentMap.get(String(row.id)),
            overrideMap.get(String(row.id)),
          ]),
          locations,
          tag_ids: classificationIds,
          tags: classificationIds
            .map((id) => tags.get(id)?.value)
            .filter(Boolean),
          unallocated_quantity: Math.max(0, row.quantity - allocated),
          allocation_shortfall: Math.max(0, allocated - row.quantity),
          allocated_quantity: allocated,
          source_managed: Boolean(row.provenance_list.length),
        };
      })
      .filter((row) => row.quantity > 0);
  }
  async function existingRow(owner, id) {
    const row = (await list(owner)).find((r) => String(r.id) === String(id));
    if (!row)
      throw new ApplicationError(
        "Entry no longer exists. Refresh your collection.",
        404,
      );
    return row;
  }
  async function tags(owner) {
    return [...(await tagRecords(owner)).values()].map((r) => ({
      ...r.value,
      version: r.version,
    }));
  }
  async function createTag(owner, input) {
    const definition = tagDefinition(input),
      id = newId();
    await store.commit(owner, [
      change("tags", id, null, {
        ...definition,
        id,
        references: 0,
        created_at: now(),
      }),
    ]);
    return tags(owner);
  }
  async function renameTag(owner, id, input) {
    validateTagId(id);
    const record = await store.get(owner, "tags", id);
    if (!record) throw new ApplicationError("Tag not found.", 404);
    const definition = tagDefinition({ ...record.value, label: input.label });
    await store.commit(owner, [
      change("tags", id, record, { ...record.value, ...definition }),
    ]);
    return tags(owner);
  }
  async function deleteTag(owner, id) {
    validateTagId(id);
    const record = await store.get(owner, "tags", id);
    if (!record) throw new ApplicationError("Tag not found.", 404);
    if (record.value.references)
      throw new ApplicationError(
        "This tag is in use. Remove its assignments first. Imported deck locations cannot be deleted while their provenance exists.",
        409,
      );
    await store.commit(owner, [change("tags", id, record, null)]);
    return tags(owner);
  }
  async function assign(owner, id, input) {
    return store.withInventoryLock(owner, async () => {
      const row = await existingRow(owner, id),
        registry = await tagRecords(owner),
        current = await store.get(owner, "assignments", String(id));
      const assignment = validateAssignments(
        input,
        { ...row, provenance: row.source_managed },
        new Map([...registry].map(([id, r]) => [id, r.value])),
      );
      assignment.source_ids = [
        ...new Set(
          (row.provenance_list || []).map((source) => source.source_id),
        ),
      ];
      const { created_at, updated_at, ...previousAssignment } =
        current?.value || {};
      if (sameStoredValue(previousAssignment, assignment)) return list(owner);
      assignment.created_at = current ? created_at || null : now();
      assignment.updated_at = now();
      const before = referencedTags(current?.value),
        after = referencedTags(assignment),
        changes = [change("assignments", String(id), current, assignment)];
      for (const tagId of new Set([...before, ...after])) {
        const tag = registry.get(tagId);
        if (!tag)
          throw new ApplicationError(
            "A tag is missing. Refresh and retry.",
            409,
          );
        const delta = Number(after.has(tagId)) - Number(before.has(tagId));
        changes.push(
          change("tags", tagId, tag, {
            ...tag.value,
            references: tag.value.references + delta,
          }),
        );
      }
      await store.commit(owner, changes);
      return list(owner);
    });
  }
  async function deckPlan(owner, raw) {
    const input = normalizeDeck(raw),
      current = await store.get(owner, "decks", input.source_id),
      plan = planDeck(current?.value, input, hash);
    const normalized = {
      ...input,
      entries: [...input.entries].sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
      ),
    };
    const fingerprint = hash(
      JSON.stringify({
        ...(input.provider === "wizards-precon"
          ? { provider: input.provider, url: input.url }
          : {}),
        source_id: input.source_id,
        name: input.name,
        folder: input.folder,
        entries: normalized.entries,
        excluded: input.excluded,
        pending: input.pending,
      }),
    );
    return { input, current, plan, fingerprint };
  }
  async function previewDeck(owner, input) {
    const { current, plan, fingerprint } = await deckPlan(owner, input);
    return {
      source_id: input.source_id,
      existing_version: current?.version ?? 0,
      unchanged: current?.value.fingerprint === fingerprint,
      additions: plan.added,
      allocated: plan.allocated,
      retained_loose: plan.retained,
      owned_from_source: plan.owned,
      existing_loose_untouched: true,
    };
  }
  async function prepareDeckImport(owner, raw, review = null) {
    const {
      input,
      current,
      plan,
      fingerprint: sourceFingerprint,
    } = await deckPlan(owner, raw);
    const fingerprint = review
      ? hash(JSON.stringify({ sourceFingerprint, review }))
      : sourceFingerprint;
    if (raw.expected_version !== (current?.version ?? 0))
      throw new ApplicationError(
        "The deck changed since preview. Preview it again.",
        409,
      );
    if (current?.value.fingerprint === fingerprint)
      return {
        changes: [],
        result: { unchanged: true, ...(await previewDeck(owner, raw)) },
      };
    const existing = await list(owner);
    const previousLots = new Map(
      (current?.value.lots ?? []).map((l) => [l.line_id, l]),
    );
    for (const lot of plan.lots) {
      const row = existing.find(
        (r) =>
          r.printing_id === lot.printing_id &&
          r.finish === lot.finish &&
          r.condition === (lot.condition || "UNK"),
      );
      validateQuantity(
        (row?.quantity ?? 0) +
          lot.owned_quantity -
          (previousLots.get(lot.line_id)?.owned_quantity ?? 0),
      );
    }
    const unique = [...new Set(plan.lots.map((l) => l.printing_id))],
      cards = [];
    for (let start = 0; start < unique.length; start += 8)
      cards.push(
        ...(await Promise.all(
          unique
            .slice(start, start + 8)
            .map(
              async (id) =>
                (await repository.getPrinting(id)) ??
                (await store.get(owner, "cards", id))?.value,
            ),
        )),
      );
    if (cards.some((c) => !c))
      throw new ApplicationError(
        "Some printings are not in the catalog cache. Resolve them before importing.",
      );
    const cardMap = new Map(cards.map((c) => [c.id, c]));
    for (const lot of plan.lots)
      if (!cardMap.get(lot.printing_id).finishes.includes(lot.finish))
        throw new ApplicationError(
          "An imported finish is not supported by its printing.",
        );
    if (
      review &&
      cards.some(
        (card) => card.digital || card.games?.includes("paper") === false,
      )
    )
      throw new ApplicationError(
        "Choose paper printings before adding this draft.",
      );
    const tagId = current?.value.tag_id ?? newId(),
      tag = await store.get(owner, "tags", tagId);
    const changes = [];
    if (review) {
      const registry = await tagRecords(owner);
      const beforeIds = new Set(
        (current?.value.lots || [])
          .flatMap((lot) => [
            ...(lot.tag_ids || []),
            ...(lot.locations || []).map((a) => a.tag_id),
          ])
          .filter((id) => id !== tagId),
      );
      for (const lot of plan.lots) {
        const rows = review.rows.filter(
          (row) =>
            row.printing_id === lot.printing_id &&
            row.finish === lot.finish &&
            (row.condition || "UNK") === (lot.condition || "UNK"),
        );
        const allocations = new Map();
        const ids = new Set();
        for (const row of rows) {
          validateAssignments(
            row,
            {},
            new Map([...registry].map(([id, r]) => [id, r.value])),
          );
          for (const allocation of [
            ...row.locations,
            ...(row.in_deck ? [{ tag_id: tagId, quantity: row.quantity }] : []),
          ])
            allocations.set(
              allocation.tag_id,
              (allocations.get(allocation.tag_id) || 0) + allocation.quantity,
            );
          row.tag_ids.forEach((id) => ids.add(id));
        }
        lot.locations = [...allocations].map(([tag_id, quantity]) => ({
          tag_id,
          quantity,
        }));
        lot.locations.forEach((a) => validateQuantity(a.quantity));
        lot.tag_ids = [...ids];
        lot.original_lines = rows.map((row) => ({
          row_id: row.id,
          ...row.original,
        }));
      }
      const afterIds = new Set(
        plan.lots
          .flatMap((lot) => [
            ...(lot.tag_ids || []),
            ...(lot.locations || []).map((a) => a.tag_id),
          ])
          .filter((id) => id !== tagId),
      );
      for (const id of new Set([...beforeIds, ...afterIds])) {
        const record = registry.get(id);
        if (!record)
          throw new ApplicationError(
            "A selected tag was removed. Edit the draft tags and retry.",
            409,
          );
        const delta = Number(afterIds.has(id)) - Number(beforeIds.has(id));
        changes.push(
          change("tags", id, record, {
            ...record.value,
            references: record.value.references + delta,
          }),
        );
      }
    }
    if (!current && input.provider !== "reviewed-capture")
      changes.push(
        change("tags", tagId, null, {
          id: tagId,
          type: "location",
          kind: "deck",
          label: input.name,
          references: 1,
          source: { provider: input.provider, id: input.source_id },
          created_at: now(),
        }),
      );
    else if (input.provider !== "reviewed-capture" && !tag)
      throw new ApplicationError("The deck location tag is missing.", 500);
    for (const lot of plan.lots) {
      const old = previousLots.get(lot.line_id);
      lot.created_at = old
        ? old.created_at || current.value.created_at || null
        : now();
      const {
        created_at: oldCreated,
        updated_at: oldUpdated,
        ...oldContent
      } = old || {};
      const {
        created_at: newCreated,
        updated_at: newUpdated,
        ...newContent
      } = lot;
      lot.updated_at =
        old && JSON.stringify(oldContent) === JSON.stringify(newContent)
          ? oldUpdated || current.value.updated_at || null
          : now();
    }
    const value = {
      ...input,
      entries: undefined,
      lots: plan.lots,
      tag_id: tagId,
      fingerprint,
      created_at: current?.value.created_at ?? now(),
      updated_at: now(),
      history: [
        ...(current?.value.history ?? []).slice(-19),
        {
          at: now(),
          added: plan.added,
          allocated: plan.allocated,
          retained: plan.retained,
          fingerprint,
        },
      ],
    };
    if (review)
      value.review = {
        original: review.original,
        reviewed_count: input.entries.reduce((n, e) => n + e.quantity, 0),
        additive_default: current?.value.review?.additive_default ?? !current,
      };
    else if (current?.value.review) value.review = current.value.review;
    delete value.entries;
    await store.saveCards(owner, cards);
    changes.push(change("decks", input.source_id, current, value));
    return {
      changes,
      result: {
        unchanged: false,
        source_id: input.source_id,
        tag_id: tagId,
        additions: plan.added,
        allocated: plan.allocated,
        retained_loose: plan.retained,
        owned_from_source: plan.owned,
      },
    };
  }
  async function importDeck(owner, raw) {
    return store.withInventoryLock(owner, async () => {
      const prepared = await prepareDeckImport(owner, raw);
      if (prepared.changes.length) await store.commit(owner, prepared.changes);
      return prepared.result;
    });
  }
  return {
    list,
    tags,
    createTag,
    renameTag,
    deleteTag,
    assign,
    previewDeck,
    importDeck,
    prepareDeckImport,
    decks: async (owner) =>
      (await store.list(owner, "decks")).map((d) => ({
        ...d.value,
        version: d.version,
        lots: d.value.lots,
      })),
    search: collection.search,
    add: (owner, input) =>
      store.withInventoryLock(owner, async () => {
        await collection.add(owner, input);
        return list(owner);
      }),
    setQuantity: (owner, id, quantity) =>
      store.withInventoryLock(owner, async () => {
        validateQuantity(quantity);
        const row = await existingRow(owner, id);
        if (quantity === row.quantity) return list(owner);
        if (row.source_managed) {
          const current = await store.get(owner, "totals", String(id));
          await store.commit(owner, [
            change("totals", String(id), current, {
              delta: (current?.value.delta ?? 0) + quantity - row.quantity,
              created_at: current ? current.value.created_at || null : now(),
              updated_at: now(),
            }),
          ]);
        } else await collection.setQuantity(owner, id, quantity);
        return list(owner);
      }),
    remove: (owner, id) =>
      store.withInventoryLock(owner, async () => {
        const row = await existingRow(owner, id);
        if (
          row.source_managed &&
          row.provenance_list.every(
            (source) => source.provider === "reviewed-capture",
          )
        ) {
          if (row.locations.length || row.tag_ids.length)
            throw new ApplicationError(
              "Clear tag assignments before removing this inventory entry.",
            );
          const current = await store.get(owner, "totals", String(id));
          await store.commit(owner, [
            change("totals", String(id), current, {
              delta: (current?.value.delta || 0) - row.quantity,
              created_at: current ? current.value.created_at || null : now(),
              updated_at: now(),
            }),
          ]);
          return list(owner);
        }
        if (row.source_managed)
          throw new ApplicationError(
            "Imported cards retain their ownership provenance and cannot be removed with this control.",
          );
        if (row.locations.length || row.tag_ids.length)
          throw new ApplicationError(
            "Clear tag assignments before removing this inventory entry.",
          );
        await collection.remove(owner, id);
        return list(owner);
      }),
  };
}
