import { type CatalogResolver, type Finish } from '../../catalog/index.js';
import {
  type CopyCondition,
  type ImportCandidate,
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
  /** Requested finish, or the printing's first offered finish when it is left open. */
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
  /** Finish the pending entry starts with; the printing's first offered finish when omitted. */
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
  readonly printingId: string;
  readonly finish: Finish;
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

/** One recorded confirmation: the operation, its acquisition source and the copies it created. */
export interface ImportReceipt {
  readonly operationId: ImportOperationId;
  readonly sessionId: ImportSessionId;
  readonly sourceKind: string;
  readonly sourceId: string;
  readonly copies: readonly PhysicalCopy[];
}

export interface ConfirmImportEntryInput {
  readonly entryId: ImportEntryId;
  readonly expectedRevision: number;
}

export interface ConfirmImportInput {
  /** Operation identity scoped to the account, so a retry refers to the same action. */
  readonly operationId: ImportOperationId;
  readonly sessionId: ImportSessionId;
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
