import { randomUUID } from 'node:crypto';

import { UserCardsError } from './errors.js';
import type { UserCardsSqlTransactor, UserCardsSqlValue } from './executor.js';
import { copyFromRow, copyPayloadSql, copiesFromRows } from './rows.js';
import {
  groupRows,
  inTransaction,
  placeholdersFor,
  readRows,
  revisionBranchSql,
  revisionFromPayload,
  revisionFromRow,
  revisionStatement,
} from './sql.js';
import type {
  CopiesData,
  CopyCorrection,
  CopyCorrectionOutcome,
  CopyStore,
  NewCopy,
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

function insertCopiesStatement(
  accountId: string,
  copies: readonly NewCopy[],
): { statement: string; parameters: Record<string, UserCardsSqlValue> } {
  const parameters: Record<string, UserCardsSqlValue> = { account_id: accountId };
  const values = copies
    .map((copy, index) => {
      parameters[`copy_id_${index}`] = copy.copyId;
      parameters[`printing_id_${index}`] = copy.printingId;
      parameters[`finish_${index}`] = copy.finish;
      parameters[`condition_${index}`] = copy.condition;
      return `(:copy_id_${index}, :account_id, :printing_id_${index}, :finish_${index}, :condition_${index}, 1)`;
    })
    .join(',\n       ');
  return {
    statement: `insert into usercards_private.copy
       (copy_id, account_id, printing_id, finish, condition, revision)
     values ${values}
     returning ${copyPayloadSql} as payload`,
    parameters,
  };
}

/**
 * The account's system ownership tag, created on first use and reused afterwards
 * (docs/architecture.md#tags-and-associations). A partial unique index keeps one owned tag per
 * account, so the returned identity is the account's only ownership tag.
 */
function ownedTagStatement(
  accountId: string,
  proposedTagId: string,
): { statement: string; parameters: Record<string, UserCardsSqlValue> } {
  return {
    statement: `insert into usercards_private.tag (tag_id, account_id, kind, label, system, revision)
     values (:tag_id, :account_id, 'owned', 'Owned', true, 1)
     on conflict (account_id) where kind = 'owned'
     do update set label = excluded.label
     returning tag_id`,
    parameters: { tag_id: proposedTagId, account_id: accountId },
  };
}

/**
 * Associates every stored copy with the account's owned tag in the same transaction, so a copy
 * that exists in private storage is owned and its physical membership is explicit
 * (docs/user-cards.md#records-and-associations).
 */
function ownedAssociationsStatement(
  accountId: string,
  ownedTagId: string,
  copies: readonly NewCopy[],
): { statement: string; parameters: Record<string, UserCardsSqlValue> } {
  const parameters: Record<string, UserCardsSqlValue> = {
    account_id: accountId,
    tag_id: ownedTagId,
  };
  const values = copies
    .map((copy, index) => {
      parameters[`association_id_${index}`] = randomUUID();
      parameters[`copy_id_${index}`] = copy.copyId;
      return `(:association_id_${index}, :account_id, :tag_id, 'owned', 'copy', :copy_id_${index}, null, 1)`;
    })
    .join(',\n       ');
  return {
    statement: `insert into usercards_private.association
       (association_id, account_id, tag_id, tag_kind, target_level, target_id, quantity, revision)
     values ${values}
     returning association_id`,
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

    async insertCopies(accountId, copies): Promise<CopiesData> {
      return inTransaction(
        sql,
        async (statements) => {
          const owned = ownedTagStatement(accountId, randomUUID());
          const ownedRows = await readRows(
            statements,
            owned.statement,
            owned.parameters,
            'The account ownership tag could not be prepared.',
          );
          const ownedTagId = ownedRows[0]?.tag_id;
          if (typeof ownedTagId !== 'string') {
            throw new UserCardsError(
              'unavailable',
              'UserCards did not report the account ownership tag.',
            );
          }

          const insert = insertCopiesStatement(accountId, copies);
          const rows = await readRows(
            statements,
            insert.statement,
            insert.parameters,
            'The copies could not be stored.',
          );

          const ownership = ownedAssociationsStatement(accountId, ownedTagId, copies);
          await readRows(
            statements,
            ownership.statement,
            ownership.parameters,
            'The copy ownership could not be stored.',
          );

          const publication = revisionStatement(accountId);
          const revisionRow = await readRows(
            statements,
            publication.statement,
            publication.parameters,
            'The private-data revision could not be advanced.',
          );
          return {
            privateRevision: revisionFromRow(revisionRow[0]),
            copies: copiesFromRows(rows),
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
            const publication = revisionStatement(accountId);
            const revisionRow = await readRows(
              statements,
              publication.statement,
              publication.parameters,
              'The private-data revision could not be advanced.',
            );
            return {
              outcome: 'updated',
              privateRevision: revisionFromRow(revisionRow[0]),
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
