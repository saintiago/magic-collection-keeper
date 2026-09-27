/**
 * Private import and capture storage of one account (docs/user-cards.md#import-and-capture-state,
 * docs/user-cards.md#persistence-and-recovery).
 *
 * Pending sessions and entries live beside the account's owned copies, never inside the published
 * copies relation. Every mutation runs in one transaction that locks the session row first, so the
 * capture order, the consecutive-identity admission sequence, the reviewed revisions and the
 * confirmation receipts of one import serialize instead of racing. A staged capture records its
 * admission decision permanently, and a confirmation reserves its account-scoped operation
 * identity before it changes any record, so an operation conflict commits nothing.
 *
 * Replay protection is durable per acquisition source and source entry: an acquisition records the
 * reviewed content of one entry and its occurrence among the source's entries with that content, so
 * a repeated import recognizes the source entries it already acquired however a caller partitions
 * its confirmations, while two identical lines or a card captured twice around another card stay
 * distinct acquisitions (docs/user-cards.md#source-imports). Each recorded operation keeps the
 * copies it reported as immutable provenance, read back in transport-safe pages.
 */

import { randomUUID } from 'node:crypto';

import { ensureOwnedTag, storeCopiesWithOwnedTag } from './copies.js';
import { UserCardsError } from './errors.js';
import type {
  UserCardsSqlExecutor,
  UserCardsSqlRow,
  UserCardsSqlTransactor,
  UserCardsSqlValue,
} from './executor.js';
import {
  USERCARDS_LIMITS,
  type ImportCandidate,
  type ImportEntry,
  type ImportSession,
  type PhysicalCopy,
} from './model.js';
import {
  copyFromRow,
  copiesFromRows,
  importCandidatePayloadSql,
  importEntriesFromRows,
  importEntryPayloadSql,
  importSessionFromRow,
  importSessionsFromRows,
} from './rows.js';
import {
  groupRows,
  inTransaction,
  placeholdersFor,
  readRows,
  revisionBranchSql,
  revisionFromPayload,
  revisionFromRow,
  revisionReadStatement,
  revisionStatement,
} from './sql.js';
import type {
  CandidateAttachment,
  CandidateAttachmentOutcome,
  CaptureStageOutcome,
  ConfirmationOutcome,
  ConfirmationPlan,
  ConfirmedImportEntry,
  ImportEntriesData,
  ImportEntryCorrection,
  ImportEntryCorrectionOutcome,
  ImportEntryDiscardOutcome,
  ImportReceiptData,
  ImportSessionDiscardOutcome,
  ImportSessionsData,
  ImportStageOutcome,
  ImportStore,
  NewImportEntry,
  NewStagedImportEntry,
} from './store.js';

interface Statement {
  readonly statement: string;
  readonly parameters: Record<string, UserCardsSqlValue>;
}

/** The durable content key of one entry: its reviewed content and its occurrence in its source. */
interface EntryKey {
  readonly entryFingerprint: string;
  readonly occurrence: number;
}

/** One stored session as its mutations need it: the source identity, sequence state and revision. */
interface StoredSession {
  readonly sessionId: string;
  readonly sourceKind: string;
  readonly sourceId: string;
  readonly lastAcceptedIdentity: string | null;
  readonly revision: number;
}

/**
 * The account's session data with the counts its lifecycle state follows. A session with no entries
 * yet is pending: its capture sequence has not admitted anything, and it stays out of the pending
 * list until it holds a reviewable entry.
 */
const sessionSelectSql = `
  select session.session_id,
         session.source_kind,
         session.source_id,
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

const sessionGroupBySql = `
   group by session.account_id, session.session_id, session.source_kind, session.source_id,
            session.revision`;

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
from (select entry_id, session_id, position, state, printing_id, finish, condition, quantity,
             revision
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

function entryDataStatement(accountId: string, entryId: string): Statement {
  return {
    statement: `${revisionBranchSql()}
