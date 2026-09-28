/**
 * Import editors of the UserInterface (docs/ui/editors.md#internal-design,
 * docs/user-interface.md#capture-and-review, docs/user-interface.md#source-imports).
 *
 * The Import activity is composed of independently mountable editors instead of one page closure:
 * the manual entry editor searches the catalog and stages the selected printings, the source
 * editor parses one supported source method into review and reopens the imports the account still
 * retains, and the pending review editor presents one import's entries with their corrections and
 * the explicit confirmation that creates copies. A staged line, source row or capture is a
 * candidate in review; only a confirmation creates physical copies. Each editor owns its drafts
 * and operation presentation; the page owns layout, route context and the coordination between
 * its children (docs/ui/pages.md#interface).
 */

import type { CardListBrowser } from '../../../card-list/index.js';
import type { Catalog, Finish, PrintingRecord } from '../../../catalog/index.js';
import type { CaptureReviewChange } from '../../../capture/index.js';
import type {
  ConfirmImportEntryInput,
  ImportReceipt,
  ImportSession,
  ImportSessionListResult,
  SourceImportResult,
} from '../../../usercards/index.js';
import type {
  UserCardsConfirmationOutcome,
  UserCardsConstraints,
  UserCardsOperation,
  UserCardsSourceImportRequest,
} from '../../../usercards/browser.js';

import type { UiActionIntent } from '../../shared/actions.js';
import type { CardViews } from '../../card-views/index.js';
import type { UiActionRequest, UiOperationAction, UiOperationOutcome } from './operations.js';
import { applyAction, outcomeText } from './operations.js';
import {
  button,
  controlLabel,
  note,
  numberInput,
  readMessage,
  select,
  statusLine,
  submitButton,
  text,
  textArea,
  textInput,
} from '../../shared/controls.js';
import type { UiDialogs } from '../../shared/dialogs.js';
import { UI_LIMITS } from '../../shared/limits.js';
import { readRetainedList, readState } from '../../shared/state.js';
import {
  cardListEntryKey,
  resolvePrintings,
  type CardListCatalogQuery,
  type CardListPickerQuery,
  type CardListEntry,
  type CardListFragmentReader,
  type CardListPendingRecord,
  type CardListRetained,
  type CardListToolSelection,
} from '../../../card-list/index.js';
import type { UiCardList } from '../../card-views/index.js';

import {
  beginSourceImport,
  confirmImport,
  discardImportEntry,
  discardImportSession,
  recoverConfirmation,
  reopenSourceImport,
  retryRetainedAttempt,
  reviewImportEntry,
  stageImportLines,
  uiImportCandidates,
  uiImportIdentity,
  uiImportSourceLabel,
  type UiImportAccess,
  type UiImportLine,
} from './import-edits.js';
import type { UiChangeCommit } from './failure.js';
import {
  boundByWindow,
  conditionOptions,
  confirmationMessage,
  defaultSessionId,
  finishOptions,
  finishSelect,
  firstFinish,
  inBatches,
  knownPrinting,
  manualImport,
  printingLine,
  readConditionValue,
  readFinishValue,
  readManualDraft,
  readQuantity,
  readQuantityValue,
  readReviewDrafts,
  readSelectedRevisions,
  readSessionId,
  readSourceDraft,
  readSourceFormat,
  reviewedWizardsLines,
  sameReviewDraft,
  sourceImportMessage,
  sourceLineText,
  sourceRow,
  stagedLineTarget,
  stagedMessage,
  stagingOutcome,
  uiSourceFormats,
  unfinishedSourceLabel,
  type UiReviewDraft,
  type UiSelectedReview,
  type UiSourceDraft,
  type UiSourceFormat,
  type UiSourceImportAttempt,
  type UiSourceInput,
  type UiStagingAttempt,
} from './import-support.js';

/** What every Import editor receives from the page that composes it. */
export interface UiImportEditorContext {
  readonly document: Document;
  /** Private pending-import access over the supplied UserCards contract. */
  readonly access: UiImportAccess;
  /** Input constraints and operation availability the editors present. */
  readonly constraints: UserCardsConstraints;
  /** CardList capability the editors describe their lists to. */
  readonly cardList: CardListBrowser;
  /** CardViews module the editors render their lists with. */
  readonly cardViews: CardViews;
  /** Verified account the editors present. */
  readonly accountId: string;
  /** Catalog the printing searches resolve through. */
  readonly catalog: Catalog;
  /** Aborted when the view closes; late results must not change a replacement view. */
  readonly signal: AbortSignal;
}

/** One outstanding confirmation the review presents until UserCards establishes its outcome. */
interface UiConfirmationDraft {
  readonly sessionId: string;
  readonly entries: readonly ConfirmImportEntryInput[];
  /** The provider-owned operation whose recorded outcome decides this confirmation. */
  readonly operation: UserCardsOperation<'confirmImport', UserCardsConfirmationOutcome>;
}

/** One presented pending-entry editor, redrawn as its draft or its stored record changes. */
interface UiImportEntryEditor {
  readonly controls: HTMLSpanElement;
  readonly entry: CardListEntry;
  readonly status: HTMLParagraphElement;
}

/** One mounted printing picker of a pending entry and the region it presents in. */
interface UiImportEntryPicker {
  readonly host: HTMLElement;
  readonly list: UiCardList<CardListPickerQuery>;
}

/** One focused control of a row a redraw keeps in place. */
interface UiKeptFocus {
  readonly id: string;
  readonly value: string | null;
  readonly start: number | null;
  readonly end: number | null;
}

/** The focused control of one row, or null when the focus is elsewhere. */
function readFocusedControl(container: HTMLElement): UiKeptFocus | null {
  const active = container.ownerDocument.activeElement;
  if (!(active instanceof HTMLElement) || active.id.length === 0) {
    return null;
  }
  if (!container.contains(active)) {
    return null;
  }
  const field =
    active instanceof HTMLInputElement ||
    active instanceof HTMLTextAreaElement ||
    active instanceof HTMLSelectElement
      ? active
      : null;
  const textField =
    active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active : null;
  return {
    id: active.id,
    value: field?.value ?? null,
    start: textField?.selectionStart ?? null,
    end: textField?.selectionEnd ?? null,
  };
}

/** Focuses the same control of a redrawn row again, with the input the owner had typed. */
function resumeFocusedControl(container: HTMLElement, kept: UiKeptFocus | null): void {
  if (kept === null) {
    return;
  }
  const control = container.ownerDocument.getElementById(kept.id);
  if (!(control instanceof HTMLElement) || !container.contains(control)) {
    return;
  }
  if (
    kept.value !== null &&
    (control instanceof HTMLInputElement ||
      control instanceof HTMLTextAreaElement ||
      control instanceof HTMLSelectElement)
  ) {
    control.value = kept.value;
  }
  if (kept.start !== null && kept.end !== null && control instanceof HTMLInputElement) {
    control.setSelectionRange(kept.start, kept.end);
  }
  control.focus({ preventScroll: true });
}

/* --------------------------------------------------------------------------------------------
 * Manual entry
 * ------------------------------------------------------------------------------------------ */

/** Draft of the manual entry form. */
export interface UiManualImportDraft {
  readonly text: string;
  readonly quantity: string;
  readonly finish: string;
  readonly condition: string;
}

export interface UiManualImportEditorOptions extends UiImportEditorContext {
  /** Page state a previous visit retained; the editor reads only its own fields. */
  readonly restored?: Readonly<Record<string, unknown>> | null;
  /**
   * Reports that staging or its recovery changed the presented imports. `unknownOutcome` is true
   * when the outcome was not established, so the review re-reads what the provider holds.
   */
  readonly onChanged: (unknownOutcome: boolean) => void;
}

/**
 * The manual entry editor: one card-name search over the catalog, the values a staged line
 * carries and the retained staging attempts whose outcome is not established yet.
 */
export interface UiManualImportEditor {
  /** The editor's content, in presentation order. */
  readonly nodes: readonly Node[];
  capture(): { readonly manual: UiManualImportDraft; readonly results: unknown };
  /** Lifecycle of the result list a previous visit retained, or null when it composed none. */
  presentation(): Promise<void> | null;
  dispose(): void;
}

