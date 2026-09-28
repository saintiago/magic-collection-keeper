/**
 * Import staging, review and confirmation of the Import page
 * (docs/user-interface.md#capture-and-review, docs/user-interface.md#source-imports,
 * docs/user-cards.md#browser-operation-lifecycle).
 *
 * The page stages manual lines and parsed sources as pending entries, reviews a pending entry's
 * printing, finish, condition and quantity under the revision it read, discards entries and
 * confirms the reviewed entries; Capture stages the camera observations and their later
 * alternatives through its own binding (docs/capture.md#interface). Every change is a UserCards
 * operation: the provider-owned handle reports whether it committed, was rejected or stays unknown,
 * retains the identity an unfinished attempt needs, and recovers a recorded outcome under that
 * identity. The page presents those outcomes; it never classifies a failure, invents an operation
 * identity or infers that a lost response committed. Nothing here reports ownership: a staged
 * line, source row or capture is a candidate in review, and only a confirmation creates the
 * physical copies.
 */

import type { Finish } from '../../../catalog/index.js';
import type {
  UserCardsAccountOperations,
  UserCardsConfirmationRequest,
  UserCardsConfirmationOutcome,
  UserCardsConstraints,
  UserCardsOperation,
  UserCardsOperationOutcome,
  UserCardsRetainedAttempt,
  UserCardsSourceImportRequest,
} from '../../../usercards/browser.js';
import type {
  CopyCondition,
  DiscardImportEntryInput,
  DiscardImportSessionInput,
  ImportCandidate,
  ImportEntry,
  ImportEntryChangeResult,
  ImportEntryId,
  ImportEntryListResult,
  ImportReceipt,
  ImportSessionChange,
  ImportSessionListResult,
  ImportStageResult,
  ListImportEntriesOptions,
  ListImportSessionsOptions,
  ReviewImportEntryInput,
  SourceImportResult,
  StageImportEntriesInput,
} from '../../../usercards/index.js';

import { commitUiOperation, type UiChangeCommit } from './failure.js';

/**
 * The private import operations the Import page presents. It is the narrow part of the UserCards
 * browser contract this page uses, so a consumer depends only on the capabilities it presents
 * (docs/architecture.md#composition-and-replacement).
 */
export type UiImportClient = Pick<
  UserCardsAccountOperations,
  | 'listImportSessions'
  | 'listImportEntries'
  | 'stageImportEntries'
  | 'beginSourceImport'
  | 'reopenSourceImport'
  | 'reviewImportEntry'
  | 'discardImportEntry'
  | 'discardImportSession'
  | 'confirmImport'
  | 'retained'
  | 'resume'
  | 'constraints'
>;

/** Private pending-import access of the Import page, over the provider-owned operation handles. */
export interface UiImportAccess {
  /** Input constraints and operation availability the page presents. */
  readonly constraints: UserCardsConstraints;
  /** One bounded page of the account's pending import sessions. */
  sessions(
    options?: ListImportSessionsOptions,
    signal?: AbortSignal,
  ): Promise<ImportSessionListResult>;
  /** One bounded page of one session's pending entries, in capture order. */
  entries(input: ListImportEntriesOptions, signal?: AbortSignal): Promise<ImportEntryListResult>;
  stage(
    input: StageImportEntriesInput,
    signal?: AbortSignal,
  ): UserCardsOperation<'stageImportEntries', ImportStageResult>;
  /** One new import: what each of its source rows became, under an identity of its own. */
  beginSource(
    input: UserCardsSourceImportRequest,
    signal?: AbortSignal,
  ): UserCardsOperation<'stageSourceImport', SourceImportResult>;
  /** One existing import, reopened under the provider-owned identity it is known by. */
  reopenSource(
    operationId: string,
    input: UserCardsSourceImportRequest,
    signal?: AbortSignal,
  ): UserCardsOperation<'stageSourceImport', SourceImportResult>;
  review(
    input: ReviewImportEntryInput,
    signal?: AbortSignal,
  ): UserCardsOperation<'reviewImportEntry', ImportEntryChangeResult>;
  discardEntry(
    input: DiscardImportEntryInput,
    signal?: AbortSignal,
  ): UserCardsOperation<'discardImportEntry', ImportEntryChangeResult>;
  discardSession(
    input: DiscardImportSessionInput,
    signal?: AbortSignal,
  ): UserCardsOperation<'discardImportSession', ImportSessionChange>;
  /** Confirms reviewed entries under a new operation identity, or resumes a retained one. */
  confirm(
    input: UserCardsConfirmationRequest,
    signal?: AbortSignal,
  ): UserCardsOperation<'confirmImport', UserCardsConfirmationOutcome>;
  /** Unfinished attempts the account retains, oldest first. */
  retained(): readonly UserCardsRetainedAttempt[];
  /** Reattaches to one retained attempt, or null when the account retains none with it. */
  resume(operationId: string): UserCardsRetainedAttempt | null;
}

