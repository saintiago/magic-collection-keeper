/** confirmation persistence for private imports. See docs/user-cards.md#internal-design. */
import { randomUUID } from 'node:crypto';
import { ensureOwnedTag, storeCopiesWithOwnedTag, type OwnedTag } from '../copies.js';
import { UserCardsError } from '../errors.js';
import type {
  UserCardsSqlExecutor,
  UserCardsSqlRow,
  UserCardsSqlTransactor,
  UserCardsSqlValue,
} from '../executor.js';
import {
  USERCARDS_LIMITS,
  associationLevelsByTagKind,
  type Association,
  type AssociationTargetLevel,
  type ImportDestination,
  type PhysicalCopy,
} from '../model.js';
import { publishMutation } from '../publication.js';
import { storePrintingReferences } from '../references.js';
import {
  associationFromRow,
  associationPayload,
  associationPayloadSql,
  copiesFromRows,
  copyFromRow,
} from '../rows.js';
import { batches, inTransaction, placeholdersFor, readRows } from '../sql.js';
import type {
  ConfirmationOutcome,
  ConfirmationPlan,
  ConfirmedImportEntry,
  ImportReceiptData,
  ImportStore,
} from '../store.js';
import {
  advanceRevision,
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
              receipt.destination,
              receipt.destination_tag_id,
              receipt.publication_position::text as publication_position,
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
    statement: `select receipt.operation_id,
              receipt.publication_position::text as publication_position
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
       (operation_id, account_id, session_id, destination, destination_tag_id, input_fingerprint)
     values (:operation_id, :account_id, :session_id, :destination, :destination_tag_id,
             :input_fingerprint)
     on conflict (account_id, operation_id) do nothing
     returning operation_id`,
    parameters: {
      operation_id: plan.operationId,
      account_id: accountId,
      session_id: plan.sessionId,
      destination: plan.destination.kind,
      destination_tag_id: plan.destination.kind === 'tag' ? plan.destination.tagId : null,
      input_fingerprint: plan.inputFingerprint,
    },
  };
}

/** Binds a replayed operation to the acquisitions its identical original request recorded. */
function bindReceiptAcquisitionsStatement(
  accountId: string,
  operationId: string,
  originalOperationId: string,
): Statement {
  return {
    statement: `insert into usercards_private.import_receipt_acquisition
       (account_id, operation_id, acquisition_id)
     select account_id, :operation_id, acquisition_id
       from usercards_private.import_receipt_acquisition
      where account_id = :account_id and operation_id = :original_operation_id`,
    parameters: {
      account_id: accountId,
      operation_id: operationId,
      original_operation_id: originalOperationId,
    },
  };
}

/**
 * Records the associations a tag destination created or updated as the immutable outcome of one
 * operation. A later correction or removal of an association changes the association, never what
 * the recorded receipt reports (docs/user-cards.md#import-and-capture-state).
 */
function insertReceiptAssociationsStatement(
  accountId: string,
  operationId: string,
  associations: readonly Association[],
): Statement {
  const parameters: Record<string, UserCardsSqlValue> = {
    account_id: accountId,
    operation_id: operationId,
  };
  const values = associations
    .map((association, index) => {
      parameters[`association_id_${index}`] = association.associationId;
      parameters[`record_${index}`] = associationPayload(association);
      return `(:account_id, :operation_id, :association_id_${index}, :record_${index}::jsonb)`;
    })
    .join(',\n       ');
  return {
    statement: `insert into usercards_private.import_receipt_association
       (account_id, operation_id, association_id, record)
     values ${values}
     on conflict (account_id, operation_id, association_id) do nothing
     returning association_id`,
    parameters,
  };
}

