/**
 * The UserCards browser operation facade (docs/user-cards.md#browser-operation-lifecycle,
 * docs/application.md#interface).
 *
 * The facade is part of this component and owns what a browser operation needs beyond one request:
 * it begins an operation under its account-scoped identity, retains the attempt while the provider
 * has not established its outcome, observes it without cancelling the server commit, recovers the
 * recorded outcome under the operation's documented identity, retries explicitly where the
 * operation's own semantics make a repeat safe, and publishes the local committed-change
 * invalidations a consumer reloads from. A revision-bound change has no recorded outcome to read:
 * its recovery is the record read the consumer performs through the published read operations, and
 * the facade keeps its attempt for the explicit retry that quotes the same identity and revision.
 * Confirmation uses its recorded receipt and staging operations use the provider's replay of the
 * identity they carry; an operation the provider gives a fresh identity per call keeps its
 * uncertain outcome for the consumer's reconciliation instead. No write is turned into a blind
 * automatic retry or an offline command queue (docs/user-cards.md#persistence-and-recovery).
 *
 * Attempt state is the minimum the existing import and recovery guarantees need, and it belongs to
 * one account: a scope keeps the unfinished attempts of the account it was created for, releases
 * them when that account ends, and reads back only records it wrote and can validate. An operation
 * that lost its response keeps its identity and input, so resuming never infers a new import from
 * matching contents or source URLs, and a submission that reuses a retained attempt's identity with
 * different input conflicts instead of replaying the older values. An established outcome, a
 * recorded absence or an explicitly discarded import releases the attempt. Only a committed outcome
 * — acknowledged or recovered — emits an invalidation, so a lost response never reports speculative
 * success.
 *
 * Ending an account's scope fences everything that scope owned: reads refuse instead of reaching the
 * transport a replacement account serves, subscriptions end, and no handle of the ended account
 * dispatches again, whether it is retained or transient, established or still in flight. The scope
 * is released when the composition that supplies it reports that the account ended
 * (docs/architecture.md#runtime-boundaries), and a later access composes a fresh scope for the
 * account.
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

/**
 * How safely one operation may be dispatched again under its identity
 * (docs/user-cards.md#browser-operation-lifecycle):
 *
 * - `recorded`: the provider records the identity and replays the outcome it recorded for it, so
 *   repeating the same input returns that outcome instead of applying the operation twice.
 * - `guarded`: the operation quotes the revision it started from, or only adds what the provider
 *   does not hold yet, so a repeat cannot double-apply.
 * - `none`: the provider composes a fresh identity for every call, so an uncertain attempt stays
 *   explicit for the consumer's own reconciliation instead of composing a second record.
 */
