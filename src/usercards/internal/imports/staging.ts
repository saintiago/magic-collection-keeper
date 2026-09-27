/** staging persistence for private imports. See docs/user-cards.md#internal-design. */
import { createHash } from 'node:crypto';
import { UserCardsError } from '../errors.js';
import type {
  UserCardsSqlExecutor,
  UserCardsSqlRow,
  UserCardsSqlTransactor,
  UserCardsSqlValue,
} from '../executor.js';
import { stagedLineFingerprint } from '../fingerprint.js';
import { type ImportCandidate } from '../model.js';
import { importSourceLinePayload } from '../rows.js';
import { inTransaction, placeholdersFor, readRows } from '../sql.js';
import type {
  CaptureStageOutcome,
  ImportStageOutcome,
  ImportStore,
  NewImportEntry,
  NewStagedImportEntry,
  SourceLineRecord,
  SourceLineStageData,
  SourceLineStageEntry,
  SourceLineStageInput,
  SourceLineStagePlan,
} from '../store.js';
import {
  advanceRevision,
  batches,
  bumpSessionStatement,
  currentRevision,
  integerValue,
  lockSessionStatement,
  readEntriesByIds,
  readEntry,
  readSession,
  requireEntry,
  requireSession,
  textValue,
  type Statement,
} from './session-state.js';

/** One stored session as its mutations need it: the source identity, sequence state and revision. */
interface StoredSession {
  readonly sessionId: string;
  readonly sourceKind: string;
  readonly sourceId: string;
  readonly lastAcceptedIdentity: string | null;
  readonly revision: number;
}

function ensureSessionStatement(
  accountId: string,
  sessionId: string,
  sourceKind: string,
  sourceId: string,
  sourceReference: string | null,
): Statement {
  return {
    statement: `insert into usercards_private.import_session
       (session_id, account_id, source_kind, source_id, source_reference,
        last_accepted_identity, revision)
     values (:session_id, :account_id, :source_kind, :source_id, :source_reference, null, 1)
     on conflict (account_id, session_id) do nothing
     returning session_id`,
    parameters: {
      session_id: sessionId,
      account_id: accountId,
      source_kind: sourceKind,
      source_id: sourceId,
      source_reference: sourceReference,
    },
  };
}

/**
 * Creates the session when it is new and locks it, verifying that a capture observation belongs to
 * a capture session and a parsed source line to the import the caller identified, whose provenance
 * cannot change under an identity it already carries (docs/user-cards.md#import-state-and-identity).
 */
