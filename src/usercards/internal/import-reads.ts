import { z } from 'zod';
import { accountIdFrom } from './context.js';
import { UserCardsError } from './errors.js';
import type {
  ImportEntryListResult,
  ImportOperations,
  ImportServiceDependencies,
  ImportSessionListResult,
  ListImportEntriesOptions,
  ListImportSessionsOptions,
} from './import-contract.js';
import { referenceSchema } from './import-validation.js';
import { USERCARDS_LIMITS, type TrustedUserContext } from './model.js';
import { decodeContinuation, encodeContinuation } from './pagination.js';

const pageSizeSchema = z
  .number()
  .int()
  .min(USERCARDS_LIMITS.minImportPageSize)
  .max(USERCARDS_LIMITS.maxImportPageSize);

const listSessionsOptionsSchema = z.object({
  pageSize: pageSizeSchema.optional(),
  continuation: referenceSchema.optional(),
});

const listEntriesOptionsSchema = z.object({
  sessionId: referenceSchema,
  pageSize: pageSizeSchema.optional(),
  continuation: referenceSchema.optional(),
});

/**
 * Trims one read to its page size and returns the continuation that follows it. A continuation
 * read at an older private revision is refused instead of skipping or repeating records
 * (docs/user-cards.md#interface).
 */
function paginate<T>(
  privateRevision: string,
  records: readonly T[],
  offset: number,
  pageSize: number,
  continuation: { readonly revision: string } | null,
): { readonly records: readonly T[]; readonly continuation: string | null } {
  if (continuation !== null && continuation.revision !== privateRevision) {
    throw new UserCardsError(
      'conflict',
      'The private data changed after this page was read; start the pending import again.',
    );
  }
  const hasMore = records.length > pageSize;
  return {
    records: hasMore ? records.slice(0, pageSize) : records,
    continuation: hasMore
      ? encodeContinuation({
          version: 1,
          offset: offset + pageSize,
          revision: privateRevision,
        })
      : null,
  };
}

export function createImportReads(
  dependencies: ImportServiceDependencies,
): Pick<ImportOperations, 'listImportSessions' | 'listImportEntries'> {
  const { store } = dependencies;
  return {
    async listImportSessions(
      context: TrustedUserContext,
      options: ListImportSessionsOptions = {},
    ): Promise<ImportSessionListResult> {
      const accountId = accountIdFrom(context);
      const request = listSessionsOptionsSchema.safeParse(options);
      if (!request.success) {
        throw new UserCardsError(
          'invalid-request',
          `A pending-import page size from ${USERCARDS_LIMITS.minImportPageSize} to ` +
            `${USERCARDS_LIMITS.maxImportPageSize} is required.`,
        );
      }
      const pageSize = request.data.pageSize ?? USERCARDS_LIMITS.defaultImportPageSize;
      const continuation =
        request.data.continuation === undefined
          ? null
          : decodeContinuation(
              request.data.continuation,
              'This continuation is not readable; start the pending import list again.',
            );
      const data = await store.listSessions(accountId, continuation?.offset ?? 0, pageSize + 1);
      const listed = paginate(
        data.privateRevision,
        data.sessions,
        continuation?.offset ?? 0,
        pageSize,
        continuation,
      );
      return {
        privateRevision: data.privateRevision,
        sessions: listed.records,
        continuation: listed.continuation,
      };
    },
    async listImportEntries(
      context: TrustedUserContext,
      options: ListImportEntriesOptions,
    ): Promise<ImportEntryListResult> {
      const accountId = accountIdFrom(context);
      const request = listEntriesOptionsSchema.safeParse(options);
      if (!request.success) {
        throw new UserCardsError(
          'invalid-request',
          'Reading pending entries needs an import identity and a page size from ' +
            `${USERCARDS_LIMITS.minImportPageSize} to ${USERCARDS_LIMITS.maxImportPageSize}.`,
        );
      }
      const pageSize = request.data.pageSize ?? USERCARDS_LIMITS.defaultImportPageSize;
      const continuation =
        request.data.continuation === undefined
          ? null
          : decodeContinuation(
              request.data.continuation,
              'This continuation is not readable; start the pending entry list again.',
            );
      const data = await store.listEntries(
        accountId,
        request.data.sessionId,
        continuation?.offset ?? 0,
        pageSize + 1,
      );
      if (data === null) {
        throw new UserCardsError('not-found', 'This account has no import with that identity.');
      }
      const listed = paginate(
        data.privateRevision,
        data.entries,
        continuation?.offset ?? 0,
        pageSize,
        continuation,
      );
      return {
        privateRevision: data.privateRevision,
        session: data.session,
        entries: listed.records,
        continuation: listed.continuation,
      };
    },
  };
}