type UserCardsRetryPolicy = 'recorded' | 'guarded' | 'none';

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
  /**
   * Dispatches the same input again under the same identity, when the operation's documented
   * semantics make that safe. An established outcome stays what this handle reports, an operation
   * the provider gives no identity per call keeps its uncertain outcome, and an attempt still in
   * flight coalesces with the dispatch already running (docs/user-cards.md#browser-operation-lifecycle).
   */
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
  /**
   * Ends one account's scope: its retained attempts, its subscriptions and its outstanding handles
   * are disposed, so nothing of that account reaches the transport a replacement account serves. A
   * later access composes a fresh scope for the same account
   * (docs/architecture.md#runtime-boundaries).
   */
  release(accountId: string): void;
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
   * Begins one new import: the provider composes a fresh import identity for it, even when another
   * import of this account holds identical contents or names the same source
   * (docs/user-cards.md#import-state-and-identity).
   */
  beginSourceImport(
    input: UserCardsSourceImportRequest,
    signal?: AbortSignal,
  ): UserCardsOperation<'stageSourceImport', SourceImportResult>;
  /**
   * Reopens the import one provider-owned identity names. An unfinished attempt this account still
   * retains under that identity is retried with its own input; any other identity reconciles that
   * import's source again under the same identity instead of beginning another import
   * (docs/user-cards.md#source-imports). Input that differs from a retained attempt's own input
   * conflicts instead of reporting the retained input's outcome.
   */
  reopenSourceImport(
    operationId: string,
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
  /**
   * Ends this account's scope: its retained attempts, subscriptions and outstanding handles are
   * disposed and its reads and dispatches refuse; a later access composes a fresh scope.
   */
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
    release(accountId) {
      // Only an account whose scope this facade composed has anything to release; a later access
      // composes a fresh scope, so the account stays usable after it signs in again.
      accounts.get(readIdentityText(accountId))?.release();
    },
  };

  function createAccountScope(accountId: string): UserCardsAccountOperations {
    /** Unfinished attempts of this account, in the order they were begun. */
    const attempts = new Map<string, Attempt<string, unknown>>();
    /** Every attempt of this scope whose outcome is not established, retained or transient. */
    const outstanding = new Set<Attempt<string, unknown>>();
    const listeners = new Set<(change: UserCardsChange) => void>();
    let released = false;

    /**
     * Tracks one attempt and publishes the committed changes it establishes. A begun or reattached
     * attempt stays in the account's scope until its outcome is established; a transient attempt of
     * one revision-bound change leaves no resumable state.
     */
    function tracked<Kind extends string, Record>(
      request: AttemptRequest<Kind, Record>,
      mode: 'begin' | 'reattach' | 'transient' | 'refused' = 'transient',
    ): Attempt<Kind, Record> {
      const attempt = createAttempt(request, emit, () => {
        // An established outcome is nothing to resume: the attempt leaves the account's scope so a
        // later submission of the same input composes an operation of its own
        // (docs/user-cards.md#import-state-and-identity).
        outstanding.delete(attempt as unknown as Attempt<string, unknown>);
        if (
          attempts.get(attempt.operationId) === (attempt as unknown as Attempt<string, unknown>)
        ) {
          attempts.delete(attempt.operationId);
          writeStoredAttempts();
        }
      });
      if (mode === 'refused') {
        // An attempt this facade refuses before dispatch belongs to no scope state at all.
        return attempt;
      }
      outstanding.add(attempt as unknown as Attempt<string, unknown>);
      if (mode !== 'transient') {
        attempts.set(attempt.operationId, attempt as unknown as Attempt<string, unknown>);
      }
      if (mode === 'begin') {
        // The identity and input are kept before the request is dispatched, so a lost response or
        // a reload still resumes this operation instead of composing another one.
        writeStoredAttempts();
      }
      if (mode !== 'reattach') {
        void attempt.dispatch(request.signal);
      }
      return attempt;
    }

    for (const record of readStoredAttempts(storage, accountId)) {
      reattach(record);
    }

    const scope: UserCardsAccountOperations = {
      constraints,
      readCopies: (copyIds, signal) => guarded(() => client.readCopies(copyIds, signal)),
      listTags: (options, signal) => guarded(() => client.listTags(options, signal)),
      readTags: (tagIds, signal) => guarded(() => client.readTags(tagIds, signal)),
      listAssociations: (tagId, options, signal) =>
        guarded(() => client.listAssociations(tagId, options, signal)),
      readAssociations: (associationIds, signal) =>
        guarded(() => client.readAssociations(associationIds, signal)),
      listImportSessions: (options, signal) =>
        guarded(() => client.listImportSessions(options, signal)),
      listImportEntries: (input, signal) => guarded(() => client.listImportEntries(input, signal)),

      stageImportEntries(input, signal) {
        requireAvailable('stageImportEntries');
        return resumeOrBegin<'stageImportEntries', ImportStageResult>({
          kind: 'stageImportEntries',
          identity: entriesIdentity(input),
          input,
          signal,
          begin: (operationId) => ({
            kind: 'stageImportEntries',
            identity: entriesIdentity(input),
            operationId,
            input,
            signal,
            run: (callSignal) => client.stageImportEntries(input, callSignal),
            change: (result) => importChange(result.session.sessionId),
            retry: 'recorded',
          }),
        }).handle;
      },

      beginSourceImport(input, signal) {
        requireAvailable('stageSourceImport');
        // A new import composes an identity of its own: identical contents or the same source URL
        // never merge two imports (docs/user-cards.md#import-state-and-identity).
        return tracked(sourceAttempt(input, identity('attempt'), signal), 'begin').handle;
      },

      reopenSourceImport(operationId, input, signal) {
        requireAvailable('stageSourceImport');
        const id = readIdentityText(operationId);
        const retained = attempts.get(id);
        if (retained !== undefined && retained.kind === 'stageSourceImport') {
          if (!sameInput(retained.input, input)) {
            // The identity is retained for the input it was begun with: changed input under it
            // conflicts instead of reporting that input's outcome
            // (docs/user-cards.md#import-state-and-identity).
            return refusedAttempt<'stageSourceImport', SourceImportResult>(
              'stageSourceImport',
              id,
              input,
              reuseConflict,
            ).handle;
          }
          void retained.dispatch(signal);
          return retained.handle as unknown as UserCardsOperation<
            'stageSourceImport',
            SourceImportResult
          >;
        }
        // The consumer carries the identity of an existing import, so re-reading that import needs
        // no retained attempt; a lost response is re-read under the same identity again.
        return tracked(sourceAttempt(input, id, signal), 'transient').handle;
      },

      stageCaptureObservation(input, signal) {
        requireAvailable('stageCaptureObservation');
        return resumeOrBegin<'stageCaptureObservation', CaptureStageResult>({
          kind: 'stageCaptureObservation',
          identity: captureIdentity(input),
          input,
          signal,
          begin: () => ({
            kind: 'stageCaptureObservation',
            identity: captureIdentity(input),
            operationId: input.captureId,
            input,
            signal,
            run: (callSignal) => client.stageCaptureObservation(input, callSignal),
            change: (result) => importChange(result.session.sessionId),
            retry: 'recorded',
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
          retry: 'guarded',
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
          // Alternatives only add what the entry does not hold yet, so a repeat cannot duplicate.
          retry: 'guarded',
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
          retry: 'guarded',
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
          retry: 'guarded',
        }).handle;
      },

      confirmImport(input, signal) {
        requireAvailable('confirmImport');
        return resumeOrBegin<'confirmImport', UserCardsConfirmationOutcome>({
          kind: 'confirmImport',
          identity: confirmationIdentity(input),
          input,
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
            retry: 'recorded',
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
          retry: 'guarded',
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
          // The provider composes a fresh tag identity per call: an uncertain creation is never
          // dispatched again, because that would compose a second tag
          // (docs/user-cards.md#browser-operation-lifecycle).
          retry: 'none',
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
          retry: 'guarded',
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
          // The provider composes a fresh association identity per call: an uncertain creation is
          // never dispatched again, because that could associate the target a second time.
          retry: 'none',
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
          retry: 'guarded',
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
          retry: 'guarded',
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
        requireLive();
        listeners.add(listener);
        return () => listeners.delete(listener);
      },

      release() {
        released = true;
        // Every handle of this account is fenced, not only the retained ones: a transient change
        // still in flight belongs to this account as well and must not report into the next one.
        for (const attempt of outstanding) {
          attempt.dispose();
        }
        outstanding.clear();
        attempts.clear();
        listeners.clear();
        releaseStoredAttempts(storage, accountId);
        if (accounts.get(accountId) === scope) {
          // A released scope is not handed out again: signing back in composes a fresh one.
          accounts.delete(accountId);
        }
      },
    };
    return scope;

    /**
     * Reattaches to an unfinished attempt of the same operation and input, or begins one. The
     * caller's explicit submission is the retry: a retained attempt is dispatched again under its
     * own identity instead of composing a second import, capture or confirmation. The same
     * identity submitted with different input conflicts instead, so the provider never reports an
     * outcome for values the caller no longer presents
     * (docs/user-cards.md#import-state-and-identity).
     */
    function resumeOrBegin<Kind extends string, Record>(options: {
      readonly kind: Kind;
      readonly identity: string;
      readonly input: unknown;
      readonly signal: AbortSignal | undefined;
      begin(operationId: string): AttemptRequest<Kind, Record>;
    }): Attempt<Kind, Record> {
      for (const attempt of attempts.values()) {
        if (attempt.kind === options.kind && attempt.identity === options.identity) {
          if (!sameInput(attempt.input, options.input)) {
            return refusedAttempt<Kind, Record>(
              options.kind,
              attempt.operationId,
              options.input,
              reuseConflict,
            );
          }
          void attempt.dispatch(options.signal);
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
                retry: 'recorded',
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
              retry: 'recorded',
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
                retry: 'recorded',
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
              retry: 'recorded',
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

    /**
     * The tracked attempt one source input dispatches under its import identity. The identity is
     * the import's own, so the provider reconciles the source lines with what that import already
     * holds instead of inferring an import from the contents or the source URL
     * (docs/user-cards.md#source-imports).
     */
    function sourceAttempt(
      input: UserCardsSourceImportRequest,
      operationId: string,
      signal: AbortSignal | undefined,
    ): AttemptRequest<'stageSourceImport', SourceImportResult> {
      return {
        kind: 'stageSourceImport',
        identity: operationId,
        operationId,
        input,
        signal,
        run: (callSignal) =>
          client.stageSourceImport(sourceRequest(input, operationId), callSignal),
        change: (result) => importChange(result.session.sessionId),
        retry: 'recorded',
      };
    }

    /**
     * One attempt that never dispatches: the identity it names is retained for different input, so
     * the facade reports the conflict that reuse establishes instead of the retained input's
     * outcome or a second record (docs/user-cards.md#import-state-and-identity).
     */
    function refusedAttempt<Kind extends string, Record>(
      kind: Kind,
      operationId: string,
      input: unknown,
      failure: UserCardsOperationFailure,
    ): Attempt<Kind, Record> {
      return tracked<Kind, Record>(
        { kind, identity: operationId, operationId, input, refused: failure },
        'refused',
      );
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

    /**
     * Writes every unfinished attempt of the account. An unresolved attempt keeps the identity and
     * input a reload needs, so none of them is silently evicted
     * (docs/user-cards.md#browser-operation-lifecycle); storage that refuses a record keeps the
     * attempts in memory only.
     */
    function writeStoredAttempts(): void {
      if (released) {
        return;
      }
      keepStoredAttempts(
        storage,
        accountId,
        [...attempts.values()].map((attempt) => ({
          kind: attempt.kind as UserCardsRetainedKind,
          identity: attempt.identity,
          operationId: attempt.operationId,
          input: attempt.input,
        })),
      );
    }

    function requireAvailable(operation: UserCardsBrowserOperation): void {
      requireLive();
      if (!operations.includes(operation)) {
        throw new Error(`The ${operation} operation is not enabled in this deployment.`);
      }
    }

    /** Refuses one call of a scope whose account has ended. */
    function requireLive(): void {
      if (released) {
        throw accountEnded();
      }
    }

    /** One read of this scope, refused rather than sent once the account has ended. */
    function guarded<Result>(read: () => Promise<Result>): Promise<Result> {
      if (released) {
        return Promise.reject(accountEnded());
      }
      return read();
    }
  }
}

/** The refusal a released scope reports instead of working for the account that replaced it. */
function accountEnded(): Error {
  return new Error('The account this operation belongs to has ended.');
}

/** The refusal that one retained identity reports for input it was not begun with. */
const reuseConflict: UserCardsOperationFailure = {
  code: 'conflict',
  message:
    'An unfinished attempt retains this identity for different input. Retry it with its own ' +
    'values, or resolve it before submitting changed ones.',
};

/** One tracked operation of one account. */
interface Attempt<Kind extends string, Record> {
  readonly kind: Kind;
  readonly identity: string;
  readonly operationId: string;
  readonly input: unknown;
  readonly handle: UserCardsOperation<Kind, Record>;
  /** Dispatches the attempt itself, without the retry policy the consumer's explicit retry obeys. */
  dispatch(signal: AbortSignal | undefined): Promise<UserCardsOperationOutcome<Record>>;
  dispose(): void;
}

/** One operation to track, before the account's invalidation sink is attached. */
interface AttemptRequest<Kind extends string, Record> {
  readonly kind: Kind;
  /** Identity of the input the attempt replays; a caller resubmitting it resumes this attempt. */
  readonly identity: string;
  readonly operationId: string;
  readonly input: unknown;
  /** Dispatches the operation; absent only for one this facade refuses before dispatch. */
  run?(signal: AbortSignal | undefined): Promise<Record>;
  /** Reads the operation's recorded outcome, when the contract defines one. */
  recorded?(signal: AbortSignal | undefined): Promise<RecordedOutcome<Record>>;
  /** How safely this operation may be dispatched again; see `UserCardsRetryPolicy`. */
  readonly retry?: UserCardsRetryPolicy;
  /** The refusal this attempt already establishes, so it never dispatches. */
  readonly refused?: UserCardsOperationFailure;
  /** The committed-change invalidation of the operation; absent for a refused attempt. */
  readonly change?: (record: Record) => UserCardsChange;
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
    request.refused !== undefined
      ? { state: 'rejected', failure: request.refused }
      : request.reattached === true
        ? { state: 'unknown', failure: null }
        : { state: 'pending' };
  let generation = 0;
  // A reattached attempt never reported: what the provider has established for it is unknown.
  let uncertain = request.reattached === true;
  let disposed = false;
  let waiting: PromiseWithResolvers<void> | null = null;
  /** The dispatch or recorded read already running; a further call observes it instead of racing it. */
  let running: Promise<UserCardsOperationOutcome<Record>> | null = null;

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
      return request.retry === 'recorded' ? dispatch(signal) : Promise.resolve(outcome);
    },
    retry: (signal: AbortSignal | undefined) => {
      if (outcome.state === 'committed' || outcome.state === 'rejected') {
        // An established outcome is what this handle reports; a later call never replaces it with
        // another attempt's answer (docs/user-cards.md#browser-operation-lifecycle).
        return Promise.resolve(outcome);
      }
      if (request.retry === 'none') {
        // The provider composes a fresh identity for every call, so an uncertain creation stays
        // explicit for the consumer to reconcile by reading the records it may have created.
        return Promise.resolve(outcome);
      }
      return dispatch(signal);
    },
  } as unknown as UserCardsOperation<Kind, Record>;
  const attempt: Attempt<Kind, Record> = {
    kind: request.kind,
    identity: request.identity,
    operationId: request.operationId,
    input: request.input,
    handle,
    dispatch,
    dispose() {
      disposed = true;
      generation += 1;
      if (outcome.state === 'pending') {
        // A deferred dispatch no longer reports into this attempt: what it may have applied stays
        // open instead of being presented as established
        // (docs/user-cards.md#browser-operation-lifecycle).
        outcome = { state: 'unknown', failure: null };
      }
      finishWaiting();
    },
  };
  return attempt;

  /** Dispatches one call, under the attempt's identity and with the caller's signal. */
  function dispatch(signal: AbortSignal | undefined): Promise<UserCardsOperationOutcome<Record>> {
    if (disposed || outcome.state === 'committed' || outcome.state === 'rejected') {
      // An ended scope disposes its attempts, an established outcome stays what this handle
      // reports, and a resolved identity is nothing left to dispatch: none of them sends a request.
      return Promise.resolve(outcome);
    }
    const run = request.run;
    if (run === undefined) {
      return Promise.resolve(outcome);
    }
    // One attempt dispatches at most one request at a time: a call made while the attempt is in
    // flight observes that dispatch instead of racing it with a second one, so an authoritative
    // result is never discarded by a later refusal (docs/user-cards.md#browser-operation-lifecycle).
    const open = running;
    if (open !== null) {
      return open;
    }
    // The slot is filled before the dispatch can finish, so it is released only by the dispatch
    // that owns it and a later call starts a dispatch of its own.
    const slot: { promise: Promise<UserCardsOperationOutcome<Record>> | null } = { promise: null };
    const started = perform(run, signal, slot);
    slot.promise = started;
    running = started;
    return started;
  }

  /** Runs one dispatch to its outcome and releases the attempt for a later explicit retry. */
  async function perform(
    run: (signal: AbortSignal | undefined) => Promise<Record>,
    signal: AbortSignal | undefined,
    slot: { promise: Promise<UserCardsOperationOutcome<Record>> | null },
  ): Promise<UserCardsOperationOutcome<Record>> {
    const current = (generation += 1);
    outcome = { state: 'pending' };
    startWaiting();
    try {
      const record = await run(signal ?? request.signal);
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
    if (running === slot.promise) {
      running = null;
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
    const open = running;
    if (open !== null) {
      // A dispatch of this attempt is still in flight: recovering observes what it establishes
      // instead of racing it with a read whose answer could predate that dispatch
      // (docs/user-cards.md#browser-operation-lifecycle).
      return open;
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
    const change = request.change;
    if (change !== undefined) {
      emit(change(record));
    }
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

/**
 * Whether one submitted input is the same value as another. An identity that does not quote its
 * input compares it structurally, so changed values conflict instead of replaying the older ones
 * (docs/user-cards.md#import-state-and-identity).
 */
function sameInput(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameInput(value, right[index]))
    );
  }
  const leftObject = readObject(left);
  const rightObject = readObject(right);
  if (leftObject === null || rightObject === null) {
    return false;
  }
  const keys = Object.keys(leftObject);
  return (
    keys.length === Object.keys(rightObject).length &&
    keys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(rightObject, key) &&
        sameInput(leftObject[key], rightObject[key]),
    )
  );
}

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
