import { z } from 'zod';

import { CatalogError } from './errors.js';
import type { CatalogSqlExecutor } from './executor.js';
import {
  CATALOG_LIMITS,
  catalogReferenceSchema,
  type CardId,
  type CardRecord,
  type CatalogReference,
  type CatalogRevision,
  type PrintingId,
  type PrintingRecord,
} from './model.js';
import { createPostgresReadStore } from './postgres.js';

export interface CatalogResolution {
  /** Revision all returned records were read from. */
  readonly revision: CatalogRevision;
  /** Resolved cards, keyed by playable identity. */
  readonly cards: ReadonlyMap<CardId, CardRecord>;
  /** Resolved printings, keyed by printing identity. */
  readonly printings: ReadonlyMap<PrintingId, PrintingRecord>;
  /** Requested references that the published revision does not contain, in request order. */
  readonly missing: readonly CatalogReference[];
}

export interface ListCardPrintingsOptions {
  readonly pageSize?: number;
  /** Continuation from the previous page of the same card's printings. */
  readonly continuation?: string;
}

export interface CardPrintingsPage {
  readonly cardId: CardId;
  /** False when the published revision does not contain the requested card. */
  readonly cardExists: boolean;
  readonly revision: CatalogRevision;
  readonly printings: readonly PrintingRecord[];
  /** Continuation for the next page, or null when this page ends the list. */
  readonly continuation: string | null;
}

export interface Catalog {
  resolve(references: readonly CatalogReference[]): Promise<CatalogResolution>;
  listCardPrintings(cardId: CardId, options?: ListCardPrintingsOptions): Promise<CardPrintingsPage>;
}

export interface CatalogDependencies {
  /**
   * Read-only SQL executor supplied by Application. Statements use `:name` placeholders and
   * observe the published views; Catalog never reads private tables.
   */
  readonly sql: CatalogSqlExecutor;
}

const resolveRequestSchema = z
  .array(catalogReferenceSchema)
  .max(CATALOG_LIMITS.maxResolutionReferences);

const identifierLength = CATALOG_LIMITS.maxIdentifierLength;

const continuationPayloadSchema = z.object({
  version: z.literal(1),
  cardId: z.string().min(1).max(identifierLength),
  offset: z.number().int().min(0),
  revision: z.string().min(1).max(identifierLength),
});

type ContinuationPayload = z.infer<typeof continuationPayloadSchema>;

/**
 * Longest token `encodeContinuation` can emit: both identifiers are bounded by
 * CATALOG_LIMITS.maxIdentifierLength, JSON escaping can spend six bytes on one string unit
 * (`"\uXXXX"`), base64url expands by 4/3, and the payload keys and an integer offset fit the
 * remaining margin. The decoder accepts every token its encoder can produce.
 */
const maxContinuationIdentifierBytes = CATALOG_LIMITS.maxIdentifierLength * 6;
const maxContinuationLength = 4 * Math.ceil((2 * maxContinuationIdentifierBytes + 64) / 3);

/**
 * The Catalog read contract. Lookups are always local: no operation waits for, or falls back to, a
 * live provider request, and a catalog read failure is distinct from a missing record.
 */
export function createCatalog(dependencies: CatalogDependencies): Catalog {
  const sql: CatalogSqlExecutor | undefined = dependencies?.sql;
  if (typeof sql?.query !== 'function') {
    throw new TypeError('createCatalog requires a SQL executor with a query method.');
  }
  const store = createPostgresReadStore(sql);

  return {
    async resolve(references: readonly CatalogReference[]): Promise<CatalogResolution> {
      const request = resolveRequestSchema.safeParse(references);
      if (!request.success) {
        throw new CatalogError('invalid-request', invalidResolveMessage(request.error));
      }

      const requested: CatalogReference[] = [];
      const cardIds: string[] = [];
      const printingIds: string[] = [];
      const seen = new Set<string>();
      for (const reference of request.data) {
        const key = `${reference.kind}:${reference.kind === 'card' ? reference.cardId : reference.printingId}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        requested.push(reference);
        if (reference.kind === 'card') {
          cardIds.push(reference.cardId);
        } else {
          printingIds.push(reference.printingId);
        }
      }

      const data = await store.resolve(cardIds, printingIds);
      const cards = new Map(data.cards.map((card) => [card.cardId, card] as const));
      const printings = new Map(
        data.printings.map((printing) => [printing.printingId, printing] as const),
      );
      const missing = requested.filter((reference) =>
        reference.kind === 'card'
          ? !cards.has(reference.cardId)
          : !printings.has(reference.printingId),
      );
      return { revision: data.revision, cards, printings, missing };
    },

    async listCardPrintings(
      cardId: CardId,
      options: ListCardPrintingsOptions = {},
    ): Promise<CardPrintingsPage> {
      if (typeof cardId !== 'string' || cardId.length === 0 || cardId.length > identifierLength) {
        throw new CatalogError(
          'invalid-request',
          `A card ID of 1 to ${identifierLength} characters is required.`,
        );
      }
      const pageSize = options.pageSize ?? CATALOG_LIMITS.defaultPrintingPageSize;
      if (
        !Number.isInteger(pageSize) ||
        pageSize < CATALOG_LIMITS.minPrintingPageSize ||
        pageSize > CATALOG_LIMITS.maxPrintingPageSize
      ) {
        throw new CatalogError(
          'invalid-request',
          `A printing page size from ${CATALOG_LIMITS.minPrintingPageSize} to ` +
            `${CATALOG_LIMITS.maxPrintingPageSize} is required.`,
        );
      }

      const continuation =
        options.continuation === undefined
          ? null
          : decodeContinuation(options.continuation, cardId);
      const offset = continuation?.offset ?? 0;
      const data = await store.listPrintings(cardId, offset, pageSize + 1);
      if (continuation !== null && continuation.revision !== data.revision.revisionId) {
        throw new CatalogError(
          'stale-continuation',
          'The catalog changed after this page was read; start the printing list again.',
        );
      }

      const hasMore = data.printings.length > pageSize;
      return {
        cardId,
        cardExists: data.cardExists,
        revision: data.revision,
        printings: hasMore ? data.printings.slice(0, pageSize) : data.printings,
        continuation: hasMore
          ? encodeContinuation({
              version: 1,
              cardId,
              offset: offset + pageSize,
              revision: data.revision.revisionId,
            })
          : null,
      };
    },
  };
}

function invalidResolveMessage(error: z.ZodError): string {
  if (error.issues.some((issue) => issue.code === 'too_big')) {
    return `Resolve accepts at most ${CATALOG_LIMITS.maxResolutionReferences} references per request.`;
  }
  return (
    'Resolve accepts typed card or printing references with an identifier of ' +
    `1 to ${identifierLength} characters.`
  );
}

function encodeContinuation(payload: ContinuationPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeContinuation(token: string, cardId: string): ContinuationPayload {
  if (typeof token !== 'string' || token.length === 0 || token.length > maxContinuationLength) {
    throw staleContinuation('This continuation is not readable; start the printing list again.');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw staleContinuation('This continuation is not readable; start the printing list again.');
  }
  const parsed = continuationPayloadSchema.safeParse(decoded);
  if (!parsed.success || parsed.data.cardId !== cardId) {
    throw staleContinuation(
      'This continuation belongs to a different printing list; start it again.',
    );
  }
  return parsed.data;
}

function staleContinuation(message: string): CatalogError {
  return new CatalogError('stale-continuation', message);
}
