import { createHash } from "node:crypto";
import { PutCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ApplicationError } from "../domain/inventory.js";
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const mismatch = () =>
  new ApplicationError(
    "This review was already submitted with different details. Check its saved status before starting a new batch.",
    409,
  );
export function createDynamoBatches({ tableName, get, send, inventoryUpdate }) {
  const partition = (owner) => `REVIEWBATCH#${owner}`;
  async function receipts(owner, items) {
    const saved = [];
    for (let i = 0; i < items.length; i += 8) {
      const group = items.slice(i, i + 8);
      const values = await Promise.all(
        group.map((r) => get(partition(owner), `ITEM#${r.item_id}`)),
      );
      values.forEach((previous, j) => {
        if (!previous) return;
        if (previous.fingerprint !== digest(group[j])) throw mismatch();
        saved.push(group[j].item_id);
      });
    }
    return saved;
  }
  async function batchStatus(owner, id) {
    const batch = await get(partition(owner), `BATCH#${id}`);
    if (!batch) return { batch_id: id, saved: [], found: false };
    return {
      batch_id: id,
      saved: await receipts(owner, batch.items),
      found: true,
    };
  }
  return {
    batchStatus,
    async reserveBatch(owner, input) {
      const PK = partition(owner),
        SK = `BATCH#${input.batch_id}`,
        fingerprint = digest(input);
      let previous = await get(PK, SK);
      if (!previous) {
        try {
          await send(
            new PutCommand({
              TableName: tableName,
              Item: { PK, SK, fingerprint, items: input.items },
              ConditionExpression: "attribute_not_exists(PK)",
            }),
          );
        } catch (error) {
          previous = await get(PK, SK);
          if (!previous) throw error;
        }
      }
      if (previous && previous.fingerprint !== fingerprint) throw mismatch();
      return batchStatus(owner, input.batch_id);
    },
    async commitBatch(owner, batch_id, entries) {
      const saved = new Set(
        await receipts(
          owner,
          entries.map((r) => r.input),
        ),
      );
      const pending = entries.filter((r) => !saved.has(r.input.item_id));
      if (!pending.length) return;
      const groups = new Map();
      for (const row of pending) {
        const key = [
          row.card.id,
          row.card.lang,
          row.input.condition,
          row.input.finish,
        ].join("|");
        const group = groups.get(key);
        if (group) group.input.quantity += row.input.quantity;
        else groups.set(key, { card: row.card, input: { ...row.input } });
      }
      if ([...groups.values()].some((r) => r.input.quantity > 100000))
        throw new ApplicationError("Total quantity cannot exceed 100,000.");
      const TransactItems = [
        ...[...groups.values()].map((r) => ({
          Update: inventoryUpdate(owner, r.input, r.card),
        })),
        ...pending.map(({ input }) => ({
          Put: {
            TableName: tableName,
            Item: {
              PK: partition(owner),
              SK: `ITEM#${input.item_id}`,
              fingerprint: digest(input),
              batch_id,
            },
            ConditionExpression: "attribute_not_exists(PK)",
          },
        })),
      ];
      // At most 25 inventory updates + 25 receipts; no duplicate item actions.
      if (Buffer.byteLength(JSON.stringify(TransactItems)) > 3000000)
        throw new ApplicationError(
          "This review is too large. Split it into smaller batches.",
        );
      try {
        await send(new TransactWriteCommand({ TransactItems }));
      } catch (error) {
        if (
          (
            await receipts(
              owner,
              pending.map((r) => r.input),
            )
          ).length === pending.length
        )
          return;
        if (
          error.CancellationReasons?.some(
            (r) => r.Code === "ConditionalCheckFailed",
          )
        )
          throw new ApplicationError(
            "Total quantity cannot exceed 100,000. Check saved batch status before retrying.",
          );
        throw error;
      }
    },
  };
}