export function createManualImportEditor(
  options: UiManualImportEditorOptions,
): UiManualImportEditor {
  const document = options.document;
  const access = options.access;
  const constraints = options.constraints;
  const restored = options.restored ?? null;
  const manual = readManualDraft(restored?.manual);
  const retainedResults = readState(restored?.results);
  let disposed = options.signal.aborted;
  options.signal.addEventListener(
    'abort',
    () => {
      disposed = true;
    },
    { once: true },
  );

  const heading = text(document, 'h3', 'import-manual-heading', 'Manual entry');
  const form = document.createElement('form');
  form.id = 'import-manual';
  const query = textInput(document, 'import-manual-query', manual.text);
  query.type = 'search';
  query.maxLength = UI_LIMITS.catalogQuery;
  const quantity = numberInput(
    document,
    'import-manual-quantity',
    manual.quantity,
    constraints.quantity.copy,
  );
  const finish = select(document, finishOptions(), manual.finish);
  finish.id = 'import-manual-finish';
  const condition = select(document, conditionOptions(), manual.condition);
  condition.id = 'import-manual-condition';
  form.append(
    controlLabel(document, 'Card', query),
    controlLabel(document, 'Quantity', quantity),
    controlLabel(document, 'Finish', finish),
    controlLabel(document, 'Condition', condition),
    submitButton(document, 'import-manual-submit', 'Find cards'),
  );
  const status = statusLine(document, 'import-manual-status');
  // A manual staging whose response was lost stays retained with UserCards; the editor presents
  // that attempt and the explicit retry it needs instead of keeping the identity itself
  // (docs/user-cards.md#browser-operation-lifecycle).
  const recovery = document.createElement('p');
  recovery.id = 'import-manual-recovery';
  const recoveryNote = document.createElement('span');
  recoveryNote.textContent = 'A manual staging attempt is waiting for its outcome.';
  const recover = button(document, 'import-manual-recover', 'Retry pending staging');
  recovery.append(recoveryNote, recover);
  // The region keeps the result list beside the editor's own presentation of the action the list
  // offers: the list reports the intent, the editor stages the lines and presents what the
  // provider established (docs/ui/editors.md#interface).
  const resultsRegion = document.createElement('div');
  resultsRegion.id = 'import-results';
  const resultsHost = document.createElement('div');
  resultsHost.id = 'import-results-list';
  const resultsStatus = statusLine(document, 'import-results-status');
  resultsStatus.dataset.uiOutcome = '';
  resultsRegion.append(resultsHost, resultsStatus);
  const resultsHeading = text(document, 'h3', 'import-results-heading', 'Add a printing');

  /** Printings the manual search presents as a bounded list over the supplied contracts. */
  let results: UiCardList<CardListCatalogQuery> | null = null;
  let recoveringStaging = false;
  /** Whether one staging is in flight; a further intent is ignored instead of run twice. */
  let addingToReview = false;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    findCards();
  });
  recover.addEventListener('click', () => {
    void recoverManualStaging();
  });
  if (retainedResults !== null) {
    composeResults(readRetainedList<CardListCatalogQuery>(retainedResults));
  }
  paintManualRecovery();

  return {
    nodes: [heading, form, status, recovery, resultsHeading, resultsRegion],
    capture: () => ({
      manual: {
        text: query.value,
        quantity: quantity.value,
        finish: finish.value,
        condition: condition.value,
      },
      // A list not composed yet keeps the state its entry handed back instead of overwriting it
      // with a partially presented view (docs/ui/architecture.md#state-ownership-and-restoration).
      results: results === null ? retainedResults : { list: results.capture() },
    }),
    presentation: () => (results === null ? null : presentedOf(results)),
    dispose: () => {
      disposed = true;
      results?.dispose();
    },
  };

  /** Composes the catalog result list of the manual entry search. */
  function composeResults(restoredState: CardListRetained<CardListCatalogQuery> | undefined): void {
    results = options.cardViews.list<CardListCatalogQuery>({
      container: resultsHost,
      create: options.cardList.create,
      source: options.cardList.account(options.accountId).catalogQuery(),
      context: { text: query.value.trim(), level: 'printing', owned: false, finish: null },
      accountId: options.accountId,
      pageSize: UI_LIMITS.importPrintings,
      restored: restoredState,
      fragments: { tools: resultToolsReader() },
      tools: [{ id: 'add-to-review', label: 'Add to review' }],
      onAction: (intent) => {
        void applyManualAdd(intent);
      },
      signal: options.signal,
    });
  }

  /**
   * Stages the explicit selected printings as manual pending lines and presents the pending state
   * and authoritative outcome the provider established. Only a committed staging is reported as
   * added; an unresolved one keeps its retained attempt visible for the explicit retry
   * (docs/ui/editors.md#drafts-and-asynchronous-outcomes).
   */
  async function applyManualAdd(intent: UiActionIntent): Promise<void> {
    if (disposed || addingToReview) {
      return;
    }
    addingToReview = true;
    resultsStatus.removeAttribute('data-ui-outcome-status');
    resultsStatus.textContent = 'Adding to review…';
    const outcome = await applyAction(addAction(), {
      selection: intent.selection,
      signal: options.signal,
    });
    if (disposed) {
      return;
    }
    addingToReview = false;
    resultsStatus.dataset.uiOutcomeStatus = outcome.status;
    resultsStatus.textContent = outcome.message ?? outcomeText(outcome.status);
  }

  /** Searches the catalog for the printings the manual entry form names. */
  function findCards(): void {
    const wanted = query.value.trim();
    if (wanted.length === 0) {
      status.textContent = 'Enter a card name or expression to find its printings.';
      return;
    }
    status.textContent = '';
    const criteria: CardListCatalogQuery = {
      text: wanted,
      level: 'printing',
      owned: false,
      finish: null,
    };
    if (results === null) {
      composeResults(undefined);
    } else {
      results.refine(criteria);
    }
  }

  /**
   * Stages the selected printings as manual pending lines with the quantity, finish and condition
   * the form presents. An earlier manual staging whose outcome is not established is retried
   * through its own retained attempt before more lines are added, so the same line is never staged
   * twice under two identities (docs/user-cards.md#import-and-capture-state).
   */
  async function addSelection(request: UiActionRequest): Promise<UiOperationOutcome> {
    const waiting = retainedStagingAttempts();
    if (waiting.length > 0) {
      // The provider keeps an earlier staging whose outcome is not established: retrying it is
      // what resolves it, and the retained attempt owns the identity its lines were staged under.
      paintManualRecovery();
      return {
        status: 'unknown',
        message:
          'The pending manual staging is still unresolved. Retry it before adding more lines.',
      };
    }
    const wantedQuantity = readQuantity(quantity, constraints.quantity.copy);
    if (wantedQuantity === null) {
      return {
        status: 'failed',
        message: `Choose a quantity from 1 to ${constraints.quantity.copy}.`,
      };
    }
    const wantedFinish = readFinishValue(finish.value);
    const wantedCondition = readConditionValue(condition.value);
    const lines: UiImportLine[] = [];
    for (const target of request.selection.targets) {
      if (target.kind !== 'printing' || target.printingId === undefined) {
        continue;
      }
      lines.push({
        entryId: uiImportIdentity(),
        printingId: target.printingId,
        finish: wantedFinish,
        condition: wantedCondition,
        quantity: wantedQuantity,
      });
    }
    if (lines.length === 0) {
      return { status: 'failed', message: 'Select the printings to add to review.' };
    }
    // One request stages at most the number of lines the provider bound accepts, so a selection
    // larger than one request is staged through further bounded requests, each line carrying the
    // identity UserCards retains while its outcome is not established (docs/user-cards.md#interface).
    let inReview = 0;
    let reported: UiOperationOutcome | null = null;
    for (const batch of inBatches(lines, constraints.batch.stageEntries)) {
      const keys = batch.map((line) => cardListEntryKey(stagedLineTarget(line)));
      const outcome = await stageImportLines(
        access,
        {
          sessionId: manualImport.sessionId,
          source: manualImport.source,
          entries: batch.map((line) => ({
            entryId: line.entryId,
            printingId: line.printingId,
            finish: line.finish,
            condition: line.condition,
            quantity: line.quantity,
          })),
        },
        request.signal,
      );
      if (disposed) {
        return { status: 'unknown', message: null };
      }
      if (outcome.status === 'committed') {
        for (const key of keys) {
          results?.setSelected(key, false);
        }
        inReview += outcome.record?.staged ?? 0;
        continue;
      }
      reported = stagingOutcome(inReview, outcome);
      break;
    }
    // Reading the pending entries shows whether a staging committed even though its response was
    // lost (docs/user-interface.md#capture-and-review).
    options.onChanged(reported?.status === 'unknown');
    paintManualRecovery();
    return reported ?? { status: 'committed', message: stagedMessage(inReview) };
  }

  /** The manual staging attempts the account retains, oldest first. */
  function retainedStagingAttempts(): readonly UiStagingAttempt[] {
    return access
      .retained()
      .flatMap((attempt) => (attempt.kind === 'stageImportEntries' ? [attempt] : []));
  }

  /** Presents the retained manual staging attempt and the retry its outcome needs. */
  function paintManualRecovery(): void {
    const attempts = retainedStagingAttempts();
    recovery.hidden = attempts.length === 0;
    recover.disabled = recoveringStaging;
    recoveryNote.textContent =
      attempts.length === 1
        ? 'A manual staging attempt is waiting for its outcome.'
        : `${attempts.length} manual staging attempts are waiting for their outcome.`;
  }

  /**
   * Retries every manual staging attempt the account retains, through its own handle, and presents
   * what the provider established. The attempt keeps the line identities it was begun with, so a
   * retry replays that staging instead of adding the lines twice
   * (docs/user-cards.md#browser-operation-lifecycle).
   */
  async function recoverManualStaging(): Promise<void> {
    if (recoveringStaging) {
      return;
    }
    recoveringStaging = true;
    paintManualRecovery();
    let inReview = 0;
    let message: string | null = null;
    try {
      for (const attempt of retainedStagingAttempts()) {
        const outcome = await retryRetainedAttempt(
          attempt,
          options.signal,
          'The lines were not added to review.',
          'The staging outcome is unknown. The lines may be in review; reload the import ' +
            'before retrying.',
        );
        if (disposed) {
          return;
        }
        if (outcome.status === 'committed' && outcome.record !== null) {
          for (const entry of attempt.request.entries) {
            const printingId = entry.printingId ?? null;
            if (printingId !== null) {
              results?.setSelected(cardListEntryKey({ kind: 'printing', printingId }), false);
            }
          }
          inReview += outcome.record.staged;
          continue;
        }
        message = outcome.message;
        break;
      }
    } finally {
      recoveringStaging = false;
      paintManualRecovery();
    }
    status.textContent = message ?? (inReview === 0 ? stagedMessage(0) : stagedMessage(inReview));
    // The committed lines were reacquired by their change notifications; only an unresolved
    // outcome needs the review's own read of the entries.
    options.onChanged(message !== null);
  }

  /** Whether each printed search result can enter the manual import. */
  function resultToolsReader(): CardListFragmentReader<readonly string[]> {
    return {
      read(request) {
        return Promise.resolve(
          request.keys.map((key) => ({
            key,
            status: 'ready' as const,
            values: key.startsWith('printing:') ? ['add-to-review'] : [],
          })),
        );
      },
    };
  }

  /** The action that stages the explicit selected printings as manual pending lines. */
  function addAction(): UiOperationAction {
    return {
      id: 'add-to-review',
      label: 'Add to review',
      apply: (request) => addSelection(request),
    };
  }
}

