/** shared persistence for private imports. See docs/user-cards.md#internal-design. */
import { UserCardsError } from '../errors.js';
import type { UserCardsSqlExecutor, UserCardsSqlValue } from '../executor.js';
import { type ImportEntry, type ImportSession } from '../model.js';
import {
  importCandidatePayloadSql,
  importEntriesFromRows,
  importEntryPayloadSql,
  importSessionFromRow,
} from '../rows.js';
import {
  groupRows,
  placeholdersFor,
  readRows,
  revisionBranchSql,
  revisionFromRow,
  revisionReadStatement,
  revisionStatement,
} from '../sql.js';

export interface Statement {
  readonly statement: string;
  readonly parameters: Record<string, UserCardsSqlValue>;
}

/**
 * Ten entries fit below 1 MiB even with eight candidates each and all four candidate strings at
 * 200 units: double JSON escaping costs at most seven bytes per unit (< 6 KiB per candidate).
 * Entry/session/revision rows and transport wrappers leave ample headroom; no row reaches 64 KiB.
 * Keep this transport bound separate from the public page and staging sizes.
 */
export const entriesPerRead = 10;

/**
 * The account's session data with the counts its lifecycle state follows. A session with no entries
 * yet is pending: its capture sequence has not admitted anything, and it stays out of the pending
 * list until it holds a reviewable entry.
 */
export const sessionSelectSql = `
  select session.session_id,
         session.source_kind,
         session.source_id,
         session.source_reference,
         session.revision,
         count(entry.entry_id) filter (where entry.state = 'pending')::int as pending_entries,
         count(entry.entry_id) filter (where entry.state = 'confirmed')::int as confirmed_entries,
         count(entry.entry_id) filter (where entry.state = 'discarded')::int as discarded_entries,
         case when count(entry.entry_id) filter (where entry.state = 'pending') > 0 then 'pending'
              when count(entry.entry_id) = 0 then 'pending'
              when count(entry.entry_id) filter (where entry.state = 'confirmed') > 0 then 'confirmed'
              else 'discarded' end as state
    from usercards_private.import_session as session
    left join usercards_private.import_entry as entry
      on entry.account_id = session.account_id
     and entry.session_id = session.session_id
   where session.account_id = :account_id`;

export const sessionGroupBySql = `
   group by session.account_id, session.session_id, session.source_kind, session.source_id,
            session.source_reference, session.revision`;

function sessionDataStatement(accountId: string, sessionId: string): Statement {
  return {
    statement: `${revisionBranchSql()}
union all
select 'session' as row_kind, 0 as row_position, to_jsonb(page)::text as payload
from (${sessionSelectSql}
       and session.session_id = :session_id
${sessionGroupBySql}) as page
order by row_kind, row_position`,
    parameters: { account_id: accountId, session_id: sessionId },
  };
}

function entryDataStatement(accountId: string, entryId: string): Statement {
  return {
    statement: `${revisionBranchSql()}
union all
select 'entry' as row_kind, 0 as row_position, ${importEntryPayloadSql} as payload
from (select entry_id, session_id, position, state, printing_id, finish, condition, quantity,
             source_line, revision
        from usercards_private.import_entry
       where account_id = :account_id and entry_id = :entry_id) as entry
union all
select 'candidate' as row_kind,
  (row_number() over (order by candidate.printing_id, candidate.provider,
                      candidate.evidence))::int as row_position,
  ${importCandidatePayloadSql} as payload
from (select entry_id, printing_id, provider, evidence
        from usercards_private.import_candidate
       where account_id = :account_id and entry_id = :entry_id) as candidate
order by row_kind, row_position`,
    parameters: { account_id: accountId, entry_id: entryId },
  };
}

/** The account's revision without changing it, for operations that publish no new private state. */
export async function currentRevision(
  statements: UserCardsSqlExecutor,
  accountId: string,
): Promise<string> {
  const request = revisionReadStatement(accountId);
  const rows = await readRows(
    statements,
    request.statement,
    request.parameters,
    'The private-data revision could not be read.',
  );
  return revisionFromRow(rows[0]);
}

export async function advanceRevision(
  statements: UserCardsSqlExecutor,
  accountId: string,
): Promise<string> {
  const publication = revisionStatement(accountId);
  const rows = await readRows(
    statements,
    publication.statement,
    publication.parameters,
    'The private-data revision could not be advanced.',
  );
  return revisionFromRow(rows[0]);
}

