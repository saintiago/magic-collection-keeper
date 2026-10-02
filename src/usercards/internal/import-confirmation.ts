import { z } from 'zod';
import type { PrintingRecord } from '../../catalog/index.js';
import { physicalFinish, resolveCards, resolvePrintings } from './catalog.js';
import { accountIdFrom } from './context.js';
import { UserCardsError } from './errors.js';
import { fingerprint } from './fingerprint.js';
import type {
  ConfirmImportInput,
  ImportConfirmationResult,
  ImportReceipt,
  ImportOperationRecoveryResult,
  ImportOperations,
  ImportServiceDependencies,
} from './import-contract.js';
import { referenceSchema, revisionSchema } from './import-validation.js';
import {
  USERCARDS_LIMITS,
  type ImportEntry,
  type ImportOperationId,
  type TrustedUserContext,
} from './model.js';
import type { ConfirmedImportEntry, ImportReceiptData } from './store.js';

const confirmImportRequestSchema = z.object({
  operationId: referenceSchema,
  sessionId: referenceSchema,
  destination: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('ownership') }),
    z.object({ kind: z.literal('tag'), tagId: referenceSchema }),
  ]),
  entries: z
    .array(z.object({ entryId: referenceSchema, expectedRevision: revisionSchema }))
    .min(1)
    .max(USERCARDS_LIMITS.maxConfirmEntries),
});

/**
 * Resolves the reviewed targets of the pending entries one confirmation covers, so it never stores
 * an association or copy for a reference the published catalog does not contain
 * (docs/user-cards.md#import-and-capture-state).
 */
async function resolveReviewedTargets(
  catalog: ImportServiceDependencies['catalog'],
  verified: readonly { readonly entry: ImportEntry }[],
): Promise<ReadonlyMap<string, PrintingRecord>> {
  const printings = await resolvePrintings(
    catalog,
    verified.flatMap(({ entry }) =>
      entry.state === 'pending' && entry.printingId !== null ? [entry.printingId] : [],
    ),
  );
  await resolveCards(
    catalog,
    verified.flatMap(({ entry }) =>
      entry.state === 'pending' && entry.printingId === null && entry.cardId !== null
        ? [entry.cardId]
        : [],
    ),
  );
  return printings;
}