/** Builds the import access over the account-scoped UserCards operations. */
export function createImportAccess(userCards: UiImportClient): UiImportAccess {
  for (const operation of [
    'listImportSessions',
    'listImportEntries',
    'stageImportEntries',
    'beginSourceImport',
    'reopenSourceImport',
    'reviewImportEntry',
    'discardImportEntry',
    'discardImportSession',
    'confirmImport',
    'retained',
    'resume',
  ] as const) {
    if (typeof userCards?.[operation] !== 'function') {
      throw new TypeError('The Import page reads and changes pending imports through UserCards.');
    }
  }
  if (userCards.constraints === undefined) {
    throw new TypeError('The Import page presents the constraints UserCards publishes.');
  }
  return {
    constraints: userCards.constraints,
    sessions: (options, signal) => userCards.listImportSessions(options, signal),
    entries: (input, signal) => userCards.listImportEntries(input, signal),
    stage: (input, signal) => userCards.stageImportEntries(input, signal),
    beginSource: (input, signal) => userCards.beginSourceImport(input, signal),
    reopenSource: (operationId, input, signal) =>
      userCards.reopenSourceImport(operationId, input, signal),
    review: (input, signal) => userCards.reviewImportEntry(input, signal),
    discardEntry: (input, signal) => userCards.discardImportEntry(input, signal),
    discardSession: (input, signal) => userCards.discardImportSession(input, signal),
    confirm: (input, signal) => userCards.confirmImport(input, signal),
    retained: () => userCards.retained(),
    resume: (operationId) => userCards.resume(operationId),
  };
}

/**
 * Display name of the source one pending import session names. The values are the provider's
 * published source families; an unknown family is presented by its own name.
 */
export function uiImportSourceLabel(sourceKind: string): string {
  switch (sourceKind) {
    case 'manual':
      return 'Manual entry';
    case 'capture':
      return 'Camera capture';
    case 'pasted-list':
      return 'Pasted list';
    case 'moxfield':
      return 'Moxfield deck';
    case 'wizards-precon':
      return 'Wizards preconstructed deck';
    default:
      return 'Import';
  }
}

/**
 * One stored recognition alternative of a pending entry, as the review presents it: the printing
 * it resolved and the provider and evidence labels that produced it
 * (docs/user-cards.md#import-and-capture-state).
 */
export interface UiImportCandidate {
  readonly printingId: string;
  readonly provider: string;
  readonly evidence: string;
}

/** Alternatives of one pending entry whose printing a capture or source left unresolved. */
export function uiImportCandidates(entry: ImportEntry): readonly UiImportCandidate[] {
  return entry.candidates.map((candidate: ImportCandidate) => ({
    printingId: candidate.printingId,
    provider: candidate.provider,
    evidence: candidate.evidence,
  }));
}

/** One staged manual line: the printing it enters review for and the values its owner chose. */
export interface UiImportLine {
  readonly entryId: ImportEntryId;
  readonly printingId: string;
  /** Requested finish, or null to take the printing's first offered finish. */
  readonly finish: Finish | null;
  readonly condition: CopyCondition | null;
  readonly quantity: number;
}

