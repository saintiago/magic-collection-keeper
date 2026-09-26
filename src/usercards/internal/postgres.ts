import { z } from 'zod';

import { finishes } from '../../catalog/index.js';
import { UserCardsError } from './errors.js';
import type {
  UserCardsSqlExecutor,
  UserCardsSqlRow,
  UserCardsSqlTransactor,
  UserCardsSqlValue,
} from './executor.js';
import { USERCARDS_LIMITS, copyConditions, type PhysicalCopy } from './model.js';
import type {
  CopiesData,
  CopyCorrection,
  CopyCorrectionOutcome,
  CopyStore,
  NewCopy,
} from './store.js';

const identifierLength = USERCARDS_LIMITS.maxIdentifierLength;

const revisionJsonSchema = z.object({ revision: z.number().int().min(0) });

const copyJsonSchema = z.object({
  copy_id: z.string().min(1).max(identifierLength),
  printing_id: z.string().min(1).max(identifierLength),
  finish: z.enum(finishes),
  condition: z.enum(copyConditions).nullable(),
  revision: z.number().int().min(1),
});

/** One JSON payload per stored copy, so a response row never mixes or aggregates copies. */
const copyPayloadSql = `json_build_object(
    'copy_id', copy_id,
    'printing_id', printing_id,
    'finish', finish,
    'condition', condition,
    'revision', revision
  )::text`;

interface NamedPlaceholders {
  readonly list: string;
  readonly parameters: Record<string, string>;
}

/** One placeholder per value; RDS Data API parameters are named and never arrays. */
function placeholdersFor(values: readonly string[], prefix: string): NamedPlaceholders {
  const parameters: Record<string, string> = {};
  const names = values.map((value, index) => {
    parameters[`${prefix}_${index}`] = value;
    return `:${prefix}_${index}`;
  });
  return { list: names.join(', '), parameters };
}

function readCopiesStatement(
  accountId: string,
  copyIds: readonly string[],
): { statement: string; parameters: Record<string, UserCardsSqlValue> } {
  // The deployed executor reaches Aurora through the RDS Data API, which caps a response row at
  // 64 KB, so copies arrive one row each; the revision row is part of the same statement, so
  // records and revision always come from one snapshot.
  const revisionBranch = `select 'revision' as row_kind,
  0 as row_position,
  json_build_object('revision', coalesce(
    (select state.revision
       from usercards_private.account_state as state
      where state.account_id = :account_id), 0))::text as payload`;
  const branches = [revisionBranch];
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

/** Publication of one change: the account revision advances in the same transaction as the row. */
function revisionStatement(accountId: string): {
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

async function readRows(
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

async function inTransaction<T>(
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

function parsePayload<T>(schema: z.ZodType<T>, value: UserCardsSqlValue | undefined): T {
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
      'The stored copy data does not match the declared read contract.',
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

type CopyJson = z.infer<typeof copyJsonSchema>;

function copyFromJson(json: CopyJson): PhysicalCopy {
  return {
    copyId: json.copy_id,
    printingId: json.printing_id,
    finish: json.finish,
    condition: json.condition,
    revision: json.revision,
  };
}

function copiesFromRows(rows: readonly UserCardsSqlRow[]): PhysicalCopy[] {
  return rows
    .map((row) => copyFromJson(parsePayload(copyJsonSchema, row.payload)))
    .sort((left, right) => left.copyId.localeCompare(right.copyId));
}

function revisionFromPayload(value: UserCardsSqlValue | undefined): string {
  return String(parsePayload(revisionJsonSchema, value).revision);
}

function revisionFromRow(row: UserCardsSqlRow | undefined): string {
  const value = row?.revision;
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
    throw new UserCardsError('unavailable', 'UserCards did not report its private-data revision.');
  }
  return value;
}

interface GroupedRows {
  readonly revision: readonly UserCardsSqlRow[];
  readonly copies: readonly UserCardsSqlRow[];
}

/** Groups the statement's rows by record kind; anything else violates the read contract. */
function groupRows(rows: readonly UserCardsSqlRow[]): GroupedRows {
  const grouped: { revision: UserCardsSqlRow[]; copies: UserCardsSqlRow[] } = {
    revision: [],
    copies: [],
  };
  for (const row of rows) {
    switch (row.row_kind) {
      case 'revision':
        grouped.revision.push(row);
        break;
      case 'copy':
        grouped.copies.push(row);
        break;
      default:
        throw new UserCardsError(
          'unavailable',
          'UserCards returned a result that is not readable.',
        );
    }
  }
  return grouped;
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
        copies: copiesFromRows(rows.copies),
      };
    },

    async insertCopies(accountId, copies): Promise<CopiesData> {
      return inTransaction(
        sql,
        async (statements) => {
          const insert = insertCopiesStatement(accountId, copies);
          const rows = await readRows(
            statements,
            insert.statement,
            insert.parameters,
            'The copies could not be stored.',
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
              copy: copyFromJson(parsePayload(copyJsonSchema, row.payload)),
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
