import { storeCopies } from './copies.js';
import { UserCardsError } from './errors.js';
import type { UserCardsSqlTransactor, UserCardsSqlValue } from './executor.js';
import { advanceRevision } from './revision.js';
import { storePrintingReferences } from './references.js';
import { copyFromRow, copyPayloadSql, copiesFromRows } from './rows.js';
import {
  groupRows,
  inTransaction,
  placeholdersFor,
  readRows,
  revisionBranchSql,
  revisionFromPayload,
} from './sql.js';
import type {
  CopiesData,
  CopyChangeData,
  CopyCorrection,
  CopyCorrectionOutcome,
  CopyStore,
} from './store.js';

function readCopiesStatement(
  accountId: string,
  copyIds: readonly string[],
): { statement: string; parameters: Record<string, UserCardsSqlValue> } {
  // The deployed executor reaches Aurora through the RDS Data API, which caps a response row at
  // 64 KB, so copies arrive one row each; the revision row is part of the same statement, so
  // records and revision always come from one snapshot.
  const branches = [revisionBranchSql()];
  const parameters: Record<string, UserCardsSqlValue> = { account_id: accountId };
  if (copyIds.length > 0) {
    const references = placeholdersFor(copyIds, 'copy');
    Object.assign(parameters, references.parameters);
    branches.push(`select 'copy' as row_kind,
  (row_number() over (order by entry.copy_id))::int as row_position,
  to_jsonb(entry)::text as payload
from (select copy_id, printing_id, finish, condition, revision
      from usercards_private.copy
      where account_id = :account_id and copy_id in (${references.list})) as entry`);
  }
  return {
    statement: `${branches.join('\nunion all\n')}
order by row_kind, row_position`,
    parameters,
  };
}

function correctionStatement(
  accountId: string,
  correction: CopyCorrection,
): { statement: string; parameters: Record<string, UserCardsSqlValue> } {
  return {
    statement: `update usercards_private.copy as target
   set printing_id = :printing_id,
       finish = :finish,
       condition = :condition,
       revision = target.revision + 1,
       updated_at = now()
 where target.copy_id = :copy_id
   and target.account_id = :account_id
   and target.revision = :expected_revision
 returning ${copyPayloadSql} as payload`,
    parameters: {
      copy_id: correction.copyId,
      account_id: accountId,
      expected_revision: correction.expectedRevision,
      printing_id: correction.printingId,
      finish: correction.finish,
      condition: correction.condition,
    },
  };
}

/** Reads and writes the private copy records of one account. */
export function createPostgresCopyStore(sql: UserCardsSqlTransactor): CopyStore {
  return {
    async readCopies(accountId, copyIds): Promise<CopiesData> {
      const request = readCopiesStatement(accountId, copyIds);
      const rows = groupRows(
        await readRows(
          sql,
          request.statement,
          request.parameters,
          'The private copies could not be read.',
        ),
        ['revision', 'copy'] as const,
      );
      const revisionRow = rows.revision[0];
      if (revisionRow === undefined) {
        throw new UserCardsError(
          'unavailable',
          'UserCards did not report its private-data revision.',
        );
      }
      return {
        privateRevision: revisionFromPayload(revisionRow.payload),
        copies: copiesFromRows(rows.copy),
      };
    },

    async insertCopies(accountId, copies): Promise<CopyChangeData> {
      return inTransaction(
        sql,
        async (statements) => {
          const stored = await storeCopies(statements, accountId, copies);
          const committedRevision = await advanceRevision(statements, accountId);
          return {
            privateRevision: committedRevision,

            copies: copiesFromRows(stored.rows),
          };
        },
        'The copies could not be committed.',
      );
    },

    async correctCopy(accountId, correction): Promise<CopyCorrectionOutcome> {
      return inTransaction(
        sql,
        async (statements) => {
          const update = correctionStatement(accountId, correction);
          const rows = await readRows(
            statements,
            update.statement,
            update.parameters,
            'The correction could not be stored.',
          );
          const row = rows[0];
          if (row !== undefined) {
            await storePrintingReferences(statements, [
              { printingId: correction.printingId, cardId: correction.cardId },
            ]);
            const committedRevision = await advanceRevision(statements, accountId);
            return {
              outcome: 'updated',
              privateRevision: committedRevision,

              copy: copyFromRow(row),
            };
          }
          const existing = await readRows(
            statements,
            `select revision from usercards_private.copy
              where copy_id = :copy_id and account_id = :account_id`,
            { copy_id: correction.copyId, account_id: accountId },
            'The copy could not be read.',
          );
          return existing[0] === undefined ? { outcome: 'missing' } : { outcome: 'conflict' };
        },
        'The correction could not be committed.',
      );
    },
  };
}
