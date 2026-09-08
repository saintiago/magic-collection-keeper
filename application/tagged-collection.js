import { ApplicationError, validateQuantity } from "../domain/inventory.js";
import {
  tagDefinition,
  validateTagId,
  validateAssignments,
  referencedTags,
} from "../domain/tags.js";
import { normalizeDeck, planDeck, deckRows } from "../domain/deck-import.js";

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
      (await store.list(owner, "tags")).map((record) => [record.id, record]),
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
    return [...groups.values()].map((row) => {
      if (row.provenance_list.length)
        row.id = `group:${hash([row.printing_id, row.language, row.finish, row.condition].join("|"))}`;
      row.quantity += overrideMap.get(String(row.id))?.delta ?? 0;
      const assigned = assignmentMap.get(String(row.id)) ?? {
        locations: [],
        tag_ids: [],
      };
      const totals = new Map();
      for (const allocation of assigned.locations_override
        ? assigned.locations
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
      return {
        ...display,
        locations,
        tag_ids: assigned.tag_ids,
        tags: assigned.tag_ids.map((id) => tags.get(id)?.value).filter(Boolean),
        unallocated_quantity: Math.max(0, row.quantity - allocated),
        allocation_shortfall: Math.max(0, allocated - row.quantity),
        allocated_quantity: allocated,
        source_managed: Boolean(row.provenance_list.length),
      };
    });
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
  async function importDeck(owner, raw) {
    return store.withInventoryLock(owner, async () => {
      const { input, current, plan, fingerprint } = await deckPlan(owner, raw);
      if (raw.expected_version !== (current?.version ?? 0))
        throw new ApplicationError(
          "The deck changed since preview. Preview it again.",
          409,
        );
      if (current?.value.fingerprint === fingerprint)
        return { unchanged: true, ...(await previewDeck(owner, raw)) };
      const existing = await list(owner);
      const previousLots = new Map(
        (current?.value.lots ?? []).map((l) => [l.line_id, l]),
      );
      for (const lot of plan.lots) {
        const row = existing.find(
          (r) =>
            r.printing_id === lot.printing_id &&
            r.finish === lot.finish &&
            r.condition === "UNK",
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
      await store.saveCards(owner, cards);
      const tagId = current?.value.tag_id ?? newId(),
        tag = await store.get(owner, "tags", tagId);
      const changes = [];
      if (!current)
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
      else if (!tag)
        throw new ApplicationError("The deck location tag is missing.", 500);
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
      delete value.entries;
      changes.push(change("decks", input.source_id, current, value));
      await store.commit(owner, changes);
      return {
        unchanged: false,
        source_id: input.source_id,
        tag_id: tagId,
        additions: plan.added,
        allocated: plan.allocated,
        retained_loose: plan.retained,
        owned_from_source: plan.owned,
      };
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
        if (row.source_managed) {
          const current = await store.get(owner, "totals", String(id));
          await store.commit(owner, [
            change("totals", String(id), current, {
              delta: (current?.value.delta ?? 0) + quantity - row.quantity,
            }),
          ]);
        } else await collection.setQuantity(owner, id, quantity);
        return list(owner);
      }),
    remove: (owner, id) =>
      store.withInventoryLock(owner, async () => {
        const row = await existingRow(owner, id);
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
