import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { CatalogError, finishes, type Catalog, type Finish } from '../../catalog/index.js';
import { UserCardsError } from './errors.js';
import type { UserCardsSqlTransactor } from './executor.js';
import {
  USERCARDS_LIMITS,
  copyConditions,
  type CopyCondition,
  type CopyId,
  type PhysicalCopy,
  type TrustedUserContext,
} from './model.js';
import { createPostgresCopyStore } from './postgres.js';
import type { NewCopy } from './store.js';

/** One copy request: one printing, its finish and condition, repeated `quantity` times. */
export interface CreateCopiesInput {
  readonly printingId: string;
  readonly finish: Finish;
  /** Physical condition; `null` stores the copy with an explicitly unknown condition. */
  readonly condition: CopyCondition | null;
  readonly quantity: number;
}

/**
 * The corrected state of one copy, guarded by the revision the caller read. The copy keeps its
 * identity, while printing, finish and condition are replaced as one explicit change.
 */
export interface CorrectCopyInput {
  readonly copyId: CopyId;
  readonly expectedRevision: number;
  readonly printingId: string;
  readonly finish: Finish;
  readonly condition: CopyCondition | null;
}

export interface CopyReadResult {
  /** Private-data revision the read observed; a continuation binds to this value. */
  readonly privateRevision: string;
  /** Authorized copies keyed by copy identity. */
  readonly copies: ReadonlyMap<CopyId, PhysicalCopy>;
  /** Requested references this account has no copy for, in request order. */
  readonly missing: readonly CopyId[];
}

export interface CopyChangeResult {
  /** Private-data revision the change published. */
  readonly privateRevision: string;
  /** Committed affected copies, ordered by copy identity. */
  readonly copies: readonly PhysicalCopy[];
}

/**
 * The UserCards contract for physical copies. Every operation takes Application's trusted user
 * context and scopes the referenced records and changes to that account; a read never returns or
 * reveals another account's copy, and a change either commits completely or reports a distinct
 * failure (docs/user-cards.md#interface).
 */
export interface UserCards {
  readCopies(context: TrustedUserContext, copyIds: readonly CopyId[]): Promise<CopyReadResult>;
  createCopies(context: TrustedUserContext, input: CreateCopiesInput): Promise<CopyChangeResult>;
  correctCopy(context: TrustedUserContext, input: CorrectCopyInput): Promise<CopyChangeResult>;
}

export interface UserCardsDependencies {
  /**
   * Transaction-capable SQL executor supplied by Application. Statements use `:name` placeholders
   * and read or write the component's own storage; consumers read the published views instead.
   */
  readonly sql: UserCardsSqlTransactor;
  /**
   * Catalog contract used to resolve printing references and validate physical-printing
   * attributes. A copy never stores a printing the catalog cannot resolve.
   */
  readonly catalog: Catalog;
}

const identifierLength = USERCARDS_LIMITS.maxIdentifierLength;

const userContextSchema = z.object({
  accountId: z.string().min(1).max(identifierLength),
});

const copyReferenceSchema = z.string().min(1).max(identifierLength);

const readCopiesRequestSchema = z
  .array(copyReferenceSchema)
  .max(USERCARDS_LIMITS.maxReadReferences);

const conditionSchema = z.enum(copyConditions).nullable();

const createCopiesRequestSchema = z.object({
  printingId: copyReferenceSchema,
  finish: z.enum(finishes),
  condition: conditionSchema,
  quantity: z.number().int().min(1).max(USERCARDS_LIMITS.maxCreateQuantity),
});

const correctCopyRequestSchema = z.object({
  copyId: copyReferenceSchema,
  expectedRevision: z.number().int().min(1),
  printingId: copyReferenceSchema,
  finish: z.enum(finishes),
  condition: conditionSchema,
});

/**
 * The UserCards contract for physical copies. Copies are resolved and validated against the
 * published catalog before they are stored, so an unavailable printing is an explicit failure
 * rather than a stored reference that nothing can resolve.
 */
