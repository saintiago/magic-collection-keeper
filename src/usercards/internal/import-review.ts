import { z } from 'zod';
import { resolvePhysicalPrinting, resolvePrintings } from './catalog.js';
import { accountIdFrom } from './context.js';
import { UserCardsError } from './errors.js';
import type {
  AttachImportCandidatesInput,
  DiscardImportEntryInput,
  DiscardImportSessionInput,
  ImportEntryChangeResult,
  ImportOperations,
  ImportServiceDependencies,
  ImportSessionChange,
  ReviewImportEntryInput,
} from './import-contract.js';
import {
  candidatesSchema,
  conditionSchema,
  distinctCandidates,
  finishSchema,
  quantitySchema,
  referenceSchema,
  revisionSchema,
} from './import-validation.js';
import { USERCARDS_LIMITS, type TrustedUserContext } from './model.js';

const reviewEntryRequestSchema = z.object({
  entryId: referenceSchema,
  expectedRevision: revisionSchema,
  printingId: referenceSchema,
  finish: finishSchema,
  condition: conditionSchema,
  quantity: quantitySchema,
});

const attachCandidatesRequestSchema = z.object({
  entryId: referenceSchema,
  candidates: candidatesSchema.min(1),
});

const discardEntryRequestSchema = z.object({
  entryId: referenceSchema,
  expectedRevision: revisionSchema,
});

const discardSessionRequestSchema = z.object({
  sessionId: referenceSchema,
  expectedRevision: revisionSchema,
});

export function createImportReview(
  dependencies: ImportServiceDependencies,
): Pick<
  ImportOperations,
  'reviewImportEntry' | 'attachImportCandidates' | 'discardImportEntry' | 'discardImportSession'
> {
  const { store, catalog } = dependencies;
  return {
    async reviewImportEntry(
      context: TrustedUserContext,
      input: ReviewImportEntryInput,
    ): Promise<ImportEntryChangeResult> {
      const accountId = accountIdFrom(context);
      const request = reviewEntryRequestSchema.safeParse(input);
      if (!request.success) {
        throw new UserCardsError(
          'invalid-request',
          'A review needs an entry identity, the revision it started from, a resolved printing ' +
            'and finish, a condition or an explicit unknown condition, and a quantity from 1 to ' +
            `${USERCARDS_LIMITS.maxCreateQuantity}.`,
        );
      }
      const { entryId, expectedRevision, printingId, finish, condition, quantity } = request.data;
      await resolvePhysicalPrinting(catalog, printingId, finish);
      const outcome = await store.correctEntry(accountId, {
        entryId,
        expectedRevision,
        printingId,
        finish,
        condition,
        quantity,
      });
      if (outcome.outcome === 'missing') {
        throw new UserCardsError(
          'not-found',
          'This account has no pending entry with that identity.',
        );
      }
      if (outcome.outcome === 'conflict') {
        throw new UserCardsError(
          'conflict',
          'The pending entry changed after this revision; reload it before reviewing it.',
        );
      }
      return {
        privateRevision: outcome.privateRevision,
        session: outcome.session,
        entry: outcome.entry,
      };
    },
    async attachImportCandidates(
      context: TrustedUserContext,
      input: AttachImportCandidatesInput,
    ): Promise<ImportEntryChangeResult> {
      const accountId = accountIdFrom(context);
      const request = attachCandidatesRequestSchema.safeParse(input);
      if (!request.success) {
        throw new UserCardsError(
          'invalid-request',
          'Attaching recognition alternatives needs a pending entry and at least one resolved ' +
            `printing, with at most ${USERCARDS_LIMITS.maxImportCandidates} per entry.`,
        );
      }
      const candidates = distinctCandidates(request.data.candidates);
      await resolvePrintings(
        catalog,
        candidates.map((candidate) => candidate.printingId),
      );
      const outcome = await store.attachCandidates(accountId, {
        entryId: request.data.entryId,
        candidates,
      });
      if (outcome.outcome === 'missing') {
        throw new UserCardsError(
          'not-found',
          'This account has no pending entry with that identity.',
        );
      }
      return {
        privateRevision: outcome.privateRevision,
        session: outcome.session,
        entry: outcome.entry,
      };
    },
    async discardImportEntry(
      context: TrustedUserContext,
      input: DiscardImportEntryInput,
    ): Promise<ImportEntryChangeResult> {
      const accountId = accountIdFrom(context);
      const request = discardEntryRequestSchema.safeParse(input);
      if (!request.success) {
        throw new UserCardsError(
          'invalid-request',
          'Discarding needs an entry identity and the revision it started from.',
        );
      }
      const outcome = await store.discardEntry(
        accountId,
        request.data.entryId,
        request.data.expectedRevision,
      );
      if (outcome.outcome === 'missing') {
        throw new UserCardsError(
          'not-found',
          'This account has no pending entry with that identity.',
        );
      }
      if (outcome.outcome === 'conflict') {
        throw new UserCardsError(
          'conflict',
          'The pending entry changed after this revision; reload it before discarding it.',
        );
      }
      return {
        privateRevision: outcome.privateRevision,
        session: outcome.session,
        entry: outcome.entry,
      };
    },
    async discardImportSession(
      context: TrustedUserContext,
      input: DiscardImportSessionInput,
    ): Promise<ImportSessionChange> {
      const accountId = accountIdFrom(context);
      const request = discardSessionRequestSchema.safeParse(input);
      if (!request.success) {
        throw new UserCardsError(
          'invalid-request',
          'Discarding an import needs its identity and the revision it started from.',
        );
      }
      const outcome = await store.discardSession(
        accountId,
        request.data.sessionId,
        request.data.expectedRevision,
      );
      if (outcome.outcome === 'missing') {
        throw new UserCardsError('not-found', 'This account has no import with that identity.');
      }
      if (outcome.outcome === 'conflict') {
        throw new UserCardsError(
          'conflict',
          'This import changed after the revision you read; reload it before discarding it.',
        );
      }
      return { privateRevision: outcome.privateRevision, session: outcome.session };
    },
  };
}