export function createImportConfirmation(
  dependencies: ImportServiceDependencies,
): Pick<ImportOperations, 'confirmImport' | 'recoverImportOperation'> {
  const { store, catalog } = dependencies;
  return {
    async confirmImport(
      context: TrustedUserContext,
      input: ConfirmImportInput,
    ): Promise<ImportConfirmationResult> {
      const accountId = accountIdFrom(context);
      const request = confirmImportRequestSchema.safeParse(input);
      if (!request.success) {
        throw new UserCardsError(
          'invalid-request',
          `A confirmation needs an operation identity, an import identity, an explicit ` +
            `destination and 1 to ${USERCARDS_LIMITS.maxConfirmEntries} reviewed entries with ` +
            'their revisions.',
        );
      }
      const { operationId, sessionId, destination, entries } = request.data;
      if (new Set(entries.map((entry) => entry.entryId)).size !== entries.length) {
        throw new UserCardsError('invalid-request', 'Each confirmed entry needs its own identity.');
      }

      const stored = await store.readEntries(
        accountId,
        entries.map((entry) => entry.entryId),
      );
      const byId = new Map(stored.map((entry) => [entry.entryId, entry] as const));
      const verified = entries.map((requested) => {
        const entry = byId.get(requested.entryId);
        if (entry === undefined || entry.sessionId !== sessionId) {
          throw new UserCardsError(
            'not-found',
            'This account has no pending entry with that identity.',
          );
        }
        return { requested, entry };
      });

      const printings = await resolveReviewedTargets(catalog, verified);
      const reviewed: ConfirmedImportEntry[] = verified.map(({ requested, entry }) => {
        let finish = entry.finish;
        const printing =
          entry.state === 'pending' && entry.printingId !== null
            ? printings.get(entry.printingId)
            : undefined;
        if (entry.state === 'pending' && entry.printingId !== null && printing === undefined) {
          throw new UserCardsError('not-found', 'The printing is not available in the catalog.');
        }
        if (
          destination.kind === 'ownership' &&
          entry.state === 'pending' &&
          entry.printingId !== null &&
          entry.finish !== null
        ) {
          if (printing === undefined) {
            throw new UserCardsError('not-found', 'The printing is not available in the catalog.');
          }
          finish = physicalFinish(printing, entry.finish);
        }
        const target = {
          cardId: printing?.cardId ?? entry.cardId,
          printingId: entry.printingId,
          finish,
          condition: entry.condition,
          quantity: entry.quantity,
        };
        return {
          entryId: entry.entryId,
          expectedRevision: requested.expectedRevision,
          state: entry.state,
          // The reviewed content of this entry is the durable key its acquisition is recorded
          // under, so replay protection does not depend on how a caller partitions confirmations.
          entryFingerprint: fingerprint([
            target.cardId,
            target.printingId,
            target.finish,
            target.condition,
            target.quantity,
          ]),
          reviewed: target,
        };
      });

      const outcome = await store.confirm(accountId, {
        operationId,
        sessionId,
        destination,
        inputFingerprint: fingerprint({
          sessionId,
          destination,
          entries: entries
            .map((entry) => [entry.entryId, entry.expectedRevision] as const)
            .sort((left, right) => left[0].localeCompare(right[0])),
        }),
        entries: reviewed,
      });
      switch (outcome.outcome) {
        case 'missing-session':
          throw new UserCardsError('not-found', 'This account has no import with that identity.');
        case 'missing-entry':
        case 'stale-entry':
          throw new UserCardsError(
            'conflict',
            'A reviewed entry changed or is no longer pending; reload the import before confirming.',
          );
        case 'unresolved-entry':
          throw new UserCardsError(
            'invalid-request',
            destination.kind === 'ownership'
              ? 'Every confirmed entry needs a reviewed printing and finish before it can add ' +
                  'owned copies.'
              : 'Every confirmed entry needs a reviewed card or printing before it can be added ' +
                  'to a tag.',
          );
        case 'missing-tag':
          throw new UserCardsError('not-found', 'This account has no tag with that identity.');
        case 'unsupported-tag':
          throw new UserCardsError(
            'invalid-request',
            'A location or system tag is not a destination a reviewed import can be applied to.',
          );
        case 'operation-conflict':
          throw new UserCardsError(
            'conflict',
            'This operation was already used with different input.',
          );
        default:
          return {
            ...publicReceipt(outcome.receipt),
            replayed: outcome.replayed,
            privateRevision: outcome.privateRevision,
          };
      }
    },
    async recoverImportOperation(
      context: TrustedUserContext,
      operationId: ImportOperationId,
    ): Promise<ImportOperationRecoveryResult> {
      const accountId = accountIdFrom(context);
      const parsed = referenceSchema.safeParse(operationId);
      if (!parsed.success) {
        throw new UserCardsError('invalid-request', 'An operation identity is required.');
      }
      const receipt = await store.recover(accountId, parsed.data);
      return receipt === null
        ? { outcome: 'absent' }
        : { outcome: 'recorded', receipt: publicReceipt(receipt) };
    },
  };
}

/** Exposes the domain outcome while retaining legacy metadata only in stored replay evidence. */
function publicReceipt(receipt: ImportReceiptData): ImportReceipt {
  return {
    operationId: receipt.operationId,
    sessionId: receipt.sessionId,
    sourceKind: receipt.sourceKind,
    sourceId: receipt.sourceId,
    destination: receipt.destination,
    copies: receipt.copies,
    associations: receipt.associations,
  };
}
