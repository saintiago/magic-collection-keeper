/** reads persistence for private imports. See docs/user-cards.md#internal-design. */
import { UserCardsError } from '../errors.js';
import type { UserCardsSqlTransactor } from '../executor.js';
import { type ImportEntry } from '../model.js';
import {
  importCandidatePayloadSql,
  importEntriesFromRows,
  importEntryPayloadSql,
  importSessionFromRow,
  importSessionsFromRows,
} from '../rows.js';
import { groupRows, readRows, revisionBranchSql, revisionFromPayload } from '../sql.js';
import type { ImportEntriesData, ImportSessionsData, ImportStore } from '../store.js';
import {
  entriesPerRead,
  readEntriesByIds,
  sessionGroupBySql,
  sessionSelectSql,
  type Statement,
} from './session-state.js';

/** One bounded page of pending import sessions, ordered by stable session identity. */
function sessionListStatement(accountId: string, offset: number, limit: number): Statement {
  return {
    statement: `${revisionBranchSql()}
union all
select 'session' as row_kind,
  (row_number() over (order by page.session_id))::int as row_position,
  to_jsonb(page)::text as payload
from (${sessionSelectSql}
${sessionGroupBySql}
  having count(entry.entry_id) filter (where entry.state = 'pending') > 0
   order by session.session_id
   limit :limit offset :offset) as page
order by row_kind, row_position`,
    parameters: { account_id: accountId, limit, offset },
  };
}

/**
 * One session with a bounded page of its pending entries and the recognition alternatives stored
 * for those entries. Entries keep their capture order; a page never aggregates a whole session into
 * one transport row.
 */
function entryPageStatement(
  accountId: string,
  sessionId: string,
  offset: number,
  limit: number,
): Statement {
  return {
    statement: `${revisionBranchSql()}
union all
select 'session' as row_kind, 0 as row_position, to_jsonb(page)::text as payload
from (${sessionSelectSql}
       and session.session_id = :session_id
${sessionGroupBySql}) as page
union all
select 'entry' as row_kind,
  (row_number() over (order by entry.position))::int as row_position,
  ${importEntryPayloadSql} as payload
from (select entry_id, session_id, position, state, card_id, printing_id, finish, condition,
             quantity, source_line, revision
        from usercards_private.import_entry
       where account_id = :account_id
         and session_id = :session_id
         and state = 'pending'
       order by position
       limit :limit offset :offset) as entry
union all
select 'candidate' as row_kind,
  (row_number() over (order by candidate.entry_id, candidate.printing_id, candidate.provider,
                      candidate.evidence))::int as row_position,
  ${importCandidatePayloadSql} as payload
from (select candidate.entry_id, candidate.printing_id, candidate.provider, candidate.evidence
        from usercards_private.import_candidate as candidate
       where candidate.account_id = :account_id
         and candidate.entry_id in (select entry_id
                                      from usercards_private.import_entry
                                     where account_id = :account_id
                                       and session_id = :session_id
                                       and state = 'pending'
                                     order by position
                                     limit :limit offset :offset)) as candidate
order by row_kind, row_position`,
    parameters: { account_id: accountId, session_id: sessionId, limit, offset },
  };
}

export function createImportReads(
  sql: UserCardsSqlTransactor,
): Pick<ImportStore, 'listSessions' | 'listEntries' | 'readEntries'> {
  return {
    async listSessions(accountId, offset, limit): Promise<ImportSessionsData> {
      const request = sessionListStatement(accountId, offset, limit);
      const rows = groupRows(
        await readRows(
          sql,
          request.statement,
          request.parameters,
          'The pending imports could not be read.',
        ),
        ['revision', 'session'] as const,
      );
      return {
        privateRevision: revisionFromPayload(rows.revision[0]?.payload),
        sessions: importSessionsFromRows(rows.session),
      };
    },
    async listEntries(accountId, sessionId, offset, limit): Promise<ImportEntriesData | null> {
      let result: ImportEntriesData | null = null;
      const collected: ImportEntry[] = [];
      for (let read = 0; read < limit; read += entriesPerRead) {
        const size = Math.min(entriesPerRead, limit - read);
        const request = entryPageStatement(accountId, sessionId, offset + read, size);
        const rows = groupRows(
          await readRows(
            sql,
            request.statement,
            request.parameters,
            'The pending entries could not be read.',
          ),
          ['revision', 'session', 'entry', 'candidate'] as const,
        );
        const sessionRow = rows.session[0];
        if (sessionRow === undefined) return null;
        const privateRevision = revisionFromPayload(rows.revision[0]?.payload);
        if (result !== null && result.privateRevision !== privateRevision) {
          throw new UserCardsError(
            'conflict',
            'The pending entries changed while being read; reload them.',
          );
        }
        const entries = importEntriesFromRows(rows.entry, rows.candidate);
        collected.push(...entries);
        result = { privateRevision, session: importSessionFromRow(sessionRow), entries: collected };
        if (entries.length < size) break;
      }
      return result;
    },
    async readEntries(accountId, entryIds): Promise<readonly ImportEntry[]> {
      return readEntriesByIds(sql, accountId, entryIds);
    },
  };
}
