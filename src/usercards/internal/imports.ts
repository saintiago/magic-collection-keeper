/**
 * Private import and capture storage of one account (docs/user-cards.md#import-and-capture-state,
 * docs/user-cards.md#persistence-and-recovery).
 *
 * Pending sessions and entries live beside the account's owned copies, never inside the published
 * copies relation. Every mutation runs in one transaction that locks the session row first, so the
 * capture order, the consecutive-identity admission sequence, the reviewed revisions and the
 * confirmation receipts of one import serialize instead of racing. A staged capture records its
 * admission decision permanently, a replayed confirmation returns the recorded outcome of its
 * operation or acquisition, and an acquisition keeps the source identity that stops the same
 * acquisition from being added twice.
 */

import { randomUUID } from 'node:crypto';

import type { Finish } from '../../catalog/index.js';
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
} from './model.js';
import {
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
              acquisition.acquisition_id,
              acquisition.source_kind,
              acquisition.source_id
     from usercards_private.import_receipt as receipt
     join usercards_private.import_acquisition as acquisition
       on acquisition.acquisition_id = receipt.acquisition_id
    where receipt.account_id = :account_id and receipt.operation_id = :operation_id`,
    parameters: { account_id: accountId, operation_id: operationId },
  };
}

function readAcquisitionStatement(
  accountId: string,
  sourceKind: string,
  sourceId: string,
  contentFingerprint: string,
): Statement {
  return {
    statement: `select acquisition_id, source_kind, source_id
     from usercards_private.import_acquisition
    where account_id = :account_id
      and source_kind = :source_kind
      and source_id = :source_id
      and content_fingerprint = :content_fingerprint`,
    parameters: {
      account_id: accountId,
      source_kind: sourceKind,
      source_id: sourceId,
      content_fingerprint: contentFingerprint,
    },
  };
}

/** Claims the acquisition of this source and content, or reports that another change holds it. */
function claimAcquisitionStatement(
  accountId: string,
  plan: ConfirmationPlan,
  sourceKind: string,
  sourceId: string,
): Statement {
  return {
    statement: `insert into usercards_private.import_acquisition
       (acquisition_id, account_id, source_kind, source_id, content_fingerprint)
     values (:acquisition_id, :account_id, :source_kind, :source_id, :content_fingerprint)
     on conflict (account_id, source_kind, source_id, content_fingerprint) do nothing
     returning acquisition_id`,
    parameters: {
      acquisition_id: randomUUID(),
      account_id: accountId,
      source_kind: sourceKind,
      source_id: sourceId,
      content_fingerprint: plan.contentFingerprint,
    },
  };
}

function provenanceStatement(
  accountId: string,
  acquisitionId: string,
  copies: readonly { readonly copyId: string; readonly entryId: string }[],
): Statement {
  const parameters: Record<string, UserCardsSqlValue> = {
    account_id: accountId,
    acquisition_id: acquisitionId,
  };
  const values = copies
    .map((copy, index) => {
      parameters[`copy_id_${index}`] = copy.copyId;
      parameters[`entry_id_${index}`] = copy.entryId;
      return `(:copy_id_${index}, :account_id, :acquisition_id, :entry_id_${index})`;
    })
    .join(',\n       ');
  return {
    statement: `insert into usercards_private.copy_provenance
       (copy_id, account_id, acquisition_id, entry_id)
     values ${values}
     returning copy_id`,
    parameters,
  };
}

function insertReceiptStatement(
  accountId: string,
  plan: ConfirmationPlan,
  acquisitionId: string,
): Statement {
  return {
    statement: `insert into usercards_private.import_receipt
       (operation_id, account_id, acquisition_id, session_id, input_fingerprint)
     values (:operation_id, :account_id, :acquisition_id, :session_id, :input_fingerprint)
     on conflict (account_id, operation_id) do nothing
     returning operation_id`,
    parameters: {
      operation_id: plan.operationId,
      account_id: accountId,
      acquisition_id: acquisitionId,
      session_id: plan.sessionId,
      input_fingerprint: plan.inputFingerprint,
    },
  };
}

/** Marks the reviewed entries of a recorded acquisition as confirmed without creating copies. */
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

/** The copies one acquisition created, read through their own provenance records. */
function acquisitionCopiesStatement(accountId: string, acquisitionId: string): Statement {
  return {
    statement: `select 'copy' as row_kind,
  (row_number() over (order by copy.copy_id))::int as row_position,
  to_jsonb(copy)::text as payload
from usercards_private.copy_provenance as provenance
join usercards_private.copy as copy
  on copy.copy_id = provenance.copy_id
where provenance.account_id = :account_id
  and provenance.acquisition_id = :acquisition_id
order by row_kind, row_position`,
    parameters: { account_id: accountId, acquisition_id: acquisitionId },
  };
}

/** One recorded outcome: the operation, the session that referred to it and the acquisition. */
async function readReceipt(
  statements: UserCardsSqlExecutor,
  accountId: string,
  operationId: string,
  sessionId: string,
  acquisitionId: string,
  sourceKind: string,
  sourceId: string,
): Promise<ImportReceiptData> {
  const copiesRequest = acquisitionCopiesStatement(accountId, acquisitionId);
  const rows = groupRows(
    await readRows(
      statements,
      copiesRequest.statement,
      copiesRequest.parameters,
      'The recorded confirmation could not be read.',
    ),
    ['copy'] as const,
  );
  return {
    operationId,
    sessionId,
    sourceKind,
    sourceId,
    copies: copiesFromRows(rows.copy),
  };
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

function acquisitionLookupStatement(
  accountId: string,
  plan: ConfirmationPlan,
  sourceKind: string,
  sourceId: string,
): Statement {
  return readAcquisitionStatement(accountId, sourceKind, sourceId, plan.contentFingerprint);
}

/** The state of the requested entries: still reviewable, already confirmed, or neither. */
interface ConfirmationClassification {
  /** Requested entries that are still pending at the revision the caller reviewed. */
  readonly pending: readonly ConfirmedImportEntry[];
  /** Requested entries this account already confirmed. */
  readonly confirmed: readonly string[];
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
  const confirmed: string[] = [];
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
    if (state === 'pending') {
      if (
        requested.state !== 'pending' ||
        integerValue(row.revision) !== requested.expectedRevision
      ) {
        stale = true;
      } else if (requested.copy.printingId === null || requested.copy.finish === null) {
        unresolved = true;
      } else {
        pending.push(requested);
      }
    } else if (state === 'confirmed') {
      // Confirmed since the caller read it: only its recorded acquisition may accept it again.
      confirmed.push(requested.entryId);
    } else {
      stale = true;
    }
  }
  return { pending, confirmed, missing, stale, unresolved };
}

interface RecordedAcquisition {
  readonly acquisitionId: string;
  readonly sourceKind: string;
  readonly sourceId: string;
}

/**
 * Replay protection for one acquisition: the source and content were already confirmed, so the
 * requested entries become confirmed without new copies and this operation is recorded against the
 * acquisition that already holds the outcome (docs/user-cards.md#persistence-and-recovery).
 */
async function replayAcquisition(
  statements: UserCardsSqlExecutor,
  accountId: string,
  plan: ConfirmationPlan,
  acquisition: RecordedAcquisition,
  pending: readonly ConfirmedImportEntry[],
): Promise<ConfirmationOutcome> {
  const entryIds = pending.map((entry) => entry.entryId);
  let privateRevision: string;
  if (entryIds.length === 0) {
    privateRevision = await currentRevision(statements, accountId);
  } else {
    const confirmation = confirmEntriesStatement(accountId, plan.sessionId, entryIds);
    const confirmed = await readRows(
      statements,
      confirmation.statement,
      confirmation.parameters,
      'The reviewed entries could not be confirmed.',
    );
    if (confirmed.length !== entryIds.length) {
      return { outcome: 'stale-entry' };
    }
    const bump = bumpSessionStatement(accountId, plan.sessionId);
    await readRows(
      statements,
      bump.statement,
      bump.parameters,
      'The import session could not be updated.',
    );
    privateRevision = await advanceRevision(statements, accountId);
  }

  const receiptInsert = insertReceiptStatement(accountId, plan, acquisition.acquisitionId);
  const recorded = (
    await readRows(
      statements,
      receiptInsert.statement,
      receiptInsert.parameters,
      'The confirmation receipt could not be stored.',
    )
  )[0];
  if (recorded === undefined) {
    // Another change recorded this operation first; only identical input may replay it.
    const request = readReceiptStatement(accountId, plan.operationId);
    const stored = (
      await readRows(
        statements,
        request.statement,
        request.parameters,
        'The recorded operation could not be read.',
      )
    )[0];
    if (stored === undefined || textValue(stored.input_fingerprint) !== plan.inputFingerprint) {
      return { outcome: 'operation-conflict' };
    }
  }
  return {
    outcome: 'confirmed',
    replayed: true,
    privateRevision,
    receipt: await readReceipt(
      statements,
      accountId,
      plan.operationId,
      plan.sessionId,
      acquisition.acquisitionId,
      acquisition.sourceKind,
      acquisition.sourceId,
    ),
  };
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
          // The session row serializes confirmations of one import: entry state, source identity and
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

          const recordedRequest = readReceiptStatement(accountId, plan.operationId);
          const recorded = (
            await readRows(
              statements,
              recordedRequest.statement,
              recordedRequest.parameters,
              'The recorded operation could not be read.',
            )
          )[0];
          if (recorded !== undefined) {
            if (textValue(recorded.input_fingerprint) !== plan.inputFingerprint) {
              return { outcome: 'operation-conflict' as const };
            }
            return {
              outcome: 'confirmed' as const,
              replayed: true,
              privateRevision: await currentRevision(statements, accountId),
              receipt: await readReceipt(
                statements,
                accountId,
                plan.operationId,
                textValue(recorded.session_id),
                textValue(recorded.acquisition_id),
                textValue(recorded.source_kind),
                textValue(recorded.source_id),
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

          const lookup = acquisitionLookupStatement(accountId, plan, sourceKind, sourceId);
          const acquisition = (
            await readRows(
              statements,
              lookup.statement,
              lookup.parameters,
              'The recorded acquisition could not be read.',
            )
          )[0];
          if (acquisition !== undefined) {
            return replayAcquisition(
              statements,
              accountId,
              plan,
              {
                acquisitionId: textValue(acquisition.acquisition_id),
                sourceKind: textValue(acquisition.source_kind),
                sourceId: textValue(acquisition.source_id),
              },
              classification.pending,
            );
          }

          if (classification.confirmed.length > 0) {
            // Content that is already owned is only acceptable under its recorded acquisition.
            return { outcome: 'stale-entry' as const };
          }

          const claim = claimAcquisitionStatement(accountId, plan, sourceKind, sourceId);
          const claimed = (
            await readRows(
              statements,
              claim.statement,
              claim.parameters,
              'The acquisition could not be recorded.',
            )
          )[0];
          if (claimed === undefined) {
            // Another change recorded the same acquisition first: replay its outcome.
            const concurrentLookup = acquisitionLookupStatement(
              accountId,
              plan,
              sourceKind,
              sourceId,
            );
            const concurrent = (
              await readRows(
                statements,
                concurrentLookup.statement,
                concurrentLookup.parameters,
                'The recorded acquisition could not be read.',
              )
            )[0];
            if (concurrent === undefined) {
              throw new UserCardsError(
                'unavailable',
                'UserCards did not report the recorded acquisition.',
              );
            }
            return replayAcquisition(
              statements,
              accountId,
              plan,
              {
                acquisitionId: textValue(concurrent.acquisition_id),
                sourceKind: textValue(concurrent.source_kind),
                sourceId: textValue(concurrent.source_id),
              },
              classification.pending,
            );
          }

          const acquisitionId = textValue(claimed.acquisition_id);
          const resolved: {
            readonly entry: ConfirmedImportEntry;
            readonly printingId: string;
            readonly finish: Finish;
          }[] = [];
          for (const entry of classification.pending) {
            const { printingId, finish } = entry.copy;
            if (printingId === null || finish === null) {
              return { outcome: 'unresolved-entry' as const };
            }
            resolved.push({ entry, printingId, finish });
          }
          const copies = resolved.flatMap(({ entry, printingId, finish }) =>
            Array.from({ length: entry.copy.quantity }, () => ({
              copyId: randomUUID(),
              entryId: entry.entryId,
              printingId,
              finish,
              condition: entry.copy.condition,
            })),
          );
          // One confirmation commits atomically, while each statement stays inside the deployed
          // write transport's bound however many copies the reviewed entries carry.
          const ownedTagId = await ensureOwnedTag(statements, accountId);
          const storedCopies: UserCardsSqlRow[] = [];
          for (const batch of batches(copies)) {
            storedCopies.push(
              ...(await storeCopiesWithOwnedTag(statements, accountId, ownedTagId, batch)),
            );
            const provenance = provenanceStatement(accountId, acquisitionId, batch);
            await readRows(
              statements,
              provenance.statement,
              provenance.parameters,
              'The copy provenance could not be stored.',
            );
          }
          const entryIds = resolved.map(({ entry }) => entry.entryId);
          if (entryIds.length > 0) {
            const confirmation = confirmEntriesStatement(accountId, plan.sessionId, entryIds);
            const confirmed = await readRows(
              statements,
              confirmation.statement,
              confirmation.parameters,
              'The reviewed entries could not be confirmed.',
            );
            if (confirmed.length !== entryIds.length) {
              return { outcome: 'stale-entry' as const };
            }
            const bump = bumpSessionStatement(accountId, plan.sessionId);
            await readRows(
              statements,
              bump.statement,
              bump.parameters,
              'The import session could not be updated.',
            );
          }
          const receiptInsert = insertReceiptStatement(accountId, plan, acquisitionId);
          const receipt = (
            await readRows(
              statements,
              receiptInsert.statement,
              receiptInsert.parameters,
              'The confirmation receipt could not be stored.',
            )
          )[0];
          if (receipt === undefined) {
            return { outcome: 'operation-conflict' as const };
          }
          return {
            outcome: 'confirmed' as const,
            replayed: false,
            privateRevision: await advanceRevision(statements, accountId),
            receipt: {
              operationId: plan.operationId,
              sessionId: plan.sessionId,
              sourceKind,
              sourceId,
              copies: copiesFromRows(storedCopies),
            },
          };
        },
        'The confirmation could not be committed.',
      );
    },

    async recover(accountId, operationId): Promise<ImportReceiptData | null> {
      const request = readReceiptStatement(accountId, operationId);
      const recorded = (
        await readRows(
          sql,
          request.statement,
          request.parameters,
          'The recorded operation could not be read.',
        )
      )[0];
      if (recorded === undefined) {
        return null;
      }
      return readReceipt(
        sql,
        accountId,
        operationId,
        textValue(recorded.session_id),
        textValue(recorded.acquisition_id),
        textValue(recorded.source_kind),
        textValue(recorded.source_id),
      );
    },
  };
}
