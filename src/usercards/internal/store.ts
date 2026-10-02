import type { Finish, PrintingId } from '../../catalog/index.js';
import type { MigrationReadback } from './migration-contract.js';
import type { MigrationBatch } from './migration-plan.js';
import type {
  Association,
  AssociationTargetLevel,
  CopyCondition,
  ImportCandidate,
  ImportDestination,
  ImportEntry,
  ImportSession,
  ImportSourceLine,
  PhysicalCopy,
  Tag,
  TagKind,
  UserTagKind,
} from './model.js';

/** One physical copy about to be stored; its stable identity is already assigned. */
export interface NewCopy {
  readonly copyId: string;
  readonly printingId: PrintingId;
  /** Stable playable identity resolved with this printing; absent only for compatible legacy loads. */
  readonly cardId?: string;
  readonly finish: Finish;
  readonly condition: CopyCondition | null;
}

/** The corrected state of one existing copy, guarded by the revision it was read at. */
export interface CopyCorrection {
  readonly copyId: string;
  readonly expectedRevision: number;
  readonly printingId: PrintingId;
  readonly cardId: string;
  readonly finish: Finish;
  readonly condition: CopyCondition | null;
}

/** Copies of one account together with the private-data revision that was observed with them. */
export interface CopiesData {
  readonly privateRevision: string;
  readonly copies: readonly PhysicalCopy[];
}

/**
 * Copies one write committed and its authoritative private revision.
 */
export interface CopyChangeData {
  readonly privateRevision: string;
  readonly copies: readonly PhysicalCopy[];
}

export type CopyCorrectionOutcome =
  | {
      readonly outcome: 'updated';
      readonly privateRevision: string;
      readonly copy: PhysicalCopy;
    }
  | { readonly outcome: 'missing' }
  | { readonly outcome: 'conflict' };

/**
 * Private copy storage of one account. Every operation is scoped by the account the caller passes,
 * and the storage never returns another account's record; a replacement implementation keeps the
 * same promises (docs/user-cards.md#interface).
 */
export interface CopyStore {
  /** Reads the copies among `copyIds` that belong to `accountId`, with the observed revision. */
  readCopies(accountId: string, copyIds: readonly string[]): Promise<CopiesData>;
  /**
   * Stores `copies` for `accountId`, associates each stored copy with the account's owned tag and
   * publishes the stored records with that account's advanced private revision, all in one
   * transaction.
   */
  insertCopies(accountId: string, copies: readonly NewCopy[]): Promise<CopyChangeData>;
  /** Applies `correction` when the stored copy still carries `expectedRevision`. */
  correctCopy(accountId: string, correction: CopyCorrection): Promise<CopyCorrectionOutcome>;
}

/** One tag about to be stored; its stable identity is already assigned. */
export interface NewTag {
  readonly tagId: string;
  readonly kind: UserTagKind;
  readonly label: string;
}

/** The renamed state of one existing tag, guarded by the revision it was read at. */
export interface TagCorrection {
  readonly tagId: string;
  readonly expectedRevision: number;
  readonly label: string;
}

/** Tags of one account together with the private-data revision that was observed with them. */
export interface TagsData {
  readonly privateRevision: string;
  readonly tags: readonly Tag[];
}

/** One committed tag together with the private-data revision the change published. */
export interface TagChangeData {
  readonly privateRevision: string;
  /** Position of the revision that completes this change. */
  readonly tag: Tag;
}

export type TagCorrectionOutcome =
  | {
      readonly outcome: 'updated';
      readonly privateRevision: string;
      readonly tag: Tag;
    }
  | { readonly outcome: 'missing' }
  | { readonly outcome: 'conflict' }
  /** The tag is system-managed; its lifecycle is not driven by the tag operations. */
  | { readonly outcome: 'system' };

