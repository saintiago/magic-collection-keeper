import { type CatalogResolver, type Finish } from '../../catalog/index.js';
import {
  type Association,
  type CopyCondition,
  type ImportCandidate,
  type ImportDestination,
  type ImportEntry,
  type ImportEntryId,
  type ImportOperationId,
  type ImportSession,
  type ImportSessionId,
  type PhysicalCopy,
  type TrustedUserContext,
} from './model.js';
import type { ImportStore } from './store.js';

export interface ListImportSessionsOptions {
  readonly pageSize?: number;
  /** Continuation from the previous page of the same account's pending imports. */
  readonly continuation?: string;
}

export interface ListImportEntriesOptions {
  readonly sessionId: ImportSessionId;
  readonly pageSize?: number;
  /** Continuation from the previous page of the same session's pending entries. */
  readonly continuation?: string;
}

export interface ImportSessionListResult {
  readonly privateRevision: string;
  /** Page of pending imports ordered by stable session identity. */
  readonly sessions: readonly ImportSession[];
  /** Continuation for the next page, or null when this page ends the list. */
  readonly continuation: string | null;
}

export interface ImportEntryListResult {
  readonly privateRevision: string;
  readonly session: ImportSession;
  /** Page of the session's pending entries in capture order. */
  readonly entries: readonly ImportEntry[];
  readonly continuation: string | null;
}

/** Identity of the acquisition a staged import belongs to, independent of its editable content. */
export interface ImportSourceInput {
  readonly kind: string;
  readonly id: string;
  /**
   * Official reference of the source, for example an official decklist URL. It is stored with the
   * session when the session is created and never rewritten
   * (docs/user-cards.md#source-imports).
   */
  readonly reference?: string | null;
}

/** One parsed source line about to become a pending entry. */
export interface StageImportEntryInput {
  /** Stable line identity; staging the same identity with identical content is idempotent. */
  readonly entryId: ImportEntryId;
  /** Resolved printing reference, or null while the parsed line is unresolved. */
  readonly printingId?: string | null;
  /** Requested finish, or the first physical finish if available when it is left open. */
  readonly finish?: Finish | null;
  readonly condition?: CopyCondition | null;
  readonly quantity: number;
  readonly candidates?: readonly ImportCandidate[];
}

export interface StageImportEntriesInput {
  readonly sessionId: ImportSessionId;
  readonly source: ImportSourceInput;
  readonly entries: readonly StageImportEntryInput[];
}

export interface ImportStageResult {
  readonly privateRevision: string;
  readonly session: ImportSession;
  /** The staged entries as they are stored now, in capture order. */
  readonly entries: readonly ImportEntry[];
  /** Entries this call staged; the remainder were already staged with identical content. */
  readonly staged: number;
  readonly replayed: boolean;
}

/** One capture observation from Recognition: its validated printing, or null while unresolved. */
export interface StageCaptureInput {
  readonly sessionId: ImportSessionId;
  /** Stable identity of this observation; a retry returns its recorded admission decision. */
  readonly captureId: ImportEntryId;
  readonly printingId?: string | null;
  /** Requested finish, or the first physical finish if available when omitted. */
  readonly finish?: Finish | null;
  readonly candidates?: readonly ImportCandidate[];
}

export interface CaptureStageResult {
  readonly privateRevision: string;
  /** The admission decision: a new entry, a suppressed repeat, or an unresolved reading. */
  readonly outcome: 'admitted' | 'suppressed' | 'unresolved';
  /** Whether this call returned a recorded decision instead of deciding now. */
  readonly replayed: boolean;
  readonly session: ImportSession;
  /** The admitted pending entry; null for a suppressed or unresolved observation. */
  readonly entry: ImportEntry | null;
}

export interface ReviewImportEntryInput {
  readonly entryId: ImportEntryId;
  readonly expectedRevision: number;
  /**
   * Reviewed playable card identity, or null when the review names none and the entry stays
   * unresolved. A printing review carries the printing's card identity; a card-level review is
   * sufficient for an association destination
   * (docs/user-cards.md#import-and-capture-state).
   */
  readonly cardId?: string | null;
  /** Reviewed printing reference, or null when the entry is reviewed at card level. */
  readonly printingId: string | null;
  /** Optional reviewed finish; physical eligibility is required only for ownership confirmation. */
  readonly finish: Finish | null;
  readonly condition: CopyCondition | null;
  readonly quantity: number;
}