/** The reported presentation of one list's retention, or null when this visit restored none. */
function presentedOf<Context>(list: UiCardList<Context>): Promise<void> | null {
  return list.restoration === null ? null : list.restoration.presented.then(() => undefined);
}

/* --------------------------------------------------------------------------------------------
 * Pending review and confirmation
 * ------------------------------------------------------------------------------------------ */

export interface UiImportReviewEditorOptions extends UiImportEditorContext {
  /** Page state a previous visit retained; the editor reads only its own fields. */
  readonly restored?: Readonly<Record<string, unknown>> | null;
  /** Brief confirmation dialogs the shell supplies for discarding pending work. */
  readonly dialogs: UiDialogs;
}

/** The review editor's draft state: the presented import, its review input and its selection. */
export interface UiImportReviewDraft {
  readonly sessionId: string | null;
  readonly review: Readonly<Record<string, UiReviewDraft>>;
  readonly selection: Readonly<Record<string, UiSelectedReview>>;
}

/**
 * The pending review editor: one import's pending entries with their reviewed printing, finish,
 * condition and quantity, the printing search that corrects them, the explicit confirmation that
 * creates copies and the discard actions. A confirmation quotes the reviewed revisions under one
 * provider-owned operation identity; a lost response is recovered through that recorded outcome
 * instead of being presented as a saved change.
 */
export interface UiImportReviewEditor {
  /** The editor's content, in presentation order. */
  readonly nodes: readonly Node[];
  capture(): UiImportReviewDraft;
  /** The pending list state this visit retains, or null when it composed none. */
  capturePending(): unknown;
  /** Resolves once the editor presented the retained content of its history entry. */
  presentation(): Promise<void>;
  /** Presents one session's pending entries, e.g. the import a source just staged. */
  presentSession(sessionId: string): Promise<void>;
  /** Re-reads the pending imports, and the presented entries unless a change covers them. */
  reconcile(refreshEntries?: boolean): Promise<void>;
  /** Takes one capture change into the review. */
  reconcileCapture(change: CaptureReviewChange): Promise<void>;
  dispose(): void;
}