/** One association about to be stored; its stable identity is already assigned. */
export interface NewAssociation {
  readonly associationId: string;
  readonly tagId: string;
  readonly tagKind: TagKind;
  readonly targetLevel: AssociationTargetLevel;
  readonly targetId: string;
  /** Stable playable identity for a printing target. */
  readonly cardId: string | null;
  readonly quantity: number | null;
}

/** The changed state of one association, guarded by the revision it was read at. */
export interface AssociationCorrection {
  readonly associationId: string;
  readonly expectedRevision: number;
  readonly targetLevel: AssociationTargetLevel;
  readonly targetId: string;
  /** Stable playable identity for a printing target. */
  readonly cardId: string | null;
  readonly quantity: number | null;
}

/** Associations of one account together with the private-data revision that was observed with them. */
export interface AssociationsData {
  readonly privateRevision: string;
  readonly associations: readonly Association[];
}

export type AssociationInsertOutcome =
  | {
      readonly outcome: 'inserted';
      readonly privateRevision: string;
      readonly association: Association;
    }
  /** The tag already associates this exact target; the existing association must be changed. */
  | { readonly outcome: 'conflict' };

export type AssociationCorrectionOutcome =
  | {
      readonly outcome: 'updated';
      readonly privateRevision: string;
      readonly association: Association;
    }
  | { readonly outcome: 'missing' }
  | { readonly outcome: 'conflict' }
  /** Another association of the same tag already covers the requested target. */
  | { readonly outcome: 'duplicate' };

export type AssociationRemovalOutcome =
  | {
      readonly outcome: 'removed';
      readonly privateRevision: string;
      readonly associationId: string;
    }
  | { readonly outcome: 'missing' }
  | { readonly outcome: 'conflict' };

export interface CopyLocationChange {
  readonly copyId: string;
  /** Revision of the copy whose location changes; a move quotes the revision it started from. */
  readonly expectedRevision: number;
  /**
   * Location tag to move the copy into, or `null` to remove its location. The service validates
   * that the tag belongs to the account and is a location tag before the move is applied.
   */
  readonly locationTagId: string | null;
}

export type CopyLocationOutcome =
  | {
      readonly outcome: 'moved';
      readonly privateRevision: string;
      readonly copy: PhysicalCopy;
      /** The copy's location membership after the move, or `null` when it has none. */
      readonly location: Association | null;
    }
  | { readonly outcome: 'missing-copy' }
  | { readonly outcome: 'conflict' };

/**
 * Private tag and association storage of one account. Every operation is scoped by the account the
 * caller passes and never returns another account's record; a replacement implementation keeps the
 * same promises, including one physical location per copy (docs/user-cards.md#records-and-associations).
 */
export interface OrganizationStore {
  /** Reads the tags among `tagIds` that belong to `accountId`, with the observed revision. */
  readTags(accountId: string, tagIds: readonly string[]): Promise<TagsData>;
  /** Reads up to `limit` tags of `accountId` ordered by tag identity, starting at `offset`. */
  listTags(accountId: string, offset: number, limit: number): Promise<TagsData>;
  /** Stores `tag` for `accountId` and advances that account's private revision atomically. */
  createTag(accountId: string, tag: NewTag): Promise<TagChangeData>;
  /** Applies `correction` when the stored tag still carries `expectedRevision` and is not system-managed. */
  correctTag(accountId: string, correction: TagCorrection): Promise<TagCorrectionOutcome>;
  /** Reads the associations among `associationIds` that belong to `accountId`. */
  readAssociations(accountId: string, associationIds: readonly string[]): Promise<AssociationsData>;
  /**
   * Reads up to `limit` associations of `accountId` for `tagId`, ordered by association identity
   * and starting at `offset`. A tag the account does not own contributes no row.
   */
  listAssociations(
    accountId: string,
    tagId: string,
    offset: number,
    limit: number,
  ): Promise<AssociationsData>;
  /** Stores `association` for `accountId` unless the tag already associates that target. */
  insertAssociation(
    accountId: string,
    association: NewAssociation,
  ): Promise<AssociationInsertOutcome>;
  /** Applies `correction` when the stored association still carries `expectedRevision`. */
  correctAssociation(
    accountId: string,
    correction: AssociationCorrection,
  ): Promise<AssociationCorrectionOutcome>;
  /** Removes the association when it still carries `expectedRevision`. */
  removeAssociation(
    accountId: string,
    associationId: string,
    expectedRevision: number,
  ): Promise<AssociationRemovalOutcome>;
  /** Moves or clears the single location membership of one copy. */
  moveCopyLocation(accountId: string, change: CopyLocationChange): Promise<CopyLocationOutcome>;
}