export interface ImportEntryChangeResult {
  readonly privateRevision: string;
  readonly session: ImportSession;
  readonly entry: ImportEntry;
}

export interface AttachImportCandidatesInput {
  readonly entryId: ImportEntryId;
  readonly candidates: readonly ImportCandidate[];
}

export interface DiscardImportEntryInput {
  readonly entryId: ImportEntryId;
  readonly expectedRevision: number;
}

export interface DiscardImportSessionInput {
  readonly sessionId: ImportSessionId;
  readonly expectedRevision: number;
}

/** One recorded confirmation: the operation, its destination and the records it created or updated. */
export interface ImportReceipt {
  readonly operationId: ImportOperationId;
  readonly sessionId: ImportSessionId;
  readonly sourceKind: string;
  readonly sourceId: string;
  /** Explicit destination the recorded confirmation applied. */
  readonly destination: ImportDestination;
  /**
   * Durable publication position that made the recorded outcome visible. A recovered or replayed
   * outcome reports the position its records were published at, not the account's current one
   * (docs/user-cards.md#query-surface).
   */
  readonly publicationPosition: string;
  /** Copies an ownership destination created, ordered by copy identity; empty for a tag. */
  readonly copies: readonly PhysicalCopy[];
  /**
   * Associations a tag destination created or updated, ordered by association identity; empty for
   * an ownership destination.
   */
  readonly associations: readonly Association[];
}

export interface ConfirmImportEntryInput {
  readonly entryId: ImportEntryId;
  readonly expectedRevision: number;
}

export interface ConfirmImportInput {
  /** Operation identity scoped to the account, so a retry refers to the same action. */
  readonly operationId: ImportOperationId;
  readonly sessionId: ImportSessionId;
  /**
   * Explicit destination of this confirmation: the tag whose reviewed card/printing associations
   * it creates or updates, or the ownership action that creates individual copies. It is part of
   * the replay input, so a retry cannot change it under the same operation identity
   * (docs/user-cards.md#import-and-capture-state).
   */
  readonly destination: ImportDestination;
  readonly entries: readonly ConfirmImportEntryInput[];
}

export interface ImportConfirmationResult extends ImportReceipt {
  /** Whether this call returned the recorded outcome instead of committing the request. */
  readonly replayed: boolean;
  readonly privateRevision: string;
}

export type ImportOperationRecoveryResult =
  | { readonly outcome: 'recorded'; readonly receipt: ImportReceipt }
  | { readonly outcome: 'absent' };

/** The import and capture operations of the UserCards contract. */
export interface ImportOperations {
  listImportSessions(
    context: TrustedUserContext,
    options?: ListImportSessionsOptions,
  ): Promise<ImportSessionListResult>;
  listImportEntries(
    context: TrustedUserContext,
    options: ListImportEntriesOptions,
  ): Promise<ImportEntryListResult>;
  stageImportEntries(
    context: TrustedUserContext,
    input: StageImportEntriesInput,
  ): Promise<ImportStageResult>;
  stageCaptureObservation(
    context: TrustedUserContext,
    input: StageCaptureInput,
  ): Promise<CaptureStageResult>;
  reviewImportEntry(
    context: TrustedUserContext,
    input: ReviewImportEntryInput,
  ): Promise<ImportEntryChangeResult>;
  attachImportCandidates(
    context: TrustedUserContext,
    input: AttachImportCandidatesInput,
  ): Promise<ImportEntryChangeResult>;
  discardImportEntry(
    context: TrustedUserContext,
    input: DiscardImportEntryInput,
  ): Promise<ImportEntryChangeResult>;
  discardImportSession(
    context: TrustedUserContext,
    input: DiscardImportSessionInput,
  ): Promise<ImportSessionChange>;
  confirmImport(
    context: TrustedUserContext,
    input: ConfirmImportInput,
  ): Promise<ImportConfirmationResult>;
  recoverImportOperation(
    context: TrustedUserContext,
    operationId: ImportOperationId,
  ): Promise<ImportOperationRecoveryResult>;
}

export interface ImportSessionChange {
  readonly privateRevision: string;
  readonly session: ImportSession;
}

export interface ImportServiceDependencies {
  readonly store: ImportStore;
  readonly catalog: CatalogResolver;
}
