/**
 * The UserCards browser operation facade (docs/user-cards.md#browser-operation-lifecycle,
 * docs/application.md#interface).
 *
 * The facade is part of this component and owns what a browser operation needs beyond one request:
 * it begins an operation under its account-scoped identity, retains the attempt while the provider
 * has not established its outcome, observes it without cancelling the server commit, recovers the
 * recorded outcome under the operation's documented identity, retries explicitly, and publishes
 * the local committed-change invalidations a consumer reloads from. A revision-bound change has no
 * recorded outcome to read: its recovery is the record read the consumer performs through the
 * published read operations, and the facade keeps its attempt for the explicit retry that quotes
 * the same identity and revision. Confirmation uses its recorded receipt and staging operations use
 * the provider's replay of the identity they carry; no write is turned into a blind automatic
 * retry or an offline command queue (docs/user-cards.md#persistence-and-recovery).
 *
 * Attempt state is the minimum the existing import and recovery guarantees need, and it belongs to
 * one account: a scope keeps the unfinished attempts of the account it was created for, releases
 * them when that account ends, and reads back only records it wrote and can validate. An operation
 * that lost its response keeps its identity and input, so resuming never infers a new import from
 * matching contents or source URLs; an established outcome, a recorded absence or an explicitly
 * discarded import releases the attempt. Only a committed outcome — acknowledged or recovered —
 * emits an invalidation, so a lost response never reports speculative success.
 */

import type { CopyId, ImportSessionId, TagId } from '../model.js';
import type {
  AttachImportCandidatesInput,
  CaptureStageResult,
  ConfirmImportInput,
  DiscardImportEntryInput,
  DiscardImportSessionInput,
  ImportConfirmationResult,
  ImportEntryChangeResult,
  ImportEntryListResult,
  ImportOperationRecoveryResult,
  ImportReceipt,
  ImportSessionChange,
  ImportSessionListResult,
  ImportStageResult,
  ListImportEntriesOptions,
  ListImportSessionsOptions,
  ReviewImportEntryInput,
  StageCaptureInput,
  StageImportEntriesInput,
} from '../import-service.js';
import type {
  AssociationChangeResult,
  AssociationListResult,
  AssociationReadResult,
  AssociationRemovalResult,
  ChangeAssociationInput,
  CopyChangeResult,
  CopyLocationResult,
  CopyReadResult,
  CorrectCopyInput,
  CreateAssociationInput,
  CreateTagInput,
  ListAssociationsOptions,
  RemoveAssociationInput,
  RenameTagInput,
  SetCopyLocationInput,
  TagChangeResult,
  TagListOptions,
  TagListResult,
  TagReadResult,
} from '../service.js';
import type {
  ReviewedWizardsLine,
  SourceImportResult,
  StageSourceImportInput,
} from '../source-imports.js';

import {
  USERCARDS_BROWSER_LIMITS,
  usercardsBrowserOperations,
  usercardsConstraints,
  type UserCardsBrowserOperation,
  type UserCardsConstraints,
} from './constraints.js';

/**
 * The private UserCards operations a browser transport serves
 * (docs/user-cards.md#interface). Application's transport adapter implements this port; the
 * browser facade below composes the operation lifecycle over it, and no consumer reaches storage.
 */