export function createUserCards(dependencies: UserCardsDependencies): UserCards {
  const sql: UserCardsSqlTransactor | undefined = dependencies?.sql;
  if (typeof sql?.query !== 'function' || typeof sql?.transaction !== 'function') {
    throw new TypeError('createUserCards requires a transaction-capable SQL executor.');
  }
  const catalog: Catalog | undefined = dependencies?.catalog;
  if (typeof catalog?.resolve !== 'function') {
    throw new TypeError('createUserCards requires the Catalog contract to resolve printings.');
  }
  const store = createPostgresCopyStore(sql);

  return {
    async readCopies(
      context: TrustedUserContext,
      copyIds: readonly CopyId[],
    ): Promise<CopyReadResult> {
      const accountId = accountIdFrom(context);
      const request = readCopiesRequestSchema.safeParse(copyIds);
      if (!request.success) {
        throw new UserCardsError(
          'invalid-request',
          `Reads accept at most ${USERCARDS_LIMITS.maxReadReferences} copy references of ` +
            `1 to ${identifierLength} characters.`,
        );
      }

      const requested: CopyId[] = [];
      const seen = new Set<CopyId>();
      for (const copyId of request.data) {
        if (!seen.has(copyId)) {
          seen.add(copyId);
          requested.push(copyId);
        }
      }

      const data = await store.readCopies(accountId, requested);
      const copies = new Map(data.copies.map((copy) => [copy.copyId, copy] as const));
      return {
        privateRevision: data.privateRevision,
        copies,
        missing: requested.filter((copyId) => !copies.has(copyId)),
      };
    },

    async createCopies(
      context: TrustedUserContext,
      input: CreateCopiesInput,
    ): Promise<CopyChangeResult> {
      const accountId = accountIdFrom(context);
      const request = createCopiesRequestSchema.safeParse(input);
      if (!request.success) {
        throw new UserCardsError('invalid-request', invalidCreateMessage(request.error));
      }
      const { printingId, finish, condition, quantity } = request.data;
      await resolvePhysicalPrinting(catalog, printingId, finish);

      const copies: NewCopy[] = Array.from({ length: quantity }, () => ({
        copyId: randomUUID(),
        printingId,
        finish,
        condition,
      }));
      const data = await store.insertCopies(accountId, copies);
      return { privateRevision: data.privateRevision, copies: data.copies };
    },

    async correctCopy(
      context: TrustedUserContext,
      input: CorrectCopyInput,
    ): Promise<CopyChangeResult> {
      const accountId = accountIdFrom(context);
      const request = correctCopyRequestSchema.safeParse(input);
      if (!request.success) {
        throw new UserCardsError(
          'invalid-request',
          'A correction needs a copy reference, the revision it started from, a printing, a ' +
            'finish and a condition or an explicit unknown condition.',
        );
      }
      const { copyId, expectedRevision, printingId, finish, condition } = request.data;
      await resolvePhysicalPrinting(catalog, printingId, finish);

      const outcome = await store.correctCopy(accountId, {
        copyId,
        expectedRevision,
        printingId,
        finish,
        condition,
      });
      if (outcome.outcome === 'missing') {
        throw new UserCardsError('not-found', 'This account has no copy with that identity.');
      }
      if (outcome.outcome === 'conflict') {
        throw new UserCardsError(
          'conflict',
          'The copy changed after this revision; reload it before correcting it.',
        );
      }
      return { privateRevision: outcome.privateRevision, copies: [outcome.copy] };
    },
  };
}

/** Missing, invalid or empty trusted context never reaches a private record. */
function accountIdFrom(context: TrustedUserContext | undefined): string {
  const parsed = userContextSchema.safeParse(context);
  if (!parsed.success) {
    throw new UserCardsError(
      'invalid-request',
      'Trusted user context with an account identity is required.',
    );
  }
  return parsed.data.accountId;
}

function invalidCreateMessage(error: z.ZodError): string {
  if (error.issues.some((issue) => issue.path[0] === 'quantity')) {
    return `Each copy request creates 1 to ${USERCARDS_LIMITS.maxCreateQuantity} copies.`;
  }
  return (
    'A copy request needs a printing reference of 1 to ' +
    `${identifierLength} characters, an available finish and a condition or an explicit ` +
    'unknown condition.'
  );
}

/**
 * Resolves the printing in the published catalog and validates the physical attributes a copy
 * would store: the printing must exist, be available as a physical card and offer that finish.
 */
async function resolvePhysicalPrinting(
  catalog: Catalog,
  printingId: string,
  finish: Finish,
): Promise<void> {
  let resolution: Awaited<ReturnType<Catalog['resolve']>>;
  try {
    resolution = await catalog.resolve([{ kind: 'printing', printingId }]);
  } catch (cause) {
    if (cause instanceof CatalogError) {
      throw new UserCardsError(
        'unavailable',
        'The catalog could not be read to validate the printing.',
        { cause },
      );
    }
    throw cause;
  }
  const printing = resolution.printings.get(printingId);
  if (printing === undefined) {
    throw new UserCardsError('not-found', 'The printing is not available in the catalog.');
  }
  if (!printing.physical) {
    throw new UserCardsError(
      'invalid-request',
      'The printing is not available as a physical card.',
    );
  }
  if (!printing.finishes.includes(finish)) {
    throw new UserCardsError(
      'invalid-request',
      `The printing is not available in the ${finish} finish.`,
    );
  }
}