export function createImportReviewEditor(
  options: UiImportReviewEditorOptions,
): UiImportReviewEditor {
  const document = options.document;
  const access = options.access;
  const constraints = options.constraints;
  const restored = options.restored ?? null;
  const bindings = options.cardList.account(options.accountId);
  let disposed = options.signal.aborted;
  options.signal.addEventListener(
    'abort',
    () => {
      disposed = true;
    },
    { once: true },
  );

  const heading = text(document, 'h3', 'import-review-heading', 'Pending review');
  const sessionSelect = document.createElement('select');
  sessionSelect.id = 'import-session';
  const sessionsMore = button(document, 'import-sessions-more', 'More imports');
  sessionsMore.hidden = true;
  const refresh = button(document, 'import-refresh', 'Refresh imports');
  const recover = button(document, 'import-recover', 'Check confirmation outcome');
  recover.hidden = true;
  const reviewStatus = statusLine(document, 'import-review-status');
  const provenance = note(document, '');
  provenance.id = 'import-provenance';
  provenance.hidden = true;
  // The region keeps the pending list beside the editor's own presentation of the confirmation
  // action the list offers (docs/ui/editors.md#interface).
  const pendingRegion = document.createElement('div');
  pendingRegion.id = 'import-pending';
  const pendingHost = document.createElement('div');
  pendingHost.id = 'import-pending-list';
  const pendingStatus = statusLine(document, 'import-pending-status');
  pendingStatus.dataset.uiOutcome = '';
  pendingRegion.append(pendingHost, pendingStatus);
  const discard = button(document, 'import-discard-session', 'Discard this import');
  discard.disabled = true;

  /** Session whose pending entries the review presents; null before one is read. */
  let sessionId: string | null = readSessionId(restored?.sessionId);
  /** Pending sessions the account reported, oldest page first. */
  let sessions: readonly ImportSession[] = [];
  let sessionsContinuation: string | null = null;
  /** Read of the pending sessions now answering for the review; an older one never replaces it. */
  let sessionsRead = 0;
  /** Session record the pending entries were read with; its revision guards a discard. */
  let session: ImportSession | null = null;
  /**
   * CardList binding of the presented import: it owns the pending-entry read, its translation and
   * the provider records the review's editors read under an entry's own key.
   */
  let pendingEntries: ReturnType<typeof bindings.pendingEntries> | null = null;
  /**
   * Reviewed revision of every explicitly selected entry the editor has read, kept while the
   * selection names it so a confirmation covers entries outside the loaded window.
   */
  const selectedRevisions = readSelectedRevisions(restored?.selection);
  /** Per-entry messages the review presents, kept across the redraws of their editor. */
  const messages = new Map<string, string>();
  /**
   * Editor the review currently presents per entry. A redraw replaces the editor's controls, so a
   * message reported after an operation reaches the controls the review presents now.
   */
  const editors = new Map<string, UiImportEntryEditor>();
  /** Records of the printings a row's review read, keyed by entry identity. */
  const printings = new Map<string, readonly PrintingRecord[]>();
  /** Printing records already read, so an unanswered identity is never asked for again. */
  const learnedPrintings = new Set<string>();
  /** Printing pickers one row presented, keyed by the entry key they belong to. */
  const printingPickers = new Map<string, UiImportEntryPicker>();
  /** Unsaved review input per entry, kept across redraws and with the history entry. */
  const drafts = readReviewDrafts(restored?.review);
  let confirmation = retainedConfirmation();
  let pending: UiCardList<string> | null = null;
  /** Whether a confirmation or a recovery of one is in flight, so only one acts at a time. */
  let confirming = false;
  let recovering = false;
  /** The retained pending list state, kept while the list is not composed yet. */
  const retainedPending = readRetainedPending(restored?.pending, sessionId);
  const presented = Promise.withResolvers<void>();
  // A view whose presentation the shell never awaits must still not surface a rejection.
  presented.promise.catch(() => {});

  sessionSelect.addEventListener('change', () => {
    present(readSessionId(sessionSelect.value));
  });
  sessionsMore.addEventListener('click', () => {
    void readSessions(sessionsContinuation, true);
  });
  refresh.addEventListener('click', () => {
    void reconcile();
  });
  recover.addEventListener('click', () => {
    void recoverPendingConfirmation();
  });
  discard.addEventListener('click', () => {
    void discardImport();
  });
  if (retainedPending !== null) {
    composePending(retainedPending.sessionId, retainedPending.list);
  }
  paintConfirmation();
  if (confirmation !== null) {
    // A confirmation whose outcome the provider has not established stays recoverable through the
    // identity it was dispatched under, also after a reload or a return to the view
    // (docs/user-cards.md#browser-operation-lifecycle).
    reviewStatus.textContent =
      'A confirmation is kept whose outcome is not established. Check it before confirming ' +
      'the same entries again.';
    void recoverPendingConfirmation();
  }
  void open();

  return {
    nodes: [
      heading,
      controlLabel(document, 'Import', sessionSelect),
      provenance,
      sessionsMore,
      refresh,
      recover,
      reviewStatus,
      pendingRegion,
      discard,
    ],
    capture: () => ({
      sessionId,
      // Unsaved review input stays with the entry, so leaving the view and returning to it keeps
      // the edits the user must review and retry
      // (docs/ui/architecture.md#state-ownership-and-restoration).
      review: Object.fromEntries([...drafts].map(([id, draft]) => [id, { ...draft }])),
      // The reviewed revisions of the explicit selection stay with the entry, so a confirmation
      // still covers entries the loaded window no longer presents.
      selection: Object.fromEntries(
        [...selectionContext()].map(([key, review]) => [key, { ...review }]),
      ),
    }),
    capturePending: () =>
      pending === null
        ? retainedPending
        : sessionId === null
          ? null
          : { sessionId, list: pending.capture() },
    presentation: () => presented.promise,
    presentSession: async (presentedSession) => {
      await readSessions(null, false);
      if (disposed) {
        return;
      }
      const listed = presentedSession === sessionId && pending !== null;
      present(presentedSession);
      if (listed) {
        // The session is already presented: its window reloads instead of being composed again.
        pending?.refresh();
      }
    },
    reconcile,
    reconcileCapture,
    dispose: () => {
      disposed = true;
      pending?.dispose();
      for (const key of [...printingPickers.keys()]) {
        releasePrintingPicker(key);
      }
    },
  };

  /** Reads the account's pending sessions and presents the review of the chosen one. */
  async function open(): Promise<void> {
    await readSessions(null, false);
    if (disposed) {
      return;
    }
    const target = sessionId ?? defaultSessionId(sessions);
    present(target);
    const restorations: (Promise<void> | null)[] = [pending === null ? null : presentedOf(pending)];
    const outstanding = restorations.filter(
      (restoration): restoration is Promise<void> => restoration !== null,
    );
    if (outstanding.length === 0) {
      presented.resolve();
      return;
    }
    void Promise.all(outstanding).then(
      () => presented.resolve(),
      (cause) => presented.reject(cause),
    );
  }

  /** One page of the account's pending sessions, appended to the ones already presented. */
  async function readSessions(continuation: string | null, append: boolean): Promise<void> {
    sessionsRead += 1;
    const read = sessionsRead;
    let page: ImportSessionListResult;
    try {
      page = await access.sessions(
        {
          pageSize: constraints.pages.imports.default,
          ...(continuation === null ? {} : { continuation }),
        },
        options.signal,
      );
    } catch (cause) {
      if (disposed || read !== sessionsRead) {
        return;
      }
      reviewStatus.textContent = `The pending imports could not be read: ${readMessage(
        cause,
        'unknown failure',
      )}`;
      return;
    }
    if (disposed || read !== sessionsRead) {
      // A response of a superseded read cannot replace the pending imports the review presents.
      return;
    }
    sessions = append ? [...sessions, ...page.sessions] : [...page.sessions];
    sessionsContinuation = page.continuation;
    paintSessions();
  }

  /** Draws the session control and the control that reads further session pages. */
  function paintSessions(): void {
    const options: { readonly value: string; readonly label: string }[] = [];
    const current = session;
    if (current !== null && !sessions.some((one) => one.sessionId === current.sessionId)) {
      // The presented import was read beyond the page now listed; it stays selectable, so a review
      // of an import outside the first page survives leaving and returning to the view.
      options.push({
        value: current.sessionId,
        label: `${uiImportSourceLabel(current.sourceKind)} · ${current.pendingEntries} pending`,
      });
    }
    for (const candidate of sessions) {
      options.push({
        value: candidate.sessionId,
        label:
          `${uiImportSourceLabel(candidate.sourceKind)} · ` + `${candidate.pendingEntries} pending`,
      });
    }
    sessionSelect.replaceChildren(
      ...options.map((option) => {
        const element = document.createElement('option');
        element.value = option.value;
        element.textContent = option.label;
        return element;
      }),
    );
    if (options.length === 0) {
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = 'No pending imports';
      sessionSelect.replaceChildren(empty);
      sessionSelect.disabled = true;
    } else {
      sessionSelect.disabled = false;
      const listed = options.some((option) => option.value === sessionId);
      sessionSelect.value = listed ? (sessionId ?? '') : (options[0]?.value ?? '');
    }
    sessionsMore.hidden = sessionsContinuation === null;
    sessionsMore.disabled = sessionsContinuation === null;
    paintProvenance();
  }

  /**
   * The provenance of the presented import: the source method it was acquired from and, when the
   * source published one, the official reference the session is kept with.
   */
  function paintProvenance(): void {
    const current = session;
    if (current === null) {
      provenance.hidden = true;
      provenance.replaceChildren();
      return;
    }
    const parts: Node[] = [];
    const label = document.createElement('span');
    label.dataset.uiImportProvenance = current.sourceKind;
    label.textContent = uiImportSourceLabel(current.sourceKind);
    parts.push(label);
    if (current.sourceReference !== null) {
      const link = document.createElement('a');
      link.dataset.uiImportReference = '';
      link.href = current.sourceReference;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent =
        current.sourceKind === 'wizards-precon'
          ? ' · Official Wizards decklist ↗'
          : ' · Open the source ↗';
      parts.push(link);
    }
    provenance.hidden = false;
    provenance.replaceChildren(...parts);
  }

  /**
   * Presents one session's pending entries. The list is composed again for another session, so a
   * chosen session keeps its own review and no row carries another import's record.
   */
  function present(next: string | null): void {
    if (next === sessionId && pending !== null) {
      // The session is already presented: its window, selection and drafts stay as they are.
      return;
    }
    sessionId = next;
    for (const key of [...printingPickers.keys()]) {
      releasePrintingPicker(key);
    }
    selectedRevisions.clear();
    messages.clear();
    editors.clear();
    session = null;
    pendingEntries = null;
    discard.disabled = true;
    paintSessions();
    if (next === null) {
      pending?.dispose();
      pending = null;
      pendingHost.replaceChildren(note(document, 'No pending entries to review.'));
      return;
    }
    composePending(next, undefined);
  }

  /** Composes the pending-entry list of one session, restoring the state the entry retained. */
  function composePending(
    presentedSession: string,
    restoredState: CardListRetained<string> | undefined,
  ): void {
    pending?.dispose();
    const entries = bindings.pendingEntries();
    pendingEntries = entries;
    pending = options.cardViews.list({
      container: pendingHost,
      create: options.cardList.create,
      source: entries.source,
      context: presentedSession,
      accountId: options.accountId,
      pageSize: constraints.pages.imports.default,
      restored: restoredState,
      fragments: { tools: pendingToolsReader() },
      tools: [{ id: 'confirm-import', label: 'Confirm selected' }],
      onAction: (intent) => {
        void applyPendingConfirmation(intent);
      },
      // A committed change of the presented import reacquires its entries through the binding; the
      // view never patches a row after an operation it drove.
      changes: bindings.changes(),
      presentation: {
        renderEntry: (entry) => entryContent(entry),
        renderFragment: (kind, entry) => (kind === 'tools' ? entryEditor(entry) : null),
      },
      signal: options.signal,
    });
    observePendingEntries(pending);
  }

  /**
   * Follows the presented pending entries: the session record the binding read keeps the review's
   * provenance and discard state current, and every explicitly selected entry keeps the revision
   * its confirmation quotes even after the row leaves the loaded window. Release editors outside
   * that window; their drafts and selected revisions have separate owners.
   */
  function observePendingEntries(list: UiCardList<string>): void {
    const read = (): void => {
      const binding = pendingEntries;
      if (binding === null || disposed) {
        return;
      }
      const presentedKeys = new Set(list.entries.map((entry) => entry.key));
      for (const key of editors.keys()) {
        if (!presentedKeys.has(key)) {
          editors.delete(key);
        }
      }
      const readSession = binding.session();
      if (readSession !== null && readSession.sessionId === sessionId && readSession !== session) {
        adoptSession(readSession);
      }
      const selected = new Set(list.selection);
      for (const key of selected) {
        const record = binding.record(key);
        if (record !== null && !selectedRevisions.has(key)) {
          selectedRevisions.set(key, {
            entryId: record.entry.entryId,
            revision: record.entry.revision,
          });
        }
      }
      for (const key of [...selectedRevisions.keys()]) {
        if (!selected.has(key)) {
          selectedRevisions.delete(key);
        }
      }
    };
    list.subscribe(read);
    read();
  }

  /** One row's basic information: the printing it will create and its reviewed values. */
  function entryContent(entry: CardListEntry): Node {
    return options.cardViews.basicContent(document, entry);
  }

  /**
   * The editor of one pending entry: the reviewed printing, finish, condition and quantity it
   * exposes before confirmation, the printing search that corrects them and the controls that save
   * the review or discard the entry (docs/user-interface.md#capture-and-review).
   */
  function entryEditor(entry: CardListEntry): Node | null {
    const record = pendingRecord(entry.key);
    if (record === null) {
      return null;
    }
    const controls = document.createElement('span');
    controls.dataset.uiImportEditor = entry.key;
    const status = statusLine(
      document,
      `import-entry-status-${encodeURIComponent(record.entry.entryId)}`,
    );
    controls.append(status);
    const editor: UiImportEntryEditor = { controls, entry, status };
    editors.set(entry.key, editor);
    // The row keeps the reviewed values the review read until the list presents the new ones.
    paintEditor(editor);
    return controls;
  }

  /**
   * Draws one entry's reviewed values and controls. The unsaved input lives in the editor's drafts
   * rather than in the rendered controls, so a redraw, paging or leaving and returning to the view
   * keeps what the user must review; only a committed change clears its own draft.
   */
  function paintEditor(editor: UiImportEntryEditor): void {
    const focused = readFocusedControl(editor.controls);
    const record = pendingRecord(editor.entry.key);
    if (record === null) {
      editor.controls.replaceChildren(editor.status);
      return;
    }
    const entry = record.entry;
    const draft = drafts.get(entry.entryId) ?? null;
    editor.status.textContent = messages.get(editor.entry.key) ?? '';
    const content: Node[] = [editor.status, reviewedContent(record)];
    const found = printings.get(entry.entryId) ?? [];
    const chosenPrintingId = draft?.printingId ?? entry.printingId ?? '';
    const chosenPrinting = knownPrinting(record, found, chosenPrintingId);
    if (chosenPrinting === null && chosenPrintingId.length > 0) {
      // The draft names a printing the row has not read: its record is read again, so the
      // reviewed values and the finish control keep following the choice
      // (docs/ui/editors.md#drafts-and-asynchronous-outcomes).
      learnPrinting(entry.entryId, chosenPrintingId);
    }
    const query = textInput(
      document,
      `import-printing-query-${encodeURIComponent(entry.entryId)}`,
      draft?.query ?? '',
    );
    query.type = 'search';
    query.maxLength = UI_LIMITS.catalogQuery;
    const find = button(
      document,
      `import-printing-find-${encodeURIComponent(entry.entryId)}`,
      'Find printings',
    );
    const chosen = document.createElement('span');
    chosen.id = `import-review-printing-${encodeURIComponent(entry.entryId)}`;
    chosen.dataset.uiImportChosen = '';
    chosen.textContent =
      chosenPrintingId.length === 0
        ? 'No printing chosen'
        : chosenPrinting === null
          ? `Printing ${chosenPrintingId}`
          : printingLine(chosenPrinting);
    const wantedFinish = finishSelect(
      document,
      chosenPrinting,
      draft?.finish ?? entry.finish ?? '',
    );
    wantedFinish.id = `import-review-finish-${encodeURIComponent(entry.entryId)}`;
    const wantedCondition = select(
      document,
      conditionOptions(),
      draft?.condition ?? entry.condition ?? '',
    );
    wantedCondition.id = `import-review-condition-${encodeURIComponent(entry.entryId)}`;
    const wantedQuantity = numberInput(
      document,
      `import-review-quantity-${encodeURIComponent(entry.entryId)}`,
      draft?.quantity ?? String(entry.quantity),
      constraints.quantity.copy,
    );
    const save = button(
      document,
      `import-review-save-${encodeURIComponent(entry.entryId)}`,
      'Save review',
    );
    const remove = button(
      document,
      `import-review-discard-${encodeURIComponent(entry.entryId)}`,
      'Discard entry',
    );
    query.addEventListener('input', () => {
      clearMessage(editor);
      draftFor(record).query = query.value;
    });
    find.addEventListener('click', () => {
      openPrintingSearch(editor, query.value);
    });
    wantedFinish.addEventListener('change', () => {
      clearMessage(editor);
      draftFor(record).finish = wantedFinish.value;
    });
    wantedCondition.addEventListener('change', () => {
      clearMessage(editor);
      draftFor(record).condition = wantedCondition.value;
    });
    wantedQuantity.addEventListener('input', () => {
      clearMessage(editor);
      draftFor(record).quantity = wantedQuantity.value;
    });
    save.addEventListener('click', () => {
      void saveReview(editor, {
        query: query.value,
        printingId: chosenPrintingId,
        finish: wantedFinish.value,
        condition: wantedCondition.value,
        quantity: wantedQuantity.value,
      });
    });
    remove.addEventListener('click', () => {
      void removeEntry(editor);
    });
    const picker = printingPickers.get(editor.entry.key) ?? null;
    content.push(
      controlLabel(document, 'Printing search', query),
      find,
      controlLabel(document, 'Printing', chosen),
      ...(picker === null ? [] : [picker.host]),
      controlLabel(document, 'Finish', wantedFinish),
      controlLabel(document, 'Condition', wantedCondition),
      controlLabel(document, 'Quantity', wantedQuantity),
      save,
      remove,
    );
    editor.controls.replaceChildren(...content);
    resumeFocusedControl(editor.controls, focused);
  }

  /** The reviewed values one entry exposes before its confirmation is decided. */
  function reviewedContent(record: CardListPendingRecord): Node {
    const entry = record.entry;
    const values = document.createElement('span');
    values.dataset.uiImportReview = entry.entryId;
    const printing = document.createElement('span');
    printing.dataset.uiImportPrinting = '';
    printing.textContent = `Printing: ${
      record.printing === null ? 'unresolved' : printingLine(record.printing)
    }`;
    const finishLine = document.createElement('span');
    finishLine.dataset.uiImportFinish = '';
    finishLine.textContent = ` Finish: ${entry.finish ?? 'not chosen yet'}`;
    const conditionLine = document.createElement('span');
    conditionLine.dataset.uiImportCondition = '';
    conditionLine.textContent = ` Condition: ${entry.condition ?? 'unknown'}`;
    const quantityLine = document.createElement('span');
    quantityLine.dataset.uiImportQuantity = '';
    quantityLine.textContent = ` Quantity: ${entry.quantity}`;
    values.append(printing, finishLine, conditionLine, quantityLine);
    const source = entry.sourceLine;
    if (source !== null) {
      const line = document.createElement('span');
      line.dataset.uiImportSource = '';
      line.textContent = ` Source: ${sourceLineText(source)}`;
      values.append(line);
    }
    const candidates = uiImportCandidates(entry);
    if (candidates.length > 0) {
      const alternatives = document.createElement('span');
      alternatives.dataset.uiImportCandidates = '';
      alternatives.textContent = ` Candidates: ${candidates
        .map(
          (candidate) => `${candidate.printingId} (${candidate.provider}, ${candidate.evidence})`,
        )
        .join('; ')}`;
      values.append(alternatives);
    }
    return values;
  }

  /**
   * Presents the printings one entry's review may choose through the supplied picker: the row's
   * search describes the list once, and a further search refines the window it holds. The list
   * owns matching, ordering, continuation and the recovery of a failed page, so an exact printing
   * beyond the first page stays reachable (docs/search.md#freshness, docs/ui/editors.md#interface).
   */
  function openPrintingSearch(editor: UiImportEntryEditor, text: string): void {
    const record = pendingRecord(editor.entry.key);
    if (record === null) {
      return;
    }
    const wanted = text.trim();
    if (wanted.length === 0) {
      report(editor, 'Enter a card name to find its printings.');
      return;
    }
    clearMessage(editor);
    draftFor(record).query = text;
    const context: CardListPickerQuery = { text: wanted, level: 'printing' };
    const existing = printingPickers.get(editor.entry.key);
    if (existing === undefined) {
      composePrintingPicker(editor, context);
      return;
    }
    existing.host.hidden = false;
    existing.list.refine(context);
    paintEditor(editor);
  }

  /** Mounts the picker of one entry's printing search. */
  function composePrintingPicker(editor: UiImportEntryEditor, context: CardListPickerQuery): void {
    const host = document.createElement('div');
    host.dataset.uiImportPrintingPicker = editor.entry.key;
    const list = options.cardViews.picker<CardListPickerQuery>({
      container: host,
      create: options.cardList.create,
      source: bindings.pickerQuery(),
      context,
      accountId: options.accountId,
      pageSize: UI_LIMITS.importPrintings,
      fragments: { tools: printingChoicesReader() },
      choice: { id: 'choose-printing', label: 'Use this printing' },
      onChoose: (selection) => {
        void choosePrinting(editor, selection);
      },
      signal: options.signal,
    });
    printingPickers.set(editor.entry.key, { host, list });
    paintEditor(editor);
  }

  /** Availability of the picker's choice for the printings one entry's search presents. */
  function printingChoicesReader(): CardListFragmentReader<readonly string[]> {
    return {
      read(request) {
        return Promise.resolve(
          request.keys.map((key) => ({
            key,
            status: 'ready' as const,
            values: key.startsWith('printing:') ? ['choose-printing'] : [],
          })),
        );
      },
    };
  }

  /**
   * Takes the printing the picker's explicit selection names into the entry's review draft and
   * reads its record, so the finish control follows the finishes that printing offers.
   */
  async function choosePrinting(
    editor: UiImportEntryEditor,
    selection: CardListToolSelection,
  ): Promise<void> {
    const record = pendingRecord(editor.entry.key);
    const target = selection.targets.find((candidate) => candidate.kind === 'printing');
    if (disposed || record === null || target?.kind !== 'printing') {
      return;
    }
    clearMessage(editor);
    const draft = draftFor(record);
    draft.printingId = target.printingId;
    const picker = printingPickers.get(editor.entry.key);
    if (picker !== undefined) {
      picker.host.hidden = true;
    }
    await learnPrinting(record.entry.entryId, target.printingId);
    const known = knownPrinting(
      record,
      printings.get(record.entry.entryId) ?? [],
      target.printingId,
    );
    if (known !== null && !known.finishes.includes(draft.finish as Finish)) {
      draft.finish = '';
    }
    paintEditor(editor);
  }

  /**
   * Reads the record of one printing the review chose; a read that fails leaves the catalog's
   * published finish vocabulary standing instead of blocking the review.
   */
  async function learnPrinting(entryId: string, printingId: string): Promise<void> {
    const known = printings.get(entryId) ?? [];
    const token = `${entryId}\u0000${printingId}`;
    if (
      known.some((printing) => printing.printingId === printingId) ||
      learnedPrintings.has(token)
    ) {
      return;
    }
    learnedPrintings.add(token);
    try {
      const resolved = await resolvePrintings(options.catalog, [printingId]);
      const record = resolved.get(printingId) ?? null;
      if (disposed || record === null) {
        return;
      }
      const current = printings.get(entryId) ?? [];
      if (!current.some((printing) => printing.printingId === printingId)) {
        printings.set(entryId, [...current, record]);
        boundByWindow(printings);
      }
      for (const editor of editors.values()) {
        if (pendingRecord(editor.entry.key)?.entry.entryId === entryId) {
          paintEditor(editor);
        }
      }
    } catch {
      // The published finish vocabulary stays usable while the record is unavailable.
    }
  }

  /** Releases the printing picker of one entry, if it is mounted. */
  function releasePrintingPicker(entryKey: string): void {
    const picker = printingPickers.get(entryKey);
    if (picker === undefined) {
      return;
    }
    printingPickers.delete(entryKey);
    picker.list.dispose();
    picker.host.remove();
  }

  /**
   * Saves one entry's reviewed printing, finish, condition and quantity under the revision the
   * review read. A conflict keeps the draft for review; a lost response keeps it too and reloads
   * the stored values instead of presenting the review as saved.
   */
  async function saveReview(
    editor: UiImportEntryEditor,
    submitted: Readonly<UiReviewDraft>,
  ): Promise<void> {
    const record = pendingRecord(editor.entry.key);
    if (record === null) {
      return;
    }
    const printingId = submitted.printingId.length > 0 ? submitted.printingId : null;
    if (printingId === null) {
      report(editor, 'Choose the printing this entry describes.');
      return;
    }
    const wantedFinish = readFinishValue(submitted.finish);
    if (submitted.finish.length > 0 && wantedFinish === null) {
      report(editor, 'Choose the finish of the printing.');
      return;
    }
    const wantedQuantity = readQuantityValue(submitted.quantity, constraints.quantity.copy);
    if (wantedQuantity === null) {
      report(editor, `Choose a quantity from 1 to ${constraints.quantity.copy}.`);
      return;
    }
    let chosenPrinting = knownPrinting(
      record,
      printings.get(record.entry.entryId) ?? [],
      printingId,
    );
    if (chosenPrinting === null) {
      try {
        chosenPrinting =
          (await resolvePrintings(options.catalog, [printingId])).get(printingId) ?? null;
      } catch (cause) {
        if (!disposed && sessionId === record.entry.sessionId) {
          report(
            editor,
            `The selected printing could not be read: ${readMessage(cause, 'unknown failure')}`,
          );
        }
        return;
      }
    }
    if (disposed) {
      return;
    }
    const resolvedFinish = wantedFinish ?? firstFinish(chosenPrinting);
    if (chosenPrinting === null || resolvedFinish === null) {
      report(editor, 'The selected printing is unavailable. Find its printing before saving.');
      return;
    }
    const outcome = await reviewImportEntry(
      access,
      {
        entryId: record.entry.entryId,
        expectedRevision: record.entry.revision,
        printingId,
        finish: resolvedFinish,
        condition: readConditionValue(submitted.condition),
        quantity: wantedQuantity,
      },
      options.signal,
    );
    if (disposed) {
      return;
    }
    if (outcome.status === 'committed' && outcome.record !== null) {
      // Only the input this review committed leaves; a draft the owner changed while the request
      // was in flight stays for the next review.
      const draft = drafts.get(record.entry.entryId);
      if (draft !== undefined && sameReviewDraft(draft, submitted)) {
        drafts.delete(record.entry.entryId);
      }
      report(editor, 'Review saved.');
      adoptSession(outcome.record.session);
      // The committed review reacquires the stored values and the printing the entry now names
      // through CardList's own change invalidation; the view owns no repair read of the list.
      return;
    }
    report(editor, outcome.message ?? 'The review was not saved.');
    if (outcome.status !== 'failed') {
      // A conflict or a lost response: the stored values are read again for review.
      await reconcile();
      if (disposed) {
        return;
      }
      pending?.reloadFragment(editor.entry.key, 'tools');
    }
  }

  /** Discards one pending entry after a brief confirmation; no copy is created. */
  async function removeEntry(editor: UiImportEntryEditor): Promise<void> {
    const record = pendingRecord(editor.entry.key);
    if (record === null) {
      return;
    }
    const accepted = await options.dialogs.confirm({
      title: 'Discard this pending entry?',
      message: 'The entry ends without creating a copy.',
      confirmLabel: 'Discard entry',
      cancelLabel: 'Keep it',
    });
    if (!accepted || disposed) {
      return;
    }
    const outcome = await discardImportEntry(
      access,
      { entryId: record.entry.entryId, expectedRevision: record.entry.revision },
      options.signal,
    );
    if (disposed) {
      return;
    }
    if (outcome.status === 'committed') {
      drafts.delete(record.entry.entryId);
      printings.delete(record.entry.entryId);
      releasePrintingPicker(editor.entry.key);
      messages.delete(editor.entry.key);
    } else {
      report(editor, outcome.message ?? 'The entry was not discarded.');
    }
    await reconcile(outcome.status !== 'committed');
  }

  /** Discards every pending entry of the presented import after a brief confirmation. */
  async function discardImport(): Promise<void> {
    const presentedSession = sessionId;
    const current = session;
    if (presentedSession === null || current === null) {
      reviewStatus.textContent = 'Read the pending import before discarding it.';
      return;
    }
    const accepted = await options.dialogs.confirm({
      title: 'Discard this import?',
      message: 'Every pending entry of this import ends without creating a copy.',
      confirmLabel: 'Discard import',
      cancelLabel: 'Keep it',
    });
    if (!accepted || disposed) {
      return;
    }
    const outcome = await discardImportSession(
      access,
      { sessionId: presentedSession, expectedRevision: current.revision },
      options.signal,
    );
    if (disposed) {
      return;
    }
    reviewStatus.textContent =
      outcome.status === 'committed'
        ? 'The import was discarded; no copies were created.'
        : (outcome.message ?? 'The import was not discarded.');
    if (outcome.status === 'committed' && presentedSession === sessionId) {
      // Only the discarded import's own review input ends; the unsaved work of another import the
      // view still presents stays (docs/ui/architecture.md#state-ownership-and-restoration).
      forgetPresentedEntries();
      paintConfirmation();
    }
    await reconcile(outcome.status !== 'committed');
  }

  /** Drops the drafts, searches and messages of the presented import's loaded entries. */
  function forgetPresentedEntries(): void {
    for (const key of pendingEntries?.keys() ?? []) {
      const record = pendingRecord(key);
      if (record === null) {
        continue;
      }
      drafts.delete(record.entry.entryId);
      printings.delete(record.entry.entryId);
      releasePrintingPicker(key);
      messages.delete(key);
    }
    selectedRevisions.clear();
  }

  /** Confirms the selected entries and presents the copies its receipt names. */
  async function confirmSelection(request: UiActionRequest): Promise<UiOperationOutcome> {
    if (confirming || recovering || confirmation !== null) {
      return {
        status: 'failed',
        message: 'Check the outstanding confirmation outcome before confirming more entries.',
      };
    }
    const presentedSession = sessionId;
    if (presentedSession === null) {
      return { status: 'failed', message: 'Read the pending import before confirming it.' };
    }
    const chosen: ConfirmImportEntryInput[] = [];
    for (const target of request.selection.targets) {
      if (target.kind !== 'pending') {
        continue;
      }
      const key = cardListEntryKey(target);
      // The reviewed revision the review read with the row, or the one it keeps for an explicit
      // selection outside the loaded window.
      const revision = reviewedRevision(key, target.entryId);
      if (revision === null) {
        return {
          status: 'failed',
          message: 'Reload the pending import before confirming these entries.',
        };
      }
      chosen.push({ entryId: target.entryId, expectedRevision: revision });
    }
    if (chosen.length === 0) {
      return { status: 'failed', message: 'Select the entries to confirm.' };
    }
    // One request confirms at most the number of entries the provider bound accepts, so a larger
    // explicit selection is confirmed through further bounded requests whose operation identities
    // stay with the entries they cover (docs/user-cards.md#interface).
    confirming = true;
    paintConfirmation();
    let copies = 0;
    let note: string | null = null;
    let reported: UiOperationOutcome | null = null;
    try {
      for (const entries of inBatches(chosen, constraints.batch.confirmEntries)) {
        // The provider owns the operation identity; the review presents the attempt while its
        // outcome is not established, so a lost response is recovered through its receipt.
        const operation: UiConfirmationDraft = {
          sessionId: presentedSession,
          entries,
          operation: access.confirm({ sessionId: presentedSession, entries }, request.signal),
        };
        confirmation = operation;
        paintConfirmation();
        const outcome = await confirmImport(operation.operation);
        if (disposed) {
          return { status: 'unknown', message: null };
        }
        if (outcome.status !== 'unknown' && confirmation === operation) {
          confirmation = null;
          paintConfirmation();
        }
        if (outcome.status !== 'committed' || outcome.record === null) {
          reported = {
            status: outcome.status,
            message:
              copies === 0
                ? outcome.message
                : `${confirmationMessage(copies, note)} ${
                    outcome.message ?? 'The remaining entries were not confirmed.'
                  }`,
          };
          break;
        }
        copies += outcome.record.copies.length;
        note ??= outcome.message;
        forgetConfirmed(operation);
      }
    } finally {
      confirming = false;
      paintConfirmation();
    }
    if (reported !== null) {
      // The reviewed revisions changed under the selection, or a request failed: the view
      // presents the stored entries again before another confirmation.
      void reconcile();
      return reported;
    }
    const message = confirmationMessage(copies, note);
    reviewStatus.textContent = message;
    void reconcile(false);
    return { status: 'committed', message };
  }

  /** Clears only the selection and drafts covered by this established confirmation. */
  function forgetConfirmed(operation: UiConfirmationDraft): void {
    for (const entry of operation.entries) {
      const key = cardListEntryKey({ kind: 'pending', entryId: entry.entryId });
      if (sessionId === operation.sessionId) {
        pending?.setSelected(key, false);
        selectedRevisions.delete(key);
      }
      drafts.delete(entry.entryId);
      printings.delete(entry.entryId);
      releasePrintingPicker(key);
    }
  }

  /** Updates the presented session counts after a change that reported them. */
  function adoptSession(changed: ImportSession): void {
    sessions = sessions.map((candidate) =>
      candidate.sessionId === changed.sessionId ? changed : candidate,
    );
    if (changed.sessionId !== sessionId) {
      paintSessions();
      return;
    }
    session = changed;
    paintSessions();
    discard.disabled = changed.state !== 'pending';
    if (changed.state !== 'pending') {
      // Every entry of the presented import is decided: the review moves to an import that still
      // has pending entries instead of presenting a finished one.
      present(defaultSessionId(sessions.filter((one) => one.pendingEntries > 0)));
      if (confirmation !== null && confirmation.sessionId === changed.sessionId) {
        // The entries of the kept confirmation are no longer pending, so its recorded outcome
        // decides whether they created copies (docs/user-interface.md#source-imports).
        void recoverPendingConfirmation();
      }
    }
  }

  /** The reviewed revision of one selected entry: the record the review read or its kept one. */
  function reviewedRevision(key: string, entryId: string): number | null {
    const record = pendingRecord(key);
    if (record !== null && record.entry.entryId === entryId) {
      return record.entry.revision;
    }
    const kept = selectedRevisions.get(key);
    return kept !== undefined && kept.entryId === entryId ? kept.revision : null;
  }

  /**
   * The confirmation context of the explicit selection: the reviewed revision of every selected
   * entry the review read, taken from its record or from the revision kept beside it.
   */
  function selectionContext(): ReadonlyMap<string, UiSelectedReview> {
    const context = new Map<string, UiSelectedReview>();
    for (const key of pending?.selection ?? []) {
      const record = pendingRecord(key);
      const known =
        record === null
          ? selectedRevisions.get(key)
          : { entryId: record.entry.entryId, revision: record.entry.revision };
      if (known !== undefined) {
        context.set(key, known);
      }
    }
    return context;
  }

  /** The provider record of one pending entry key this visit's binding read, or null. */
  function pendingRecord(key: string): CardListPendingRecord | null {
    return pendingEntries?.record(key) ?? null;
  }

  /** Shows the recovery control while a confirmation's outcome is not yet established. */
  function paintConfirmation(): void {
    const outstanding = confirmation !== null;
    recover.hidden = !outstanding;
    recover.disabled = !outstanding || confirming || recovering;
  }

  /**
   * Reads the recorded outcome of the confirmation the review kept, independently of the current
   * selection and of whether the entries it covered are still pending
   * (docs/application.md#construction-and-request-boundary).
   */
  async function recoverPendingConfirmation(): Promise<void> {
    const outstanding = confirmation;
    if (outstanding === null || confirming || recovering) {
      return;
    }
    recovering = true;
    paintConfirmation();
    let outcome: UiChangeCommit<ImportReceipt>;
    try {
      outcome = await recoverConfirmation(outstanding.operation, options.signal);
    } finally {
      recovering = false;
      paintConfirmation();
    }
    if (disposed || confirmation !== outstanding) {
      return;
    }
    if (outcome.status !== 'unknown') {
      confirmation = null;
      paintConfirmation();
    }
    if (outcome.status === 'committed' && outcome.record !== null) {
      forgetConfirmed(outstanding);
      const message = confirmationMessage(outcome.record.copies.length, outcome.message);
      reviewStatus.textContent = message;
      void reconcile(false);
      return;
    }
    reviewStatus.textContent = outcome.message ?? 'The confirmation outcome could not be read.';
  }

  /** Keeps one message with its entry, so a redraw of the row presents it again. */
  function report(editor: UiImportEntryEditor, message: string): void {
    messages.set(editor.entry.key, message);
    boundByWindow(messages);
    (editors.get(editor.entry.key) ?? editor).status.textContent = message;
  }

  /** Drops the message of one entry when its owner edits the reviewed values again. */
  function clearMessage(editor: UiImportEntryEditor): void {
    messages.delete(editor.entry.key);
    (editors.get(editor.entry.key) ?? editor).status.textContent = '';
  }

  /**
   * The unsaved review input of one entry, created from the values the review presented when the
   * owner first edits one of them: reviewing a single attribute keeps every other stored value of
   * that entry (docs/user-interface.md#capture-and-review).
   */
  function draftFor(record: CardListPendingRecord): UiReviewDraft {
    const entry = record.entry;
    const existing = drafts.get(entry.entryId);
    if (existing !== undefined) {
      return existing;
    }
    const created: UiReviewDraft = {
      query: '',
      printingId: entry.printingId ?? '',
      finish: entry.finish ?? '',
      condition: entry.condition ?? '',
      quantity: String(entry.quantity),
    };
    drafts.set(entry.entryId, created);
    boundByWindow(drafts);
    return created;
  }

  /**
   * Only records in the current read sequence establish pending availability. Retained selected
   * revisions are action context, not evidence of continued existence.
   */
  function pendingToolsReader(): CardListFragmentReader<readonly string[]> {
    return {
      read(request) {
        return Promise.resolve(
          request.keys.map((key) => ({
            key,
            status: 'ready' as const,
            values: pendingRecord(key) !== null ? ['confirm-import'] : [],
          })),
        );
      },
    };
  }

  /** The action that confirms the explicit selected pending entries. */
  function confirmAction(): UiOperationAction {
    return {
      id: 'confirm-import',
      label: 'Confirm selected',
      apply: (request) => confirmSelection(request),
    };
  }

  /**
   * Confirms the explicit selected entries and presents the pending state and outcome the provider
   * established. A confirmation that was not established keeps its retained attempt visible for
   * the explicit recovery (docs/ui/editors.md#drafts-and-asynchronous-outcomes).
   */
  async function applyPendingConfirmation(intent: UiActionIntent): Promise<void> {
    if (disposed) {
      return;
    }
    pendingStatus.removeAttribute('data-ui-outcome-status');
    pendingStatus.textContent = 'Confirming…';
    const outcome = await applyAction(confirmAction(), {
      selection: intent.selection,
      signal: options.signal,
    });
    if (disposed) {
      return;
    }
    pendingStatus.dataset.uiOutcomeStatus = outcome.status;
    pendingStatus.textContent = outcome.message ?? outcomeText(outcome.status);
  }

  /**
   * Reloads the pending sessions the review owns, and the presented entries when no committed
   * change covers them: the view never repairs a list the change notification already reacquires
   * (docs/card-list.md#loading-and-recovery).
   */
  async function reconcile(refreshEntries = true): Promise<void> {
    await readSessions(null, false);
    if (disposed) {
      return;
    }
    if (sessionId === null) {
      // No import was presented yet: the review opens the one the account has pending.
      present(defaultSessionId(sessions));
      return;
    }
    const listed = sessions.some((one) => one.sessionId === sessionId);
    if (!listed && session !== null && session.pendingEntries === 0) {
      // The presented import has no pending entries left: the review moves to an import that still
      // has some.
      present(defaultSessionId(sessions));
      return;
    }
    if (refreshEntries) {
      pending?.refresh();
    }
  }

  /**
   * Takes one capture change into the review. A staged observation is presented in its capture
   * session, so the candidate the success cue announced is visible in review; late alternatives
   * reload the session that holds them when the review presents it; an unknown outcome re-reads
   * what the provider holds instead of inferring an entry.
   */
  async function reconcileCapture(change: CaptureReviewChange): Promise<void> {
    if (change.kind === 'unknown') {
      pending?.refresh();
      await readSessions(null, false);
      return;
    }
    if (change.session.sessionId !== sessionId) {
      if (change.kind === 'attached') {
        // The updated entry belongs to an import the review does not present; its counts stay
        // current while the presented review keeps its own window.
        await readSessions(null, false);
        return;
      }
      await readSessions(null, false);
      if (disposed) {
        return;
      }
      present(change.session.sessionId);
      return;
    }
    adoptSession(change.session);
    // A committed capture change reacquires the pending entries through CardList's own change
    // invalidation; the view owns no repair read of the list.
  }

  /** The confirmation the provider still tracks for this account, or null when none is open. */
  function retainedConfirmation(): UiConfirmationDraft | null {
    for (const attempt of access.retained()) {
      if (attempt.kind === 'confirmImport') {
        return {
          sessionId: attempt.request.sessionId,
          entries: attempt.request.entries,
          operation: attempt,
        };
      }
    }
    return null;
  }
}

