/**
 * Import staging, review and confirmation of the Import page
 * (docs/user-interface.md#capture-and-review, docs/user-cards.md#import-and-capture-state).
 *
 * The page stages manual lines as pending entries, reviews a pending entry's printing, finish,
 * condition and quantity under the revision it read, discards entries and confirms the reviewed
 * entries under one operation identity. Staging, review and discard quote an entry identity, so a
 * rejected change either conflicts or stays unknown exactly like every other private edit, and a
 * confirmation that lost its response is recovered through the recorded outcome of its operation
 * identity instead of inferring commitment (docs/application.md#construction-and-request-boundary).
 * Nothing here reports ownership: a staged line is a candidate in review, and only a confirmation
 * creates the physical copies.
 */

import type { UserCardsClient } from '../../application/index.js';
import type { Finish } from '../../catalog/index.js';
import type {
  ConfirmImportInput,
  CopyCondition,
  DiscardImportEntryInput,
  DiscardImportSessionInput,
  ImportConfirmationResult,
  ImportEntry,
  ImportEntryChangeResult,
  ImportEntryId,
  ImportEntryListResult,
  ImportOperationId,
  ImportOperationRecoveryResult,
  ImportReceipt,
  ImportSessionChange,
  ImportSessionListResult,
  ImportStageResult,
  ListImportEntriesOptions,
  ListImportSessionsOptions,
  ReviewImportEntryInput,
  StageImportEntriesInput,
} from '../../usercards/index.js';

import {
  commitUiChange,
  isUiDefiniteFailure,
  readUiFailureCode,
  readUiFailureMessage,
  type UiChangeCommit,
} from './failure.js';

/**
 * The private import operations the Import page presents. It is the narrow part of Application's
 * browser contract this page uses, so a consumer depends only on the capabilities it presents
 * (docs/architecture.md#composition-and-replacement).
 */
export type UiImportClient = Pick<
  UserCardsClient,
  | 'listImportSessions'
  | 'listImportEntries'
  | 'stageImportEntries'
  | 'reviewImportEntry'
  | 'discardImportEntry'
  | 'discardImportSession'
  | 'confirmImport'
  | 'recoverImportOperation'
>;

/** Private pending-import access of the Import page. */
export interface UiImportAccess {
  /** One bounded page of the account's pending import sessions. */
  sessions(
    options?: ListImportSessionsOptions,
    signal?: AbortSignal,
  ): Promise<ImportSessionListResult>;
  /** One bounded page of one session's pending entries, in capture order. */
  entries(input: ListImportEntriesOptions, signal?: AbortSignal): Promise<ImportEntryListResult>;
  stage(input: StageImportEntriesInput, signal?: AbortSignal): Promise<ImportStageResult>;
  review(input: ReviewImportEntryInput, signal?: AbortSignal): Promise<ImportEntryChangeResult>;
  discardEntry(
    input: DiscardImportEntryInput,
    signal?: AbortSignal,
  ): Promise<ImportEntryChangeResult>;
  discardSession(
    input: DiscardImportSessionInput,
    signal?: AbortSignal,
  ): Promise<ImportSessionChange>;
  confirm(input: ConfirmImportInput, signal?: AbortSignal): Promise<ImportConfirmationResult>;
  /** The recorded outcome of one operation identity, or its explicit absence. */
  recover(
    operationId: ImportOperationId,
    signal?: AbortSignal,
  ): Promise<ImportOperationRecoveryResult>;
}

/** Builds the import access over the private contract Application supplies. */
export function createImportAccess(userCards: UiImportClient): UiImportAccess {
  for (const operation of [
    'listImportSessions',
    'listImportEntries',
    'stageImportEntries',
    'reviewImportEntry',
    'discardImportEntry',
    'discardImportSession',
    'confirmImport',
    'recoverImportOperation',
  ] as const) {
    if (typeof userCards?.[operation] !== 'function') {
      throw new TypeError('The Import page reads and changes pending imports through UserCards.');
    }
  }
  return {
    sessions: (options, signal) => userCards.listImportSessions(options, signal),
    entries: (input, signal) => userCards.listImportEntries(input, signal),
    stage: (input, signal) => userCards.stageImportEntries(input, signal),
    review: (input, signal) => userCards.reviewImportEntry(input, signal),
    discardEntry: (input, signal) => userCards.discardImportEntry(input, signal),
    discardSession: (input, signal) => userCards.discardImportSession(input, signal),
    confirm: (input, signal) => userCards.confirmImport(input, signal),
    recover: (operationId, signal) => userCards.recoverImportOperation(operationId, signal),
  };
}

