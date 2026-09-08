import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { createHash } from "node:crypto";
import { ApplicationError } from "../domain/inventory.js";
const digest = (value) => createHash("sha256").update(value).digest("hex");
export function createDynamoAdapters(tableName, rateKey = "scryfall") {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const send = (command) => client.send(command);
  const get = async (PK, SK) =>
    (
      await send(
        new GetCommand({
          TableName: tableName,
          Key: { PK, SK },
          ConsistentRead: true,
        }),
      )
    ).Item;
  const put = (Item) => send(new PutCommand({ TableName: tableName, Item }));
  const userKey = (owner) => `USER#${owner}`;
  const notFound = (error) => {
    if (error.name === "ConditionalCheckFailedException")
      throw new ApplicationError(
        "Entry no longer exists. Update your collection.",
        404,
      );
    throw error;
  };
  return {
    repository: {
      async getPrinting(id) {
        return (await get("PRINTINGS", id || "missing"))?.card;
      },
      async list(owner) {
        let items = [],
          cursor;
        do {
          const page = await send(
            new QueryCommand({
              TableName: tableName,
              KeyConditionExpression: "PK = :p",
              ExpressionAttributeValues: { ":p": userKey(owner) },
              ExclusiveStartKey: cursor,
              ConsistentRead: true,
            }),
          );
          items.push(...page.Items);
          cursor = page.LastEvaluatedKey;
        } while (cursor);
        return items
          .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
          .map(({ PK, SK, ...row }) => row);
      },
      async add(owner, input, card) {
        const id = digest(
          [card.id, card.lang, input.condition, input.finish].join("|"),
        );
        const update = {
          TableName: tableName,
          Key: { PK: userKey(owner), SK: id },
          UpdateExpression:
            "SET id=:id, printing_id=:p, #lang=:l, #condition=:c, #finish=:f, card=:card, updated_at=:now, created_at=if_not_exists(created_at,:now) ADD quantity :q",
          ConditionExpression:
            "attribute_not_exists(quantity) OR quantity <= :max",
          ExpressionAttributeNames: {
            "#lang": "language",
            "#condition": "condition",
            "#finish": "finish",
          },
          ExpressionAttributeValues: {
            ":id": id,
            ":p": card.id,
            ":l": card.lang,
            ":c": input.condition,
            ":f": input.finish,
            ":card": card,
            ":now": new Date().toISOString(),
            ":q": input.quantity,
            ":max": 100000 - input.quantity,
          },
        };
        const operationPK = `OPERATIONS#${owner}`,
          fingerprint = digest(JSON.stringify(input));
        async function alreadySaved() {
          const previous =
            input.operation_id && (await get(operationPK, input.operation_id));
          if (previous && previous.fingerprint !== fingerprint)
            throw new ApplicationError(
              "This operation was already saved with different details. Reopen the card to make another change.",
            );
          return Boolean(previous);
        }
        if (await alreadySaved()) return;
        try {
          if (input.operation_id)
            await send(
              new TransactWriteCommand({
                TransactItems: [
                  { Update: update },
                  {
                    Put: {
                      TableName: tableName,
                      Item: {
                        PK: operationPK,
                        SK: input.operation_id,
                        fingerprint,
                        expires: Math.floor(Date.now() / 1000) + 604800,
                      },
                      ConditionExpression: "attribute_not_exists(PK)",
                    },
                  },
                ],
              }),
            );
          else await send(new UpdateCommand(update));
        } catch (error) {
          if (await alreadySaved()) return;
          if (
            error.name === "ConditionalCheckFailedException" ||
            error.CancellationReasons?.some(
              (reason) => reason.Code === "ConditionalCheckFailed",
            )
          )
            throw new ApplicationError("Total quantity cannot exceed 100,000.");
          throw error;
        }
      },
      async setQuantity(owner, id, quantity) {
        try {
          await send(
            new UpdateCommand({
              TableName: tableName,
              Key: { PK: userKey(owner), SK: id },
              UpdateExpression: "SET quantity=:q,updated_at=:now",
              ConditionExpression: "attribute_exists(PK)",
              ExpressionAttributeValues: {
                ":q": quantity,
                ":now": new Date().toISOString(),
              },
            }),
          );
        } catch (error) {
          notFound(error);
        }
      },
      async remove(owner, id) {
        try {
          await send(
            new DeleteCommand({
              TableName: tableName,
              Key: { PK: userKey(owner), SK: id },
              ConditionExpression: "attribute_exists(PK)",
            }),
          );
        } catch (error) {
          notFound(error);
        }
      },
    },
    cache: {
      async get(key) {
        const cached = await get("SEARCH", digest(key));
        if (!cached || cached.expires < Date.now() / 1000) return null;
        const printings = await Promise.all(
          cached.ids.map((id) => get("PRINTINGS", id)),
        );
        return printings.every(Boolean)
          ? {
              cards: printings.map((r) => r.card),
              total: cached.total,
              hasMore: cached.hasMore,
            }
          : null;
      },
      async put(key, result) {
        await Promise.all(
          result.cards.map(async (card) => {
            await put({
              PK: "PRINTINGS",
              SK: card.id,
              card,
              expires: Math.floor(Date.now() / 1000) + 86400 * 30,
            });
            if (card.oracle_id)
              await put({
                PK: "IDENTITIES",
                SK: card.oracle_id,
                name: card.name,
              });
          }),
        );
        await put({
          PK: "SEARCH",
          SK: digest(key),
          ids: result.cards.map((c) => c.id),
          total: result.total,
          hasMore: result.hasMore,
          expires: Math.floor(Date.now() / 1000) + 86400,
        });
      },
    },
    rateLimit: {
      async acquire() {
        for (let attempt = 0; attempt < 20; attempt++) {
          const now = Date.now();
          try {
            await send(
              new UpdateCommand({
                TableName: tableName,
                Key: { PK: "RATE", SK: rateKey },
                UpdateExpression: "SET available_at=:next",
                ConditionExpression:
                  "attribute_not_exists(available_at) OR available_at <= :now",
                ExpressionAttributeValues: { ":now": now, ":next": now + 600 },
              }),
            );
            return;
          } catch (error) {
            if (error.name !== "ConditionalCheckFailedException") throw error;
            await new Promise((resolve) => setTimeout(resolve, 650));
          }
        }
        throw new ApplicationError(
          "Card lookup is busy. Please try again shortly.",
          429,
        );
      },
      pause: (milliseconds) =>
        put({
          PK: "RATE",
          SK: rateKey,
          available_at: Date.now() + milliseconds,
        }),
    },
  };
}
