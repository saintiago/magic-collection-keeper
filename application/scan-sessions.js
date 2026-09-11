import { ApplicationError } from "../domain/inventory.js";

const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const copyCount = (draft) => draft.rows.reduce((n, row) => n + row.quantity, 0);
const change = (space, id, record, value) => ({
  space,
  id,
  expected: record?.version || 0,
  value,
});
const groupSlot = (id) => "scan:" + id;
const indexSlot = (id, index) => `${id}:${String(index).padStart(12, "0")}`;

// A session has one small Import header. Its bounded batches are point-read;
// neither scanner memory nor Import's draft list contains all captured rows.
export function createScanSessions({ store, now }) {
  const group = (owner, id) => store.get(owner, "import-drafts", groupSlot(id));
  async function batchAt(owner, id, index) {
    const entry = await store.get(
      owner,
      "scan-batch-index",
      indexSlot(id, index),
    );
    return entry?.value.batch_id || null;
  }
  return {
    group,
    async find(owner, id) {
      if (!uuid.test(id || "")) return null;
      const direct = await store.get(owner, "scan-drafts", id);
      if (direct) return { ...direct, scanSlot: id };
      const session = await group(owner, id);
      if (!session) return null;
      const latest = await store.get(
        owner,
        "scan-drafts",
        session.value.last_batch,
      );
      return latest ? { ...latest, scanSlot: session.value.last_batch } : null;
    },
    mutation(record, input, value) {
      return record.scanSlot
        ? change("scan-drafts", record.scanSlot, record, value)
        : change("import-drafts", input, record, value);
    },
    async summaryChanges(owner, record, next) {
      const context = record.value.scan_session;
      if (!context) return [];
      const previous = await group(owner, context.id);
      if (!previous)
        throw new ApplicationError("The scan session is unavailable.", 409);
      const closing = next.state !== "pending";
      const pending = previous.value.pending_batches - Number(closing);
      return [
        change("import-drafts", groupSlot(context.id), previous, {
          ...previous.value,
          state: pending ? "pending" : "empty",
          pending_batches: pending,
          pending_copies:
            previous.value.pending_copies -
            copyCount(record.value) +
            (closing ? 0 : copyCount(next)),
          updated_at: now(),
        }),
      ];
    },
    async context(owner, record) {
      const context = record?.value.scan_session;
      if (!context) return null;
      const session = (await group(owner, context.id))?.value;
      if (!session) return null;
      const [previous, next] = await Promise.all([
        context.index > 1
          ? batchAt(owner, context.id, context.index - 1)
          : null,
        context.index < session.batches
          ? batchAt(owner, context.id, context.index + 1)
          : null,
      ]);
      return {
        batch_id: record.scanSlot || record.value.id,
        id: context.id,
        index: context.index,
        batches: session.batches,
        accepted: session.accepted,
        pending_batches: session.pending_batches,
        pending_copies: session.pending_copies,
        previous,
        next,
      };
    },
    async stage(owner, raw, stageDraft) {
      if (
        !raw ||
        Object.keys(raw).some(
          (key) => !["id", "index", "last_oracle", "batch"].includes(key),
        ) ||
        !uuid.test(raw.id || "") ||
        !Number.isSafeInteger(raw.index) ||
        raw.index < 1 ||
        raw.index > 999999999999 ||
        !uuid.test(raw.last_oracle || "") ||
        raw.batch?.kind !== "scan" ||
        !uuid.test(raw.batch?.id || "")
      )
        throw new ApplicationError(
          "A stable scan session and bounded batch are required.",
        );
      const previous = await group(owner, raw.id);
      const receipt = await store.get(owner, "import-stages", raw.batch.id);
      const context = {
        id: raw.id,
        index: raw.index,
        last_oracle: raw.last_oracle,
      };
      if (!receipt && raw.index !== (previous?.value.batches || 0) + 1)
        throw new ApplicationError(
          "This scan advanced in another tab. Reload or retry its saved batch.",
          409,
        );
      const timestamp = now();
      await stageDraft(owner, raw.batch, {
        scanContext: context,
        decorate: (draft) => ({
          ...draft,
          scan_session: { id: raw.id, index: raw.index },
          name: `Scanned cards · batch ${raw.index}`,
        }),
        changes: (draft) => [
          change("import-drafts", groupSlot(raw.id), previous, {
            id: raw.id,
            state: "pending",
            provider: "scan-session",
            name: "Continuous scan",
            created_at: previous?.value.created_at || timestamp,
            updated_at: timestamp,
            rows: [],
            last_batch: draft.id,
            last_oracle: raw.last_oracle,
            batches: raw.index,
            accepted: (previous?.value.accepted || 0) + draft.rows.length,
            pending_batches: (previous?.value.pending_batches || 0) + 1,
            pending_copies:
              (previous?.value.pending_copies || 0) + copyCount(draft),
          }),
          change("scan-batch-index", indexSlot(raw.id, raw.index), null, {
            batch_id: draft.id,
          }),
          ...draft.rows.map((row) =>
            change("scan-capture-index", row.id, null, {
              session_id: raw.id,
              batch_id: draft.id,
            }),
          ),
        ],
      });
      const saved = await group(owner, raw.id);
      return {
        staged_id: raw.batch.id,
        session_id: raw.id,
        index: raw.index,
        accepted: saved.value.accepted,
        pending_batches: saved.value.pending_batches,
        last_oracle: saved.value.last_oracle,
      };
    },
  };
}