async function claimSession(
  statements: UserCardsSqlExecutor,
  accountId: string,
  sessionId: string,
  sourceKind: string,
  sourceId: string,
  sourceReference: string | null,
): Promise<StoredSession> {
  const ensure = ensureSessionStatement(
    accountId,
    sessionId,
    sourceKind,
    sourceId,
    sourceReference,
  );
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
  entries: readonly NewStagedImportEntry[],
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
      parameters[`source_line_${index}`] =
        entry.sourceLine === null ? null : importSourceLinePayload(entry.sourceLine);
      parameters[`source_line_key_${index}`] = entry.sourceLineKey;
      return (
        `(:entry_id_${index}, :account_id, :session_id, 'pending', :position_${index}, ` +
        `:printing_id_${index}, :finish_${index}, :condition_${index}, :quantity_${index}, ` +
        `:source_line_${index}::jsonb, :source_line_key_${index}, 1)`
      );
    })
    .join(',\n       ');
  return {
    statement: `insert into usercards_private.import_entry
       (entry_id, account_id, session_id, state, position, printing_id, finish, condition,
        quantity, source_line, source_line_key, revision)
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

/**
 * Stores freshly staged entries with their alternatives and their permanent admission receipts.
 * Every write stays inside the bounded batch the deployed transport accepts and inside the
 * caller's transaction, so one staging call remains atomic and entry positions stay contiguous.
 */
async function insertStagedEntries(
  statements: UserCardsSqlExecutor,
  accountId: string,
  sessionId: string,
  fresh: readonly NewStagedImportEntry[],
): Promise<void> {
  let position = await nextPosition(statements, accountId, sessionId);
  for (const batch of batches(fresh)) {
    const insert = insertEntriesStatement(accountId, sessionId, batch, position);
    await readRows(
      statements,
      insert.statement,
      insert.parameters,
      'The pending entries could not be stored.',
    );
    position += batch.length;
  }
  for (const batch of batches(candidateRows(fresh))) {
    const candidates = insertCandidatesStatement(accountId, batch);
    await readRows(
      statements,
      candidates.statement,
      candidates.parameters,
      'The recognition alternatives could not be stored.',
    );
  }
  for (const batch of batches(fresh)) {
    const staging = insertStagingReceiptsStatement(accountId, sessionId, batch);
    await readRows(
      statements,
      staging.statement,
      staging.parameters,
      'The staging receipts could not be stored.',
    );
  }
  const bump = bumpSessionStatement(accountId, sessionId);
  await readRows(
    statements,
    bump.statement,
    bump.parameters,
    'The import session could not be updated.',
  );
}

function readStagingReceiptStatement(accountId: string, captureId: string): Statement {
  return {
    statement: `select session_id, fingerprint, outcome, entry_id
     from usercards_private.import_stage
    where account_id = :account_id and capture_id = :capture_id`,
    parameters: { account_id: accountId, capture_id: captureId },
  };
}

/**
 * What one import recorded for a bounded set of parsed source lines. Only entries of the named
 * import and account are aggregated, so a line of another import or another account never affects
 * the reconciliation (docs/user-cards.md#source-imports).
 */
function sourceLinesStatement(
  accountId: string,
  sessionId: string,
  sourceLineKeys: readonly string[],
): Statement {
  const references = placeholdersFor(sourceLineKeys, 'source_line_key');
  return {
    statement: `select entry.source_line_key,
              coalesce(sum(entry.quantity) filter (where entry.state = 'pending'), 0)::int
                as pending_quantity,
              coalesce(sum(entry.quantity) filter (where entry.state = 'confirmed'), 0)::int
                as confirmed_quantity,
              count(*)::int as records,
              (array_agg(entry.session_id order by entry.entry_id)
                filter (where entry.state = 'pending'))[1] as pending_session_id,
              (array_agg(entry.entry_id order by entry.entry_id)
                filter (where entry.state = 'pending'))[1] as pending_entry_id,
              (array_agg(entry.session_id order by entry.entry_id)
                filter (where entry.state = 'confirmed'))[1] as confirmed_session_id,
              (array_agg(entry.entry_id order by entry.entry_id)
                filter (where entry.state = 'confirmed'))[1] as confirmed_entry_id
     from usercards_private.import_entry as entry
    where entry.account_id = :account_id
      and entry.session_id = :session_id
      and entry.source_line_key in (${references.list})
    group by entry.source_line_key`,
    parameters: {
      account_id: accountId,
      session_id: sessionId,
      ...references.parameters,
    },
  };
}

/** One recorded line's aggregate, with the identities its reconciliation may point the caller at. */
function sourceLineRecordFromRow(row: UserCardsSqlRow): SourceLineRecord {
  const optionalText = (value: UserCardsSqlValue | undefined): string | null =>
    typeof value === 'string' ? value : null;
  const pendingSessionId = optionalText(row.pending_session_id);
  const pendingEntryId = optionalText(row.pending_entry_id);
  const confirmedSessionId = optionalText(row.confirmed_session_id);
  const confirmedEntryId = optionalText(row.confirmed_entry_id);
  return {
    sourceLineKey: textValue(row.source_line_key),
    pendingQuantity: integerValue(row.pending_quantity),
    confirmedQuantity: integerValue(row.confirmed_quantity),
    records: integerValue(row.records),
    pendingEntry:
      pendingSessionId === null || pendingEntryId === null
        ? null
        : { sessionId: pendingSessionId, entryId: pendingEntryId },
    confirmedEntry:
      confirmedSessionId === null || confirmedEntryId === null
        ? null
        : { sessionId: confirmedSessionId, entryId: confirmedEntryId },
  };
}

/**
 * Durable identity of the next pending entry of one parsed source line. `attempt` counts the
 * entries the line already recorded, so a line whose entry was discarded stages a fresh entry
 * instead of replaying the discarded one, while a covered line stages nothing at all.
 */
function sourceEntryId(sessionId: string, sourceLineKey: string, attempt: number): string {
  return createHash('sha256')
    .update(`${sessionId}\u0000${sourceLineKey}\u0000${attempt}`, 'utf8')
    .digest('hex');
}

/** Reads one aggregate per parsed source line inside the caller's transaction. */
async function readSourceLineRecords(
  statements: UserCardsSqlExecutor,
  accountId: string,
  sessionId: string,
  sourceLineKeys: readonly string[],
): Promise<readonly SourceLineRecord[]> {
  const distinct = [...new Set(sourceLineKeys)];
  if (distinct.length === 0) {
    return [];
  }
  const records: SourceLineRecord[] = [];
  for (const batch of batches(distinct)) {
    const request = sourceLinesStatement(accountId, sessionId, batch);
    const rows = await readRows(
      statements,
      request.statement,
      request.parameters,
      'The recorded source lines could not be read.',
    );
    records.push(...rows.map(sourceLineRecordFromRow));
  }
  return records;
}

/** What one source line's reconciliation staged, and what each offered row is represented by. */
interface ReconciledSourceLines {
  readonly lines: readonly SourceLineStageEntry[];
  readonly fresh: readonly NewStagedImportEntry[];
}

/**
 * Reconciles the offered lines of one import with what that import already recorded. Equivalent
 * rows share one durable key and their declared quantities are covered together, in the order the
 * source published them, so reordering, removing or duplicating a row never moves an already staged
 * or acquired quantity onto another row and never stages a covered quantity again
 * (docs/user-cards.md#source-imports).
 */
async function reconcileSourceLines(
  statements: UserCardsSqlExecutor,
  accountId: string,
  plan: SourceLineStagePlan,
): Promise<ReconciledSourceLines> {
  const groups = new Map<
    string,
    { readonly line: SourceLineStageInput; readonly index: number }[]
  >();
  for (const [index, line] of plan.lines.entries()) {
    const group = groups.get(line.sourceLineKey);
    if (group === undefined) {
      groups.set(line.sourceLineKey, [{ line, index }]);
    } else {
      group.push({ line, index });
    }
  }

  const recorded = await readSourceLineRecords(statements, accountId, plan.sessionId, [
    ...groups.keys(),
  ]);
  const recordedByKey = new Map(recorded.map((record) => [record.sourceLineKey, record]));

  const lines: SourceLineStageEntry[] = new Array<SourceLineStageEntry>(plan.lines.length);
  const fresh: { readonly index: number; readonly entry: NewStagedImportEntry }[] = [];
  for (const [sourceLineKey, group] of groups) {
    const record = recordedByKey.get(sourceLineKey) ?? null;
    const pending = (record?.pendingQuantity ?? 0) > 0;
    const held = (record?.pendingQuantity ?? 0) + (record?.confirmedQuantity ?? 0);
    let coverage = held;
    let attempts = record?.records ?? 0;
    for (const { line, index } of group) {
      // The recorded quantity covers the group's rows in source order, so a row the source still
      // declares as covered is not staged again, and only the quantity the group exceeds stages.
      const covered = Math.min(line.declaredQuantity, coverage);
      coverage -= covered;
      const quantity = line.declaredQuantity - covered;
      if (quantity === 0) {
        const entry = pending ? (record?.pendingEntry ?? null) : (record?.confirmedEntry ?? null);
        if (entry === null) {
          throw new UserCardsError(
            'unavailable',
            'The import source recorded a covered line without an entry.',
          );
        }
        lines[index] = {
          outcome: pending ? 'pending' : 'acquired',
          entryId: entry.entryId,
          sessionId: entry.sessionId,
        };
        continue;
      }
      attempts += 1;
      const entry: NewStagedImportEntry = {
        entryId: sourceEntryId(plan.sessionId, sourceLineKey, attempts),
        printingId: line.printingId,
        finish: line.finish,
        condition: line.condition,
        quantity,
        candidates: line.candidates,
        sourceLine: line.sourceLine,
        sourceLineKey,
        fingerprint: stagedLineFingerprint({
          printingId: line.printingId,
          finish: line.finish,
          condition: line.condition,
          quantity,
          candidates: line.candidates,
        }),
      };
      fresh.push({ index, entry });
      lines[index] = { outcome: 'staged', entryId: entry.entryId, sessionId: plan.sessionId };
    }
  }
  // Group traversal determines quantity coverage; session positions follow the offered rows.
  fresh.sort((left, right) => left.index - right.index);
  return { lines, fresh: fresh.map(({ entry }) => entry) };
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

export function createImportStaging(
  sql: UserCardsSqlTransactor,
): Pick<ImportStore, 'stageSourceLines' | 'stageEntries' | 'stageCapture'> {
  return {
    async stageSourceLines(accountId, plan): Promise<SourceLineStageData> {
      return inTransaction(
        sql,
        async (statements) => {
          const session = await claimSession(
            statements,
            accountId,
            plan.sessionId,
            plan.sourceKind,
            plan.sourceId,
            plan.sourceReference,
          );
          if (session.sourceKind !== plan.sourceKind || session.sourceId !== plan.sourceId) {
            throw new UserCardsError(
              'invalid-request',
              'This session belongs to another import source; start a new import.',
            );
          }

          // Reconciliation reads what the source recorded only after this transaction holds the
          // session, so a review, discard or competing import that committed first is observed
          // instead of overwritten (docs/user-cards.md#persistence-and-recovery).
          const reconciled = await reconcileSourceLines(statements, accountId, plan);
          let privateRevision: string;
          if (reconciled.fresh.length === 0) {
            privateRevision = await currentRevision(statements, accountId);
          } else {
            await insertStagedEntries(statements, accountId, plan.sessionId, reconciled.fresh);
            privateRevision = await advanceRevision(statements, accountId);
          }

          return {
            privateRevision,
            session: await requireSession(statements, accountId, plan.sessionId),
            lines: reconciled.lines,
            staged: reconciled.fresh.length,
          };
        },
        'The staged entries could not be committed.',
      );
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
            plan.sourceReference,
          );
          if (session.sourceKind !== plan.sourceKind || session.sourceId !== plan.sourceId) {
            throw new UserCardsError(
              'invalid-request',
              'This session belongs to another import source; start a new import.',
            );
          }

          // An empty batch only prepares the session and names no identity to read a receipt for.
          let receipts: readonly UserCardsSqlRow[] = [];
          if (plan.entries.length > 0) {
            const receiptRequest = readStagingReceiptsStatement(
              accountId,
              plan.entries.map((entry) => entry.entryId),
            );
            receipts = await readRows(
              statements,
              receiptRequest.statement,
              receiptRequest.parameters,
              'The staged entries could not be read.',
            );
          }
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
            await insertStagedEntries(statements, accountId, plan.sessionId, fresh);
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
            null,
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
  };
}
