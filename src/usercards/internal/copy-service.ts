import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { finishes, type CatalogResolver } from '../../catalog/index.js';
import { resolvePhysicalPrinting } from './catalog.js';
import { accountIdFrom } from './context.js';
import { UserCardsError } from './errors.js';
import { USERCARDS_LIMITS, copyConditions, type CopyId, type TrustedUserContext } from './model.js';
import type {
  CopyChangeResult,
  CopyReadResult,
  CorrectCopyInput,
  CreateCopiesInput,
  UserCards,
} from './records-contract.js';
import {
  distinctReferences,
  identifierLength,
  referenceSchema,
  referencesSchema,
  revisionSchema,
} from './record-validation.js';
import type { CopyStore } from './store.js';

const conditionSchema = z.enum(copyConditions).nullable();

const createCopiesRequestSchema = z.object({
  printingId: referenceSchema,
  finish: z.enum(finishes),
  condition: conditionSchema,
  quantity: z.number().int().min(1).max(USERCARDS_LIMITS.maxCreateQuantity),
});

const correctCopyRequestSchema = z.object({
  copyId: referenceSchema,
  expectedRevision: revisionSchema,
  printingId: referenceSchema,
  finish: z.enum(finishes),
  condition: conditionSchema,
});

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

export function createCopyOperations(dependencies: {
  readonly store: CopyStore;
  readonly catalog: CatalogResolver;
}): Pick<UserCards, 'readCopies' | 'createCopies' | 'correctCopy'> {
  const { store, catalog } = dependencies;
  return {
    async readCopies(
      context: TrustedUserContext,
      copyIds: readonly CopyId[],
    ): Promise<CopyReadResult> {
      const accountId = accountIdFrom(context);
      const request = referencesSchema.safeParse(copyIds);
      if (!request.success) {
        throw new UserCardsError(
          'invalid-request',
          `Reads accept at most ${USERCARDS_LIMITS.maxReadReferences} copy references of ` +
            `1 to ${identifierLength} characters.`,
        );
      }

      const requested = distinctReferences(request.data);
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
      const resolved = await resolvePhysicalPrinting(catalog, printingId, finish);

      const copies = Array.from({ length: quantity }, () => ({
        copyId: randomUUID(),
        printingId,
        cardId: resolved.printing.cardId,
        finish,
        condition,
      }));
      const data = await store.insertCopies(accountId, copies);
      return {
        privateRevision: data.privateRevision,
        publicationPosition: data.publicationPosition,
        copies: data.copies,
      };
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
      const resolved = await resolvePhysicalPrinting(catalog, printingId, finish);

      const outcome = await store.correctCopy(accountId, {
        copyId,
        expectedRevision,
        printingId,
        cardId: resolved.printing.cardId,
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
      return {
        privateRevision: outcome.privateRevision,
        publicationPosition: outcome.publicationPosition,
        copies: [outcome.copy],
      };
    },
  };
}