/** One pending entry about to be staged; its stable capture or source-line identity is assigned. */
export interface NewImportEntry {
  readonly entryId: string;
  /** Reviewed card identity when the observation resolved one; null while unresolved. */
  readonly cardId: string | null;
  readonly printingId: string | null;
  readonly finish: Finish | null;
  readonly condition: CopyCondition | null;
  readonly quantity: number;
  readonly candidates: readonly ImportCandidate[];
}

/** One parsed source line about to be staged, with the digest of the input it was parsed from. */
export interface NewStagedImportEntry extends NewImportEntry {
  /**
   * Digest of the staged input. Restaging the identical line returns the recorded state, while a
   * changed line under the same identity is refused instead of silently overwriting review work
   * (docs/user-cards.md#import-and-capture-state).
   */
  readonly fingerprint: string;
  /**
   * Parsed source line this entry carries, or null for a capture observation that names no source
   * line. A source line is stored with the entry, so an unresolved name or printing stays
   * reviewable (docs/user-cards.md#source-imports).
   */
  readonly sourceLine: ImportSourceLine | null;
  /**
   * Durable identity of the parsed source line within its import, or null when the entry was not
   * parsed from a source line. A repeated import of that list matches on it.
   */
  readonly sourceLineKey: string | null;
}

export interface ImportStagePlan {
  readonly sessionId: string;
  readonly sourceKind: string;
  readonly sourceId: string;
  /** Official reference of the acquisition source, or null when it published none. */
  readonly sourceReference: string | null;
  readonly entries: readonly NewStagedImportEntry[];
}

export interface ImportStageData {
  readonly privateRevision: string;
  readonly session: ImportSession;
  /** The staged entries as they are stored now, in request order. */
  readonly entries: readonly ImportEntry[];
  /** Entries this call staged; the remainder were already staged with identical input. */
  readonly staged: number;
  readonly replayed: boolean;
}

export type ImportStageOutcome =
  ({ readonly outcome: 'staged' } & ImportStageData) | { readonly outcome: 'line-conflict' };

export interface CaptureStagePlan {
  readonly sessionId: string;
  readonly captureId: string;
  /** Digest of the staged observation, so a retry replays its recorded admission decision. */
  readonly fingerprint: string;
  /** Accepted card identity of the observation, or `null` while the reading is unresolved. */
  readonly identity: string | null;
  /** Entry data the observation carries when it resolves; `null` for an unresolved reading. */
  readonly entry: NewImportEntry | null;
}

/**
 * The recorded decision of one staged capture observation: it was admitted as a new pending entry,
 * suppressed as a repeat of the session's last accepted identity, or left unresolved. A replay
 * returns the recorded decision instead of deciding again.
 */
export type CaptureStageData =
  | {
      readonly outcome: 'admitted';
      readonly replayed: boolean;
      readonly privateRevision: string;
      readonly session: ImportSession;
      readonly entry: ImportEntry;
    }
  | {
      readonly outcome: 'suppressed';
      readonly replayed: boolean;
      readonly privateRevision: string;
      readonly session: ImportSession;
      readonly entry: null;
    }
  | {
      readonly outcome: 'unresolved';
      readonly replayed: boolean;
      readonly privateRevision: string;
      readonly session: ImportSession;
      readonly entry: null;
    };

export type CaptureStageOutcome = CaptureStageData | { readonly outcome: 'conflict' };

