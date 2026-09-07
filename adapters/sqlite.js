import { collection, addInventory, savePrinting } from "../db.js";
import { ApplicationError } from "../domain/inventory.js";
export function createSqliteAdapters(db) {
  let availableAt = 0,
    queue = Promise.resolve();
  const requireEntry = (id) => {
    if (!db.prepare("SELECT id FROM inventory WHERE id=?").get(id))
      throw new ApplicationError(
        "Entry no longer exists. Update your collection.",
        404,
      );
  };
  return {
    repository: {
      list: () => collection(db),
      getPrinting: (id) => {
        const row = db
          .prepare("SELECT data FROM printings WHERE id=?")
          .get(id || "missing");
        return row ? JSON.parse(row.data) : null;
      },
      add: (_owner, input) => {
        db.exec("BEGIN IMMEDIATE");
        try {
          const previous =
            input.operation_id &&
            db
              .prepare("SELECT input FROM operations WHERE id=?")
              .get(input.operation_id);
          if (previous) {
            if (previous.input !== JSON.stringify(input))
              throw new ApplicationError(
                "This operation was already saved with different details. Reopen the card to make another change.",
              );
          } else {
            addInventory(db, input);
            if (input.operation_id)
              db.prepare("INSERT INTO operations VALUES (?,?)").run(
                input.operation_id,
                JSON.stringify(input),
              );
          }
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
      setQuantity: (_owner, id, quantity) => {
        requireEntry(id);
        db.prepare(
          "UPDATE inventory SET quantity=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",
        ).run(quantity, id);
      },
      remove: (_owner, id) => {
        requireEntry(id);
        db.prepare("DELETE FROM inventory WHERE id=?").run(id);
      },
    },
    cache: {
      get: (key) => {
        const row = db.prepare("SELECT * FROM api_cache WHERE key=?").get(key);
        return row && Date.now() - row.timestamp < 86400000
          ? JSON.parse(row.data)
          : null;
      },
      put: (key, result) => {
        for (const card of result.cards) savePrinting(db, card);
        db.prepare("INSERT OR REPLACE INTO api_cache VALUES (?,?,?)").run(
          key,
          JSON.stringify(result),
          Date.now(),
        );
      },
    },
    rateLimit: {
      acquire() {
        const request = queue.then(async () => {
          if (availableAt - Date.now() > 1000)
            throw new ApplicationError(
              "Scryfall is busy. Please try again in a minute.",
              429,
            );
          await new Promise((resolve) =>
            setTimeout(resolve, Math.max(0, availableAt - Date.now())),
          );
          availableAt = Date.now() + 600;
        });
        queue = request.catch(() => {});
        return request;
      },
      pause: (milliseconds) => {
        availableAt = Date.now() + milliseconds;
      },
    },
  };
}
