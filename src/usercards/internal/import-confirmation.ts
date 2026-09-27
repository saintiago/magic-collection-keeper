import { z } from 'zod';
import { physicalFinish, resolvePrintings } from './catalog.js';
import { accountIdFrom } from './context.js';
import { UserCardsError } from './errors.js';
import { fingerprint } from './fingerprint.js';
import type {
  ConfirmImportInput,
  ImportConfirmationResult,
  ImportOperationRecoveryResult,
  ImportOperations,
  ImportServiceDependencies,
} from './import-contract.js';
import { referenceSchema, revisionSchema } from './import-validation.js';
import { USERCARDS_LIMITS, type ImportOperationId, type TrustedUserContext } from './model.js';
import type { ConfirmedImportEntry } from './store.js';

const confirmImportRequestSchema = z.object({
  operationId: referenceSchema,
  sessionId: referenceSchema,
  entries: z
    .array(z.object({ entryId: referenceSchema, expectedRevision: revisionSchema }))
    .min(1)
    .max(USERCARDS_LIMITS.maxConfirmEntries),
});

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
          `A confirmation needs an operation identity, an import identity and 1 to ` +
            `${USERCARDS_LIMITS.maxConfirmEntries} reviewed entries with their revisions.`,
        );
      }
      const { operationId, sessionId, entries } = request.data;
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

      const printings = await resolvePrintings(
        catalog,
        verified.flatMap(({ entry }) =>
          entry.state === 'pending' && entry.printingId !== null ? [entry.printingId] : [],
        ),
      );
      const reviewed: ConfirmedImportEntry[] = verified.map(({ requested, entry }) => {
        let finish = entry.finish;
        if (entry.state === 'pending' && entry.printingId !== null && entry.finish !== null) {
          const printing = printings.get(entry.printingId);
          if (printing === undefined) {
            throw new UserCardsError('not-found', 'The printing is not available in the catalog.');
          }
          finish = physicalFinish(printing, entry.finish);
        }
        const copy = {
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
            copy.printingId,
            copy.finish,
            copy.condition,
            copy.quantity,
          ]),
          copy,
        };
      });

      const outcome = await store.confirm(accountId, {
        operationId,
        sessionId,
        inputFingerprint: fingerprint({
          sessionId,
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
            'Every confirmed entry needs a reviewed printing and finish first.',
          );
        case 'operation-conflict':
          throw new UserCardsError(
            'conflict',
            'This operation was already used with different input.',
          );
        default:
          return {
            ...outcome.receipt,
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
      return receipt === null ? { outcome: 'absent' } : { outcome: 'recorded', receipt };
    },
  };
}