/** The reviewed state of one pending entry, guarded by the revision it was read at. */
export interface ImportEntryCorrection {
  readonly entryId: string;
  readonly expectedRevision: number;
  /** Reviewed card identity, or null while the entry stays unresolved. */
  readonly cardId: string | null;
  /** Reviewed printing reference, or null for a card-level review. */
  readonly printingId: string | null;
  /** Optional reviewed finish; physical eligibility is required only for ownership confirmation. */
  readonly finish: Finish | null;
  readonly condition: CopyCondition | null;
  readonly quantity: number;
}

export type ImportEntryCorrectionOutcome =
  | {
      readonly outcome: 'updated';
      readonly privateRevision: string;
      readonly session: ImportSession;
      readonly entry: ImportEntry;
    }
  | { readonly outcome: 'missing' }
  | { readonly outcome: 'conflict' };

/** Later recognition alternatives for one pending entry; they never replace reviewed values. */
export interface CandidateAttachment {
  readonly entryId: string;
  readonly candidates: readonly ImportCandidate[];
}

export type CandidateAttachmentOutcome =
  | {
      readonly outcome: 'recorded';
      readonly privateRevision: string;
      readonly session: ImportSession;
      readonly entry: ImportEntry;
    }
  | { readonly outcome: 'missing' };

export type ImportEntryDiscardOutcome =
  | {
      readonly outcome: 'discarded';
      readonly privateRevision: string;
      readonly session: ImportSession;
      readonly entry: ImportEntry;
    }
  | { readonly outcome: 'missing' }
  | { readonly outcome: 'conflict' };

export type ImportSessionDiscardOutcome =
  | {
      readonly outcome: 'discarded';
      readonly privateRevision: string;
      readonly session: ImportSession;
    }
  | { readonly outcome: 'missing' }
  | { readonly outcome: 'conflict' };

/** The reviewed target one pending entry carried when the caller read it. */
export interface ReviewedEntryTarget {
  readonly cardId: string | null;
  readonly printingId: string | null;
  readonly finish: Finish | null;
  readonly condition: CopyCondition | null;
  readonly quantity: number;
}

/**
 * One reviewed entry a confirmation covers, with the state and copy data the caller read. The
 * entry fingerprint digests that reviewed content, so a repeat of the same import recognizes the
 * entry it already acquired without depending on how confirmations were partitioned
 * (docs/user-cards.md#source-imports).
 */
export interface ConfirmedImportEntry {
  readonly entryId: string;
  readonly expectedRevision: number;
  readonly state: ImportEntry['state'];
  /** Digest of the reviewed copy attributes and quantity of this entry. */
  readonly entryFingerprint: string;
  readonly reviewed: ReviewedEntryTarget;
}

export interface ConfirmationPlan {
  /** Operation identity scoped to the account, so a retry refers to the same action. */
  readonly operationId: string;
  readonly sessionId: string;
  /**
   * Explicit destination of this confirmation: the tag whose reviewed associations it creates or
   * updates, or the ownership action that creates individual copies
   * (docs/user-cards.md#import-and-capture-state).
   */
  readonly destination: ImportDestination;
  /**
   * Digest of the confirmation request. Reuse with a different request is refused, while the same
   * request under another operation identity returns the recorded outcome.
   */
  readonly inputFingerprint: string;
  readonly entries: readonly ConfirmedImportEntry[];
}

export interface ImportReceiptData {
  readonly operationId: string;
  readonly sessionId: string;
  readonly sourceKind: string;
  readonly sourceId: string;
  /** Destination the recorded confirmation applied. */
  readonly destination: ImportDestination;
  /**
   * Position of the publication that made the recorded outcome visible, or of the recorded
   * operations whose acquisitions this outcome replayed (docs/user-cards.md#query-surface).
   */
  readonly publicationPosition: string;
  /** Copies an ownership action created, ordered by copy identity; empty for a tag destination. */
  readonly copies: readonly PhysicalCopy[];
  /**
   * Associations a tag destination created or updated, ordered by association identity; empty for
   * an ownership action.
   */
  readonly associations: readonly Association[];
}

