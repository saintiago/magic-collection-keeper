import { z } from 'zod';

import { UserCardsError } from './errors.js';
import type {
  UserCardsSqlExecutor,
  UserCardsSqlRow,
  UserCardsSqlTransactor,
  UserCardsSqlValue,
} from './executor.js';

/**
 * Statements and row helpers shared by the private UserCards stores. Private reads return one
 * bounded row per record plus the revision row, so a valid batch never exceeds the deployed
 * transport's per-row limit, and every change publishes the account revision in the same
 * transaction as the records it affects (docs/user-cards.md#persistence-and-recovery).
 */

export interface NamedPlaceholders {
  readonly list: string;
  readonly parameters: Record<string, string>;
}

/** One placeholder per value; RDS Data API parameters are named and never arrays. */
export function placeholdersFor(values: readonly string[], prefix: string): NamedPlaceholders {
  const parameters: Record<string, string> = {};
  const names = values.map((value, index) => {
    parameters[`${prefix}_${index}`] = value;
    return `:${prefix}_${index}`;
  });
  return { list: names.join(', '), parameters };
}

export async function readRows(
  sql: UserCardsSqlExecutor,
  statement: string,
  parameters: Readonly<Record<string, UserCardsSqlValue>>,
  message: string,
): Promise<readonly UserCardsSqlRow[]> {
  try {
    return await sql.query(statement, parameters);
  } catch (cause) {
    throw new UserCardsError('unavailable', message, { cause });
  }
}

export async function inTransaction<T>(
  sql: UserCardsSqlTransactor,
  work: (statements: UserCardsSqlExecutor) => Promise<T>,
  message: string,
): Promise<T> {
  try {
    return await sql.transaction((statements) => work(statements));
  } catch (cause) {
    if (cause instanceof UserCardsError) {
      throw cause;
    }
    throw new UserCardsError('unavailable', message, { cause });
  }
}

export function parsePayload<T>(schema: z.ZodType<T>, value: UserCardsSqlValue | undefined): T {
  if (typeof value !== 'string') {
    throw new UserCardsError('unavailable', 'UserCards returned a result that is not readable.');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch (cause) {
    throw new UserCardsError('unavailable', 'UserCards returned unreadable result data.', {
      cause,
    });
  }
  const parsed = schema.safeParse(decoded);
  if (!parsed.success) {
    throw new UserCardsError(
      'unavailable',
      'The stored private data does not match the declared read contract.',
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

export const revisionJsonSchema = z.object({ revision: z.number().int().min(0) });

export function revisionFromPayload(value: UserCardsSqlValue | undefined): string {
  return String(parsePayload(revisionJsonSchema, value).revision);
}

export function revisionFromRow(row: UserCardsSqlRow | undefined): string {
  const value = row?.revision;
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
    throw new UserCardsError('unavailable', 'UserCards did not report its private-data revision.');
  }
  return value;
}

/** One statement of a private read: the account revision that the same statement observed. */
export function revisionBranchSql(): string {
  return `select 'revision' as row_kind,
  0 as row_position,
  json_build_object('revision', coalesce(
    (select state.revision
       from usercards_private.account_state as state
      where state.account_id = :account_id), 0))::text as payload`;
}

/** Publication of one change: the account revision advances in the same transaction as the row. */
export function revisionStatement(accountId: string): {
  statement: string;
  parameters: Record<string, UserCardsSqlValue>;
} {
  return {
    statement: `insert into usercards_private.account_state (account_id, revision)
     values (:account_id, 1)
     on conflict (account_id) do update set revision = account_state.revision + 1
     returning revision::text as revision`,
    parameters: { account_id: accountId },
  };
}

/**
 * Groups the rows of a private read statement by record kind. Anything else violates the read
 * contract, so a storage that returns unexpected rows fails instead of being reported as an empty
 * result.
 */
export function groupRows<K extends string>(
  rows: readonly UserCardsSqlRow[],
  kinds: readonly K[],
): Record<K, UserCardsSqlRow[]> {
  const grouped = Object.fromEntries(
    kinds.map((kind) => [kind, [] as UserCardsSqlRow[]] as const),
  ) as Record<K, UserCardsSqlRow[]>;
  for (const row of rows) {
    const kind = row.row_kind;
    if (typeof kind !== 'string' || !kinds.includes(kind as K)) {
      throw new UserCardsError('unavailable', 'UserCards returned a result that is not readable.');
    }
    grouped[kind as K].push(row);
  }
  return grouped;
}
