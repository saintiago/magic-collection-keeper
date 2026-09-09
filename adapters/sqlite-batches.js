import { addInventory } from "../db.js";
import { ApplicationError } from "../domain/inventory.js";
export function createSqliteBatches(db) {
  // Local profiles remain separate SQLite files; owner is retained in receipt keys.
  const key = (owner, kind, id) => `review:${owner}:${kind}:${id}`;
  const get = (id) =>
    db.prepare("SELECT input FROM operations WHERE id=?").get(id)?.input;
  const put = (id, value) =>
    db
      .prepare("INSERT INTO operations VALUES (?,?)")
      .run(id, JSON.stringify(value));
  const check = (before, value) => {
    if (before && before !== JSON.stringify(value))
      throw new ApplicationError(
        "This review was already submitted with different details.",
        409,
      );
    return Boolean(before);
  };
  function batchStatus(owner, id) {
    const stored = get(key(owner, "batch", id));
    if (!stored) return { batch_id: id, saved: [], found: false };
    const batch = JSON.parse(stored);
    return {
      batch_id: id,
      found: true,
      saved: batch.items
        .filter((r) => check(get(key(owner, "item", r.item_id)), r))
        .map((r) => r.item_id),
    };
  }
  return {
    batchStatus,
    reserveBatch(owner, input) {
      const id = key(owner, "batch", input.batch_id);
      if (!check(get(id), input)) put(id, input);
      return batchStatus(owner, input.batch_id);
    },
    commitBatch(owner, _batch, entries) {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const { input } of entries) {
          const id = key(owner, "item", input.item_id);
          if (check(get(id), input)) continue;
          addInventory(db, input);
          put(id, input);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