export interface UserCardsBrowserClient {
  /** Authorized copies of the requested references, with the references this account has none for. */
  readCopies(copyIds: readonly CopyId[], signal?: AbortSignal): Promise<CopyReadResult>;
  /** The corrected state of one copy, guarded by the revision the caller read. */
  correctCopy(input: CorrectCopyInput, signal?: AbortSignal): Promise<CopyChangeResult>;
  /** Page of the account's tags, ordered by stable tag identity. */
  listTags(options?: TagListOptions, signal?: AbortSignal): Promise<TagListResult>;
  /** Authorized tags of the requested references, with the references this account has none for. */
  readTags(tagIds: readonly string[], signal?: AbortSignal): Promise<TagReadResult>;
  /** One new tag of the account. */
  createTag(input: CreateTagInput, signal?: AbortSignal): Promise<TagChangeResult>;
  /** The renamed state of one tag, guarded by the revision the caller read. */
  renameTag(input: RenameTagInput, signal?: AbortSignal): Promise<TagChangeResult>;
  /** Page of one tag's associations, ordered by stable association identity. */
  listAssociations(
    tagId: string,
    options?: Omit<ListAssociationsOptions, 'tagId'>,
    signal?: AbortSignal,
  ): Promise<AssociationListResult>;
  /** Authorized associations of the requested references, for reviewing a change's outcome. */
  readAssociations(
    associationIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<AssociationReadResult>;
  /** One new association of a tag; a card or printing target carries its intended quantity. */
  createAssociation(
    input: CreateAssociationInput,
    signal?: AbortSignal,
  ): Promise<AssociationChangeResult>;
  /** The changed state of one association, guarded by the revision the caller read. */
  changeAssociation(
    input: ChangeAssociationInput,
    signal?: AbortSignal,
  ): Promise<AssociationChangeResult>;
  /** The removal of one association, guarded by the revision the caller read. */
  removeAssociation(
    input: RemoveAssociationInput,
    signal?: AbortSignal,
  ): Promise<AssociationRemovalResult>;
  /** The new single physical location of one copy, guarded by the revision the caller read. */
  setCopyLocation(input: SetCopyLocationInput, signal?: AbortSignal): Promise<CopyLocationResult>;
  /** Page of the account's pending import sessions, ordered by stable session identity. */
  listImportSessions(
    options?: ListImportSessionsOptions,
    signal?: AbortSignal,
  ): Promise<ImportSessionListResult>;
  /** Page of one pending import session's entries, in capture order. */
  listImportEntries(
    input: ListImportEntriesOptions,
    signal?: AbortSignal,
  ): Promise<ImportEntryListResult>;
  /** Stages parsed or manually entered lines as pending entries of one session. */
  stageImportEntries(
    input: StageImportEntriesInput,
    signal?: AbortSignal,
  ): Promise<ImportStageResult>;
  /** Parses one supported source into the account's pending entries. */
  stageSourceImport(
    input: StageSourceImportInput,
    signal?: AbortSignal,
  ): Promise<SourceImportResult>;
  /** Stages one capture observation of its capture session. */
  stageCaptureObservation(
    input: StageCaptureInput,
    signal?: AbortSignal,
  ): Promise<CaptureStageResult>;
  /** One pending entry's reviewed values, guarded by the revision the caller read. */
  reviewImportEntry(
    input: ReviewImportEntryInput,
    signal?: AbortSignal,
  ): Promise<ImportEntryChangeResult>;
  /** Late recognition alternatives of one pending entry; reviewed values stay unchanged. */
  attachImportCandidates(
    input: AttachImportCandidatesInput,
    signal?: AbortSignal,
  ): Promise<ImportEntryChangeResult>;
  /** Ends one pending entry without creating owned copies. */
  discardImportEntry(
    input: DiscardImportEntryInput,
    signal?: AbortSignal,
  ): Promise<ImportEntryChangeResult>;
  /** Ends every pending entry of one import without creating owned copies. */
  discardImportSession(
    input: DiscardImportSessionInput,
    signal?: AbortSignal,
  ): Promise<ImportSessionChange>;
  /** Confirms reviewed entries under one operation identity, creating their copies. */
  confirmImport(input: ConfirmImportInput, signal?: AbortSignal): Promise<ImportConfirmationResult>;
  /** The recorded outcome of one operation identity, or its explicit absence. */
  recoverImportOperation(
    operationId: string,
    signal?: AbortSignal,
  ): Promise<ImportOperationRecoveryResult>;
}

/**
 * One source import a browser submits. It names the source the way the provider's input does; the
 * import identity the operation runs under belongs to the facade, so resuming keeps the import the
 * same input already composes instead of inferring one from the contents or source URL.
 */
export type UserCardsSourceImportRequest =
  | { readonly format: 'pasted-list'; readonly text: string }
  | { readonly format: 'moxfield'; readonly url: string }
  | {
      readonly format: 'wizards-precon';
      readonly sourceId: string;
      readonly reference: string;
      readonly entries: readonly ReviewedWizardsLine[];
    };

/** One confirmation a browser submits, under the operation identity the facade owns. */
export interface UserCardsConfirmationRequest {
  readonly sessionId: ImportSessionId;
  readonly entries: readonly ConfirmImportInput['entries'][number][];
}

/** The scope whose membership or quantities a committed change may have changed. */
export type UserCardsChangeScope = 'copies' | 'tags' | 'associations' | 'imports';

/** One affected record of a committed change. */
export type UserCardsRecordReference =
  | { readonly kind: 'copy'; readonly copyId: CopyId }
  | { readonly kind: 'tag'; readonly tagId: TagId }
  | { readonly kind: 'association'; readonly associationId: string };

/**
 * One local committed-change invalidation. It requests a read of the scope it names; it is never a
 * second copy of authoritative data. The references are the records the change reported, the
 * imports are the pending imports whose entries may have changed, and the position is the durable
 * publication position when indexing is affected (docs/user-cards.md#query-surface).
 */
export interface UserCardsChange {
  readonly scope: UserCardsChangeScope;
  readonly records: readonly UserCardsRecordReference[];
  readonly imports: readonly ImportSessionId[];
  readonly position: string | null;
}

/** What one operation reported: a definite refusal, or a failure that leaves the outcome open. */
export interface UserCardsOperationFailure {
  /** Failure code the provider or transport reported, or null when it carried none. */
  readonly code: string | null;
  readonly message: string;
}

/**
 * What the provider has established about one user operation. `pending` has not reported yet,
 * `committed` carries the authoritative record, `rejected` establishes that the operation did not
 * apply, and `unknown` leaves it open until an authoritative read or the owner resolves it. A
 * committed record reports whether the provider replayed a recorded outcome, so a consumer
 * presents a recorded confirmation as such instead of as a new commitment.
 */
export type UserCardsOperationOutcome<Record> =
  | { readonly state: 'pending' }
  | { readonly state: 'committed'; readonly record: Record }
  | { readonly state: 'rejected'; readonly failure: UserCardsOperationFailure }
  | { readonly state: 'unknown'; readonly failure: UserCardsOperationFailure | null };

/**
 * One confirmation's committed outcome: the receipt that names its copies and whether the
 * provider returned the recorded outcome instead of committing the request again.
 */
export interface UserCardsConfirmationOutcome extends ImportReceipt {
  readonly replayed: boolean;
}

/** The operations whose unfinished attempts one account retains and can resume. */
type UserCardsRetainedKind =
  'stageImportEntries' | 'stageSourceImport' | 'stageCaptureObservation' | 'confirmImport';

/** One user operation the facade tracks, with the capabilities every consumer needs. */
export interface UserCardsOperation<Kind extends string, Record> {
  /** The operation this attempt belongs to. */
  readonly kind: Kind;
  /** Identity the operation runs under: import, entry, capture or confirmation identity. */
  readonly operationId: string;
  /** What the provider has established, without waiting. */
  outcome(): UserCardsOperationOutcome<Record>;
  /** Resolves when the dispatched attempt reports; an observer never cancels the server commit. */
  observe(): Promise<UserCardsOperationOutcome<Record>>;
  /** Recovers the operation's recorded outcome under its documented identity. */
  recover(signal?: AbortSignal): Promise<UserCardsOperationOutcome<Record>>;
  /** Dispatches the same input again under the same identity; the caller's explicit retry. */
  retry(signal?: AbortSignal): Promise<UserCardsOperationOutcome<Record>>;
}

/**
 * One unfinished attempt a consumer may resume: the operation it belongs to and the input its
 * identity was begun with. A consumer presents that input again — or dispatches the same
 * confirmation — and reaches the operation it already started instead of composing another one.
 */
export interface UserCardsRetainedOperation<
  Kind extends string,
  Record,
  Request,
> extends UserCardsOperation<Kind, Record> {
  /** The input this unfinished attempt keeps; replaying it resumes this operation. */
  readonly request: Request;
}

/** One retained attempt of one account, typed by the operation it belongs to. */
export type UserCardsRetainedAttempt =
  | UserCardsRetainedOperation<'stageImportEntries', ImportStageResult, StageImportEntriesInput>
  | UserCardsRetainedOperation<
      'stageSourceImport',
      SourceImportResult,
      UserCardsSourceImportRequest
    >
  | UserCardsRetainedOperation<'stageCaptureObservation', CaptureStageResult, StageCaptureInput>
  | UserCardsRetainedOperation<
      'confirmImport',
      UserCardsConfirmationOutcome,
      UserCardsConfirmationRequest
    >;

/** Storage an account's unfinished attempts survive a reload in; a browsing session provides one. */
export interface UserCardsAttemptStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface UserCardsOperationsOptions {
  /** The private operations port the facade serves; Application's transport adapter implements it. */
  readonly client: UserCardsBrowserClient;
  /** Storage retained attempts survive a reload in; without one they live in memory only. */
  readonly storage?: UserCardsAttemptStorage | null;
  /** Operations this deployment enables; defaults to every operation the client implements. */
  readonly operations?: readonly UserCardsBrowserOperation[];
  /** Identity source of new import, capture and confirmation identities; tests control it. */
  readonly identity?: () => string;
}

/** The published constraints and account-scoped operations of one deployment. */
export interface UserCardsOperations {
  /** Account-scoped facade of one presented account; one account keeps one scope. */
  account(accountId: string): UserCardsAccountOperations;
}

/**
 * The UserCards operations one account presents. Reads reach the provider unchanged; every change
 * is an operation whose outcome is pending, committed, rejected or unknown. Beginning one tracks
 * it, `retained` and `resume` reattach what the account still keeps, `observe` waits without
 * cancelling the commit, `recover` reads the recorded outcome and `retry` dispatches the same
 * input again; an established attempt publishes the invalidation a consumer reloads from.
 */
export interface UserCardsAccountOperations {
  /** Input constraints and operation availability of this deployment. */
  readonly constraints: UserCardsConstraints;
  readCopies(copyIds: readonly CopyId[], signal?: AbortSignal): Promise<CopyReadResult>;
  listTags(options?: TagListOptions, signal?: AbortSignal): Promise<TagListResult>;
  readTags(tagIds: readonly string[], signal?: AbortSignal): Promise<TagReadResult>;
  listAssociations(
    tagId: string,
    options?: Omit<ListAssociationsOptions, 'tagId'>,
    signal?: AbortSignal,
  ): Promise<AssociationListResult>;
  readAssociations(
    associationIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<AssociationReadResult>;
  listImportSessions(
    options?: ListImportSessionsOptions,
    signal?: AbortSignal,
  ): Promise<ImportSessionListResult>;
  listImportEntries(
    input: ListImportEntriesOptions,
    signal?: AbortSignal,
  ): Promise<ImportEntryListResult>;
  /** Stages lines under their entry identities; a repeat replays the recorded staging. */
  stageImportEntries(
    input: StageImportEntriesInput,
    signal?: AbortSignal,
  ): UserCardsOperation<'stageImportEntries', ImportStageResult>;
  /**
   * Parses one source under the identity of the import it composes: an input an unfinished attempt
   * already keeps resumes that import, and any other input composes one of its own.
   */
  stageSourceImport(
    input: UserCardsSourceImportRequest,
    signal?: AbortSignal,
  ): UserCardsOperation<'stageSourceImport', SourceImportResult>;
  /** Stages one capture observation under its capture identity. */
  stageCaptureObservation(
    input: StageCaptureInput,
    signal?: AbortSignal,
  ): UserCardsOperation<'stageCaptureObservation', CaptureStageResult>;
  reviewImportEntry(
    input: ReviewImportEntryInput,
    signal?: AbortSignal,
  ): UserCardsOperation<'reviewImportEntry', ImportEntryChangeResult>;
  attachImportCandidates(
    input: AttachImportCandidatesInput,
    signal?: AbortSignal,
  ): UserCardsOperation<'attachImportCandidates', ImportEntryChangeResult>;
  discardImportEntry(
    input: DiscardImportEntryInput,
    signal?: AbortSignal,
  ): UserCardsOperation<'discardImportEntry', ImportEntryChangeResult>;
  discardImportSession(
    input: DiscardImportSessionInput,
    signal?: AbortSignal,
  ): UserCardsOperation<'discardImportSession', ImportSessionChange>;
  /** Confirms reviewed entries under a new operation identity, or resumes a retained one. */
  confirmImport(
    input: UserCardsConfirmationRequest,
    signal?: AbortSignal,
  ): UserCardsOperation<'confirmImport', UserCardsConfirmationOutcome>;
  correctCopy(
    input: CorrectCopyInput,
    signal?: AbortSignal,
  ): UserCardsOperation<'correctCopy', CopyChangeResult>;
  createTag(
    input: CreateTagInput,
    signal?: AbortSignal,
  ): UserCardsOperation<'createTag', TagChangeResult>;
  renameTag(
    input: RenameTagInput,
    signal?: AbortSignal,
  ): UserCardsOperation<'renameTag', TagChangeResult>;
  createAssociation(
    input: CreateAssociationInput,
    signal?: AbortSignal,
  ): UserCardsOperation<'createAssociation', AssociationChangeResult>;
  changeAssociation(
    input: ChangeAssociationInput,
    signal?: AbortSignal,
  ): UserCardsOperation<'changeAssociation', AssociationChangeResult>;
  removeAssociation(
    input: RemoveAssociationInput,
    signal?: AbortSignal,
  ): UserCardsOperation<'removeAssociation', AssociationRemovalResult>;
  setCopyLocation(
    input: SetCopyLocationInput,
    signal?: AbortSignal,
  ): UserCardsOperation<'setCopyLocation', CopyLocationResult>;
  /** Unfinished attempts of this account, oldest first; an established attempt is released. */
  retained(): readonly UserCardsRetainedAttempt[];
  /** Reattaches to one retained attempt, or null when this account retains none with that identity. */
  resume(operationId: string): UserCardsRetainedAttempt | null;
  /** Local committed-change invalidations of this account; the returned call unsubscribes. */
  subscribe(listener: (change: UserCardsChange) => void): () => void;
  /** Releases this account's retained attempts and subscriptions. */
  release(): void;
}

/**
 * Builds the browser facade over the private operations port. Application's browser composition
 * supplies the transport-backed client, the browser session's attempt storage and the operations
 * the deployment enables; the facade publishes only browser-safe types
 * (docs/application.md#interface).
 */
export function createUserCardsOperations(
  options: UserCardsOperationsOptions,
): UserCardsOperations {
  const client = options?.client;
  if (typeof client !== 'object' || client === null) {
    throw new TypeError('createUserCardsOperations requires the UserCards client it presents.');
  }
  const operations = readAvailable(options.operations, client);
  const constraints: UserCardsConstraints = { operations, ...usercardsConstraints };
  const storage = options.storage ?? null;
  const identity = typeof options.identity === 'function' ? options.identity : usercardsIdentity;
  const accounts = new Map<string, UserCardsAccountOperations>();

  return {
    account(accountId) {
      const id = readIdentityText(accountId);
      const existing = accounts.get(id);
      if (existing !== undefined) {
        return existing;
      }
      const scope = createAccountScope(id);
      accounts.set(id, scope);
      return scope;
    },
  };

  function createAccountScope(accountId: string): UserCardsAccountOperations {
    /** Unfinished attempts of this account, in the order they were begun. */
    const attempts = new Map<string, Attempt<string, unknown>>();
    const listeners = new Set<(change: UserCardsChange) => void>();
    let released = false;

    /**
     * Tracks one attempt and publishes the committed changes it establishes. A begun or reattached
     * attempt stays in the account's scope until its outcome is established; a transient attempt of
     * one revision-bound change leaves no resumable state.
     */
    function tracked<Kind extends string, Record>(
      request: AttemptRequest<Kind, Record>,
      mode: 'begin' | 'reattach' | 'transient' = 'transient',
    ): Attempt<Kind, Record> {
      const attempt = createAttempt(request, emit, () => {
        // An established outcome is nothing to resume: the attempt leaves the account's scope so a
        // later submission of the same input composes an operation of its own
        // (docs/user-cards.md#import-state-and-identity).
        if (
          attempts.get(attempt.operationId) === (attempt as unknown as Attempt<string, unknown>)
        ) {
          attempts.delete(attempt.operationId);
          writeStoredAttempts();
        }
      });
      if (mode !== 'transient') {
        attempts.set(attempt.operationId, attempt as unknown as Attempt<string, unknown>);
      }
      if (mode === 'begin') {
        // The identity and input are kept before the request is dispatched, so a lost response or
        // a reload still resumes this operation instead of composing another one.
        writeStoredAttempts();
      }
      if (mode !== 'reattach') {
        void attempt.handle.retry(request.signal);
      }
      return attempt;
    }

    for (const record of readStoredAttempts(storage, accountId)) {
      reattach(record);
    }

    return {
      constraints,
      readCopies: (copyIds, signal) => client.readCopies(copyIds, signal),
      listTags: (options, signal) => client.listTags(options, signal),
      readTags: (tagIds, signal) => client.readTags(tagIds, signal),
      listAssociations: (tagId, options, signal) => client.listAssociations(tagId, options, signal),
      readAssociations: (associationIds, signal) => client.readAssociations(associationIds, signal),
      listImportSessions: (options, signal) => client.listImportSessions(options, signal),
      listImportEntries: (input, signal) => client.listImportEntries(input, signal),

      stageImportEntries(input, signal) {
        requireAvailable('stageImportEntries');
        return resumeOrBegin<'stageImportEntries', ImportStageResult>({
          kind: 'stageImportEntries',
          identity: entriesIdentity(input),
          signal,
          begin: (operationId) => ({
            kind: 'stageImportEntries',
            identity: entriesIdentity(input),
            operationId,
            input,
            signal,
            run: (callSignal) => client.stageImportEntries(input, callSignal),
            change: (result) => importChange(result.session.sessionId),
            replay: true,
          }),
        }).handle;
      },

      stageSourceImport(input, signal) {
        requireAvailable('stageSourceImport');
        return resumeOrBegin<'stageSourceImport', SourceImportResult>({
          kind: 'stageSourceImport',
          identity: sourceIdentity(input),
          signal,
          // The import identity lives with the unfinished attempt: an input that already composes
          // one resumes it instead of inferring another import from its contents or source URL.
          begin: (operationId) => {
            const request = sourceRequest(input, operationId);
            return {
              kind: 'stageSourceImport',
              identity: sourceIdentity(input),
              operationId,
              input,
              signal,
              run: (callSignal) => client.stageSourceImport(request, callSignal),
              change: (result) => importChange(result.session.sessionId),
              replay: true,
            };
          },
        }).handle;
      },

      stageCaptureObservation(input, signal) {
        requireAvailable('stageCaptureObservation');
        return resumeOrBegin<'stageCaptureObservation', CaptureStageResult>({
          kind: 'stageCaptureObservation',
          identity: captureIdentity(input),
          signal,
          begin: () => ({
            kind: 'stageCaptureObservation',
            identity: captureIdentity(input),
            operationId: input.captureId,
            input,
            signal,
            run: (callSignal) => client.stageCaptureObservation(input, callSignal),
            change: (result) => importChange(result.session.sessionId),
            replay: true,
          }),
        }).handle;
      },

      reviewImportEntry(input, signal) {
        requireAvailable('reviewImportEntry');
        return tracked<'reviewImportEntry', ImportEntryChangeResult>({
          kind: 'reviewImportEntry',
          identity: `entry ${input.entryId}`,
          operationId: identity('review'),
          input,
          signal,
          run: (callSignal) => client.reviewImportEntry(input, callSignal),
          change: (result) => importChange(result.session.sessionId),
        }).handle;
      },

      attachImportCandidates(input, signal) {
        requireAvailable('attachImportCandidates');
        return tracked<'attachImportCandidates', ImportEntryChangeResult>({
          kind: 'attachImportCandidates',
          identity: `entry ${input.entryId}`,
          operationId: identity('candidates'),
          input,
          signal,
          run: (callSignal) => client.attachImportCandidates(input, callSignal),
          change: (result) => importChange(result.session.sessionId),
        }).handle;
      },

      discardImportEntry(input, signal) {
        requireAvailable('discardImportEntry');
        return tracked<'discardImportEntry', ImportEntryChangeResult>({
          kind: 'discardImportEntry',
          identity: `entry ${input.entryId}`,
          operationId: identity('discard'),
          input,
          signal,
          run: (callSignal) => client.discardImportEntry(input, callSignal),
          change: (result) => importChange(result.session.sessionId),
        }).handle;
      },

      discardImportSession(input, signal) {
        requireAvailable('discardImportSession');
        return tracked<'discardImportSession', ImportSessionChange>({
          kind: 'discardImportSession',
          identity: `session ${input.sessionId}`,
          operationId: identity('discard'),
          input,
          signal,
          run: (callSignal) => client.discardImportSession(input, callSignal),
          change: (result) => importChange(result.session.sessionId),
          settled: (result) => forgetSourceImport(result.session.sessionId),
        }).handle;
      },

      confirmImport(input, signal) {
        requireAvailable('confirmImport');
        return resumeOrBegin<'confirmImport', UserCardsConfirmationOutcome>({
          kind: 'confirmImport',
          identity: confirmationIdentity(input),
          signal,
          begin: (operationId) => ({
            kind: 'confirmImport',
            identity: confirmationIdentity(input),
            operationId,
            input,
            signal,
            run: (callSignal) => client.confirmImport({ ...input, operationId }, callSignal),
            // Confirmation uses its recorded receipt: a lost response never infers commitment
            // from the entries that may or may not have produced copies
            // (docs/application.md#construction-and-request-boundary).
            recorded: (callSignal) => recordedConfirmation(operationId, callSignal),
            change: (confirmation) => confirmedChange(confirmation),
            settled: (confirmation) => forgetSourceImport(confirmation.sessionId),
          }),
        }).handle;
      },

      correctCopy(input, signal) {
        requireAvailable('correctCopy');
        return tracked<'correctCopy', CopyChangeResult>({
          kind: 'correctCopy',
          identity: `copy ${input.copyId}`,
          operationId: identity('correction'),
          input,
          signal,
          run: (callSignal) => client.correctCopy(input, callSignal),
          change: (result) => ({
            scope: 'copies',
            records: result.copies.map((copy) => ({ kind: 'copy', copyId: copy.copyId })),
            imports: [],
            position: result.publicationPosition,
          }),
        }).handle;
      },

      createTag(input, signal) {
        requireAvailable('createTag');
        return tracked<'createTag', TagChangeResult>({
          kind: 'createTag',
          identity: 'tag',
          operationId: identity('tag'),
          input,
          signal,
          run: (callSignal) => client.createTag(input, callSignal),
          change: (result) => tagChange(result),
        }).handle;
      },

      renameTag(input, signal) {
        requireAvailable('renameTag');
        return tracked<'renameTag', TagChangeResult>({
          kind: 'renameTag',
          identity: `tag ${input.tagId}`,
          operationId: identity('tag'),
          input,
          signal,
          run: (callSignal) => client.renameTag(input, callSignal),
          change: (result) => tagChange(result),
        }).handle;
      },

      createAssociation(input, signal) {
        requireAvailable('createAssociation');
        return tracked<'createAssociation', AssociationChangeResult>({
          kind: 'createAssociation',
          identity: `tag ${input.tagId}`,
          operationId: identity('association'),
          input,
          signal,
          run: (callSignal) => client.createAssociation(input, callSignal),
          change: (result) => associationChange(result),
        }).handle;
      },

      changeAssociation(input, signal) {
        requireAvailable('changeAssociation');
        return tracked<'changeAssociation', AssociationChangeResult>({
          kind: 'changeAssociation',
          identity: `association ${input.associationId}`,
          operationId: identity('association'),
          input,
          signal,
          run: (callSignal) => client.changeAssociation(input, callSignal),
          change: (result) => associationChange(result),
        }).handle;
      },

      removeAssociation(input, signal) {
        requireAvailable('removeAssociation');
        return tracked<'removeAssociation', AssociationRemovalResult>({
          kind: 'removeAssociation',
          identity: `association ${input.associationId}`,
          operationId: identity('association'),
          input,
          signal,
          run: (callSignal) => client.removeAssociation(input, callSignal),
          change: (result) => ({
            scope: 'associations',
            records: [{ kind: 'association', associationId: result.associationId }],
            imports: [],
            position: result.publicationPosition,
          }),
        }).handle;
      },

      setCopyLocation(input, signal) {
        requireAvailable('setCopyLocation');
        return tracked<'setCopyLocation', CopyLocationResult>({
          kind: 'setCopyLocation',
          identity: `copy ${input.copyId}`,
          operationId: identity('location'),
          input,
          signal,
          run: (callSignal) => client.setCopyLocation(input, callSignal),
          change: (result) => ({
            scope: 'associations',
            records: [
              { kind: 'copy', copyId: result.copy.copyId },
              ...(result.location === null
                ? []
                : [{ kind: 'association', associationId: result.location.associationId } as const]),
            ],
            imports: [],
            position: result.publicationPosition,
          }),
        }).handle;
      },

      retained() {
        return [...attempts.values()].map((attempt) => attempt.handle as UserCardsRetainedAttempt);
      },

      resume(operationId) {
        const attempt = attempts.get(operationId);
        return attempt === undefined ? null : (attempt.handle as UserCardsRetainedAttempt);
      },

      subscribe(listener) {
        if (typeof listener !== 'function') {
          throw new TypeError('A committed-change subscriber is a function.');
        }
        listeners.add(listener);
        return () => listeners.delete(listener);
      },

      release() {
        released = true;
        for (const attempt of attempts.values()) {
          attempt.dispose();
        }
        attempts.clear();
        listeners.clear();
        releaseStoredAttempts(storage, accountId);
      },
    };

    /**
     * Reattaches to an unfinished attempt of the same operation and input, or begins one. The
     * caller's explicit submission is the retry: a retained attempt is dispatched again under its
     * own identity instead of composing a second import, capture or confirmation.
     */
    function resumeOrBegin<Kind extends string, Record>(options: {
      readonly kind: Kind;
      readonly identity: string;
      readonly signal: AbortSignal | undefined;
      begin(operationId: string): AttemptRequest<Kind, Record>;
    }): Attempt<Kind, Record> {
      for (const attempt of attempts.values()) {
        if (attempt.kind === options.kind && attempt.identity === options.identity) {
          void attempt.handle.retry(options.signal);
          return attempt as unknown as Attempt<Kind, Record>;
        }
      }
      return tracked(options.begin(identity('attempt')), 'begin');
    }

    /** Reattaches one validated stored attempt without dispatching it. */
    function reattach(record: StoredAttempt): void {
      switch (record.kind) {
        case 'stageImportEntries': {
          const input = readStageEntries(record.input);
          if (input !== null) {
            tracked(
              {
                kind: record.kind,
                identity: record.identity,
                operationId: record.operationId,
                input,
                run: (callSignal) => client.stageImportEntries(input, callSignal),
                change: (result) => importChange(result.session.sessionId),
                replay: true,
                reattached: true,
              },
              'reattach',
            );
          }
          return;
        }
        case 'stageSourceImport': {
          const input = readSourceImport(record.input);
          if (input === null) {
            return;
          }
          const request = sourceRequest(input, record.operationId);
          tracked(
            {
              kind: record.kind,
              identity: record.identity,
              operationId: record.operationId,
              input,
              run: (callSignal) => client.stageSourceImport(request, callSignal),
              change: (result) => importChange(result.session.sessionId),
              replay: true,
              reattached: true,
            },
            'reattach',
          );
          return;
        }
        case 'stageCaptureObservation': {
          const input = readCapture(record.input);
          if (input !== null) {
            tracked(
              {
                kind: record.kind,
                identity: record.identity,
                operationId: record.operationId,
                input,
                run: (callSignal) => client.stageCaptureObservation(input, callSignal),
                change: (result) => importChange(result.session.sessionId),
                replay: true,
                reattached: true,
              },
              'reattach',
            );
          }
          return;
        }
        case 'confirmImport': {
          const input = readConfirmation(record.input);
          if (input === null) {
            return;
          }
          tracked(
            {
              kind: record.kind,
              identity: record.identity,
              operationId: record.operationId,
              input,
              run: (callSignal) =>
                client.confirmImport({ ...input, operationId: record.operationId }, callSignal),
              recorded: (callSignal) => recordedConfirmation(record.operationId, callSignal),
              change: (receipt) => confirmedChange(receipt),
              settled: (receipt) => forgetSourceImport(receipt.sessionId),
              reattached: true,
            },
            'reattach',
          );
          return;
        }
      }
    }

    /** Reads the recorded receipt of one confirmation, or its explicit absence. */
    async function recordedConfirmation(
      operationId: string,
      signal: AbortSignal | undefined,
    ): Promise<RecordedOutcome<UserCardsConfirmationOutcome>> {
      const recovered = await client.recoverImportOperation(operationId, signal);
      return recovered.outcome === 'recorded'
        ? { state: 'committed', record: { ...recovered.receipt, replayed: true } }
        : { state: 'rejected', failure: confirmationAbsent };
    }

    /** Emits one committed change to the account's subscribers. */
    function emit(change: UserCardsChange): void {
      for (const listener of [...listeners]) {
        try {
          listener(change);
        } catch {
          // A subscriber that refuses a hint never breaks the operation that committed.
        }
      }
    }

    /**
     * Releases the source-import identity one established session change resolved: a committed
     * confirmation or an explicitly discarded import ends the import a source input composed, so
     * the next submission of that input composes a new list. A confirmation whose own outcome is
     * not established stays retained until its recorded receipt or its absence decides it.
     */
    function forgetSourceImport(sessionId: string): void {
      let changed = false;
      for (const attempt of attempts.values()) {
        if (attempt.kind === 'stageSourceImport' && attempt.operationId === sessionId) {
          attempt.dispose();
          attempts.delete(attempt.operationId);
          changed = true;
        }
      }
      if (changed) {
        writeStoredAttempts();
      }
    }

    /** Writes the account's unfinished attempts, bounded to the most recent ones. */
    function writeStoredAttempts(): void {
      if (released) {
        return;
      }
      const unfinished = [...attempts.values()];
      const bounded = unfinished.slice(
        Math.max(0, unfinished.length - USERCARDS_BROWSER_LIMITS.retainedAttempts),
      );
      keepStoredAttempts(
        storage,
        accountId,
        bounded.map((attempt) => ({
          kind: attempt.kind as UserCardsRetainedKind,
          identity: attempt.identity,
          operationId: attempt.operationId,
          input: attempt.input,
        })),
      );
    }

    function requireAvailable(operation: UserCardsBrowserOperation): void {
      if (released) {
        throw new Error('The account this operation belongs to has ended.');
      }
      if (!operations.includes(operation)) {
        throw new Error(`The ${operation} operation is not enabled in this deployment.`);
      }
    }
  }
}

/** One tracked operation of one account. */
interface Attempt<Kind extends string, Record> {
  readonly kind: Kind;
  readonly identity: string;
  readonly operationId: string;
  readonly input: unknown;
  readonly handle: UserCardsOperation<Kind, Record>;
  dispose(): void;
}

/** One operation to track, before the account's invalidation sink is attached. */
interface AttemptRequest<Kind extends string, Record> {
  readonly kind: Kind;
  /** Identity of the input the attempt replays; a caller resubmitting it resumes this attempt. */
  readonly identity: string;
  readonly operationId: string;
  readonly input: unknown;
  /** Dispatches the operation; the provider's replay semantics make a repeated call safe. */
  run(signal: AbortSignal | undefined): Promise<Record>;
  /** Reads the operation's recorded outcome, when the contract defines one. */
  recorded?(signal: AbortSignal | undefined): Promise<RecordedOutcome<Record>>;
  /** True when the provider records this operation's identity, so recovery replays it. */
  readonly replay?: boolean;
  readonly change: (record: Record) => UserCardsChange;
  /** Applies a committed record to related retained attempts. */
  readonly settled?: (record: Record) => void;
  /** True for one attempt reattached from storage, which a resume resolves. */
  readonly reattached?: boolean;
  readonly signal?: AbortSignal | undefined;
}

type RecordedOutcome<Record> =
  | { readonly state: 'committed'; readonly record: Record }
  | { readonly state: 'rejected'; readonly failure: UserCardsOperationFailure }
  | { readonly state: 'unknown' };

/** Creates one tracked operation without dispatching it. */
function createAttempt<Kind extends string, Record>(
  request: AttemptRequest<Kind, Record>,
  emit: (change: UserCardsChange) => void,
  established: () => void,
): Attempt<Kind, Record> {
  let outcome: UserCardsOperationOutcome<Record> =
    request.reattached === true ? { state: 'unknown', failure: null } : { state: 'pending' };
  let generation = 0;
  // A reattached attempt never reported: what the provider has established for it is unknown.
  let uncertain = request.reattached === true;
  let disposed = false;
  let waiting: PromiseWithResolvers<void> | null = null;

  const handle = {
    kind: request.kind,
    operationId: request.operationId,
    // The input an unfinished attempt keeps; a consumer that presents it again resumes this
    // operation instead of composing another one (docs/user-cards.md#browser-operation-lifecycle).
    request: request.input,
    outcome: () => outcome,
    async observe() {
      while (outcome.state === 'pending' && !disposed) {
        const open = waiting;
        if (open === null) {
          break;
        }
        await open.promise;
      }
      return outcome;
    },
    recover: (signal: AbortSignal | undefined) => {
      if (request.recorded !== undefined) {
        return readRecorded(signal);
      }
      // A staging operation records the identity it carries, so replaying it recovers the
      // recorded outcome. A revision-bound change has no recorded outcome: only the consumer's
      // read of the record can resolve what stays unknown, and its retry quotes the revision.
      return request.replay === true ? dispatch(signal) : Promise.resolve(outcome);
    },
    retry: (signal: AbortSignal | undefined) => dispatch(signal),
  } as unknown as UserCardsOperation<Kind, Record>;
  const attempt: Attempt<Kind, Record> = {
    kind: request.kind,
    identity: request.identity,
    operationId: request.operationId,
    input: request.input,
    handle,
    dispose() {
      disposed = true;
      generation += 1;
      finishWaiting();
    },
  };
  return attempt;

  /** Dispatches one call, under the attempt's identity and with the caller's signal. */
  async function dispatch(
    signal: AbortSignal | undefined,
  ): Promise<UserCardsOperationOutcome<Record>> {
    if (disposed) {
      return outcome;
    }
    const current = (generation += 1);
    outcome = { state: 'pending' };
    startWaiting();
    try {
      const record = await request.run(signal ?? request.signal);
      if (!disposed && current === generation) {
        commit(record);
      }
    } catch (cause) {
      if (!disposed && current === generation) {
        await fail(cause, signal ?? request.signal, current);
      }
    }
    if (!disposed && current === generation) {
      finishWaiting();
    }
    return outcome;
  }

  /** One dispatch's failure: the operation's recorded outcome decides when it has one. */
  async function fail(
    cause: unknown,
    signal: AbortSignal | undefined,
    current: number,
  ): Promise<void> {
    const failure = readFailure(cause);
    const refused = failure.code !== null && isRejectedCode(failure.code);
    if (refused && !uncertain) {
      // A definite refusal of a first attempt establishes that the operation did not apply; its
      // recorded outcome is not read, because there is nothing to recover.
      reject(failure);
      return;
    }
    const recorded = request.recorded;
    if (recorded !== undefined) {
      let recovered: RecordedOutcome<Record>;
      let recordedFailure: UserCardsOperationFailure | null = null;
      try {
        recovered = await recorded(signal);
      } catch (cause) {
        recovered = { state: 'unknown' };
        recordedFailure = readFailure(cause);
      }
      if (disposed || current !== generation) {
        return;
      }
      if (recovered.state === 'committed') {
        commit(recovered.record);
        return;
      }
      if (recovered.state === 'rejected') {
        reject(recovered.failure);
        return;
      }
      if (recordedFailure !== null) {
        // Neither the dispatch nor the recorded outcome reported: the operation stays open, and
        // the failure the recovery reported describes why.
        uncertain = true;
        outcome = { state: 'unknown', failure: recordedFailure };
        return;
      }
    }
    if (refused) {
      // A refused retry does not establish an earlier uncertain attempt: its identity and input
      // stay retained until an authoritative read or the owner resolves it
      // (docs/user-cards.md#browser-operation-lifecycle).
      outcome = { state: 'unknown', failure };
      return;
    }
    uncertain = true;
    outcome = { state: 'unknown', failure };
  }

  /** Reads the operation's recorded outcome through its operation identity. */
  async function readRecorded(
    signal: AbortSignal | undefined,
  ): Promise<UserCardsOperationOutcome<Record>> {
    const recorded = request.recorded;
    if (recorded === undefined || disposed || outcome.state === 'committed') {
      return outcome;
    }
    const current = (generation += 1);
    outcome = { state: 'pending' };
    startWaiting();
    try {
      const recovered = await recorded(signal ?? request.signal);
      if (!disposed && current === generation) {
        if (recovered.state === 'committed') {
          commit(recovered.record);
        } else if (recovered.state === 'rejected') {
          reject(recovered.failure);
        } else {
          uncertain = true;
          outcome = { state: 'unknown', failure: null };
        }
      }
    } catch (cause) {
      if (!disposed && current === generation) {
        uncertain = true;
        outcome = { state: 'unknown', failure: readFailure(cause) };
      }
    }
    if (!disposed && current === generation) {
      finishWaiting();
    }
    return outcome;
  }

  /** Applies one committed record: the outcome, the invalidation and the related releases. */
  function commit(record: Record): void {
    outcome = { state: 'committed', record };
    uncertain = false;
    request.settled?.(record);
    emit(request.change(record));
    established();
  }

  /** Applies one definite refusal of an attempt whose earlier outcome was not uncertain. */
  function reject(failure: UserCardsOperationFailure): void {
    outcome = { state: 'rejected', failure };
    established();
  }

  function startWaiting(): void {
    const superseded = waiting;
    waiting = Promise.withResolvers<void>();
    superseded?.resolve();
  }

  function finishWaiting(): void {
    const open = waiting;
    waiting = null;
    open?.resolve();
  }
}

/** One committed tag change: the tag whose label or kind may have changed. */
function tagChange(result: TagChangeResult): UserCardsChange {
  return {
    scope: 'tags',
    records: [{ kind: 'tag', tagId: result.tag.tagId }],
    imports: [],
    position: result.publicationPosition,
  };
}

/** One committed association change: the association and its membership or quantity. */
function associationChange(result: AssociationChangeResult): UserCardsChange {
  return {
    scope: 'associations',
    records: [{ kind: 'association', associationId: result.association.associationId }],
    imports: [],
    position: result.publicationPosition,
  };
}

/** One committed confirmation: the created copies and the import they leave. */
function confirmedChange(receipt: ImportReceipt): UserCardsChange {
  return {
    scope: 'copies',
    records: receipt.copies.map((copy) => ({ kind: 'copy', copyId: copy.copyId })),
    imports: [receipt.sessionId],
    position: receipt.publicationPosition,
  };
}

/** One committed pending-import change: the import whose entries may have changed. */
function importChange(sessionId: ImportSessionId): UserCardsChange {
  return { scope: 'imports', records: [], imports: [sessionId], position: null };
}

/** The failure one confirmation reports when the provider records no outcome for it. */
const confirmationAbsent: UserCardsOperationFailure = {
  code: 'not-found',
  message: 'This confirmation is not recorded; no copies were created.',
};

/** Definite refusals that establish the operation did not apply. */
function isRejectedCode(code: string): boolean {
  return (
    code === 'conflict' ||
    code === 'invalid-request' ||
    code === 'unsupported-query' ||
    code === 'not-found' ||
    code === 'unauthorized' ||
    code === 'route-not-found' ||
    code === 'method-not-allowed'
  );
}

/** The failure one rejected operation reported, or an unknown outcome without one. */
function readFailure(cause: unknown): UserCardsOperationFailure {
  const code = readObject(cause)?.code;
  return {
    code: typeof code === 'string' && code.length > 0 ? code : null,
    message:
      cause instanceof Error && cause.message.length > 0
        ? cause.message
        : 'The operation did not report an outcome.',
  };
}

/** One identity of a new import, attempt, confirmation or change of this contract. */
function usercardsIdentity(family: string): string {
  serial += 1;
  const stamp = Date.now().toString(36);
  const noise = Math.random().toString(36).slice(2, 8);
  return `${family}-${stamp}-${serial.toString(36)}-${noise}`;
}

let serial = 0;

/** The operations this deployment enables: the supplied set, or everything the client serves. */
function readAvailable(
  value: readonly UserCardsBrowserOperation[] | undefined,
  client: UserCardsBrowserClient,
): readonly UserCardsBrowserOperation[] {
  const served = usercardsBrowserOperations.filter(
    (operation) => typeof (client as unknown as Record<string, unknown>)[operation] === 'function',
  );
  if (value === undefined) {
    return served;
  }
  const enabled: UserCardsBrowserOperation[] = [];
  for (const operation of value) {
    if (!usercardsBrowserOperations.includes(operation)) {
      throw new TypeError(`Unknown UserCards browser operation ${String(operation)}.`);
    }
    if (!served.includes(operation)) {
      throw new TypeError(`The UserCards client does not serve the ${operation} operation.`);
    }
    if (!enabled.includes(operation)) {
      enabled.push(operation);
    }
  }
  return enabled;
}

/** The request one source import dispatches under the identity of its unfinished attempt. */
function sourceRequest(
  input: UserCardsSourceImportRequest,
  sessionId: string,
): StageSourceImportInput {
  switch (input.format) {
    case 'pasted-list':
      return { format: input.format, sessionId, text: input.text };
    case 'moxfield':
      return { format: input.format, sessionId, url: input.url };
    case 'wizards-precon':
      return {
        format: input.format,
        sessionId,
        sourceId: input.sourceId,
        reference: input.reference,
        entries: input.entries,
      };
  }
}

/** The identity one staged batch carries: its session and the entry identities it stages. */
function entriesIdentity(input: StageImportEntriesInput): string {
  return `entries ${input.sessionId} ${input.entries.map((entry) => entry.entryId).join(' ')}`;
}

/** The identity of one source input, so a resumed import is found without matching the contents. */
function sourceIdentity(input: UserCardsSourceImportRequest): string {
  switch (input.format) {
    case 'pasted-list':
      return `pasted-list ${input.text}`;
    case 'moxfield':
      return `moxfield ${input.url}`;
    case 'wizards-precon':
      return `wizards-precon ${input.sourceId} ${input.reference} ${JSON.stringify(input.entries)}`;
  }
}

/** The capture identity of one observation: its session and capture. */
function captureIdentity(input: StageCaptureInput): string {
  return `capture ${input.sessionId} ${input.captureId}`;
}

/** The identity of one confirmation: the import session and the entries it covers. */
function confirmationIdentity(input: UserCardsConfirmationRequest): string {
  return `confirmation ${input.sessionId} ${input.entries.map((entry) => entry.entryId).join(' ')}`;
}

/** One stored attempt as it is kept for a reload. */
interface StoredAttempt {
  readonly kind: UserCardsRetainedKind;
  readonly identity: string;
  readonly operationId: string;
  readonly input: unknown;
}

/** Prefix of the session-storage entry one account's unfinished attempts live under. */
const storagePrefix = 'keeper.usercards.attempts.';

/** True for one of the operations whose attempt one account retains. */
function isRetainedOperation(value: unknown): value is UserCardsRetainedKind {
  return (
    value === 'stageImportEntries' ||
    value === 'stageSourceImport' ||
    value === 'stageCaptureObservation' ||
    value === 'confirmImport'
  );
}

/** The unfinished attempts one account stored, validated when they are read back. */
function readStoredAttempts(
  storage: UserCardsAttemptStorage | null,
  accountId: string,
): StoredAttempt[] {
  const raw = readStored(storage, `${storagePrefix}${accountId}`);
  if (raw === null) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const attempts: StoredAttempt[] = [];
  for (const value of parsed) {
    const record = readObject(value);
    const kind = record?.kind;
    const identityText = record?.identity;
    const operationId = record?.operationId;
    if (
      !isRetainedOperation(kind) ||
      !isText(identityText) ||
      !isText(operationId) ||
      !isStoredInput(kind, record?.input)
    ) {
      continue;
    }
    attempts.push({ kind, identity: identityText, operationId, input: record?.input });
  }
  return attempts;
}

/** Keeps one account's unfinished attempts under its own storage entry. */
function keepStoredAttempts(
  storage: UserCardsAttemptStorage | null,
  accountId: string,
  attempts: readonly StoredAttempt[],
): void {
  if (storage === null) {
    return;
  }
  try {
    if (attempts.length === 0) {
      storage.removeItem(`${storagePrefix}${accountId}`);
      return;
    }
    storage.setItem(`${storagePrefix}${accountId}`, JSON.stringify(attempts));
  } catch {
    // Storage that refuses the record keeps the in-memory attempts only.
  }
}

/** Releases every unfinished attempt one account kept. */
function releaseStoredAttempts(storage: UserCardsAttemptStorage | null, accountId: string): void {
  try {
    storage?.removeItem(`${storagePrefix}${accountId}`);
  } catch {
    // Storage the context refuses keeps nothing this facade can release.
  }
}

/** One storage value, or null when the context refuses the read. */
function readStored(storage: UserCardsAttemptStorage | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Whether one stored input is one this facade wrote for the operation it is kept with. */
function isStoredInput(kind: UserCardsRetainedKind, value: unknown): boolean {
  switch (kind) {
    case 'stageImportEntries':
      return readStageEntries(value) !== null;
    case 'stageSourceImport':
      return readSourceImport(value) !== null;
    case 'stageCaptureObservation':
      return readCapture(value) !== null;
    case 'confirmImport':
      return readConfirmation(value) !== null;
  }
}

/** One staged-lines input, or null when the stored value is not one. */
function readStageEntries(value: unknown): StageImportEntriesInput | null {
  const record = readObject(value);
  const source = readObject(record?.source);
  return record !== null &&
    isText(record.sessionId) &&
    source !== null &&
    isText(source.kind) &&
    isText(source.id) &&
    Array.isArray(record.entries)
    ? (value as StageImportEntriesInput)
    : null;
}

/** One source input, or null when the stored value is not one. */
function readSourceImport(value: unknown): UserCardsSourceImportRequest | null {
  const record = readObject(value);
  switch (record?.format) {
    case 'pasted-list':
      return isText(record.text) ? { format: 'pasted-list', text: record.text } : null;
    case 'moxfield':
      return isText(record.url) ? { format: 'moxfield', url: record.url } : null;
    case 'wizards-precon':
      return isText(record.sourceId) && isText(record.reference) && Array.isArray(record.entries)
        ? {
            format: 'wizards-precon',
            sourceId: record.sourceId,
            reference: record.reference,
            entries: record.entries as ReviewedWizardsLine[],
          }
        : null;
    default:
      return null;
  }
}

/** One capture observation, or null when the stored value is not one. */
function readCapture(value: unknown): StageCaptureInput | null {
  const record = readObject(value);
  return record !== null && isText(record.sessionId) && isText(record.captureId)
    ? (value as StageCaptureInput)
    : null;
}

/** One confirmation input, or null when the stored value is not one. */
function readConfirmation(value: unknown): UserCardsConfirmationRequest | null {
  const record = readObject(value);
  return record !== null && isText(record.sessionId) && Array.isArray(record.entries)
    ? (value as UserCardsConfirmationRequest)
    : null;
}

/** One account identity, which scopes the attempts it owns. */
function readIdentityText(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('A UserCards operation scope names its account.');
  }
  return value;
}

function readObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