export type ConfirmationOutcome =
  | {
      readonly outcome: 'confirmed';
      readonly replayed: boolean;
      readonly privateRevision: string;
      readonly receipt: ImportReceiptData;
    }
  | { readonly outcome: 'missing-session' }
  | { readonly outcome: 'missing-entry' }
  /** A reviewed entry changed after it was read, or is no longer pending. */
  | { readonly outcome: 'stale-entry' }
  /** A reviewed entry has no resolved printing and finish, so it cannot become copies. */
  | { readonly outcome: 'unresolved-entry' }
  /** The destination tag is not this account's. */
  | { readonly outcome: 'missing-tag' }
  /** The destination tag is system-managed or does not associate cards or printings. */
  | { readonly outcome: 'unsupported-tag' }
  /** The operation identity was already used for a different request. */
  | { readonly outcome: 'operation-conflict' };

export interface ImportSessionsData {
  readonly privateRevision: string;
  readonly sessions: readonly ImportSession[];
}

export interface ImportEntriesData {
  readonly privateRevision: string;
  readonly session: ImportSession;
  readonly entries: readonly ImportEntry[];
}

/** One recorded entry of a parsed source line, used to address the line's next pending entry. */
export interface SourceLineEntry {
  readonly sessionId: string;
  readonly entryId: string;
}

/**
 * What one import already recorded for one parsed source line: the pending quantity awaiting
 * review, the quantity its confirmations acquired, and one entry of each state so a repeated import
 * of that list can point the caller at the record instead of staging the line again
 * (docs/user-cards.md#source-imports).
 */
export interface SourceLineRecord {
  readonly sourceLineKey: string;
  /** Reviewed quantity of the line's pending entries; 0 while none is pending. */
  readonly pendingQuantity: number;
  /** Quantity already acquired from this line; 0 while nothing was confirmed. */
  readonly confirmedQuantity: number;
  /** Entries recorded for this line in any state, which addresses the line's next entry. */
  readonly records: number;
  readonly pendingEntry: SourceLineEntry | null;
  readonly confirmedEntry: SourceLineEntry | null;
}

/**
 * One parsed source line offered for staging. Equivalent lines of one import share `sourceLineKey`,
 * so duplicates are reconciled together and their order does not decide which quantity is already
 * covered (docs/user-cards.md#source-imports).
 */
export interface SourceLineStageInput {
  /** Durable identity of the parsed line inside its import, without its quantity. */
  readonly sourceLineKey: string;
  readonly printingId: string | null;
  readonly finish: Finish | null;
  readonly condition: CopyCondition | null;
  /** Quantity the source published for this row; a covered part of it stages nothing. */
  readonly declaredQuantity: number;
  readonly sourceLine: ImportSourceLine;
  readonly candidates: readonly ImportCandidate[];
}

/** The parsed lines of one import, staged together under its session. */
export interface SourceLineStagePlan {
  /** Identity of the import the caller stages into; a new import carries a new identity. */
  readonly sessionId: string;
  readonly sourceKind: string;
  /** Published source identity of the import, or its own identity when it published none. */
  readonly sourceId: string;
  readonly sourceReference: string | null;
  /** Offered lines in source order; equivalent lines of one import may repeat. */
  readonly lines: readonly SourceLineStageInput[];
}

/** What one offered line became when its staging committed. */
export interface SourceLineStageEntry {
  readonly outcome: 'staged' | 'pending' | 'acquired';
  /** Entry this line is represented by: the entry this call staged, or the record covering it. */
  readonly entryId: string;
  readonly sessionId: string;
}

/** The committed outcome of staging the parsed lines of one import. */
export interface SourceLineStageData {
  readonly privateRevision: string;
  readonly session: ImportSession;
  /** One outcome per offered line, in the order the lines were offered. */
  readonly lines: readonly SourceLineStageEntry[];
  /** Lines this call staged; the remainder were already covered by the import's records. */
  readonly staged: number;
}