export async function readSession(
  statements: UserCardsSqlExecutor,
  accountId: string,
  sessionId: string,
): Promise<ImportSession | null> {
  const request = sessionDataStatement(accountId, sessionId);
  const rows = groupRows(
    await readRows(
      statements,
      request.statement,
      request.parameters,
      'The pending import could not be read.',
    ),
    ['revision', 'session'] as const,
  );
  const row = rows.session[0];
  return row === undefined ? null : importSessionFromRow(row);
}

export async function readEntry(
  statements: UserCardsSqlExecutor,
  accountId: string,
  entryId: string,
): Promise<ImportEntry | null> {
  const request = entryDataStatement(accountId, entryId);
  const rows = groupRows(
    await readRows(
      statements,
      request.statement,
      request.parameters,
      'The pending entry could not be read.',
    ),
    ['revision', 'entry', 'candidate'] as const,
  );
  return importEntriesFromRows(rows.entry, rows.candidate)[0] ?? null;
}

export function integerValue(value: UserCardsSqlValue | undefined): number {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) {
    return Number(value);
  }
  throw new UserCardsError('unavailable', 'UserCards returned a result that is not readable.');
}

export function textValue(value: UserCardsSqlValue | undefined): string {
  if (typeof value === 'string') {
    return value;
  }
  throw new UserCardsError('unavailable', 'UserCards returned a result that is not readable.');
}

export function lockSessionStatement(accountId: string, sessionId: string): Statement {
  return {
    statement: `select source_kind, source_id, last_accepted_identity, revision
     from usercards_private.import_session
    where account_id = :account_id and session_id = :session_id
    for update`,
    parameters: { account_id: accountId, session_id: sessionId },
  };
}

export function bumpSessionStatement(accountId: string, sessionId: string): Statement {
  return {
    statement: `update usercards_private.import_session
     set revision = revision + 1,
         updated_at = now()
    where account_id = :account_id and session_id = :session_id`,
    parameters: { account_id: accountId, session_id: sessionId },
  };
}

/** One session that must exist, because a mutation just read or wrote it in this transaction. */
export async function requireSession(
  statements: UserCardsSqlExecutor,
  accountId: string,
  sessionId: string,
): Promise<ImportSession> {
  const session = await readSession(statements, accountId, sessionId);
  if (session === null) {
    throw new UserCardsError('unavailable', 'UserCards did not report the import session.');
  }
  return session;
}

export async function requireEntry(
  statements: UserCardsSqlExecutor,
  accountId: string,
  entryId: string,
): Promise<ImportEntry> {
  const entry = await readEntry(statements, accountId, entryId);
  if (entry === null) {
    throw new UserCardsError('unavailable', 'UserCards did not report the pending entry.');
  }
  return entry;
}

function entriesDataStatement(accountId: string, entryIds: readonly string[]): Statement {
  const references = placeholdersFor(entryIds, 'entry');
  return {
    statement: `select 'entry' as row_kind,
  (row_number() over (order by entry.position))::int as row_position,
  ${importEntryPayloadSql} as payload
from (select entry_id, session_id, position, state, printing_id, finish, condition, quantity,
             source_line, revision
        from usercards_private.import_entry
       where account_id = :account_id and entry_id in (${references.list})) as entry
union all
select 'candidate' as row_kind,
  (row_number() over (order by candidate.entry_id, candidate.printing_id, candidate.provider,
                      candidate.evidence))::int as row_position,
  ${importCandidatePayloadSql} as payload
from (select entry_id, printing_id, provider, evidence
        from usercards_private.import_candidate
       where account_id = :account_id and entry_id in (${references.list})) as candidate
order by row_kind, row_position`,
    parameters: { account_id: accountId, ...references.parameters },
  };
}

/** Reads the stored state of the staged entries, in capture order, with their alternatives. */
export async function readEntriesByIds(
  statements: UserCardsSqlExecutor,
  accountId: string,
  entryIds: readonly string[],
): Promise<ImportEntry[]> {
  if (entryIds.length === 0) {
    return [];
  }
  const entries: ImportEntry[] = [];
  for (let offset = 0; offset < entryIds.length; offset += entriesPerRead) {
    const request = entriesDataStatement(
      accountId,
      entryIds.slice(offset, offset + entriesPerRead),
    );
    const rows = groupRows(
      await readRows(
        statements,
        request.statement,
        request.parameters,
        'The pending entries could not be read.',
      ),
      ['entry', 'candidate'] as const,
    );
    entries.push(...importEntriesFromRows(rows.entry, rows.candidate));
  }
  return entries.sort((left, right) => left.position - right.position);
}