/**
 * Display name of one acquisition source a pending import session names. The values are the
 * provider's published source families; an unknown family is presented by its own name.
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
  return entry.candidates.map((candidate) => ({
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
 * page reports a committed outcome as entries in review, and a repeated call with the same line
 * identities replays its recorded staging instead of adding the lines twice
 * (docs/user-cards.md#import-and-capture-state).
 */
export async function stageImportLines(
  access: UiImportAccess,
  input: StageImportEntriesInput,
  signal?: AbortSignal,
): Promise<UiChangeCommit<ImportStageResult>> {
  return commitUiChange(
    () => access.stage(input, signal),
    async () => null,
    'The lines were not added to review.',
    'The staging outcome is unknown. The lines may be in review; reload the import before retrying.',
  );
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
  return commitUiChange(
    () => access.review(input, signal),
    async () => null,
    'The review was not saved.',
    'The review outcome is unknown. Reload the pending import before retrying.',
  );
}

/** Ends one pending entry without creating copies; the entry stays historical on the provider. */
export async function discardImportEntry(
  access: UiImportAccess,
  input: DiscardImportEntryInput,
  signal?: AbortSignal,
): Promise<UiChangeCommit<ImportEntryChangeResult>> {
  return commitUiChange(
    () => access.discardEntry(input, signal),
    async () => null,
    'The entry was not discarded.',
    'The discard outcome is unknown. Reload the pending import before retrying.',
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
  return commitUiChange(
    () => access.discardSession(input, signal),
    async () => null,
    'The import was not discarded.',
    'The discard outcome is unknown. Reload the pending imports before retrying.',
  );
}

/**
 * Confirms reviewed entries under one operation identity. A successful response or the operation's
 * recorded outcome reports the receipt that names the created copies; an explicit absence of a
 * recorded outcome says that the confirmation did not commit, so the page keeps the reviewed
 * entries for an idempotent retry under the same identity
 * (docs/user-cards.md#interface, docs/user-interface.md#capture-and-review).
 */
export async function confirmImport(
  access: UiImportAccess,
  input: ConfirmImportInput,
  signal?: AbortSignal,
): Promise<UiChangeCommit<ImportReceipt>> {
  try {
    return { status: 'committed', message: null, record: await access.confirm(input, signal) };
  } catch (cause) {
    const code = readUiFailureCode(cause);
    if (code === 'conflict') {
      return {
        status: 'conflict',
        message: readUiFailureMessage(cause, 'The confirmation was not committed.'),
        record: null,
      };
    }
    if (code !== null && isUiDefiniteFailure(code)) {
      return {
        status: 'failed',
        message: readUiFailureMessage(cause, 'The confirmation was not committed.'),
        record: null,
      };
    }
    // The response was lost or the service is busy: the operation identity decides, never an
    // inference from the pending entries that may or may not have produced copies.
    let recovered: ImportOperationRecoveryResult | null;
    try {
      recovered = await access.recover(input.operationId, signal);
    } catch {
      recovered = null;
    }
    if (recovered?.outcome === 'recorded') {
      return {
        status: 'committed',
        message: 'This confirmation had already been recorded; the copies it created are listed.',
        record: recovered.receipt,
      };
    }
    if (recovered?.outcome === 'absent') {
      return {
        status: 'unknown',
        message:
          'This confirmation is not recorded, so no copies were created. Review the entries and ' +
          'confirm them again.',
        record: null,
      };
    }
    return {
      status: 'unknown',
      message:
        'The confirmation outcome could not be read. Retry the same confirmation before ' +
        'changing the reviewed entries.',
      record: null,
    };
  }
}

/** Prefix of the identities this page generates for staged lines and confirmation operations. */
const importIdentityPrefix = 'ui-import';

let importSerial = 0;

/**
 * One stable identity for a staged line or a confirmation operation. It is unique inside this
 * presentation and bounded like every identifier UserCards accepts, so a retry of the same input
 * refers to the recorded staging or confirmation instead of creating a second one.
 */
export function uiImportIdentity(): string {
  importSerial += 1;
  const stamp = Date.now().toString(36);
  const noise = Math.random().toString(36).slice(2, 8);
  return `${importIdentityPrefix}-${stamp}-${importSerial.toString(36)}-${noise}`;
}