/**
 * Private import and capture storage of one account (docs/user-cards.md#import-and-capture-state).
 * Pending entries are stored separately from the account's owned copies and never change ownership;
 * every operation is scoped by the account the caller passes and never returns another account's
 * record. A replacement implementation keeps the same promises, including the consecutive-identity
 * admission rule, the durable source-line records that let a repeated import reconcile with what
 * that import already staged and acquired, and the permanent operation and acquisition records that
 * make confirmation replay-safe.
 */
export interface ImportStore {
  /** Reads the account's pending import sessions, ordered by session identity. */
  listSessions(accountId: string, offset: number, limit: number): Promise<ImportSessionsData>;
  /**
   * Reads one session with a bounded page of its pending entries, or `null` when it is not this
   * account's.
   */
  listEntries(
    accountId: string,
    sessionId: string,
    offset: number,
    limit: number,
  ): Promise<ImportEntriesData | null>;
  /** Reads the entries among `entryIds` that belong to this account, in capture order. */
  readEntries(accountId: string, entryIds: readonly string[]): Promise<readonly ImportEntry[]>;
  /**
   * Stages the parsed lines of one import, reconciling every line with the quantity that import
   * already staged and acquired. Reconciliation and staging run under the session lock inside one
   * transaction, so a concurrent review, discard or import of the same list cannot overstage it, and
   * the returned lines and count report what the committed transaction actually did
   * (docs/user-cards.md#persistence-and-recovery).
   */
  stageSourceLines(accountId: string, plan: SourceLineStagePlan): Promise<SourceLineStageData>;
  /** Stages parsed source lines, each admitted once under its own stable identity. */
  stageEntries(accountId: string, plan: ImportStagePlan): Promise<ImportStageOutcome>;
  /** Stages one capture observation and returns the admission decision it recorded. */
  stageCapture(accountId: string, plan: CaptureStagePlan): Promise<CaptureStageOutcome>;
  /** Stores the reviewed values of one pending entry, guarded by its revision. */
  correctEntry(
    accountId: string,
    correction: ImportEntryCorrection,
  ): Promise<ImportEntryCorrectionOutcome>;
  /** Records later recognition alternatives without touching reviewed values or the sequence. */
  attachCandidates(
    accountId: string,
    attachment: CandidateAttachment,
  ): Promise<CandidateAttachmentOutcome>;
  /** Discards one pending entry when it still carries `expectedRevision`. */
  discardEntry(
    accountId: string,
    entryId: string,
    expectedRevision: number,
  ): Promise<ImportEntryDiscardOutcome>;
  /** Discards every pending entry of one session when it still carries `expectedRevision`. */
  discardSession(
    accountId: string,
    sessionId: string,
    expectedRevision: number,
  ): Promise<ImportSessionDiscardOutcome>;
  /**
   * Confirms reviewed entries under their explicit destination: a tag destination creates or
   * updates the reviewed card/printing associations with their intended quantities and never
   * establishes ownership, while the ownership destination creates individual copies with their
   * provenance for every source entry the import has not acquired yet. Entries whose own import
   * already holds that source entry are confirmed under the recorded outcome instead of creating
   * copies again, so a repeated import of one list adds nothing however the caller partitions its
   * confirmations (docs/user-cards.md#import-and-capture-state).
   */
  confirm(accountId: string, plan: ConfirmationPlan): Promise<ConfirmationOutcome>;
  /** Reads the recorded outcome of one operation, or `null` when the account has none. */
  recover(accountId: string, operationId: string): Promise<ImportReceiptData | null>;
}

/** What one migration records about itself beside its durable source archive. */
export interface MigrationRecord {
  /**
   * Verified source snapshot identity this migration loads. It identifies the migration inside the
   * account: presenting another plan under the same identity is conflicting input, and another
   * identity on an account that already holds records is refused.
   */
  readonly migrationId: string;
  readonly planDigest: string;
  readonly sourceDigest: string;
  /** Batches this plan is loaded in. */
  readonly batchCount: number;
}