/** The pending list state of one retained review, or null when it carries none. */
function readRetainedPending(
  value: unknown,
  sessionId: string | null,
): { readonly sessionId: string; readonly list: CardListRetained<string> | undefined } | null {
  const record = readState(value);
  const retainedSession = readSessionId(record?.sessionId);
  if (record === null || retainedSession === null || retainedSession !== sessionId) {
    return null;
  }
  return { sessionId: retainedSession, list: readRetainedList<string>(record) };
}

/* --------------------------------------------------------------------------------------------
 * Source import
 * ------------------------------------------------------------------------------------------ */

export interface UiSourceImportEditorOptions extends UiImportEditorContext {
  /** Page state a previous visit retained; the editor reads only its own field. */
  readonly restored?: Readonly<Record<string, unknown>> | null;
  /** Presents the import whose rows a source read back, so the review presents it. */
  readonly onStaged: (sessionId: string) => void;
  /** Reports that an outcome was not established, so the review re-reads what is held. */
  readonly onChanged: () => void;
}

/** The source import editor: one method at a time, its rows and the waiting retained imports. */
export interface UiSourceImportEditor {
  readonly nodes: readonly Node[];
  readonly enabled: boolean;
  capture(): UiSourceDraft | null;
  dispose(): void;
}

export function createSourceImportEditor(
  options: UiSourceImportEditorOptions,
): UiSourceImportEditor {
  const document = options.document;
  const access = options.access;
  const constraints = options.constraints;
  const restored = options.restored ?? null;
  const sourceEnabled = constraints.operations.includes('stageSourceImport');
  const source = readSourceDraft(restored?.source, constraints.text);
  let disposed = options.signal.aborted;
  options.signal.addEventListener(
    'abort',
    () => {
      disposed = true;
    },
    { once: true },
  );
  /** Whether a source is being parsed or a waiting import reopened; one import in flight. */
  let sourcing = false;
  let reopening = false;

  const heading = text(document, 'h3', 'import-source-heading', 'Import a source');
  const form = document.createElement('form');
  form.id = 'import-source';
  const format = select(
    document,
    uiSourceFormats.map((value) => ({ value, label: uiImportSourceLabel(value) })),
    source.format,
  );
  format.id = 'import-source-format';
  const sourceText = textArea(
    document,
    'import-source-text',
    source.text,
    constraints.text.sourceText,
  );
  const sourceUrl = textInput(document, 'import-source-url', source.url);
  sourceUrl.type = 'url';
  sourceUrl.maxLength = constraints.text.sourceReference;
  sourceUrl.placeholder = 'https://moxfield.com/decks/…';
  const sourceIdentity = textInput(document, 'import-source-identity', source.identity);
  sourceIdentity.maxLength = constraints.text.identifier;
  sourceIdentity.placeholder = 'wizards:mkm:deadly-disguise:regular:en';
  const sourceReference = textInput(document, 'import-source-reference', source.reference);
  sourceReference.type = 'url';
  sourceReference.maxLength = constraints.text.sourceReference;
  sourceReference.placeholder = 'https://magic.wizards.com/en/news/feature/decklist';
  const sourceLines = textArea(
    document,
    'import-source-lines',
    source.lines,
    constraints.text.sourceText,
  );
  const formatField = controlLabel(document, 'Source method', format);
  const textField = controlLabel(document, 'Card lines', sourceText);
  const urlField = controlLabel(document, 'Moxfield deck link', sourceUrl);
  const identityField = controlLabel(document, 'Source identity', sourceIdentity);
  const referenceField = controlLabel(document, 'Official decklist link', sourceReference);
  const linesField = controlLabel(document, 'Reviewed lines', sourceLines);
  const submit = submitButton(document, 'import-source-submit', 'Add source to review');
  form.append(formatField, textField, urlField, identityField, referenceField, linesField, submit);
  const status = statusLine(document, 'import-source-status');
  const rows = document.createElement('ul');
  rows.id = 'import-source-rows';
  // Unfinished source imports stay with UserCards: the editor presents each retained attempt and
  // the explicit reopen action that reads its recorded rows, instead of deciding an import's
  // identity from the contents or the URL the form holds
  // (docs/user-cards.md#browser-operation-lifecycle, docs/ui/editors.md#internal-design).
  const waiting = document.createElement('ul');
  waiting.id = 'import-source-waiting';
  const sourceNote = note(
    document,
    'Parsing a source only stages pending entries. Confirm the reviewed lines to create ' +
      'their physical copies.',
  );
  sourceNote.id = 'import-source-note';
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void importSource();
  });
  format.addEventListener('change', () => {
    // The rows of another method's import do not describe this one, so they are cleared while the
    // input of the presented method keeps the import it already composes.
    status.textContent = '';
    rows.replaceChildren();
    paintForm();
    paintWaiting();
  });
  paintForm();
  paintWaiting();

  return {
    nodes: sourceEnabled ? [heading, form, status, waiting, rows, sourceNote] : [],
    enabled: sourceEnabled,
    capture: () =>
      sourceEnabled
        ? {
            format: format.value as UiSourceFormat,
            text: sourceText.value,
            url: sourceUrl.value,
            identity: sourceIdentity.value,
            reference: sourceReference.value,
            lines: sourceLines.value,
          }
        : null,
    dispose: () => {
      disposed = true;
    },
  };

  /**
   * Draws the fields of the selected source method. Only the fields the method needs are
   * presented: the others keep their drafts but end outside this method's submission, so a value
   * they hold cannot refuse a request the presented method describes.
   */
  function paintForm(): void {
    const wanted = readSourceFormat(format.value);
    const pasted = wanted === 'pasted-list';
    const moxfield = wanted === 'moxfield';
    const wizards = wanted === 'wizards-precon';
    textField.hidden = !pasted;
    sourceText.disabled = !pasted;
    urlField.hidden = !moxfield;
    sourceUrl.disabled = !moxfield;
    identityField.hidden = !wizards;
    sourceIdentity.disabled = !wizards;
    referenceField.hidden = !wizards;
    sourceReference.disabled = !wizards;
    linesField.hidden = !wizards;
    sourceLines.disabled = !wizards;
    submit.disabled = sourcing || reopening;
    submit.textContent = sourcing ? 'Reading the source…' : 'Add source to review';
  }

  /**
   * Presents every unfinished source import the account retains: the input each attempt was begun
   * with and the explicit reopen action that reads the rows the provider recorded. A new-import
   * submission and a reopen are distinct intents, so the form never decides which identity an
   * input composes (docs/ui/editors.md#internal-design, docs/user-cards.md#browser-operation-lifecycle).
   */
  function paintWaiting(): void {
    if (!sourceEnabled) {
      return;
    }
    const attempts = unfinishedSources();
    waiting.replaceChildren(
      ...attempts.map((attempt) => {
        const item = document.createElement('li');
        item.dataset.uiSourceWaiting = attempt.operationId;
        const label = document.createElement('span');
        label.textContent = unfinishedSourceLabel(attempt.request);
        const reopen = button(
          document,
          `import-source-reopen-${encodeURIComponent(attempt.operationId)}`,
          'Reopen this import',
        );
        reopen.addEventListener('click', () => {
          void reopenSource(attempt.operationId, attempt.request);
        });
        item.append(label, reopen);
        return item;
      }),
    );
    waiting.hidden = attempts.length === 0;
  }

  /** The unfinished source imports the account retains, oldest first. */
  function unfinishedSources(): readonly UiSourceImportAttempt[] {
    return access
      .retained()
      .flatMap((attempt) => (attempt.kind === 'stageSourceImport' ? [attempt] : []));
  }

  /** Reports one problem of the source form before any import is dispatched. */
  function report(problem: string): void {
    status.textContent = problem;
    rows.replaceChildren();
  }

  /**
   * The source input the form presents, or null after reporting what it still needs. The editor
   * names the import this input composes when it dispatches the request, so the provider
   * reconciles the rows with that import's own records instead of inferring an import from the
   * entered contents or the source URL (docs/user-interface.md#source-imports).
   */
  function sourceInput(): UiSourceInput | null {
    const wanted = readSourceFormat(format.value);
    if (wanted === null) {
      report('Choose the source method to import.');
      return null;
    }
    if (wanted === 'pasted-list') {
      if (sourceText.value.trim().length === 0) {
        report('Paste the card lines of the list first.');
        return null;
      }
      return { format: wanted, text: sourceText.value };
    }
    if (wanted === 'moxfield') {
      const url = sourceUrl.value.trim();
      if (url.length === 0) {
        report('Enter the public Moxfield deck link first.');
        return null;
      }
      return { format: wanted, url };
    }
    const identity = sourceIdentity.value.trim();
    if (identity.length === 0) {
      report('Name the reviewed product as wizards:<edition>:<product>:<variant>:<language>.');
      return null;
    }
    const reference = sourceReference.value.trim();
    if (reference.length === 0) {
      report('Enter the official decklist link on magic.wizards.com first.');
      return null;
    }
    if (reviewedWizardsLines(sourceLines.value).length === 0) {
      report('Paste the reviewed decklist lines, one card per row, first.');
      return null;
    }
    return { format: wanted, identity, reference, lines: sourceLines.value };
  }

  /** The request one source input composes, under the import identity the provider owns. */
  function sourceRequest(input: UiSourceInput): UserCardsSourceImportRequest {
    switch (input.format) {
      case 'pasted-list':
        return { format: input.format, text: input.text };
      case 'moxfield':
        return { format: input.format, url: input.url };
      case 'wizards-precon':
        return {
          format: input.format,
          sourceId: input.identity,
          reference: input.reference,
          entries: reviewedWizardsLines(input.lines),
        };
    }
  }

  /**
   * Begins a new import of the source method the form presents and presents what every row
   * became. The provider never confirms ownership, so the outcome reports the lines that entered
   * review beside the ones it had already staged or acquired; a source whose response is lost
   * stays retained under the identity the provider composed for it and is reopened through the
   * waiting list instead of being submitted as another list.
   */
  async function importSource(): Promise<void> {
    if (sourcing || reopening) {
      return;
    }
    const input = sourceInput();
    if (input === null) {
      return;
    }
    const request = sourceRequest(input);
    sourcing = true;
    paintForm();
    let outcome: UiChangeCommit<SourceImportResult>;
    try {
      // The account retains the new import before its request is dispatched, so the waiting list
      // presents it while its outcome is still open (docs/user-cards.md#browser-operation-lifecycle).
      const started = beginSourceImport(access, request, options.signal);
      paintWaiting();
      outcome = await started;
    } finally {
      sourcing = false;
      paintForm();
      paintWaiting();
    }
    // A departed view must not write its old recovery snapshot over the active view's requests.
    if (disposed) {
      return;
    }
    const result = outcome.record;
    if (result === null) {
      report(outcome.message ?? 'The source lines were not added to review.');
      if (outcome.status === 'unknown') {
        // The rows may have committed: the review reads what the account holds instead of
        // inferring whether this source staged anything.
        options.onChanged();
      }
      return;
    }
    status.textContent = sourceImportMessage(result);
    rows.replaceChildren(...result.rows.map((row) => sourceRow(document, row)));
    options.onStaged(result.session.sessionId);
  }

  /**
   * Reopens one import the account still retains, under the identity that attempt was begun with.
   * Reopening reads the rows the provider recorded for that import instead of composing another
   * one, also after a reload or a return to the view (docs/user-cards.md#browser-operation-lifecycle).
   */
  async function reopenSource(
    operationId: string,
    request: UserCardsSourceImportRequest,
  ): Promise<void> {
    if (sourcing || reopening) {
      return;
    }
    reopening = true;
    paintForm();
    let outcome: UiChangeCommit<SourceImportResult>;
    try {
      outcome = await reopenSourceImport(access, operationId, request, options.signal);
    } finally {
      reopening = false;
      paintForm();
      paintWaiting();
    }
    if (disposed) {
      return;
    }
    const result = outcome.record;
    if (result === null) {
      status.textContent = outcome.message ?? 'The source lines were not read back into review.';
      return;
    }
    status.textContent = sourceImportMessage(result);
    rows.replaceChildren(...result.rows.map((row) => sourceRow(document, row)));
    options.onStaged(result.session.sessionId);
  }
}
