import { randomUUID } from 'node:crypto';

import type { UserCardsSqlExecutor, UserCardsSqlRow, UserCardsSqlValue } from './executor.js';
import { UserCardsError } from './errors.js';
import { copyPayloadSql } from './rows.js';
import { readRows } from './sql.js';
import type { NewCopy } from './store.js';

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
 * Associates stored copies with the account's owned tag in the same transaction, so a copy that
 * exists in private storage is owned and its physical membership is explicit
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

/** Creates or reuses the account's ownership tag and returns its identity. */
export async function ensureOwnedTag(
  statements: UserCardsSqlExecutor,
  accountId: string,
): Promise<string> {
  const owned = ownedTagStatement(accountId, randomUUID());
  const rows = await readRows(
    statements,
    owned.statement,
    owned.parameters,
    'The account ownership tag could not be prepared.',
  );
  const ownedTagId = rows[0]?.tag_id;
  if (typeof ownedTagId !== 'string') {
    throw new UserCardsError('unavailable', 'UserCards did not report the account ownership tag.');
  }
  return ownedTagId;
}

/**
 * Stores copies with their explicit owned membership as one part of the caller's transaction and
 * returns the stored copy rows in the same order as `copies`.
 */
export async function storeCopies(
  statements: UserCardsSqlExecutor,
  accountId: string,
  copies: readonly NewCopy[],
): Promise<readonly UserCardsSqlRow[]> {
  const ownedTagId = await ensureOwnedTag(statements, accountId);
  return storeCopiesWithOwnedTag(statements, accountId, ownedTagId, copies);
}

/**
 * The same write for a caller that already prepared the account's ownership tag, so a confirmation
 * larger than one transport-bounded statement keeps one tag for all of its batches.
 */
export async function storeCopiesWithOwnedTag(
  statements: UserCardsSqlExecutor,
  accountId: string,
  ownedTagId: string,
  copies: readonly NewCopy[],
): Promise<readonly UserCardsSqlRow[]> {
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
  return rows;
}