/**
 * Stages lines as pending entries of one import session. Staging never changes ownership, so the
 * page reports a committed outcome as entries in review, and a repeated call with the same entry
 * identities replays its recorded staging instead of adding the lines twice
 * (docs/user-cards.md#import-and-capture-state).
 */
export async function stageImportLines(
  access: UiImportAccess,
  input: StageImportEntriesInput,
  signal?: AbortSignal,
): Promise<UiChangeCommit<ImportStageResult>> {
  return commitUiOperation(
    access.stage(input, signal),
    async (): Promise<ImportStageResult | null> => null,
    'The lines were not added to review.',
    {
      unknown:
        'The staging outcome is unknown. The lines may be in review; reload the import before retrying.',
    },
  );
}

/**
 * What one source import whose outcome is not established reports: the account keeps the input
 * under the import's identity, so reopening that import reads the rows the provider recorded
 * (docs/user-interface.md#source-imports).
 */
export const uiUnfinishedSourceMessage =
  'The staging outcome is unknown. Reopen the waiting import to read its recorded rows.';

/**
 * Begins one new import of a supported source. The provider parses inside its own boundary and
 * composes a fresh import identity for it, so the same contents or source URL never merges with
 * another import (docs/user-cards.md#import-state-and-identity); a source whose response was lost
 * stays retained under that identity and is reopened through `reopenSourceImport`
 * (docs/user-interface.md#source-imports).
 */
export async function beginSourceImport(
  access: UiImportAccess,
  input: UserCardsSourceImportRequest,
  signal?: AbortSignal,
): Promise<UiChangeCommit<SourceImportResult>> {
  return commitUiOperation(
    access.beginSource(input, signal),
    async (): Promise<SourceImportResult | null> => null,
    'The source lines were not added to review.',
    { unknown: uiUnfinishedSourceMessage },
  );
}

/**
 * Reopens one existing import under the provider-owned identity it is known by: the retained
 * unfinished attempt is retried with its own input, and any other identity reconciles that
 * import's source again instead of beginning another import
 * (docs/user-interface.md#source-imports, docs/user-cards.md#source-imports).
 */
export async function reopenSourceImport(
  access: UiImportAccess,
  operationId: string,
  input: UserCardsSourceImportRequest,
  signal?: AbortSignal,
): Promise<UiChangeCommit<SourceImportResult>> {
  return commitUiOperation(
    access.reopenSource(operationId, input, signal),
    async (): Promise<SourceImportResult | null> => null,
    'The source lines were not added to review.',
    { unknown: uiUnfinishedSourceMessage },
  );
}

/**
 * Retries one attempt the account still retains, through that attempt's own handle, and presents
 * what it establishes. The handle owns the identity and input, so a reopening view never composes
 * a second operation (docs/user-cards.md#browser-operation-lifecycle).
 */
export async function retryRetainedAttempt<Kind extends string, Record>(
  operation: UserCardsOperation<Kind, Record>,
  signal: AbortSignal | undefined,
  fallback: string,
  unknown: string,
): Promise<UiChangeCommit<Record>> {
  void operation.retry(signal);
  return commitUiOperation(operation, async (): Promise<Record | null> => null, fallback, {
    unknown,
  });
}

/**
 * Review of one pending entry under the revision the page read. A conflict keeps the entry
 * reviewable; a lost response reads nothing back, because the page reloads the entry list and
 * presents the stored values instead of inferring which fields the review committed.
 */
export async function reviewImportEntry(
  access: UiImportAccess,
  input: ReviewImportEntryInput,
  signal?: AbortSignal,
): Promise<UiChangeCommit<ImportEntryChangeResult>> {
  return commitUiOperation(
    access.review(input, signal),
    async (): Promise<ImportEntryChangeResult | null> => null,
    'The review was not saved.',
    { unknown: 'The review outcome is unknown. Reload the pending import before retrying.' },
  );
}