/** One recorded batch, identified by the digest of exactly the records it wrote. */
export interface MigrationBatchReceipt {
  readonly index: number;
  readonly fingerprint: string;
}

/** Durable progress of one recorded migration. */
export interface MigrationProgress {
  readonly state: 'loading' | 'completed';
  /** Recorded batch receipts, ordered by batch index. */
  readonly batches: readonly MigrationBatchReceipt[];
  /** Position of the last query-visible batch; null while the plan published none. */
  readonly publicationPosition: string | null;
}

export type MigrationStartOutcome =
  /** The migration was recorded now, or its identical recording was returned. */
  | { readonly outcome: 'started'; readonly progress: MigrationProgress }
  | { readonly outcome: 'recorded'; readonly progress: MigrationProgress }
  /**
   * Another plan is recorded for this source snapshot, or the target account already holds private
   * records: a migration loads into an empty account and never mixes with other input.
   */
  | {
      readonly outcome: 'conflict';
      readonly reason: 'recorded-input' | 'nonempty-account';
    };

/**
 * The progress already recorded for one source snapshot, read without writing anything, so a
 * completed migration is recognizable before the target Catalog is consulted.
 */
export type MigrationRecordedOutcome =
  | { readonly outcome: 'recorded'; readonly progress: MigrationProgress }
  /** The account recorded another plan for this source snapshot. */
  | { readonly outcome: 'conflict'; readonly reason: 'recorded-input' };

export type MigrationBatchOutcome =
  | { readonly outcome: 'applied'; readonly publicationPosition: string | null }
  /** The identical batch was already recorded; nothing was written again. */
  | { readonly outcome: 'replayed'; readonly publicationPosition: string | null }
  /** A different batch is recorded at this index; the presented plan is not this migration. */
  | { readonly outcome: 'conflict' };

export type MigrationReadbackOutcome =
  | { readonly outcome: 'read'; readonly readback: MigrationReadback }
  /** The account records no migration. */
  | { readonly outcome: 'absent' }
  /** The recorded migration did not complete, so its records are not a reconciled outcome. */
  | { readonly outcome: 'incomplete' };

/**
 * Private migration storage (docs/migration.md#rehearsal-and-execution-gates). One migration is
 * identified per account by the verified source snapshot it loads; its archive, its batch receipts
 * and its records commit through the account's own private records, every query-visible batch
 * publishes normally, and the readback reads the authoritative records rather than a consumer's
 * projection.
 */
export interface MigrationStore {
  /**
   * Reads the progress already recorded for this source snapshot without writing anything, or null
   * when the account records no migration for it. A recorded snapshot whose plan, source or batch
   * count differs is conflicting input, reported as the same conflict `start` reports.
   */
  recorded(accountId: string, record: MigrationRecord): Promise<MigrationRecordedOutcome | null>;
  /**
   * Records the migration and its archive when the account holds no records yet, or returns the
   * progress already recorded for this snapshot. Another plan under a recorded snapshot, or any
   * further migration on an account that already holds private records, reports a conflict.
   */
  start(
    accountId: string,
    record: MigrationRecord,
    archive: readonly string[],
  ): Promise<MigrationStartOutcome>;
  /**
   * Applies one batch, its replay receipt and its revision in one transaction, or returns the
   * recorded receipt when the identical batch already committed.
   */
  applyBatch(
    accountId: string,
    migrationId: string,
    batch: MigrationBatch,
  ): Promise<MigrationBatchOutcome>;
  /** Records the completed migration with the position of its last query-visible batch. */
  complete(accountId: string, migrationId: string): Promise<MigrationProgress>;
  /** Reads the completed migration's private records and archive digest for reconciliation. */
  readReadback(accountId: string): Promise<MigrationReadbackOutcome>;
}