union all
select 'entry' as row_kind, 0 as row_position, ${importEntryPayloadSql} as payload
from (select entry_id, session_id, position, state, printing_id, finish, condition, quantity,
             revision
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
async function currentRevision(
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

async function advanceRevision(
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

async function readSession(
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

async function readEntry(
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

function integerValue(value: UserCardsSqlValue | undefined): number {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) {
    return Number(value);
  }
  throw new UserCardsError('unavailable', 'UserCards returned a result that is not readable.');
}

function textValue(value: UserCardsSqlValue | undefined): string {
  if (typeof value === 'string') {
    return value;
  }
  throw new UserCardsError('unavailable', 'UserCards returned a result that is not readable.');
}

/**
 * Splits one change into the bounded batches the deployed write transport accepts. Every batch
 * commits inside the caller's single transaction, so the change stays atomic.
 */
function batches<T>(records: readonly T[]): readonly (readonly T[])[] {
  const grouped: T[][] = [];
  for (let start = 0; start < records.length; start += USERCARDS_LIMITS.maxRecordsPerStatement) {
    grouped.push(records.slice(start, start + USERCARDS_LIMITS.maxRecordsPerStatement));
  }
  return grouped;
}

function ensureSessionStatement(
  accountId: string,
  sessionId: string,
  sourceKind: string,
  sourceId: string,
): Statement {
  return {
    statement: `insert into usercards_private.import_session
       (session_id, account_id, source_kind, source_id, last_accepted_identity, revision)
     values (:session_id, :account_id, :source_kind, :source_id, null, 1)
     on conflict (account_id, session_id) do nothing
     returning session_id`,
    parameters: {
      session_id: sessionId,
      account_id: accountId,
      source_kind: sourceKind,
      source_id: sourceId,
    },
  };
}

function lockSessionStatement(accountId: string, sessionId: string): Statement {
  return {
    statement: `select source_kind, source_id, last_accepted_identity, revision
     from usercards_private.import_session
    where account_id = :account_id and session_id = :session_id
    for update`,
    parameters: { account_id: accountId, session_id: sessionId },
  };
}

/** Resolves an entry's session and locks it, so its mutations serialize with the whole import. */
function lockEntrySessionStatement(accountId: string, entryId: string): Statement {
  return {
    statement: `select session.account_id, session.session_id
     from usercards_private.import_session as session
     join usercards_private.import_entry as entry
       on entry.account_id = session.account_id
      and entry.session_id = session.session_id
    where session.account_id = :account_id and entry.entry_id = :entry_id
    for update of session`,
    parameters: { account_id: accountId, entry_id: entryId },
  };
}

/**
 * Creates the session when it is new and locks it, verifying that a capture observation belongs to
 * a capture session and a parsed source line to the session of its own source.
 */
async function claimSession(
  statements: UserCardsSqlExecutor,
  accountId: string,
  sessionId: string,
  sourceKind: string,
  sourceId: string,
): Promise<StoredSession> {
  const ensure = ensureSessionStatement(accountId, sessionId, sourceKind, sourceId);
  await readRows(
    statements,
    ensure.statement,
    ensure.parameters,
    'The import session could not be prepared.',
  );
  const lock = lockSessionStatement(accountId, sessionId);
  const rows = await readRows(
    statements,
    lock.statement,
    lock.parameters,
    'The import session could not be locked.',
  );
  const stored = rows[0];
  if (stored === undefined) {
    throw new UserCardsError('unavailable', 'UserCards did not report the import session.');
  }
  const lastAccepted = stored.last_accepted_identity;
  return {
    sessionId,
    sourceKind: textValue(stored.source_kind),
    sourceId: textValue(stored.source_id),
    lastAcceptedIdentity: typeof lastAccepted === 'string' ? lastAccepted : null,
    revision: integerValue(stored.revision),
  };
}

function nextPositionStatement(accountId: string, sessionId: string): Statement {
  return {
    statement: `select coalesce(max(position), 0) as position
     from usercards_private.import_entry
    where account_id = :account_id and session_id = :session_id`,
    parameters: { account_id: accountId, session_id: sessionId },
  };
}

async function nextPosition(
  statements: UserCardsSqlExecutor,
  accountId: string,
  sessionId: string,
): Promise<number> {
  const request = nextPositionStatement(accountId, sessionId);
  const rows = await readRows(
    statements,
    request.statement,
    request.parameters,
    'The pending entry position could not be read.',
  );
  return integerValue(rows[0]?.position) + 1;
}

function insertEntryStatement(
  accountId: string,
  sessionId: string,
  entry: NewImportEntry,
  position: number,
): Statement {
  return {
    statement: `insert into usercards_private.import_entry
       (entry_id, account_id, session_id, state, position, printing_id, finish, condition,
        quantity, revision)
     values (:entry_id, :account_id, :session_id, 'pending', :position, :printing_id, :finish,
             :condition, :quantity, 1)
     returning entry_id`,
    parameters: {
      entry_id: entry.entryId,
      account_id: accountId,
      session_id: sessionId,
      position,
      printing_id: entry.printingId,
      finish: entry.finish,
      condition: entry.condition,
      quantity: entry.quantity,
    },
  };
}

function insertEntriesStatement(
  accountId: string,
  sessionId: string,
  entries: readonly NewImportEntry[],
  basePosition: number,
): Statement {
  const parameters: Record<string, UserCardsSqlValue> = {
    account_id: accountId,
    session_id: sessionId,
  };
  const values = entries
    .map((entry, index) => {
      parameters[`entry_id_${index}`] = entry.entryId;
      parameters[`position_${index}`] = basePosition + index;
      parameters[`printing_id_${index}`] = entry.printingId;
      parameters[`finish_${index}`] = entry.finish;
      parameters[`condition_${index}`] = entry.condition;
      parameters[`quantity_${index}`] = entry.quantity;
      return (
        `(:entry_id_${index}, :account_id, :session_id, 'pending', :position_${index}, ` +
        `:printing_id_${index}, :finish_${index}, :condition_${index}, :quantity_${index}, 1)`
      );
    })
    .join(',\n       ');
  return {
    statement: `insert into usercards_private.import_entry
       (entry_id, account_id, session_id, state, position, printing_id, finish, condition,
        quantity, revision)
     values ${values}
     returning entry_id`,
    parameters,
  };
}

/** Recognition alternatives of newly staged entries; a repeated alternative is stored once. */
function insertCandidatesStatement(
  accountId: string,
  candidates: readonly {
    readonly entryId: string;
    readonly candidate: ImportCandidate;
  }[],
): Statement {
  const parameters: Record<string, UserCardsSqlValue> = { account_id: accountId };
  const values = candidates
    .map(({ entryId, candidate }, index) => {
      parameters[`entry_id_${index}`] = entryId;
      parameters[`printing_id_${index}`] = candidate.printingId;
      parameters[`provider_${index}`] = candidate.provider;
      parameters[`evidence_${index}`] = candidate.evidence;
      return (
        `(:entry_id_${index}, :account_id, :printing_id_${index}, :provider_${index}, ` +
        `:evidence_${index})`
      );
    })
    .join(',\n       ');
  return {
    statement: `insert into usercards_private.import_candidate
       (entry_id, account_id, printing_id, provider, evidence)
     values ${values}
     on conflict do nothing
     returning entry_id`,
    parameters,
  };
}

/** Every recognition alternative of the newly staged entries, in staging order. */
function candidateRows(
  entries: readonly NewImportEntry[],
): { readonly entryId: string; readonly candidate: ImportCandidate }[] {
  return entries.flatMap((entry) =>
    entry.candidates.map((candidate) => ({ entryId: entry.entryId, candidate })),
  );
}

/** Permanent staging receipt of one admitted entry or one suppressed capture observation. */
function insertStagingReceiptStatement(
  accountId: string,
  sessionId: string,
  captured: {
    readonly captureId: string;
    readonly fingerprint: string;
    readonly outcome: 'admitted' | 'suppressed';
    readonly entryId: string | null;
  },
): Statement {
  return {
    statement: `insert into usercards_private.import_stage
       (capture_id, account_id, session_id, fingerprint, outcome, entry_id)
     values (:capture_id, :account_id, :session_id, :fingerprint, :outcome, :entry_id)
     returning capture_id`,
    parameters: {
      capture_id: captured.captureId,
      account_id: accountId,
      session_id: sessionId,
      fingerprint: captured.fingerprint,
      outcome: captured.outcome,
      entry_id: captured.entryId,
    },
  };
}

/** Staging receipts of a batch of parsed lines, each admitted under its own identity. */
function insertStagingReceiptsStatement(
  accountId: string,
  sessionId: string,
  entries: readonly NewStagedImportEntry[],
): Statement {
  const parameters: Record<string, UserCardsSqlValue> = {
    account_id: accountId,
    session_id: sessionId,
  };
  const values = entries
    .map((entry, index) => {
      parameters[`capture_id_${index}`] = entry.entryId;
      parameters[`fingerprint_${index}`] = entry.fingerprint;
      return (
        `(:capture_id_${index}, :account_id, :session_id, :fingerprint_${index}, ` +
        `'admitted', :capture_id_${index})`
      );
    })
    .join(',\n       ');
  return {
    statement: `insert into usercards_private.import_stage
       (capture_id, account_id, session_id, fingerprint, outcome, entry_id)
     values ${values}
     returning capture_id`,
    parameters,
  };
}

function readStagingReceiptsStatement(accountId: string, captureIds: readonly string[]): Statement {
  const references = placeholdersFor(captureIds, 'capture');
  return {
    statement: `select capture_id, session_id, fingerprint, outcome, entry_id
     from usercards_private.import_stage
    where account_id = :account_id and capture_id in (${references.list})`,
    parameters: { account_id: accountId, ...references.parameters },
  };
}

function readStagingReceiptStatement(accountId: string, captureId: string): Statement {
  return {
    statement: `select session_id, fingerprint, outcome, entry_id
     from usercards_private.import_stage
    where account_id = :account_id and capture_id = :capture_id`,
    parameters: { account_id: accountId, capture_id: captureId },
  };
}

function bumpSessionStatement(accountId: string, sessionId: string): Statement {
  return {
    statement: `update usercards_private.import_session
     set revision = revision + 1,
         updated_at = now()
    where account_id = :account_id and session_id = :session_id`,
    parameters: { account_id: accountId, session_id: sessionId },
  };
}

/** Admitting a capture advances the session's accepted sequence with the new entry. */
function acceptIdentityStatement(
  accountId: string,
  sessionId: string,
  identity: string,
): Statement {
  return {
    statement: `update usercards_private.import_session
     set last_accepted_identity = :identity,
         revision = revision + 1,
         updated_at = now()
    where account_id = :account_id and session_id = :session_id`,
    parameters: { account_id: accountId, session_id: sessionId, identity },
  };
}

function correctEntryStatement(accountId: string, correction: ImportEntryCorrection): Statement {
  return {
    statement: `update usercards_private.import_entry as target
     set printing_id = :printing_id,
         finish = :finish,
         condition = :condition,
         quantity = :quantity,
         revision = target.revision + 1,
         updated_at = now()
    where target.account_id = :account_id
      and target.entry_id = :entry_id
      and target.state = 'pending'
      and target.revision = :expected_revision
    returning target.entry_id`,
    parameters: {
      account_id: accountId,
      entry_id: correction.entryId,
      expected_revision: correction.expectedRevision,
      printing_id: correction.printingId,
      finish: correction.finish,
      condition: correction.condition,
      quantity: correction.quantity,
    },
  };
}

function insertCandidateStatement(
  accountId: string,
  entryId: string,
  candidates: CandidateAttachment['candidates'],
): Statement {
  const parameters: Record<string, UserCardsSqlValue> = {
    account_id: accountId,
    entry_id: entryId,
  };
  const values = candidates
    .map((candidate, index) => {
      parameters[`printing_id_${index}`] = candidate.printingId;
      parameters[`provider_${index}`] = candidate.provider;
      parameters[`evidence_${index}`] = candidate.evidence;
      return (
        `(:entry_id, :account_id, :printing_id_${index}, :provider_${index}, ` +
        `:evidence_${index})`
      );
    })
    .join(',\n       ');
  return {
    statement: `insert into usercards_private.import_candidate
       (entry_id, account_id, printing_id, provider, evidence)
     values ${values}
     on conflict do nothing
     returning printing_id`,
    parameters,
  };
}

function discardEntryStatement(
  accountId: string,
  entryId: string,
  expectedRevision: number,
): Statement {
  return {
    statement: `update usercards_private.import_entry as target
     set state = 'discarded',
         revision = target.revision + 1,
         updated_at = now()
    where target.account_id = :account_id
      and target.entry_id = :entry_id
      and target.state = 'pending'
      and target.revision = :expected_revision
    returning target.entry_id`,
    parameters: {
      account_id: accountId,
      entry_id: entryId,
      expected_revision: expectedRevision,
    },
  };
}

function discardPendingEntriesStatement(accountId: string, sessionId: string): Statement {
  return {
    statement: `update usercards_private.import_entry
     set state = 'discarded',
         revision = revision + 1,
         updated_at = now()
    where account_id = :account_id and session_id = :session_id and state = 'pending'
    returning entry_id`,
    parameters: { account_id: accountId, session_id: sessionId },
  };
}

/** The reviewed entries a confirmation covers, as one bounded read of their state and revision. */
function readConfirmationEntriesStatement(
  accountId: string,
  sessionId: string,
  entryIds: readonly string[],
): Statement {
  const references = placeholdersFor(entryIds, 'requested');
  return {
    statement: `select entry_id, state, revision
     from usercards_private.import_entry
    where account_id = :account_id
      and session_id = :session_id
      and entry_id in (${references.list})`,
    parameters: { account_id: accountId, session_id: sessionId, ...references.parameters },
  };
}

function readReceiptStatement(accountId: string, operationId: string): Statement {
  return {
    statement: `select receipt.session_id,
              receipt.input_fingerprint,
              session.source_kind,
              session.source_id
     from usercards_private.import_receipt as receipt
     join usercards_private.import_session as session
       on session.account_id = receipt.account_id
      and session.session_id = receipt.session_id
    where receipt.account_id = :account_id and receipt.operation_id = :operation_id`,
    parameters: { account_id: accountId, operation_id: operationId },
  };
}

/**
 * The recorded outcome of one reviewed request, whatever operation identity first ran it. An
 * identical request replayed under a different operation identity returns that outcome instead of
 * changing records again (docs/user-cards.md#interface).
 */
function readReceiptByInputStatement(accountId: string, inputFingerprint: string): Statement {
  return {
    statement: `select receipt.operation_id
     from usercards_private.import_receipt as receipt
    where account_id = :account_id
      and input_fingerprint = :input_fingerprint
    order by receipt.created_at, receipt.operation_id
    limit 1`,
    parameters: {
      account_id: accountId,
      input_fingerprint: inputFingerprint,
    },
  };
}

/**
 * The occurrence of each requested entry among its session's entries with the same reviewed
 * content, counted in capture order. Together with the entry fingerprint it identifies the source
 * entry an acquisition belongs to, so a duplicate line or a scan of the same card twice stays a
 * separate acquisition while a repeated import of that source recognizes what it already acquired.
 */
function entryOccurrencesStatement(
  accountId: string,
  sessionId: string,
  entryIds: readonly string[],
): Statement {
  const references = placeholdersFor(entryIds, 'occurrence');
  return {
    statement: `select requested.entry_id,
       (select count(*)::int
          from usercards_private.import_entry as peer
         where peer.account_id = requested.account_id
           and peer.session_id = requested.session_id
           and peer.position <= requested.position
           and peer.printing_id is not distinct from requested.printing_id
           and peer.finish is not distinct from requested.finish
           and peer.condition is not distinct from requested.condition
           and peer.quantity = requested.quantity) as occurrence
     from usercards_private.import_entry as requested
    where requested.account_id = :account_id
      and requested.session_id = :session_id
      and requested.entry_id in (${references.list})`,
    parameters: {
      account_id: accountId,
      session_id: sessionId,
      ...references.parameters,
    },
  };
}

/** The acquisitions already recorded for the requested reviewed entries of one source. */
function recordedAcquisitionsStatement(
  accountId: string,
  sourceKind: string,
  sourceId: string,
  keys: readonly EntryKey[],
): Statement {
  const parameters: Record<string, UserCardsSqlValue> = {
    account_id: accountId,
    source_kind: sourceKind,
    source_id: sourceId,
  };
  const values = keys
    .map((key, index) => {
      parameters[`fingerprint_${index}`] = key.entryFingerprint;
      parameters[`occurrence_${index}`] = key.occurrence;
      return `(:fingerprint_${index}::text, :occurrence_${index}::int)`;
    })
    .join(',\n       ');
  return {
    statement: `select acquisition.acquisition_id,
              acquisition.entry_fingerprint,
              acquisition.occurrence
     from usercards_private.import_acquisition as acquisition
     join (values ${values}) as requested (entry_fingerprint, occurrence)
       on requested.entry_fingerprint = acquisition.entry_fingerprint
      and requested.occurrence = acquisition.occurrence
    where acquisition.account_id = :account_id
      and acquisition.source_kind = :source_kind
      and acquisition.source_id = :source_id`,
    parameters,
  };
}

/** Records the acquisition of one source entry the account has not acquired from that source. */
function claimAcquisitionStatement(
  accountId: string,
  sourceKind: string,
  sourceId: string,
  entry: ConfirmedImportEntry,
  occurrence: number,
): Statement {
  return {
    statement: `insert into usercards_private.import_acquisition
       (acquisition_id, account_id, source_kind, source_id, entry_fingerprint, occurrence, entry_id)
     values (:acquisition_id, :account_id, :source_kind, :source_id, :entry_fingerprint,
             :occurrence, :entry_id)
     on conflict (account_id, source_kind, source_id, entry_fingerprint, occurrence) do nothing
     returning acquisition_id`,
    parameters: {
      acquisition_id: randomUUID(),
      account_id: accountId,
      source_kind: sourceKind,
      source_id: sourceId,
      entry_fingerprint: entry.entryFingerprint,
      occurrence,
      entry_id: entry.entryId,
    },
  };
}

/** The durable key of one reviewed entry inside its acquisition source. */
function entryKey(entryFingerprint: string, occurrence: number): string {
  return `${entryFingerprint}\u0000${occurrence}`;
}

function provenanceStatement(
  accountId: string,
  acquisitionId: string,
  copies: readonly (PhysicalCopy & { readonly entryId: string })[],
): Statement {
  const parameters: Record<string, UserCardsSqlValue> = {
    account_id: accountId,
    acquisition_id: acquisitionId,
  };
  const values = copies
    .map((copy, index) => {
      parameters[`copy_id_${index}`] = copy.copyId;
      parameters[`entry_id_${index}`] = copy.entryId;
      parameters[`printing_id_${index}`] = copy.printingId;
      parameters[`finish_${index}`] = copy.finish;
      parameters[`condition_${index}`] = copy.condition;
      parameters[`revision_${index}`] = copy.revision;
      return (
        `(:copy_id_${index}, :account_id, :acquisition_id, :entry_id_${index}, ` +
        `:printing_id_${index}, :finish_${index}, :condition_${index}, :revision_${index})`
      );
    })
    .join(',\n       ');
  return {
    statement: `insert into usercards_private.copy_provenance
       (copy_id, account_id, acquisition_id, entry_id, printing_id, finish, condition, revision)
     values ${values}
     returning copy_id`,
    parameters,
  };
}

/**
 * Reserves the account-scoped operation identity before any record changes. The insert is the first
 * mutation of a confirmation, so an operation conflict leaves every record untouched.
 */
function insertReceiptStatement(accountId: string, plan: ConfirmationPlan): Statement {
  return {
    statement: `insert into usercards_private.import_receipt
       (operation_id, account_id, session_id, input_fingerprint)
     values (:operation_id, :account_id, :session_id, :input_fingerprint)
     on conflict (account_id, operation_id) do nothing
     returning operation_id`,
    parameters: {
      operation_id: plan.operationId,
      account_id: accountId,
      session_id: plan.sessionId,
      input_fingerprint: plan.inputFingerprint,
    },
  };
}

/** The acquisitions one operation's confirmation covered, as the recorded outcome it returns. */
function insertReceiptAcquisitionsStatement(
  accountId: string,
  operationId: string,
  acquisitionIds: readonly string[],
): Statement {
  const parameters: Record<string, UserCardsSqlValue> = {
    account_id: accountId,
    operation_id: operationId,
  };
  const values = acquisitionIds
    .map((acquisitionId, index) => {
      parameters[`acquisition_id_${index}`] = acquisitionId;
      return `(:account_id, :operation_id, :acquisition_id_${index})`;
    })
    .join(',\n       ');
  return {
    statement: `insert into usercards_private.import_receipt_acquisition
       (account_id, operation_id, acquisition_id)
     values ${values}
     returning acquisition_id`,
    parameters,
  };
}

/** Closes the reviewed entries of one confirmation, whether they created copies or replayed. */
function confirmEntriesStatement(
  accountId: string,
  sessionId: string,
  entryIds: readonly string[],
): Statement {
  const references = placeholdersFor(entryIds, 'confirmed');
  return {
    statement: `update usercards_private.import_entry
     set state = 'confirmed',
         revision = revision + 1,
         updated_at = now()
    where account_id = :account_id
      and session_id = :session_id
      and state = 'pending'
      and entry_id in (${references.list})
    returning entry_id`,
    parameters: { account_id: accountId, session_id: sessionId, ...references.parameters },
  };
}

/**
 * One bounded page of the copies a recorded operation covered, as the immutable provenance of
 * their own acquisition recorded them when they were created. A later correction of a physical
 * copy changes the copy, never this recorded outcome.
 */
function receiptCopiesStatement(
  accountId: string,
  operationId: string,
  limit: number,
  offset: number,
): Statement {
  return {
    statement: `select 'copy' as row_kind,
  (row_number() over (order by provenance.copy_id))::int as row_position,
  to_jsonb(provenance)::text as payload
from (select provenance.copy_id,
             provenance.printing_id,
             provenance.finish,
             provenance.condition,
             provenance.revision
        from usercards_private.import_receipt_acquisition as covered
        join usercards_private.copy_provenance as provenance
          on provenance.account_id = covered.account_id
         and provenance.acquisition_id = covered.acquisition_id
       where covered.account_id = :account_id
         and covered.operation_id = :operation_id
       order by provenance.copy_id
       limit :limit offset :offset) as provenance
order by row_kind, row_position`,
    parameters: { account_id: accountId, operation_id: operationId, limit, offset },
  };
}

/**
 * One recorded outcome: the operation, the session that referred to it and the copies it reported,
 * read in transport-safe pages so an outcome larger than one response stays complete. The copies
 * come from the immutable provenance of the acquisitions the operation covered, so later physical
 * corrections never change what the operation recorded.
 */
async function readReceipt(
  statements: UserCardsSqlExecutor,
  accountId: string,
  operationId: string,
): Promise<ImportReceiptData | null> {
  const recordedRequest = readReceiptStatement(accountId, operationId);
  const recorded = (
    await readRows(
      statements,
      recordedRequest.statement,
      recordedRequest.parameters,
      'The recorded operation could not be read.',
    )
  )[0];
  if (recorded === undefined) {
    return null;
  }
  const pageSize = USERCARDS_LIMITS.maxReceiptCopiesPerRead;
  const copies: UserCardsSqlRow[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const request = receiptCopiesStatement(accountId, operationId, pageSize, offset);
    const page = await readRows(
      statements,
      request.statement,
      request.parameters,
      'The recorded confirmation could not be read.',
    );
    copies.push(...page);
    if (page.length < pageSize) {
      break;
    }
  }
  return {
    operationId,
    sessionId: textValue(recorded.session_id),
    sourceKind: textValue(recorded.source_kind),
    sourceId: textValue(recorded.source_id),
    copies: copiesFromRows(copies),
  };
}

/** The recorded outcome of one operation that must exist, because this transaction recorded it. */
async function requireReceipt(
  statements: UserCardsSqlExecutor,
  accountId: string,
  operationId: string,
): Promise<ImportReceiptData> {
  const receipt = await readReceipt(statements, accountId, operationId);
  if (receipt === null) {
    throw new UserCardsError('unavailable', 'UserCards did not report the recorded confirmation.');
  }
  return receipt;
}

/** One session that must exist, because a mutation just read or wrote it in this transaction. */
async function requireSession(
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

async function requireEntry(
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

/** Resolves the session of one entry and locks it, or `null` when this account has no such entry. */
async function lockEntrySession(
  statements: UserCardsSqlExecutor,
  accountId: string,
  entryId: string,
): Promise<string | null> {
  const request = lockEntrySessionStatement(accountId, entryId);
  const rows = await readRows(
    statements,
    request.statement,
    request.parameters,
    'The pending entry could not be locked.',
  );
  const row = rows[0];
  return row === undefined ? null : textValue(row.session_id);
}

function entriesDataStatement(accountId: string, entryIds: readonly string[]): Statement {
  const references = placeholdersFor(entryIds, 'entry');
  return {
    statement: `select 'entry' as row_kind,
  (row_number() over (order by entry.position))::int as row_position,
  ${importEntryPayloadSql} as payload
from (select entry_id, session_id, position, state, printing_id, finish, condition, quantity,
             revision
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
async function readEntriesByIds(
  statements: UserCardsSqlExecutor,
  accountId: string,
  entryIds: readonly string[],
): Promise<ImportEntry[]> {
  if (entryIds.length === 0) {
    return [];
  }
  const request = entriesDataStatement(accountId, entryIds);
  const rows = groupRows(
    await readRows(
      statements,
      request.statement,
      request.parameters,
      'The pending entries could not be read.',
    ),
    ['entry', 'candidate'] as const,
  );
  return importEntriesFromRows(rows.entry, rows.candidate);
}

function candidateKey(printingId: string, provider: string, evidence: string): string {
  return `${printingId}\u0000${provider}\u0000${evidence}`;
}

/** The state of the requested entries: still reviewable, already confirmed, or neither. */
interface ConfirmationClassification {
  /** Requested entries that are still pending at the revision the caller reviewed. */
  readonly pending: readonly ConfirmedImportEntry[];
  /** A requested entry is not this account's or not in this session. */
  readonly missing: boolean;
  /** A requested entry was discarded, or changed after the caller read it. */
  readonly stale: boolean;
  /** A pending requested entry has no resolved printing and finish yet. */
  readonly unresolved: boolean;
}

async function classifyConfirmation(
  statements: UserCardsSqlExecutor,
  accountId: string,
  plan: ConfirmationPlan,
): Promise<ConfirmationClassification> {
  const request = readConfirmationEntriesStatement(
    accountId,
    plan.sessionId,
    plan.entries.map((entry) => entry.entryId),
  );
  const rows = await readRows(
    statements,
    request.statement,
    request.parameters,
    'The reviewed entries could not be read.',
  );
  const stored = new Map(rows.map((row) => [textValue(row.entry_id), row] as const));
  const pending: ConfirmedImportEntry[] = [];
  let missing = false;
  let stale = false;
  let unresolved = false;
  for (const requested of plan.entries) {
    const row = stored.get(requested.entryId);
    if (row === undefined) {
      missing = true;
      continue;
    }
    const state = textValue(row.state);
    if (
      state !== 'pending' ||
      requested.state !== 'pending' ||
      integerValue(row.revision) !== requested.expectedRevision
    ) {
      // The entry is confirmed or discarded, or changed after the caller read it.
      stale = true;
    } else if (requested.copy.printingId === null || requested.copy.finish === null) {
      unresolved = true;
    } else {
      pending.push(requested);
    }
  }
  return { pending, missing, stale, unresolved };
}

/** One reviewed entry with the durable key its acquisition source is recognized by. */
interface KeyedImportEntry {
  readonly entry: ConfirmedImportEntry;
  /** Occurrence of the entry among the session's entries with the same reviewed content. */
  readonly occurrence: number;
  readonly key: string;
}

/**
 * The occurrence of each reviewed entry among its session's entries with the same reviewed
 * content, in capture order. Two identical lines, or a card scanned twice around another card, get
 * distinct occurrences and stay distinct acquisitions, while a repeated import of the same source
 * declares the same occurrences again.
 */
async function readEntryKeys(
  statements: UserCardsSqlExecutor,
  accountId: string,
  sessionId: string,
  pending: readonly ConfirmedImportEntry[],
): Promise<readonly KeyedImportEntry[]> {
  const request = entryOccurrencesStatement(
    accountId,
    sessionId,
    pending.map((entry) => entry.entryId),
  );
  const rows = await readRows(
    statements,
    request.statement,
    request.parameters,
    'The reviewed entries could not be read.',
  );
  const occurrences = new Map(
    rows.map((row) => [textValue(row.entry_id), integerValue(row.occurrence)] as const),
  );
  return pending.map((entry) => {
    const occurrence = occurrences.get(entry.entryId);
    if (occurrence === undefined) {
      throw new UserCardsError('unavailable', 'UserCards did not report the reviewed entries.');
    }
    return {
      entry,
      occurrence,
      key: entryKey(entry.entryFingerprint, occurrence),
    };
  });
}

/** The acquisitions already recorded for the given durable keys of one source. */
async function readRecordedAcquisitions(
  statements: UserCardsSqlExecutor,
  accountId: string,
  sourceKind: string,
  sourceId: string,
  keys: readonly KeyedImportEntry[],
): Promise<ReadonlyMap<string, string>> {
  if (keys.length === 0) {
    return new Map();
  }
  const request = recordedAcquisitionsStatement(
    accountId,
    sourceKind,
    sourceId,
    keys.map(({ entry, occurrence }) => ({
      entryFingerprint: entry.entryFingerprint,
      occurrence,
    })),
  );
  const rows = await readRows(
    statements,
    request.statement,
    request.parameters,
    'The recorded acquisitions could not be read.',
  );
  return new Map(
    rows.map(
      (row) =>
        [
          entryKey(textValue(row.entry_fingerprint), integerValue(row.occurrence)),
          textValue(row.acquisition_id),
        ] as const,
    ),
  );
}

/** Reads and writes the private pending imports of one account. */
export function createPostgresImportStore(sql: UserCardsSqlTransactor): ImportStore {
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
      const request = entryPageStatement(accountId, sessionId, offset, limit);
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
      if (sessionRow === undefined) {
        return null;
      }
      return {
        privateRevision: revisionFromPayload(rows.revision[0]?.payload),
        session: importSessionFromRow(sessionRow),
        entries: importEntriesFromRows(rows.entry, rows.candidate),
      };
    },

    async readEntries(accountId, entryIds): Promise<readonly ImportEntry[]> {
      return readEntriesByIds(sql, accountId, entryIds);
    },

    async stageEntries(accountId, plan): Promise<ImportStageOutcome> {
      return inTransaction(
        sql,
        async (statements) => {
          const session = await claimSession(
            statements,
            accountId,
            plan.sessionId,
            plan.sourceKind,
            plan.sourceId,
          );
          if (session.sourceKind !== plan.sourceKind || session.sourceId !== plan.sourceId) {
            throw new UserCardsError(
              'invalid-request',
              'This session belongs to another import source; start a new import.',
            );
          }

          const receiptRequest = readStagingReceiptsStatement(
            accountId,
            plan.entries.map((entry) => entry.entryId),
          );
          const receipts = await readRows(
            statements,
            receiptRequest.statement,
            receiptRequest.parameters,
            'The staged entries could not be read.',
          );
          const recorded = new Map(
            receipts.map((row) => [textValue(row.capture_id), row] as const),
          );
          const fresh: NewStagedImportEntry[] = [];
          for (const entry of plan.entries) {
            const receipt = recorded.get(entry.entryId);
            if (receipt === undefined) {
              fresh.push(entry);
              continue;
            }
            if (
              textValue(receipt.fingerprint) !== entry.fingerprint ||
              textValue(receipt.session_id) !== plan.sessionId ||
              textValue(receipt.outcome) !== 'admitted'
            ) {
              return { outcome: 'line-conflict' as const };
            }
          }

          let privateRevision: string;
          if (fresh.length === 0) {
            privateRevision = await currentRevision(statements, accountId);
          } else {
            const base = await nextPosition(statements, accountId, plan.sessionId);
            const insert = insertEntriesStatement(accountId, plan.sessionId, fresh, base);
            await readRows(
              statements,
              insert.statement,
              insert.parameters,
              'The pending entries could not be stored.',
            );
            for (const batch of batches(candidateRows(fresh))) {
              const candidates = insertCandidatesStatement(accountId, batch);
              await readRows(
                statements,
                candidates.statement,
                candidates.parameters,
                'The recognition alternatives could not be stored.',
              );
            }
            const staging = insertStagingReceiptsStatement(accountId, plan.sessionId, fresh);
            await readRows(
              statements,
              staging.statement,
              staging.parameters,
              'The staging receipts could not be stored.',
            );
            const bump = bumpSessionStatement(accountId, plan.sessionId);
            await readRows(
              statements,
              bump.statement,
              bump.parameters,
              'The import session could not be updated.',
            );
            privateRevision = await advanceRevision(statements, accountId);
          }

          const storedSession = await readSession(statements, accountId, plan.sessionId);
          if (storedSession === null) {
            throw new UserCardsError('unavailable', 'UserCards did not report the import session.');
          }
          return {
            outcome: 'staged' as const,
            privateRevision,
            session: storedSession,
            entries: await readEntriesByIds(
              statements,
              accountId,
              plan.entries.map((entry) => entry.entryId),
            ),
            staged: fresh.length,
            replayed: fresh.length === 0,
          };
        },
        'The staged entries could not be committed.',
      );
    },

    async stageCapture(accountId, plan): Promise<CaptureStageOutcome> {
      return inTransaction(
        sql,
        async (statements) => {
          const session = await claimSession(
            statements,
            accountId,
            plan.sessionId,
            'capture',
            plan.sessionId,
          );
          if (session.sourceKind !== 'capture' || session.sourceId !== plan.sessionId) {
            throw new UserCardsError(
              'invalid-request',
              'This session belongs to another import source; start a new capture session.',
            );
          }

          const receiptRequest = readStagingReceiptStatement(accountId, plan.captureId);
          const receipt = (
            await readRows(
              statements,
              receiptRequest.statement,
              receiptRequest.parameters,
              'The staged capture could not be read.',
            )
          )[0];
          if (receipt !== undefined) {
            if (
              textValue(receipt.fingerprint) !== plan.fingerprint ||
              textValue(receipt.session_id) !== plan.sessionId
            ) {
              return { outcome: 'conflict' as const };
            }
            const recorded = textValue(receipt.outcome);
            const entryId = typeof receipt.entry_id === 'string' ? receipt.entry_id : null;
            const storedSession = await requireSession(statements, accountId, plan.sessionId);
            const privateRevision = await currentRevision(statements, accountId);
            if (recorded === 'admitted') {
              const entry =
                entryId === null ? null : await readEntry(statements, accountId, entryId);
              if (entry === null) {
                throw new UserCardsError(
                  'unavailable',
                  'UserCards did not report the staged capture.',
                );
              }
              return {
                outcome: 'admitted' as const,
                replayed: true,
                privateRevision,
                session: storedSession,
                entry,
              };
            }
            return {
              outcome: 'suppressed' as const,
              replayed: true,
              privateRevision,
              session: storedSession,
              entry: null,
            };
          }

          if (plan.identity === null || plan.entry === null) {
            // An unresolved reading stages nothing: it must not advance the accepted sequence and
            // the same capture can resolve later.
            return {
              outcome: 'unresolved' as const,
              replayed: false,
              privateRevision: await currentRevision(statements, accountId),
              session: await requireSession(statements, accountId, plan.sessionId),
              entry: null,
            };
          }

          if (session.lastAcceptedIdentity === plan.identity) {
            const staging = insertStagingReceiptStatement(accountId, plan.sessionId, {
              captureId: plan.captureId,
              fingerprint: plan.fingerprint,
              outcome: 'suppressed',
              entryId: null,
            });
            await readRows(
              statements,
              staging.statement,
              staging.parameters,
              'The staging receipt could not be stored.',
            );
            return {
              outcome: 'suppressed' as const,
              replayed: false,
              privateRevision: await currentRevision(statements, accountId),
              session: await requireSession(statements, accountId, plan.sessionId),
              entry: null,
            };
          }

          const position = await nextPosition(statements, accountId, plan.sessionId);
          const insert = insertEntryStatement(accountId, plan.sessionId, plan.entry, position);
          await readRows(
            statements,
            insert.statement,
            insert.parameters,
            'The pending entry could not be stored.',
          );
          for (const batch of batches(candidateRows([plan.entry]))) {
            const candidates = insertCandidatesStatement(accountId, batch);
            await readRows(
              statements,
              candidates.statement,
              candidates.parameters,
              'The recognition alternatives could not be stored.',
            );
          }
          const accept = acceptIdentityStatement(accountId, plan.sessionId, plan.identity);
          await readRows(
            statements,
            accept.statement,
            accept.parameters,
            'The accepted capture identity could not be stored.',
          );
          const staging = insertStagingReceiptStatement(accountId, plan.sessionId, {
            captureId: plan.captureId,
            fingerprint: plan.fingerprint,
            outcome: 'admitted',
            entryId: plan.entry.entryId,
          });
          await readRows(
            statements,
            staging.statement,
            staging.parameters,
            'The staging receipt could not be stored.',
          );
          return {
            outcome: 'admitted' as const,
            replayed: false,
            privateRevision: await advanceRevision(statements, accountId),
            session: await requireSession(statements, accountId, plan.sessionId),
            entry: await requireEntry(statements, accountId, plan.entry.entryId),
          };
        },
        'The capture could not be staged.',
      );
    },

    async correctEntry(accountId, correction): Promise<ImportEntryCorrectionOutcome> {
      return inTransaction(
        sql,
        async (statements) => {
          const located = await lockEntrySession(statements, accountId, correction.entryId);
          if (located === null) {
            return { outcome: 'missing' as const };
          }
          const update = correctEntryStatement(accountId, correction);
          const rows = await readRows(
            statements,
            update.statement,
            update.parameters,
            'The reviewed entry could not be stored.',
          );
          if (rows[0] === undefined) {
            return { outcome: 'conflict' as const };
          }
          // A review changes the pending state a whole-import discard removes, so it advances the
          // session revision that discard validates.
          const bump = bumpSessionStatement(accountId, located);
          await readRows(
            statements,
            bump.statement,
            bump.parameters,
            'The import session could not be updated.',
          );
          const privateRevision = await advanceRevision(statements, accountId);
          return {
            outcome: 'updated' as const,
            privateRevision,
            session: await requireSession(statements, accountId, located),
            entry: await requireEntry(statements, accountId, correction.entryId),
          };
        },
        'The reviewed entry could not be committed.',
      );
    },

    async attachCandidates(accountId, attachment): Promise<CandidateAttachmentOutcome> {
      return inTransaction(
        sql,
        async (statements) => {
          const located = await lockEntrySession(statements, accountId, attachment.entryId);
          if (located === null) {
            return { outcome: 'missing' as const };
          }
          const current = await readEntry(statements, accountId, attachment.entryId);
          if (current === null) {
            return { outcome: 'missing' as const };
          }
          if (current.state !== 'pending') {
            // A late alternative for an entry that is no longer reviewable changes nothing.
            return {
              outcome: 'recorded' as const,
              privateRevision: await currentRevision(statements, accountId),
              session: await requireSession(statements, accountId, located),
              entry: current,
            };
          }

          const keys = new Set(
            current.candidates.map((candidate) =>
              candidateKey(candidate.printingId, candidate.provider, candidate.evidence),
            ),
          );
          const additions = attachment.candidates.filter(
            (candidate) =>
              !keys.has(candidateKey(candidate.printingId, candidate.provider, candidate.evidence)),
          );
          if (keys.size + additions.length > USERCARDS_LIMITS.maxImportCandidates) {
            throw new UserCardsError(
              'invalid-request',
              `A pending entry keeps at most ${USERCARDS_LIMITS.maxImportCandidates} ` +
                'recognition alternatives.',
            );
          }

          let privateRevision: string;
          if (additions.length === 0) {
            privateRevision = await currentRevision(statements, accountId);
          } else {
            const insert = insertCandidateStatement(accountId, attachment.entryId, additions);
            await readRows(
              statements,
              insert.statement,
              insert.parameters,
              'The recognition alternatives could not be stored.',
            );
            // Later alternatives are part of the pending state a whole-import discard removes, so
            // that discard quotes the session revision they published.
            const bump = bumpSessionStatement(accountId, located);
            await readRows(
              statements,
              bump.statement,
              bump.parameters,
              'The import session could not be updated.',
            );
            privateRevision = await advanceRevision(statements, accountId);
          }
          return {
            outcome: 'recorded' as const,
            privateRevision,
            session: await requireSession(statements, accountId, located),
            entry: await requireEntry(statements, accountId, attachment.entryId),
          };
        },
        'The recognition alternatives could not be committed.',
      );
    },

    async discardEntry(accountId, entryId, expectedRevision): Promise<ImportEntryDiscardOutcome> {
      return inTransaction(
        sql,
        async (statements) => {
          const located = await lockEntrySession(statements, accountId, entryId);
          if (located === null) {
            return { outcome: 'missing' as const };
          }
          const discard = discardEntryStatement(accountId, entryId, expectedRevision);
          const rows = await readRows(
            statements,
            discard.statement,
            discard.parameters,
            'The pending entry could not be discarded.',
          );
          if (rows[0] === undefined) {
            return { outcome: 'conflict' as const };
          }
          const bump = bumpSessionStatement(accountId, located);
          await readRows(
            statements,
            bump.statement,
            bump.parameters,
            'The import session could not be updated.',
          );
          const privateRevision = await advanceRevision(statements, accountId);
          return {
            outcome: 'discarded' as const,
            privateRevision,
            session: await requireSession(statements, accountId, located),
            entry: await requireEntry(statements, accountId, entryId),
          };
        },
        'The pending entry could not be discarded.',
      );
    },

    async discardSession(
      accountId,
      sessionId,
      expectedRevision,
    ): Promise<ImportSessionDiscardOutcome> {
      return inTransaction(
        sql,
        async (statements) => {
          const lock = lockSessionStatement(accountId, sessionId);
          const locked = await readRows(
            statements,
            lock.statement,
            lock.parameters,
            'The import session could not be locked.',
          );
          const stored = locked[0];
          if (stored === undefined) {
            return { outcome: 'missing' as const };
          }
          if (integerValue(stored.revision) !== expectedRevision) {
            return { outcome: 'conflict' as const };
          }
          const discard = discardPendingEntriesStatement(accountId, sessionId);
          const discarded = await readRows(
            statements,
            discard.statement,
            discard.parameters,
            'The pending entries could not be discarded.',
          );
          let privateRevision: string;
          if (discarded.length === 0) {
            privateRevision = await currentRevision(statements, accountId);
          } else {
            const bump = bumpSessionStatement(accountId, sessionId);
            await readRows(
              statements,
              bump.statement,
              bump.parameters,
              'The import session could not be updated.',
            );
            privateRevision = await advanceRevision(statements, accountId);
          }
          return {
            outcome: 'discarded' as const,
            privateRevision,
            session: await requireSession(statements, accountId, sessionId),
          };
        },
        'The pending import could not be discarded.',
      );
    },

    async confirm(accountId, plan): Promise<ConfirmationOutcome> {
      return inTransaction(
        sql,
        async (statements) => {
          // The session row serializes the changes of one import: entry state, source identity and
          // revision cannot change under this transaction.
          const lock = lockSessionStatement(accountId, plan.sessionId);
          const locked = await readRows(
            statements,
            lock.statement,
            lock.parameters,
            'The import session could not be locked.',
          );
          const stored = locked[0];
          if (stored === undefined) {
            return { outcome: 'missing-session' as const };
          }
          const sourceKind = textValue(stored.source_kind);
          const sourceId = textValue(stored.source_id);

          const operationRequest = readReceiptStatement(accountId, plan.operationId);
          const operation = (
            await readRows(
              statements,
              operationRequest.statement,
              operationRequest.parameters,
              'The recorded operation could not be read.',
            )
          )[0];
          if (operation !== undefined) {
            if (textValue(operation.input_fingerprint) !== plan.inputFingerprint) {
              return { outcome: 'operation-conflict' as const };
            }
            return {
              outcome: 'confirmed' as const,
              replayed: true,
              privateRevision: await currentRevision(statements, accountId),
              receipt: await requireReceipt(statements, accountId, plan.operationId),
            };
          }

          // The same reviewed request confirmed under another operation identity returns that
          // operation's recorded outcome instead of changing records again.
          const identicalRequest = readReceiptByInputStatement(accountId, plan.inputFingerprint);
          const identical = (
            await readRows(
              statements,
              identicalRequest.statement,
              identicalRequest.parameters,
              'The recorded request could not be read.',
            )
          )[0];
          if (identical !== undefined) {
            return {
              outcome: 'confirmed' as const,
              replayed: true,
              privateRevision: await currentRevision(statements, accountId),
              receipt: await requireReceipt(
                statements,
                accountId,
                textValue(identical.operation_id),
              ),
            };
          }

          const classification = await classifyConfirmation(statements, accountId, plan);
          if (classification.missing) {
            return { outcome: 'missing-entry' as const };
          }
          if (classification.stale) {
            return { outcome: 'stale-entry' as const };
          }
          if (classification.unresolved) {
            return { outcome: 'unresolved-entry' as const };
          }

          // Each reviewed entry is recognized by the durable key of its source entry: an
          // acquisition this source already holds is replayed, and only a source entry the account
          // has not acquired creates copies.
          const keys = await readEntryKeys(
            statements,
            accountId,
            plan.sessionId,
            classification.pending,
          );
          const recorded = await readRecordedAcquisitions(
            statements,
            accountId,
            sourceKind,
            sourceId,
            keys,
          );

          // Reserve the account-scoped operation identity before changing any record, so an
          // operation conflict commits no copy, acquisition or entry closure.
          const reservation = insertReceiptStatement(accountId, plan);
          const reserved = await readRows(
            statements,
            reservation.statement,
            reservation.parameters,
            'The confirmation receipt could not be stored.',
          );
          if (reserved.length === 0) {
            // Another confirmation of this account reserved the operation first; only identical
            // input may replay it, and nothing of this request has changed yet.
            const conflictingRequest = readReceiptStatement(accountId, plan.operationId);
            const conflicting = (
              await readRows(
                statements,
                conflictingRequest.statement,
                conflictingRequest.parameters,
                'The recorded operation could not be read.',
              )
            )[0];
            if (conflicting === undefined) {
              throw new UserCardsError(
                'unavailable',
                'UserCards did not report the recorded confirmation.',
              );
            }
            if (textValue(conflicting.input_fingerprint) !== plan.inputFingerprint) {
              return { outcome: 'operation-conflict' as const };
            }
            return {
              outcome: 'confirmed' as const,
              replayed: true,
              privateRevision: await currentRevision(statements, accountId),
              receipt: await requireReceipt(statements, accountId, plan.operationId),
            };
          }

          const covered = new Set<string>();
          let ownedTagId: string | null = null;
          let acquired = false;
          for (const { entry, occurrence, key } of keys) {
            const alreadyAcquired = recorded.get(key);
            if (alreadyAcquired !== undefined) {
              covered.add(alreadyAcquired);
              continue;
            }
            const claim = claimAcquisitionStatement(
              accountId,
              sourceKind,
              sourceId,
              entry,
              occurrence,
            );
            const claimed = (
              await readRows(
                statements,
                claim.statement,
                claim.parameters,
                'The acquisition could not be recorded.',
              )
            )[0];
            if (claimed === undefined) {
              // A competing confirmation of another session acquired the same source entry first:
              // this entry replays that recorded acquisition instead of adding it twice.
              const concurrent = await readRecordedAcquisitions(
                statements,
                accountId,
                sourceKind,
                sourceId,
                [{ entry, occurrence, key }],
              );
              const concurrentlyAcquired = concurrent.get(key);
              if (concurrentlyAcquired === undefined) {
                throw new UserCardsError(
                  'unavailable',
                  'UserCards did not record the acquisition.',
                );
              }
              covered.add(concurrentlyAcquired);
              continue;
            }
            acquired = true;
            const acquisitionId = textValue(claimed.acquisition_id);
            covered.add(acquisitionId);
            ownedTagId ??= await ensureOwnedTag(statements, accountId);
            const { printingId, finish } = entry.copy;
            if (printingId === null || finish === null) {
              throw new UserCardsError(
                'unavailable',
                'UserCards did not report the reviewed entry content.',
              );
            }
            const copies = Array.from({ length: entry.copy.quantity }, () => ({
              copyId: randomUUID(),
              entryId: entry.entryId,
              printingId,
              finish,
              condition: entry.copy.condition,
            }));
            // One confirmation commits atomically, while each statement stays inside the deployed
            // write transport's bound however many copies the reviewed entries carry.
            for (const batch of batches(copies)) {
              const stored = await storeCopiesWithOwnedTag(
                statements,
                accountId,
                ownedTagId,
                batch,
              );
              const provenance = provenanceStatement(
                accountId,
                acquisitionId,
                stored.map((row) => ({ ...copyFromRow(row), entryId: entry.entryId })),
              );
              await readRows(
                statements,
                provenance.statement,
                provenance.parameters,
                'The copy provenance could not be stored.',
              );
            }
          }

          const entryIds = keys.map(({ entry }) => entry.entryId);
          const confirmation = confirmEntriesStatement(accountId, plan.sessionId, entryIds);
          const confirmed = await readRows(
            statements,
            confirmation.statement,
            confirmation.parameters,
            'The reviewed entries could not be confirmed.',
          );
          if (confirmed.length !== entryIds.length) {
            throw new UserCardsError(
              'unavailable',
              'UserCards did not confirm the reviewed entries.',
            );
          }
          const bump = bumpSessionStatement(accountId, plan.sessionId);
          await readRows(
            statements,
            bump.statement,
            bump.parameters,
            'The import session could not be updated.',
          );
          for (const batch of batches([...covered])) {
            const outcome = insertReceiptAcquisitionsStatement(accountId, plan.operationId, batch);
            await readRows(
              statements,
              outcome.statement,
              outcome.parameters,
              'The recorded outcome could not be stored.',
            );
          }
          const privateRevision = await advanceRevision(statements, accountId);
          return {
            outcome: 'confirmed' as const,
            // A confirmation whose source entries are all already acquired returned their recorded
            // outcome instead of committing a new acquisition.
            replayed: !acquired,
            privateRevision,
            receipt: await requireReceipt(statements, accountId, plan.operationId),
          };
        },
        'The confirmation could not be committed.',
      );
    },

    async recover(accountId, operationId): Promise<ImportReceiptData | null> {
      return readReceipt(sql, accountId, operationId);
    },
  };
}