/** Ends one pending entry without creating copies; the entry stays historical on the provider. */
export async function discardImportEntry(
  access: UiImportAccess,
  input: DiscardImportEntryInput,
  signal?: AbortSignal,
): Promise<UiChangeCommit<ImportEntryChangeResult>> {
  return commitUiOperation(
    access.discardEntry(input, signal),
    async (): Promise<ImportEntryChangeResult | null> => null,
    'The entry was not discarded.',
    { unknown: 'The discard outcome is unknown. Reload the pending import before retrying.' },
  );
}

/**
 * Ends every pending entry of one import without creating copies; the session quotes the revision
 * its entries were read at, so a concurrently reviewed entry conflicts instead of being lost.
 */
export async function discardImportSession(
  access: UiImportAccess,
  input: DiscardImportSessionInput,
  signal?: AbortSignal,
): Promise<UiChangeCommit<ImportSessionChange>> {
  return commitUiOperation(
    access.discardSession(input, signal),
    async (): Promise<ImportSessionChange | null> => null,
    'The import was not discarded.',
    { unknown: 'The discard outcome is unknown. Reload the pending imports before retrying.' },
  );
}

/** Note the page presents beside the copies of a confirmation that had already been recorded. */
const recordedConfirmationNote =
  'This confirmation had already been recorded; the copies it created are listed.';

/** What one confirmation's outcome reports to the page. */
function confirmationCommit(
  outcome: UserCardsOperationOutcome<UserCardsConfirmationOutcome>,
): UiChangeCommit<ImportReceipt> {
  if (outcome.state === 'committed') {
    return {
      status: 'committed',
      // The provider reports whether it returned a recorded outcome; only that earns the note.
      message: outcome.record.replayed ? recordedConfirmationNote : null,
      record: outcome.record,
    };
  }
  if (outcome.state === 'rejected') {
    if (outcome.failure.code === 'not-found') {
      return {
        status: 'failed',
        message:
          'This confirmation is not recorded, so no copies were created. Review the entries and ' +
          'confirm them again.',
        record: null,
      };
    }
    return outcome.failure.code === 'conflict'
      ? { status: 'conflict', message: outcome.failure.message, record: null }
      : { status: 'failed', message: outcome.failure.message, record: null };
  }
  return {
    status: 'unknown',
    message:
      'The confirmation outcome could not be read. Check its outcome before confirming more entries.',
    record: null,
  };
}

/**
 * Confirms reviewed entries under one operation identity. A successful response or the operation's
 * recorded receipt reports the copies it created; an explicit absence of a recorded outcome says
 * that the confirmation did not commit, so the page keeps the reviewed entries for another
 * explicit confirmation (docs/user-cards.md#interface, docs/user-interface.md#capture-and-review).
 */
export async function confirmImport(
  operation: UserCardsOperation<'confirmImport', UserCardsConfirmationOutcome>,
): Promise<UiChangeCommit<ImportReceipt>> {
  return confirmationCommit(await operation.observe());
}

/**
 * Reads the recorded outcome of the confirmation the page kept, independently of the current
 * selection and of whether the entries it covered are still pending
 * (docs/user-cards.md#browser-operation-lifecycle).
 */
export async function recoverConfirmation(
  operation: UserCardsOperation<'confirmImport', UserCardsConfirmationOutcome>,
  signal?: AbortSignal,
): Promise<UiChangeCommit<ImportReceipt>> {
  return confirmationCommit(await operation.recover(signal));
}

/** Prefix of the identities this page generates for staged lines. */
const importIdentityPrefix = 'ui-import';

let importSerial = 0;

/**
 * One stable identity for a staged line. It is unique inside this presentation and bounded like
 * every identifier UserCards accepts, so a retry of the same line refers to its recorded staging
 * instead of creating a second one.
 */
export function uiImportIdentity(): string {
  return uiIdentity(importIdentityPrefix);
}

/** One bounded, unique identity of the given family. */
function uiIdentity(prefix: string): string {
  importSerial += 1;
  const stamp = Date.now().toString(36);
  const noise = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${stamp}-${importSerial.toString(36)}-${noise}`;
}