/** Binds a replayed operation to the association outcomes its identical original request recorded. */
function bindReceiptAssociationsStatement(
  accountId: string,
  operationId: string,
  originalOperationId: string,
): Statement {
  return {
    statement: `insert into usercards_private.import_receipt_association
       (account_id, operation_id, association_id, record)
     select account_id, :operation_id, association_id, record
       from usercards_private.import_receipt_association
      where account_id = :account_id and operation_id = :original_operation_id`,
    parameters: {
      account_id: accountId,
      operation_id: operationId,
      original_operation_id: originalOperationId,
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

/** Records the position of the publication that made this outcome's copies visible. */
function recordedPositionStatement(
  accountId: string,
  operationId: string,
  position: string,
): Statement {
  return {
    statement: `update usercards_private.import_receipt
     set publication_position = cast(:position as bigint)
    where account_id = :account_id and operation_id = :operation_id`,
    parameters: { account_id: accountId, operation_id: operationId, position },
  };
}

/**
 * The position of an outcome that replayed already acquired source entries: the newest position
 * among the recorded operations whose acquisitions this outcome covers, so recovery returns the
 * position the copies were published at rather than the account's current one.
 */
function inheritedAcquisitionPositionStatement(accountId: string, operationId: string): Statement {
  return {
    statement: `update usercards_private.import_receipt as receipt
     set publication_position = recorded.position
    from (
      select max(source.publication_position) as position
        from usercards_private.import_receipt_acquisition as binding
        join usercards_private.import_receipt as source
          on source.account_id = binding.account_id
         and source.operation_id = binding.operation_id
       where binding.account_id = :account_id
         and binding.operation_id <> :operation_id
         and binding.acquisition_id in (
           select covered.acquisition_id
             from usercards_private.import_receipt_acquisition as covered
            where covered.account_id = :account_id
              and covered.operation_id = :operation_id)
    ) as recorded
    where receipt.account_id = :account_id and receipt.operation_id = :operation_id`,
    parameters: { account_id: accountId, operation_id: operationId },
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
 * The immutable association outcome of one recorded tag destination. Reading the recorded record
 * instead of the current association keeps a later correction or removal from changing what the
 * operation reported (docs/user-cards.md#import-and-capture-state).
 */
function receiptAssociationsStatement(accountId: string, operationId: string): Statement {
  return {
    statement: `select 'association' as row_kind,
  (row_number() over (order by recorded.association_id))::int as row_position,
  recorded.record::text as payload
from (select association_id, record
        from usercards_private.import_receipt_association
       where account_id = :account_id
         and operation_id = :operation_id
       order by association_id) as recorded
order by row_kind, row_position`,
    parameters: { account_id: accountId, operation_id: operationId },
  };
}

/** The explicit destination one recorded receipt carries, or unreadable state. */
function recordedDestination(recorded: UserCardsSqlRow): ImportDestination {
  const destination = recorded.destination;
  if (destination === 'ownership') {
    return { kind: 'ownership' };
  }
  const tagId = recorded.destination_tag_id;
  if (destination === 'tag' && typeof tagId === 'string' && tagId.length > 0) {
    return { kind: 'tag', tagId };
  }
  throw new UserCardsError(
    'unavailable',
    'UserCards did not report the recorded confirmation destination.',
  );
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
  const destination = recordedDestination(recorded);
  const copies =
    destination.kind === 'ownership'
      ? await readReceiptCopies(statements, accountId, operationId)
      : [];
  const associations =
    destination.kind === 'tag'
      ? await readReceiptAssociations(statements, accountId, operationId)
      : [];
  return {
    operationId,
    sessionId: textValue(recorded.session_id),
    sourceKind: textValue(recorded.source_kind),
    sourceId: textValue(recorded.source_id),
    destination,
    publicationPosition: receiptPosition(recorded.publication_position),
    copies,
    associations,
  };
}

/** One bounded page of the copies a recorded operation covered, read as its immutable provenance. */
async function readReceiptCopies(
  statements: UserCardsSqlExecutor,
  accountId: string,
  operationId: string,
): Promise<readonly PhysicalCopy[]> {
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
  return copiesFromRows(copies);
}

/** The recorded associations of one tag destination, as the confirmation recorded them. */
async function readReceiptAssociations(
  statements: UserCardsSqlExecutor,
  accountId: string,
  operationId: string,
): Promise<readonly Association[]> {
  const request = receiptAssociationsStatement(accountId, operationId);
  const rows = await readRows(
    statements,
    request.statement,
    request.parameters,
    'The recorded confirmation could not be read.',
  );
  return rows
    .map((row) => associationFromRow(row))
    .sort((left, right) => left.associationId.localeCompare(right.associationId));
}

/**
 * The recorded publication position of one outcome. Every recorded outcome covers an acquisition
 * a publication made visible, so a stored outcome without a position is unreadable state rather
 * than an outcome a consumer could resume from.
 */
function receiptPosition(value: UserCardsSqlValue | undefined): string {
  if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) {
    return value;
  }
  throw new UserCardsError(
    'unavailable',
    'UserCards did not report the recorded publication position.',
  );
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
    } else if (
      plan.destination.kind === 'ownership'
        ? requested.reviewed.printingId === null || requested.reviewed.finish === null
        : requested.reviewed.printingId === null && requested.reviewed.cardId === null
    ) {
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

/** Locks the destination tag and reads its kind, so its association writers serialize. */
function lockDestinationTagStatement(accountId: string, tagId: string): Statement {
  return {
    statement: `select tag_id, kind
     from usercards_private.tag
    where account_id = :account_id and tag_id = :tag_id
    for update`,
    parameters: { account_id: accountId, tag_id: tagId },
  };
}

/** Whether one tag kind associates the card and printing targets a confirmation reviews. */
function tagAcceptsReviewedTargets(kind: string): boolean {
  const levels = associationLevelsByTagKind[kind as keyof typeof associationLevelsByTagKind];
  return levels !== undefined && levels.includes('card') && levels.includes('printing');
}

/** The association one tag already holds for one reviewed target, or none. */
function storedAssociationStatement(
  accountId: string,
  tagId: string,
  targetLevel: AssociationTargetLevel,
  targetId: string,
): Statement {
  return {
    statement: `select association_id, tag_id, target_level, target_id, quantity, revision
     from usercards_private.association
    where account_id = :account_id
      and tag_id = :tag_id
      and target_level = :target_level
      and target_id = :target_id`,
    parameters: {
      account_id: accountId,
      tag_id: tagId,
      target_level: targetLevel,
      target_id: targetId,
    },
  };
}

/** Creates the association one confirmed entry reviews into its destination tag. */
function insertConfirmedAssociationStatement(
  accountId: string,
  tagId: string,
  tagKind: string,
  targetLevel: AssociationTargetLevel,
  targetId: string,
  quantity: number,
): Statement {
  return {
    statement: `insert into usercards_private.association
       (association_id, account_id, tag_id, tag_kind, target_level, target_id, quantity, revision)
     values (:association_id, :account_id, :tag_id, :tag_kind, :target_level, :target_id,
             :quantity, 1)
     returning ${associationPayloadSql} as payload`,
    parameters: {
      association_id: randomUUID(),
      account_id: accountId,
      tag_id: tagId,
      tag_kind: tagKind,
      target_level: targetLevel,
      target_id: targetId,
      quantity,
    },
  };
}

/** Grows the intended quantity of the association one confirmed entry reviews into its tag. */
function updateConfirmedAssociationStatement(
  accountId: string,
  tagId: string,
  targetLevel: AssociationTargetLevel,
  targetId: string,
  quantity: number,
): Statement {
  return {
    statement: `update usercards_private.association as target
     set quantity = :quantity,
         revision = target.revision + 1,
         updated_at = now()
    where target.account_id = :account_id
      and target.tag_id = :tag_id
      and target.target_level = :target_level
      and target.target_id = :target_id
    returning ${associationPayloadSql} as payload`,
    parameters: {
      account_id: accountId,
      tag_id: tagId,
      target_level: targetLevel,
      target_id: targetId,
      quantity,
    },
  };
}

/**
 * One association target a tag destination reviews, with the intended quantity every reviewed
 * entry adds to it. An entry quantity is an intended quantity, so the lines that review to one
 * target (for example a mainboard and a sideboard line of one printing) add up to one outcome.
 */
interface ReviewedAssociationTarget {
  readonly targetLevel: AssociationTargetLevel;
  readonly targetId: string;
  readonly quantity: number;
}

/** One reviewed target per identity, in the order the reviewed entries first name them. */
function reviewedAssociationTargets(
  pending: readonly ConfirmedImportEntry[],
): readonly ReviewedAssociationTarget[] {
  const targets = new Map<string, ReviewedAssociationTarget>();
  for (const entry of pending) {
    const targetLevel: AssociationTargetLevel =
      entry.reviewed.printingId === null ? 'card' : 'printing';
    const targetId = entry.reviewed.printingId ?? entry.reviewed.cardId;
    if (targetId === null) {
      throw new UserCardsError(
        'unavailable',
        'UserCards did not report the reviewed entry target.',
      );
    }
    const key = `${targetLevel}\u0000${targetId}`;
    const reviewed = targets.get(key);
    targets.set(key, {
      targetLevel,
      targetId,
      quantity: (reviewed?.quantity ?? 0) + entry.reviewed.quantity,
    });
  }
  return [...targets.values()];
}

/**
 * Applies one tag destination to the reviewed entries. Every identity creates or grows the
 * association its reviewed target names, once, by every quantity the entries add to it; a target
 * the tag already requires grows by what this import now accepts. The single final outcome per
 * identity is what the confirmation records and publishes, so a destination is never recorded
 * twice with an intermediate quantity. A tag destination never creates copies: physical ownership
 * changes only through the explicit ownership destination
 * (docs/user-cards.md#import-and-capture-state).
 */
async function applyTagDestination(
  statements: UserCardsSqlExecutor,
  accountId: string,
  tagId: string,
  tagKind: string,
  pending: readonly ConfirmedImportEntry[],
): Promise<readonly Association[]> {
  const recorded: Association[] = [];
  for (const { targetLevel, targetId, quantity: reviewed } of reviewedAssociationTargets(pending)) {
    const existingRequest = storedAssociationStatement(accountId, tagId, targetLevel, targetId);
    const existing = (
      await readRows(
        statements,
        existingRequest.statement,
        existingRequest.parameters,
        'The destination association could not be read.',
      )
    )[0];
    const quantity = (existing === undefined ? 0 : integerValue(existing.quantity)) + reviewed;
    if (quantity > USERCARDS_LIMITS.maxAssociationQuantity) {
      throw new UserCardsError(
        'invalid-request',
        'The destination would require more than ' +
          `${USERCARDS_LIMITS.maxAssociationQuantity} of one card; review the import quantity ` +
          'before confirming it.',
      );
    }
    const statement =
      existing === undefined
        ? insertConfirmedAssociationStatement(
            accountId,
            tagId,
            tagKind,
            targetLevel,
            targetId,
            quantity,
          )
        : updateConfirmedAssociationStatement(accountId, tagId, targetLevel, targetId, quantity);
    const rows = await readRows(
      statements,
      statement.statement,
      statement.parameters,
      'The destination association could not be stored.',
    );
    recorded.push(associationFromRow(rows[0]));
  }
  return recorded;
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

          // The explicit destination is validated before the operation identity is reserved, so a
          // refused destination leaves no receipt, association or copy behind.
          let destinationTagKind: string | null = null;
          if (plan.destination.kind === 'tag') {
            const tagRequest = lockDestinationTagStatement(accountId, plan.destination.tagId);
            const tag = (
              await readRows(
                statements,
                tagRequest.statement,
                tagRequest.parameters,
                'The destination tag could not be locked.',
              )
            )[0];
            if (tag === undefined) {
              return { outcome: 'missing-tag' as const };
            }
            destinationTagKind = textValue(tag.kind);
            if (!tagAcceptsReviewedTargets(destinationTagKind)) {
              return { outcome: 'unsupported-tag' as const };
            }
          }

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
            const originalOperationId = textValue(identical.operation_id);
            const binding =
              plan.destination.kind === 'ownership'
                ? bindReceiptAcquisitionsStatement(accountId, plan.operationId, originalOperationId)
                : bindReceiptAssociationsStatement(
                    accountId,
                    plan.operationId,
                    originalOperationId,
                  );
            await readRows(
              statements,
              binding.statement,
              binding.parameters,
              'The replay outcome could not be stored.',
            );
            // The replayed outcome is the outcome of the request it repeats, so it reports that
            // record's own publication position; a later operation that touched the same
            // association or acquisition does not change what this request recorded.
            const recorded = recordedPositionStatement(
              accountId,
              plan.operationId,
              receiptPosition(identical.publication_position),
            );
            await readRows(
              statements,
              recorded.statement,
              recorded.parameters,
              'The recorded publication position could not be stored.',
            );
            return {
              outcome: 'confirmed' as const,
              replayed: true,
              privateRevision: await advanceRevision(statements, accountId),
              receipt: await requireReceipt(statements, accountId, plan.operationId),
            };
          }
          if (plan.destination.kind === 'tag') {
            if (destinationTagKind === null) {
              throw new UserCardsError(
                'unavailable',
                'UserCards did not report the destination tag.',
              );
            }
            return confirmTagDestination(
              statements,
              accountId,
              plan,
              plan.destination.tagId,
              destinationTagKind,
              classification?.pending ?? [],
            );
          }
          return confirmOwnershipDestination(
            statements,
            accountId,
            plan,
            classification?.pending ?? [],
          );
        },
        'The confirmation could not be committed.',
      );
    },
    async recover(accountId, operationId): Promise<ImportReceiptData | null> {
      return readReceipt(sql, accountId, operationId);
    },
  };
}

/**
 * Applies one tag destination inside the caller's transaction: the reviewed associations are
 * created or grown, the entries close and the recorded outcome publishes, all atomically. No
 * acquisition, copy or owned membership is created.
 */
async function confirmTagDestination(
  statements: UserCardsSqlExecutor,
  accountId: string,
  plan: ConfirmationPlan,
  tagId: string,
  tagKind: string,
  pending: readonly ConfirmedImportEntry[],
): Promise<ConfirmationOutcome> {
  await storeReviewedPrintingReferences(statements, pending);
  const recorded = await applyTagDestination(statements, accountId, tagId, tagKind, pending);
  await closeConfirmedEntries(
    statements,
    accountId,
    plan.sessionId,
    pending.map((entry) => entry.entryId),
  );
  for (const batch of batches(recorded)) {
    const outcome = insertReceiptAssociationsStatement(accountId, plan.operationId, batch);
    await readRows(
      statements,
      outcome.statement,
      outcome.parameters,
      'The recorded outcome could not be stored.',
    );
  }
  // The associations this confirmation created or grew and the revision that completes them
  // commit together, and the recorded outcome reports the position they were published at.
  const publication = await publishMutation(statements, accountId, {
    associations: recorded.map((association) => association.associationId),
  });
  const position = recordedPositionStatement(accountId, plan.operationId, publication.position);
  await readRows(
    statements,
    position.statement,
    position.parameters,
    'The recorded publication position could not be stored.',
  );
  return {
    outcome: 'confirmed' as const,
    replayed: false,
    privateRevision: publication.revision,
    receipt: await requireReceipt(statements, accountId, plan.operationId),
  };
}

/**
 * Closes the reviewed entries of one confirmation and advances the session revision that its
 * pending set carries.
 */
async function closeConfirmedEntries(
  statements: UserCardsSqlExecutor,
  accountId: string,
  sessionId: string,
  entryIds: readonly string[],
): Promise<void> {
  const confirmation = confirmEntriesStatement(accountId, sessionId, entryIds);
  const confirmed = await readRows(
    statements,
    confirmation.statement,
    confirmation.parameters,
    'The reviewed entries could not be confirmed.',
  );
  if (confirmed.length !== entryIds.length) {
    throw new UserCardsError('unavailable', 'UserCards did not confirm the reviewed entries.');
  }
  const bump = bumpSessionStatement(accountId, sessionId);
  await readRows(
    statements,
    bump.statement,
    bump.parameters,
    'The import session could not be updated.',
  );
}

/**
 * Applies the explicit ownership destination inside the caller's transaction: individual copies,
 * their acquisition provenance and their owned memberships. A source entry this import already
 * acquired is bound to its recorded acquisition instead of being acquired again.
 */
async function confirmOwnershipDestination(
  statements: UserCardsSqlExecutor,
  accountId: string,
  plan: ConfirmationPlan,
  pending: readonly ConfirmedImportEntry[],
): Promise<ConfirmationOutcome> {
  await storeReviewedPrintingReferences(statements, pending);
  const keys = await readEntryKeys(statements, accountId, plan.sessionId, pending);
  const recorded = await readRecordedAcquisitions(statements, accountId, plan.sessionId, keys);
  const bindings = new Map<string, string>();
  const covered = new Set<string>();
  const created: {
    copies: string[];
    associations: string[];
    tags: string[];
  } = { copies: [], associations: [], tags: [] };
  let ownedTag: OwnedTag | null = null;
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
    if (ownedTag === null) {
      ownedTag = await ensureOwnedTag(statements, accountId);
      if (ownedTag.created) {
        created.tags.push(ownedTag.tagId);
      }
    }
    const { printingId, finish, condition, quantity } = entry.reviewed;
    if (printingId === null || finish === null) {
      throw new UserCardsError(
        'unavailable',
        'UserCards did not report the reviewed entry content.',
      );
    }
    const copies = Array.from({ length: quantity }, () => ({
      copyId: randomUUID(),
      entryId: entry.entryId,
      printingId,
      finish,
      condition,
    }));
    // One confirmation commits atomically, while each statement stays inside the deployed
    // write transport's bound however many copies the reviewed entries carry.
    for (const batch of batches(copies)) {
      const stored = await storeCopiesWithOwnedTag(statements, accountId, ownedTag.tagId, batch);
      created.copies.push(...stored.rows.map((row) => textValue(row.copy_id)));
      created.associations.push(...stored.ownedMemberships);
      const provenance = provenanceStatement(
        accountId,
        acquisitionId,
        stored.rows.map((row) => ({ ...copyFromRow(row), entryId: entry.entryId })),
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
  await closeConfirmedEntries(statements, accountId, plan.sessionId, entryIds);
  for (const batch of batches([...covered])) {
    const outcome = insertReceiptAcquisitionsStatement(accountId, plan.operationId, batch);
    await readRows(
      statements,
      outcome.statement,
      outcome.parameters,
      'The recorded outcome could not be stored.',
    );
  }
  // The copies this confirmation created and the revision that completes them commit
  // together; a confirmation that only replayed already acquired source entries publishes
  // no record and reports the position its acquisitions were recorded at.
  let privateRevision: string;
  if (acquired) {
    const publication = await publishMutation(statements, accountId, created);
    privateRevision = publication.revision;
    const recorded = recordedPositionStatement(accountId, plan.operationId, publication.position);
    await readRows(
      statements,
      recorded.statement,
      recorded.parameters,
      'The recorded publication position could not be stored.',
    );
  } else {
    privateRevision = await advanceRevision(statements, accountId);
    const inherited = inheritedAcquisitionPositionStatement(accountId, plan.operationId);
    await readRows(
      statements,
      inherited.statement,
      inherited.parameters,
      'The recorded publication position could not be inherited.',
    );
  }
  return {
    outcome: 'confirmed' as const,
    // A confirmation whose source entries are all already acquired returned their recorded
    // outcome instead of committing a new acquisition.
    replayed: !acquired,
    privateRevision,
    receipt: await requireReceipt(statements, accountId, plan.operationId),
  };
}

async function storeReviewedPrintingReferences(
  statements: UserCardsSqlExecutor,
  pending: readonly ConfirmedImportEntry[],
): Promise<void> {
  const references = pending.flatMap((entry) => {
    const { printingId, cardId } = entry.reviewed;
    if (printingId === null) return [];
    if (cardId === null) {
      throw new UserCardsError(
        'unavailable',
        'UserCards did not report the reviewed printing’s playable card.',
      );
    }
    return [{ printingId, cardId }];
  });
  await storePrintingReferences(statements, references);
}
