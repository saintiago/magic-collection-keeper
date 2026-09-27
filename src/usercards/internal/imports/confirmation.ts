/** confirmation persistence for private imports. See docs/user-cards.md#internal-design. */
import { randomUUID } from 'node:crypto';
import { ensureOwnedTag, storeCopiesWithOwnedTag } from '../copies.js';
import { UserCardsError } from '../errors.js';
import type {
  UserCardsSqlExecutor,
  UserCardsSqlRow,
  UserCardsSqlTransactor,
  UserCardsSqlValue,
} from '../executor.js';
import { USERCARDS_LIMITS, type PhysicalCopy } from '../model.js';
import { copiesFromRows, copyFromRow } from '../rows.js';
import { inTransaction, placeholdersFor, readRows } from '../sql.js';
import type {
  ConfirmationOutcome,
  ConfirmationPlan,
  ConfirmedImportEntry,
  ImportReceiptData,
  ImportStore,
} from '../store.js';
import {
  advanceRevision,
  batches,
  bumpSessionStatement,
  currentRevision,
  integerValue,
  lockSessionStatement,
  textValue,
  type Statement,
} from './session-state.js';

/** The durable content key of one entry: its reviewed content and its occurrence in its import. */
interface EntryKey {
  readonly entryFingerprint: string;
  readonly occurrence: number;
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

/** Counts only permanent bindings, never editable pending peers. */
function entryOccurrencesStatement(
  accountId: string,
  sessionId: string,
  fingerprints: readonly string[],
): Statement {
  const references = placeholdersFor(fingerprints, 'fingerprint');
  return {
    statement: `select acquisition.entry_fingerprint, count(*)::int as occurrence
      from usercards_private.import_entry_acquisition as binding
      join usercards_private.import_entry as entry
        on entry.account_id = binding.account_id and entry.entry_id = binding.entry_id
      join usercards_private.import_acquisition as acquisition
        on acquisition.acquisition_id = binding.acquisition_id
     where binding.account_id = :account_id and entry.session_id = :session_id
       and acquisition.entry_fingerprint in (${references.list})
     group by acquisition.entry_fingerprint`,
    parameters: { account_id: accountId, session_id: sessionId, ...references.parameters },
  };
}

/** Permanently binds an entry, including a replay, to the acquisition it confirmed. */
function bindEntryStatement(accountId: string, entryId: string, acquisitionId: string): Statement {
  return {
    statement: `insert into usercards_private.import_entry_acquisition
      (account_id, entry_id, acquisition_id) values (:account_id, :entry_id, :acquisition_id)`,
    parameters: { account_id: accountId, entry_id: entryId, acquisition_id: acquisitionId },
  };
}

/** The acquisitions already recorded for the requested reviewed entries of one import. */
function recordedAcquisitionsStatement(
  accountId: string,
  sessionId: string,
  keys: readonly EntryKey[],
): Statement {
  const parameters: Record<string, UserCardsSqlValue> = {
    account_id: accountId,
    session_id: sessionId,
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
      and acquisition.session_id = :session_id`,
    parameters,
  };
}

/** Records the acquisition of one source entry the import has not acquired yet. */
function claimAcquisitionStatement(
  accountId: string,
  sessionId: string,
  entry: ConfirmedImportEntry,
  occurrence: number,
): Statement {
  return {
    statement: `insert into usercards_private.import_acquisition
       (acquisition_id, account_id, session_id, entry_fingerprint, occurrence, entry_id)
     values (:acquisition_id, :account_id, :session_id, :entry_fingerprint, :occurrence, :entry_id)
     on conflict (account_id, session_id, entry_fingerprint, occurrence) do nothing
     returning acquisition_id`,
    parameters: {
      acquisition_id: randomUUID(),
      account_id: accountId,
      session_id: sessionId,
      entry_fingerprint: entry.entryFingerprint,
      occurrence,
      entry_id: entry.entryId,
    },
  };
}

/** The durable key of one reviewed entry inside its import. */
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

/** One reviewed entry with the durable key its import recognizes it by. */
interface KeyedImportEntry {
  readonly entry: ConfirmedImportEntry;
  /** Next occurrence allocated from this session's permanent confirmation bindings. */
  readonly occurrence: number;
  readonly key: string;
}

/**
 * Allocate distinct occurrences after the entries already confirmed with this content. The session
 * lock serializes allocation, and each resulting binding is permanent, including source replays.
 * Reviews of other entries therefore cannot steal or shift an already assigned acquisition.
 */
async function readEntryKeys(
  statements: UserCardsSqlExecutor,
  accountId: string,
  sessionId: string,
  pending: readonly ConfirmedImportEntry[],
): Promise<readonly KeyedImportEntry[]> {
  const request = entryOccurrencesStatement(accountId, sessionId, [
    ...new Set(pending.map((entry) => entry.entryFingerprint)),
  ]);
  const rows = await readRows(
    statements,
    request.statement,
    request.parameters,
    'The reviewed entries could not be read.',
  );
  const occurrences = new Map(
    rows.map((row) => [textValue(row.entry_fingerprint), integerValue(row.occurrence)] as const),
  );
  return pending.map((entry) => {
    const occurrence = (occurrences.get(entry.entryFingerprint) ?? 0) + 1;
    occurrences.set(entry.entryFingerprint, occurrence);
    return {
      entry,
      occurrence,
      key: entryKey(entry.entryFingerprint, occurrence),
    };
  });
}

/** The acquisitions already recorded for the given durable keys of one import. */
async function readRecordedAcquisitions(
  statements: UserCardsSqlExecutor,
  accountId: string,
  sessionId: string,
  keys: readonly KeyedImportEntry[],
): Promise<ReadonlyMap<string, string>> {
  if (keys.length === 0) {
    return new Map();
  }
  const request = recordedAcquisitionsStatement(
    accountId,
    sessionId,
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

export function createImportConfirmation(
  sql: UserCardsSqlTransactor,
): Pick<ImportStore, 'confirm' | 'recover'> {
  return {
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
          const classification =
            identical === undefined
              ? await classifyConfirmation(statements, accountId, plan)
              : null;
          if (classification?.missing) return { outcome: 'missing-entry' as const };
          if (classification?.stale) return { outcome: 'stale-entry' as const };
          if (classification?.unresolved) return { outcome: 'unresolved-entry' as const };

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

          if (identical !== undefined) {
            // Bind every successful operation ID, even when its reviewed request already ran.
            await readRows(
              statements,
              `insert into usercards_private.import_receipt_acquisition
                 (account_id, operation_id, acquisition_id)
               select account_id, :operation_id, acquisition_id
                 from usercards_private.import_receipt_acquisition
                where account_id = :account_id and operation_id = :original_operation_id`,
              {
                account_id: accountId,
                operation_id: plan.operationId,
                original_operation_id: textValue(identical.operation_id),
              },
              'The replay outcome could not be stored.',
            );
            return {
              outcome: 'confirmed' as const,
              replayed: true,
              privateRevision: await advanceRevision(statements, accountId),
              receipt: await requireReceipt(statements, accountId, plan.operationId),
            };
          }
          const keys = await readEntryKeys(
            statements,
            accountId,
            plan.sessionId,
            classification?.pending ?? [],
          );
          const recorded = await readRecordedAcquisitions(
            statements,
            accountId,
            plan.sessionId,
            keys,
          );
          const bindings = new Map<string, string>();
          const covered = new Set<string>();
          let ownedTagId: string | null = null;
          let acquired = false;
          for (const { entry, occurrence, key } of keys) {
            const alreadyAcquired = recorded.get(key);
            if (alreadyAcquired !== undefined) {
              covered.add(alreadyAcquired);
              bindings.set(entry.entryId, alreadyAcquired);
              continue;
            }
            const claim = claimAcquisitionStatement(accountId, plan.sessionId, entry, occurrence);
            const claimed = (
              await readRows(
                statements,
                claim.statement,
                claim.parameters,
                'The acquisition could not be recorded.',
              )
            )[0];
            if (claimed === undefined) {
              // The import is locked and its recorded acquisitions were just read, so a claim that
              // inserts nothing can only be a persistent record UserCards did not report.
              throw new UserCardsError('unavailable', 'UserCards did not record the acquisition.');
            }
            acquired = true;
            const acquisitionId = textValue(claimed.acquisition_id);
            covered.add(acquisitionId);
            bindings.set(entry.entryId, acquisitionId);
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

          for (const [entryId, acquisitionId] of bindings) {
            const binding = bindEntryStatement(accountId, entryId, acquisitionId);
            await readRows(
              statements,
              binding.statement,
              binding.parameters,
              'The confirmed entry binding could not be stored.',
            );
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
