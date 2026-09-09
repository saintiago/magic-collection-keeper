import { reviewBatch, batchId } from "../domain/review-batch.js";
import { validateEntry } from "../domain/inventory.js";
// Bounded canonical reads; adapters atomically commit inventory and permanent receipts.
export function createReviewBatches({ repository, store }) {
  return {
    batchStatus: (owner, id) => repository.batchStatus(owner, batchId(id)),
    addBatch: (owner, raw) =>
      store.withInventoryLock(owner, async () => {
        const input = reviewBatch(raw);
        const receipt = await repository.reserveBatch(owner, input);
        const pending = input.items.filter(
          (r) => !receipt.saved.includes(r.item_id),
        );
        const printings = new Map();
        const ids = [...new Set(pending.map((r) => r.printing_id))];
        for (let i = 0; i < ids.length; i += 8)
          await Promise.all(
            ids
              .slice(i, i + 8)
              .map(async (id) =>
                printings.set(id, await repository.getPrinting(id)),
              ),
          );
        for (const row of pending)
          validateEntry(row, printings.get(row.printing_id));
        for (let i = 0; i < pending.length; i += 25)
          await repository.commitBatch(
            owner,
            input.batch_id,
            pending.slice(i, i + 25).map((input) => ({
              input,
              card: printings.get(input.printing_id),
            })),
          );
        return repository.batchStatus(owner, input.batch_id);
      }),
  };
}
