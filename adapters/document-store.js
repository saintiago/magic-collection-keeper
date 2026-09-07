import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  PutCommand,
  DeleteCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { ApplicationError } from "../domain/inventory.js";
const conflict = () =>
  new ApplicationError(
    "This information changed in another session. Refresh and try again.",
    409,
  );
const limit = (value) => {
  if (Buffer.byteLength(JSON.stringify(value)) > 300000)
    throw new ApplicationError(
      "This record exceeds the supported size. Split the import into smaller decks.",
    );
};

export function createDynamoDocumentStore(tableName) {
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const key = (owner, space, id) => ({ PK: `META#${owner}#${space}`, SK: id });
  return {
    async withInventoryLock(owner, action) {
      const token = randomUUID(),
        Key = key(owner, "locks", "inventory");
      try {
        await db.send(
          new PutCommand({
            TableName: tableName,
            Item: { ...Key, token, until: Date.now() + 45000 },
            ConditionExpression: "attribute_not_exists(PK) OR #until < :now",
            ExpressionAttributeNames: { "#until": "until" },
            ExpressionAttributeValues: { ":now": Date.now() },
          }),
        );
      } catch (error) {
        if (error.name === "ConditionalCheckFailedException")
          throw new ApplicationError(
            "Another collection change is in progress. Please retry shortly.",
            409,
          );
        throw error;
      }
      try {
        return await action();
      } finally {
        await db.send(
          new DeleteCommand({
            TableName: tableName,
            Key,
            ConditionExpression: "#token=:token",
            ExpressionAttributeNames: { "#token": "token" },
            ExpressionAttributeValues: { ":token": token },
          }),
        );
      }
    },
    async get(owner, space, id) {
      return (
        (
          await db.send(
            new GetCommand({
              TableName: tableName,
              Key: key(owner, space, id),
              ConsistentRead: true,
            }),
          )
        ).Item ?? null
      );
    },
    async list(owner, space) {
      let items = [],
        cursor;
      do {
        const result = await db.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: "PK=:p",
            ExpressionAttributeValues: { ":p": key(owner, space, "").PK },
            ConsistentRead: true,
            ExclusiveStartKey: cursor,
          }),
        );
        items.push(...result.Items);
        cursor = result.LastEvaluatedKey;
      } while (cursor);
      return items;
    },
    async commit(owner, changes) {
      if (changes.length > 95)
        throw new ApplicationError("Too many tags changed at once.");
      const TransactItems = changes.map((change) => {
        const expected = change.expected ?? 0,
          expression = expected ? "#version=:v" : "attribute_not_exists(PK)",
          conditions = {
            ConditionExpression: expression,
            ...(expected
              ? {
                  ExpressionAttributeNames: { "#version": "version" },
                  ExpressionAttributeValues: { ":v": expected },
                }
              : {}),
          };
        if (change.value === null)
          return {
            Delete: {
              TableName: tableName,
              Key: key(owner, change.space, change.id),
              ...conditions,
            },
          };
        limit(change.value);
        return {
          Put: {
            TableName: tableName,
            Item: {
              ...key(owner, change.space, change.id),
              id: change.id,
              version: expected + 1,
              value: change.value,
            },
            ...conditions,
          },
        };
      });
      try {
        await db.send(new TransactWriteCommand({ TransactItems }));
      } catch (error) {
        if (
          error.name === "TransactionCanceledException" &&
          error.CancellationReasons?.some(
            (r) => r.Code === "ConditionalCheckFailed",
          )
        )
          throw conflict();
        throw error;
      }
    },
    async saveCards(owner, cards) {
      for (let start = 0; start < cards.length; start += 8)
        await Promise.all(
          cards
            .slice(start, start + 8)
            .map((card) =>
              db.send(
                new PutCommand({
                  TableName: tableName,
                  Item: {
                    ...key(owner, "cards", card.id),
                    id: card.id,
                    version: 1,
                    value: card,
                  },
                }),
              ),
            ),
        );
    },
  };
}
export function createSqliteDocumentStore(db) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS documents(owner TEXT NOT NULL, space TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,value TEXT NOT NULL,PRIMARY KEY(owner,space,id)); PRAGMA user_version=2;",
  );
  const get = (owner, space, id) => {
    const row = db
      .prepare("SELECT * FROM documents WHERE owner=? AND space=? AND id=?")
      .get(owner, space, id);
    return row ? { ...row, value: JSON.parse(row.value) } : null;
  };
  const locks = new Map();
  return {
    async withInventoryLock(owner, action) {
      if (locks.has(owner))
        throw new ApplicationError(
          "Another collection change is in progress. Please retry shortly.",
          409,
        );
      locks.set(owner, true);
      try {
        return await action();
      } finally {
        locks.delete(owner);
      }
    },
    get,
    list: (owner, space) =>
      db
        .prepare("SELECT * FROM documents WHERE owner=? AND space=?")
        .all(owner, space)
        .map((r) => ({ ...r, value: JSON.parse(r.value) })),
    commit(owner, changes) {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const change of changes) {
          const existing = get(owner, change.space, change.id);
          if ((existing?.version ?? 0) !== (change.expected ?? 0))
            throw conflict();
          if (change.value === null)
            db.prepare(
              "DELETE FROM documents WHERE owner=? AND space=? AND id=?",
            ).run(owner, change.space, change.id);
          else {
            limit(change.value);
            db.prepare(
              "INSERT OR REPLACE INTO documents VALUES (?,?,?,?,?)",
            ).run(
              owner,
              change.space,
              change.id,
              (change.expected ?? 0) + 1,
              JSON.stringify(change.value),
            );
          }
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    saveCards(owner, cards) {
      for (const card of cards)
        db.prepare("INSERT OR REPLACE INTO documents VALUES (?,?,?,?,?)").run(
          owner,
          "cards",
          card.id,
          1,
          JSON.stringify(card),
        );
    },
  };
}
