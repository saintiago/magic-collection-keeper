/**
 * Import page of the UserInterface (docs/user-interface.md#capture-and-review,
 * docs/user-interface.md#source-imports, docs/user-cards.md#import-and-capture-state).
 *
 * The page stages manually entered cards and parses the supported source methods as pending
 * entries, then presents the account's pending imports for review. A manual entry searches the
 * catalog for printings, and the selected printing becomes one pending entry carrying the quantity,
 * finish and condition the owner chose; a pasted list, a public Moxfield deck or a reviewed Wizards
 * list is parsed inside the provider's boundary, which reports each row's outcome — added to
 * review, already in review, already acquired from that source, or unreadable — so the page can
 * explain a repeated or partially covered import where the owner decides. A success cue means the
 * line was accepted into review, never that it is owned. Pending entries are read through the
 * supplied import operations and presented through the list boundary, each row exposing the
 * reviewed printing, finish, condition and quantity, the source line it was parsed from, its stored
 * recognition alternatives and the controls that correct them under the revision the page read. A
 * confirmation quotes the reviewed revisions under one operation identity and reports the copies
 * its receipt names; a lost response is recovered through that recorded outcome instead of being
 * presented as a saved change (docs/user-cards.md#interface).
 *
 * The page owns its form input, its per-entry review drafts and the session it presents, and keeps
 * them with its history entry. The identity of an import stays with UserCards instead: an unfinished
 * import whose response was lost keeps its input and the identity it was dispatched under across a
 * reload and a source-method change, so reopening it quotes that identity rather than composing a
 * second import, while an established import releases it and the next list the owner starts gets
 * its own identity and stays a separate import. The page presents those retained attempts and the
 * recovery control each one needs instead of remembering the identity itself
 * (docs/user-interface.md#source-imports, docs/user-cards.md#browser-operation-lifecycle). The
 * lists own their windows, selection and restoration, and the pending entries and operation
 * receipts themselves stay with UserCards. Leaving the view releases its lists and aborts their
 * work, so a late response cannot change another view or account; ending the account releases the
 * UserCards scope Application composed (docs/architecture.md#runtime-boundaries).
 */

import type { UiOperationOutcome, UiActionRequest, UiListAction } from './actions.js';

import type { SearchClient } from '../../application/index.js';
import type { CaptureReviewChange } from '../../capture/index.js';
import type { Catalog, Finish, PrintingRecord } from '../../catalog/index.js';
import type {
  ConfirmImportEntryInput,
  CopyCondition,
  ImportReceipt,
  ImportSession,
  ImportSessionListResult,
  ImportStageResult,
  ImportSourceLine,
  ReviewedWizardsLine,
  SourceImportOutcome,
  SourceImportResult,
  SourceImportRow,
} from '../../usercards/index.js';

import { createCaptureControls } from './capture.js';
import {
  cardListEntryKey,
  readableSearchPage,
  resolvePrintings,
  type CardListCatalogQuery,
  type CardListEntry,
  type CardListFragmentReader,
  type CardListPendingEntries,
  type CardListPendingRecord,
  type CardListRetained,
  type CardListTarget,
} from '../../card-list/index.js';
import { cardListBasicContent, createCardListView, type UiCardList } from './card-list.js';
import { uiCopyConditions } from './copy-edits.js';
import {
  beginSourceImport,
  confirmImport,
  createImportAccess,
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
  type UiImportLine,
} from './import-edits.js';
import { type UiChangeCommit } from './failure.js';
import type {
  UserCardsConfirmationOutcome,
  UserCardsOperation,
  UserCardsConstraints,
  UserCardsRetainedAttempt,
  UserCardsSourceImportRequest,
} from '../../usercards/browser.js';
import { UI_LIMITS } from './limits.js';
import type { UiPageDefinition } from './pages.js';
import {
  controlLabel,
  readListState,
  readPageState,
  restoredPresentation,
  selectControl,
  type UiSelectOption,
} from './page-support.js';
import { uiCatalogFinishes, uiFinishLabel } from './routes.js';

/** The one manual entry queue of an account; its lines are reviewed and confirmed like any import. */
const manualImport = {
  sessionId: 'manual',
  source: { kind: 'manual', id: 'manual' },
} as const;

/** The source methods the Import page offers, in the order its form presents them. */
const uiSourceFormats = ['pasted-list', 'moxfield', 'wizards-precon'] as const;

/** The Import page: manual entry beside the pending review and confirmation of one import. */
export function createImportPages(): readonly UiPageDefinition[] {
  return [importPage()];
}

/** Unsaved review input of one entry, kept outside the rendered controls. */
interface UiReviewDraft {
  query: string;
  printingId: string;
  finish: string;
  condition: string;
  quantity: string;
}

/** Reviewed revision of one explicitly selected entry the loaded window no longer presents. */
interface UiSelectedReview {
  readonly entryId: string;
  readonly revision: number;
}

/**
 * One source method the Import page parses into review.
 */
type UiSourceFormat = UserCardsSourceImportRequest['format'];

/** One unfinished source import the account retains, with the input it was begun with. */
type UiSourceImportAttempt = Extract<
  UserCardsRetainedAttempt,
  { readonly kind: 'stageSourceImport' }
>;

/** One unfinished manual staging the account retains, with the lines it was begun with. */
type UiStagingAttempt = Extract<UserCardsRetainedAttempt, { readonly kind: 'stageImportEntries' }>;

/** The unsaved source input of one method, before the account begins the import it describes. */
type UiSourceInput =
  | { readonly format: 'pasted-list'; readonly text: string }
  | { readonly format: 'moxfield'; readonly url: string }
  | {
      readonly format: 'wizards-precon';
      readonly identity: string;
      readonly reference: string;
      readonly lines: string;
    };

/**
 * Unsaved input of the source form. The page keeps it with its history entry so leaving and
 * returning keeps the edits to retry. The identity of an import stays with UserCards: submitting
 * this form begins a new import, and the waiting imports the account retains are reopened through
 * their own identity instead (docs/user-interface.md#source-imports).
 */
interface UiSourceDraft {
  format: UiSourceFormat;
  text: string;
  url: string;
  identity: string;
  reference: string;
  lines: string;
}

/**
 * One outstanding confirmation the page presents until UserCards establishes its outcome. The
 * provider-owned operation keeps the identity and the input; the page keeps the handles it must
 * present messages for and the entries a resolved confirmation covers.
 */
interface UiConfirmationDraft {
  /** Import session the confirmed entries belong to. */
  readonly sessionId: string;
  readonly entries: readonly ConfirmImportEntryInput[];
  /** The provider-owned operation whose recorded outcome decides this confirmation. */
  readonly operation: UserCardsOperation<'confirmImport', UserCardsConfirmationOutcome>;
}

/** One presented pending-entry editor, redrawn as its draft or its stored record changes. */
interface UiImportEditor {
  readonly controls: HTMLSpanElement;
  readonly entry: CardListEntry;
  readonly status: HTMLParagraphElement;
}

function importPage(): UiPageDefinition {
  return {
    page: 'import',
    mount(container, context) {
      const document = container.ownerDocument;
      const operations = context.capabilities.userCards.account(context.account.accountId);
      const access = createImportAccess(operations);
      const constraints = operations.constraints;
      const catalog = context.capabilities.catalog;
      const search = context.capabilities.search;
      const restored = readPageState(context.restored?.state);
      const presented = Promise.withResolvers<void>();
      // A page whose presentation the shell never awaits must still not surface a rejection.
      presented.promise.catch(() => {});
      let closed = false;
      context.signal.addEventListener(
        'abort',
        () => {
          closed = true;
        },
        { once: true },
      );

      const manualHeading = text(document, 'h3', 'import-manual-heading', 'Manual entry');
      const manualForm = document.createElement('form');
      manualForm.id = 'import-manual';
      const manual = readManualDraft(restored?.manual);
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
      const manualSubmit = submitButton(document, 'import-manual-submit', 'Find cards');
      manualForm.append(
        controlLabel(document, 'Card', query),
        controlLabel(document, 'Quantity', quantity),
        controlLabel(document, 'Finish', finish),
        controlLabel(document, 'Condition', condition),
        manualSubmit,
      );
      const manualStatus = statusLine(document, 'import-manual-status');
      // A manual staging whose response was lost stays retained with UserCards; the page presents
      // that attempt and the explicit retry it needs instead of keeping the identity itself
      // (docs/user-cards.md#browser-operation-lifecycle).
      const manualRecovery = document.createElement('p');
      manualRecovery.id = 'import-manual-recovery';
      const manualRecoveryNote = document.createElement('span');
      manualRecoveryNote.textContent = 'A manual staging attempt is waiting for its outcome.';
      const manualRecover = button(document, 'import-manual-recover', 'Retry pending staging');
      manualRecovery.append(manualRecoveryNote, manualRecover);
      const resultsHost = document.createElement('div');
      resultsHost.id = 'import-results';
      const resultsHeading = text(document, 'h3', 'import-results-heading', 'Add a printing');

      // Source imports are the deployment's capability: when the provider publishes no staging
      // operation, the page presents no method the backend would refuse
      // (docs/user-interface.md#source-imports, docs/user-cards.md#browser-operation-lifecycle).
      const sourceEnabled = constraints.operations.includes('stageSourceImport');
      const source = readSourceDraft(restored?.source, constraints.text);
      const sourceHeading = text(document, 'h3', 'import-source-heading', 'Import a source');
      const sourceForm = document.createElement('form');
      sourceForm.id = 'import-source';
      const sourceFormat = select(
        document,
        uiSourceFormats.map((format) => ({
          value: format,
          label: uiImportSourceLabel(format),
        })),
        source.format,
      );
      sourceFormat.id = 'import-source-format';
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
      const formatField = controlLabel(document, 'Source method', sourceFormat);
      const textField = controlLabel(document, 'Card lines', sourceText);
      const urlField = controlLabel(document, 'Moxfield deck link', sourceUrl);
      const identityField = controlLabel(document, 'Source identity', sourceIdentity);
      const referenceField = controlLabel(document, 'Official decklist link', sourceReference);
      const linesField = controlLabel(document, 'Reviewed lines', sourceLines);
      const sourceSubmit = submitButton(document, 'import-source-submit', 'Add source to review');
      sourceForm.append(
        formatField,
        textField,
        urlField,
        identityField,
        referenceField,
        linesField,
        sourceSubmit,
      );
      const sourceStatus = statusLine(document, 'import-source-status');
      const sourceRows = document.createElement('ul');
      sourceRows.id = 'import-source-rows';
      // Unfinished source imports stay with UserCards: the page presents each retained attempt and
      // the explicit reopen action that reads its recorded rows, instead of deciding an import's
      // identity from the contents or the URL the form holds
      // (docs/user-cards.md#browser-operation-lifecycle, docs/ui/editors.md#internal-design).
      const sourceWaiting = document.createElement('ul');
      sourceWaiting.id = 'import-source-waiting';
      const sourceNote = note(
        document,
        'Parsing a source only stages pending entries. Confirm the reviewed lines to create ' +
          'their physical copies.',
      );
      sourceNote.id = 'import-source-note';

      // Hands-free camera capture feeds the same pending review as manual entry: the page binds
      // one Capture session to this account and one pending import, presents its controls and
      // disposes it with the view, releasing the camera and the Recognition session
      // (docs/ui/capture-controls.md, docs/capture.md#interface).
      const capture = createCaptureControls({
        document,
        capture: context.capabilities.capture,
        accountId: context.account.accountId,
        importId: context.capabilities.capture.createImportId(),
        device: context.device,
        signal: context.signal,
        reviewChanged: (change) => {
          void reconcileCapture(change);
        },
      });

      const reviewHeading = text(document, 'h3', 'import-review-heading', 'Pending review');
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
      const pendingHost = document.createElement('div');
      pendingHost.id = 'import-pending';
      const discard = button(document, 'import-discard-session', 'Discard this import');
      discard.disabled = true;
      container.append(
        manualHeading,
        manualForm,
        manualStatus,
        manualRecovery,
        resultsHeading,
        resultsHost,
        ...(sourceEnabled
          ? [sourceHeading, sourceForm, sourceStatus, sourceWaiting, sourceRows, sourceNote]
          : []),
        capture.element,
        reviewHeading,
        controlLabel(document, 'Import', sessionSelect),
        provenance,
        sessionsMore,
        refresh,
        recover,
        reviewStatus,
        pendingHost,
        discard,
      );

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
       * CardList binding of the presented import: it owns the pending-entry read, its translation
       * and the provider records the review's editors read under an entry's own key
       * (docs/card-list.md#required-interfaces-and-source-bindings).
       */
      let pendingEntries: CardListPendingEntries | null = null;
      /**
       * Reviewed revision of every explicitly selected entry the page has read, kept while the
       * selection names it so a confirmation covers entries outside the loaded window
       * (docs/user-interface.md#state-ownership-and-restoration).
       */
      const selectedRevisions = readSelectedRevisions(restored?.selection);
      /** Per-entry messages the page presents, kept across the redraws of their editor. */
      const messages = new Map<string, string>();
      /**
       * Editor the page currently presents per entry. A redraw replaces the editor's controls, so
       * a message reported after an operation reaches the controls the page presents now.
       */
      const editors = new Map<string, UiImportEditor>();
      /** Printings one row's own search offered, keyed by entry identity. */
      const printings = new Map<string, readonly PrintingRecord[]>();
      /** Current search per entry; editing its query or leaving its session retires the request. */
      const printingSearches = new Map<string, symbol>();
      /** Unsaved review input per entry, kept across redraws and with the history entry. */
      const drafts = readReviewDrafts(restored?.review);
      let confirmation = retainedConfirmation();
      let results: UiCardList<CardListCatalogQuery> | null = null;
      let pending: UiCardList<string> | null = null;
      /** Whether a confirmation or a recovery of one is in flight, so only one acts at a time. */
      let confirming = false;
      let recovering = false;
      /** Whether the retained manual staging attempts are being retried. */
      let recoveringStaging = false;
      /** Whether a source is being parsed, so one import is in flight at a time. */
      let sourcing = false;
      /** Whether a waiting import is being reopened, so one import is in flight at a time. */
      let reopening = false;
      /** The retained list states, kept while the lists are not composed yet. */
      const retainedResults = readPageState(restored?.results);
      const retainedPending = readRetainedPending(restored?.pending, sessionId);

      manualForm.addEventListener('submit', (event) => {
        event.preventDefault();
        findCards();
      });
      sourceForm.addEventListener('submit', (event) => {
        event.preventDefault();
        void importSource();
      });
      sourceFormat.addEventListener('change', () => {
        // The rows of another method's import do not describe this one, so they are cleared while
        // the input of the presented method keeps the import it already composes
        // (docs/user-interface.md#source-imports).
        sourceStatus.textContent = '';
        sourceRows.replaceChildren();
        paintSourceForm();
        paintUnfinishedSource();
      });
      sessionSelect.addEventListener('change', () => {
        present(readSessionId(sessionSelect.value));
      });
      sessionsMore.addEventListener('click', () => {
        void readSessions(sessionsContinuation, true);
      });
      refresh.addEventListener('click', () => {
        void reconcileImport();
      });
      recover.addEventListener('click', () => {
        void recoverPendingConfirmation();
      });
      manualRecover.addEventListener('click', () => {
        void recoverManualStaging();
      });
      discard.addEventListener('click', () => {
        void discardImport();
      });

      if (retainedResults !== null) {
        composeResults(readListState<CardListCatalogQuery>(retainedResults));
      }
      if (retainedPending !== null) {
        composePending(retainedPending.sessionId, retainedPending.list);
      }
      paintSourceForm();
      paintUnfinishedSource();
      paintManualRecovery();
      paintConfirmation();
      if (confirmation !== null) {
        // A confirmation whose outcome the provider has not established stays recoverable through
        // the identity it was dispatched under, also after a reload or a return to the view
        // (docs/user-cards.md#browser-operation-lifecycle).
        reviewStatus.textContent =
          'A confirmation is kept whose outcome is not established. Check it before confirming ' +
          'the same entries again.';
        void recoverPendingConfirmation();
      }
      void open();

      return {
        capture: captureState,
        presented: () => presented.promise,
        dispose: () => {
          capture.dispose();
          results?.dispose();
          pending?.dispose();
        },
      };

      /** State this page retains for its history entry: its draft input and its lists' states. */
      function captureState(): unknown {
        return {
          sessionId,
          manual: {
            text: query.value,
            quantity: quantity.value,
            finish: finish.value,
            condition: condition.value,
          },
          // The unsaved source input stays with the entry as well: returning to the view keeps the
          // edits to retry, while the account keeps the identity of an import whose outcome was not
          // reported (docs/user-interface.md#source-imports).
          source: sourceEnabled
            ? {
                format: sourceFormat.value,
                text: sourceText.value,
                url: sourceUrl.value,
                identity: sourceIdentity.value,
                reference: sourceReference.value,
                lines: sourceLines.value,
              }
            : null,
          // Unsaved review input stays with the entry, so leaving the view and returning to it
          // keeps the edits the user must review and retry
          // (docs/user-interface.md#state-ownership-and-restoration).
          review: Object.fromEntries([...drafts].map(([id, draft]) => [id, { ...draft }])),
          // The reviewed revisions of the explicit selection stay with the entry, so a
          // confirmation still covers entries the loaded window no longer presents.
          selection: Object.fromEntries(
            [...selectionContext()].map(([key, review]) => [key, { ...review }]),
          ),
          // A list not composed yet keeps the state its entry handed back instead of overwriting it
          // with a partially presented view (docs/user-interface.md#state-ownership-and-restoration).
          results: results === null ? retainedResults : { list: results.capture() },
          pending:
            pending === null
              ? retainedPending
              : sessionId === null
                ? null
                : { sessionId, list: pending.capture() },
        };
      }

      /** Reads the account's pending sessions and presents the review of the chosen one. */
      async function open(): Promise<void> {
        await readSessions(null, false);
        if (closed) {
          return;
        }
        const target = sessionId ?? defaultSessionId(sessions);
        present(target);
        const restorations: (Promise<void> | null)[] = [
          results === null ? null : restoredPresentation(results),
          pending === null ? null : restoredPresentation(pending),
        ];
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
            context.signal,
          );
        } catch (cause) {
          if (closed || read !== sessionsRead) {
            return;
          }
          reviewStatus.textContent = `The pending imports could not be read: ${readMessage(
            cause,
            'unknown failure',
          )}`;
          return;
        }
        if (closed || read !== sessionsRead) {
          // A response of a superseded read cannot replace the pending imports the review presents
          // (docs/user-interface.md#pages-and-navigation).
          return;
        }
        sessions = append ? [...sessions, ...page.sessions] : [...page.sessions];
        sessionsContinuation = page.continuation;
        paintSessions();
      }

      /** Draws the session control and the control that reads further session pages. */
      function paintSessions(): void {
        const options: UiSelectOption[] = [];
        const current = session;
        if (current !== null && !sessions.some((one) => one.sessionId === current.sessionId)) {
          // The presented import was read beyond the page now listed; it stays selectable, so a
          // review of an import outside the first page survives leaving and returning to the view.
          options.push({
            value: current.sessionId,
            label:
              `${uiImportSourceLabel(current.sourceKind)} · ` + `${current.pendingEntries} pending`,
          });
        }
        for (const candidate of sessions) {
          options.push({
            value: candidate.sessionId,
            label:
              `${uiImportSourceLabel(candidate.sourceKind)} · ` +
              `${candidate.pendingEntries} pending`,
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
       * The provenance of the presented import: the source method it was acquired from and, when
       * the source published one, the official reference the session is kept with
       * (docs/user-interface.md#source-imports).
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
       * Presents one session's pending entries. The list is composed again for another session, so
       * a chosen session keeps its own review and no row carries another import's record.
       */
      function present(next: string | null): void {
        if (next === sessionId && pending !== null) {
          // The session is already presented: its window, selection and drafts stay as they are.
          return;
        }
        sessionId = next;
        printingSearches.clear();
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
        const bindings = context.capabilities.cardList.account(context.account.accountId);
        const entries = bindings.pendingEntries();
        pendingEntries = entries;
        pending = createCardListView({
          container: pendingHost,
          create: context.capabilities.cardList.create,
          source: entries.source,
          context: presentedSession,
          accountId: context.account.accountId,
          pageSize: constraints.pages.imports.default,
          restored: restoredState,
          fragments: { tools: pendingToolsReader() },
          tools: [confirmTool()],
          // A committed change of the presented import reacquires its entries through the binding;
          // the page never patches a row after an operation it drove.
          changes: bindings.changes(),
          presentation: {
            renderEntry: (entry) => entryContent(entry),
            renderFragment: (kind, entry) => (kind === 'tools' ? entryEditor(entry) : null),
          },
          signal: context.signal,
        });
        observePendingEntries(pending);
      }

      /**
       * Follows the presented pending entries: the session record the binding read keeps the
       * page's provenance and discard state current, and every explicitly selected entry keeps the
       * revision its confirmation quotes even after the row leaves the loaded window. Release
       * editors outside that window; their drafts and selected revisions have separate owners
       * (docs/user-interface.md#state-ownership-and-restoration).
       */
      function observePendingEntries(list: UiCardList<string>): void {
        const read = (): void => {
          const binding = pendingEntries;
          if (binding === null || closed) {
            return;
          }
          const presented = new Set(list.entries.map((entry) => entry.key));
          for (const key of editors.keys()) {
            if (!presented.has(key)) {
              editors.delete(key);
            }
          }
          const readSession = binding.session();
          if (
            readSession !== null &&
            readSession.sessionId === sessionId &&
            readSession !== session
          ) {
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

      /** Composes the catalog result list of the manual entry search. */
      function composeResults(
        restoredState: CardListRetained<CardListCatalogQuery> | undefined,
      ): void {
        results = createCardListView<CardListCatalogQuery>({
          container: resultsHost,
          create: context.capabilities.cardList.create,
          source: context.capabilities.cardList.account(context.account.accountId).catalogQuery(),
          context: { text: query.value.trim(), level: 'printing', owned: false, finish: null },
          accountId: context.account.accountId,
          pageSize: UI_LIMITS.importPrintings,
          restored: restoredState,
          fragments: { tools: resultToolsReader() },
          tools: [addTool()],
          signal: context.signal,
        });
      }

      /** Searches the catalog for the printings the manual entry form names. */
      function findCards(): void {
        const text = query.value.trim();
        if (text.length === 0) {
          manualStatus.textContent = 'Enter a card name or expression to find its printings.';
          return;
        }
        manualStatus.textContent = '';
        const wanted: CardListCatalogQuery = {
          text,
          level: 'printing',
          owned: false,
          finish: null,
        };
        if (results === null) {
          composeResults(undefined);
        } else {
          results.refine(wanted);
        }
      }

      /**
       * Draws the fields of the selected source method. Only the fields the method needs are
       * presented: the others keep their drafts but end outside this method's submission, so a
       * value they hold cannot refuse a request the presented method describes. The control that
       * stages the source is unavailable while one source is being parsed
       * (docs/user-interface.md#source-imports).
       */
      function paintSourceForm(): void {
        const format = readSourceFormat(sourceFormat.value);
        const pasted = format === 'pasted-list';
        const moxfield = format === 'moxfield';
        const wizards = format === 'wizards-precon';
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
        sourceSubmit.disabled = sourcing || reopening;
        sourceSubmit.textContent = sourcing ? 'Reading the source…' : 'Add source to review';
      }

      /**
       * Presents every unfinished source import the account retains: the input each attempt was
       * begun with and the explicit reopen action that reads the rows the provider recorded. A
       * new-import submission and a reopen are distinct intents, so the form never decides which
       * identity an input composes (docs/ui/editors.md#internal-design,
       * docs/user-cards.md#browser-operation-lifecycle).
       */
      function paintUnfinishedSource(): void {
        if (!sourceEnabled) {
          return;
        }
        const attempts = unfinishedSources();
        sourceWaiting.replaceChildren(
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
        sourceWaiting.hidden = attempts.length === 0;
      }

      /** The unfinished source imports the account retains, oldest first. */
      function unfinishedSources(): readonly UiSourceImportAttempt[] {
        return access
          .retained()
          .flatMap((attempt) => (attempt.kind === 'stageSourceImport' ? [attempt] : []));
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

      /** Reports one problem of the source form before any import is dispatched. */
      function reportSource(problem: string): void {
        sourceStatus.textContent = problem;
        sourceRows.replaceChildren();
      }

      /**
       * The source input the form presents, or null after reporting what it still needs. The page
       * names the import this input composes when it dispatches the request, so the provider
       * reconciles the rows with that import's own records instead of inferring an import from the
       * entered contents or the source URL (docs/user-interface.md#source-imports).
       */
      function sourceInput(): UiSourceInput | null {
        const format = readSourceFormat(sourceFormat.value);
        if (format === null) {
          reportSource('Choose the source method to import.');
          return null;
        }
        if (format === 'pasted-list') {
          if (sourceText.value.trim().length === 0) {
            reportSource('Paste the card lines of the list first.');
            return null;
          }
          return { format, text: sourceText.value };
        }
        if (format === 'moxfield') {
          const url = sourceUrl.value.trim();
          if (url.length === 0) {
            reportSource('Enter the public Moxfield deck link first.');
            return null;
          }
          return { format, url };
        }
        const identity = sourceIdentity.value.trim();
        if (identity.length === 0) {
          reportSource(
            'Name the reviewed product as wizards:<edition>:<product>:<variant>:<language>.',
          );
          return null;
        }
        const reference = sourceReference.value.trim();
        if (reference.length === 0) {
          reportSource('Enter the official decklist link on magic.wizards.com first.');
          return null;
        }
        if (reviewedWizardsLines(sourceLines.value).length === 0) {
          reportSource('Paste the reviewed decklist lines, one card per row, first.');
          return null;
        }
        return { format, identity, reference, lines: sourceLines.value };
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
       * became. The provider never confirms ownership, so the outcome reports the lines that
       * entered review beside the ones it had already staged or acquired; a source whose response
       * is lost stays retained under the identity the provider composed for it and is reopened
       * through the waiting list instead of being submitted as another list
       * (docs/user-interface.md#source-imports).
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
        paintSourceForm();
        let outcome: UiChangeCommit<SourceImportResult>;
        try {
          // The account retains the new import before its request is dispatched, so the waiting
          // list presents it while its outcome is still open
          // (docs/user-cards.md#browser-operation-lifecycle).
          const started = beginSourceImport(access, request, context.signal);
          paintUnfinishedSource();
          outcome = await started;
        } finally {
          sourcing = false;
          paintSourceForm();
          paintUnfinishedSource();
        }
        // A departed page must not write its old recovery snapshot over the active page's
        // requests or restore records after sign-out. The retained import is still reopenable.
        if (closed) {
          return;
        }
        const result = outcome.record;
        if (result === null) {
          reportSource(outcome.message ?? 'The source lines were not added to review.');
          if (outcome.status === 'unknown') {
            // The rows may have committed: the page reads what the account holds instead of
            // inferring whether this source staged anything
            // (docs/user-interface.md#source-imports).
            void reconcileImport();
          }
          return;
        }
        sourceStatus.textContent = sourceImportMessage(result);
        sourceRows.replaceChildren(...result.rows.map((row) => sourceRow(document, row)));
        await presentSource(result.session.sessionId);
      }

      /**
       * Reopens one import the account still retains, under the identity that attempt was begun
       * with. Reopening reads the rows the provider recorded for that import instead of composing
       * another one, also after a reload or a return to the view
       * (docs/user-cards.md#browser-operation-lifecycle).
       */
      async function reopenSource(
        operationId: string,
        request: UserCardsSourceImportRequest,
      ): Promise<void> {
        if (sourcing || reopening) {
          return;
        }
        reopening = true;
        paintSourceForm();
        let outcome: UiChangeCommit<SourceImportResult>;
        try {
          outcome = await reopenSourceImport(access, operationId, request, context.signal);
        } finally {
          reopening = false;
          paintSourceForm();
          paintUnfinishedSource();
        }
        if (closed) {
          return;
        }
        const result = outcome.record;
        if (result === null) {
          sourceStatus.textContent =
            outcome.message ?? 'The source lines were not read back into review.';
          return;
        }
        sourceStatus.textContent = sourceImportMessage(result);
        sourceRows.replaceChildren(...result.rows.map((row) => sourceRow(document, row)));
        await presentSource(result.session.sessionId);
      }

      /**
       * Presents the session a parsed source belongs to, so its rows are reviewed and explicitly
       * confirmed like every other pending import
       * (docs/user-interface.md#capture-and-review). A session the listed page does not carry stays
       * selectable instead of being replaced by another import.
       */
      async function presentSource(presented: string): Promise<void> {
        await readSessions(null, false);
        if (closed) {
          return;
        }
        const listed = presented === sessionId && pending !== null;
        present(presented);
        if (listed) {
          // The session is already presented: its window reloads instead of being composed again.
          pending?.refresh();
        }
      }

      /**
       * Stages the selected printings as manual pending lines with the quantity, finish and
       * condition the form presents. An earlier manual staging whose outcome is not established is
       * retried through its own retained attempt before more lines are added, so the same line is
       * never staged twice under two identities
       * (docs/user-cards.md#import-and-capture-state).
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
        for (const target of request.targets) {
          if (target.kind !== 'printing') {
            continue;
          }
          const line: UiImportLine = {
            entryId: uiImportIdentity(),
            printingId: target.printingId,
            finish: wantedFinish,
            condition: wantedCondition,
            quantity: wantedQuantity,
          };
          lines.push(line);
        }
        if (lines.length === 0) {
          return { status: 'failed', message: 'Select the printings to add to review.' };
        }
        // One request stages at most the number of lines the provider bound accepts, so a
        // selection larger than one request is staged through further bounded requests, each line
        // carrying the identity UserCards retains while its outcome is not established
        // (docs/user-cards.md#interface).
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
          if (closed) {
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
        // Reading the pending entries shows whether a staging committed even though its response
        // was lost (docs/user-interface.md#capture-and-review).
        void reconcileImport(reported?.status === 'unknown');
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
        manualRecovery.hidden = attempts.length === 0;
        manualRecover.disabled = recoveringStaging;
        manualRecoveryNote.textContent =
          attempts.length === 1
            ? 'A manual staging attempt is waiting for its outcome.'
            : `${attempts.length} manual staging attempts are waiting for their outcome.`;
      }

      /**
       * Retries every manual staging attempt the account retains, through its own handle, and
       * presents what the provider established. The attempt keeps the line identities it was begun
       * with, so a retry replays that staging instead of adding the lines twice
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
              context.signal,
              'The lines were not added to review.',
              'The staging outcome is unknown. The lines may be in review; reload the import ' +
                'before retrying.',
            );
            if (closed) {
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
        manualStatus.textContent =
          message ?? (inReview === 0 ? stagedMessage(0) : stagedMessage(inReview));
        // The committed lines were reacquired by their change notifications; only an unresolved
        // outcome needs the page's own read of the entries.
        void reconcileImport(message !== null);
      }

      /**
       * Reloads the pending sessions a page owns, and the presented entries when no committed
       * change covers them: the page never repairs a list the change notification already
       * reacquires (docs/card-list.md#loading-and-recovery).
       */
      async function reconcileImport(refreshEntries = true): Promise<void> {
        await readSessions(null, false);
        if (closed) {
          return;
        }
        if (sessionId === null) {
          // No import was presented yet: the review opens the one the account has pending.
          present(defaultSessionId(sessions));
          return;
        }
        const listed = sessions.some((one) => one.sessionId === sessionId);
        if (!listed && session !== null && session.pendingEntries === 0) {
          // The presented import has no pending entries left: the review moves to an import that
          // still has some.
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
       * what the provider holds instead of inferring an entry
       * (docs/user-interface.md#capture-and-review).
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
          if (closed) {
            return;
          }
          present(change.session.sessionId);
          return;
        }
        adoptSession(change.session);
        // A committed capture change reacquires the pending entries through CardList's own change
        // invalidation; the page owns no repair read of the list.
      }

      /** One row's basic information: the printing it will create and its reviewed values. */
      function entryContent(entry: CardListEntry): Node {
        return cardListBasicContent(document, entry);
      }

      /**
       * The editor of one pending entry: the reviewed printing, finish, condition and quantity it
       * exposes before confirmation, the printing search that corrects them and the controls that
       * save the review or discard the entry (docs/user-interface.md#capture-and-review).
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
        const editor: UiImportEditor = { controls, entry, status };
        editors.set(entry.key, editor);
        // The row keeps the reviewed values the page read until the list presents the new ones.
        paintEditor(editor);
        return controls;
      }

      /**
       * Draws one entry's reviewed values and controls. The unsaved input lives in the page's
       * drafts rather than in the rendered controls, so a redraw, paging or leaving and returning
       * to the view keeps what the user must review; only a committed change clears its own draft
       * (docs/user-interface.md#state-ownership-and-restoration).
       */
      function paintEditor(editor: UiImportEditor): void {
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
        const chosen = printingSelect(document, record, found, chosenPrintingId);
        chosen.id = `import-review-printing-${encodeURIComponent(entry.entryId)}`;
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
          printingSearches.delete(entry.entryId);
        });
        find.addEventListener('click', () => {
          void findPrintings(editor, query.value);
        });
        chosen.addEventListener('change', () => {
          clearMessage(editor);
          const next = draftFor(record);
          next.printingId = chosen.value;
          const known = knownPrinting(record, found, chosen.value);
          if (known !== null && !known.finishes.includes(next.finish as Finish)) {
            next.finish = '';
          }
          paintEditor(editor);
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
            printingId: chosen.value,
            finish: wantedFinish.value,
            condition: wantedCondition.value,
            quantity: wantedQuantity.value,
          });
        });
        remove.addEventListener('click', () => {
          void removeEntry(editor);
        });
        content.push(
          controlLabel(document, 'Printing search', query),
          find,
          controlLabel(document, 'Printing', chosen),
          controlLabel(document, 'Finish', wantedFinish),
          controlLabel(document, 'Condition', wantedCondition),
          controlLabel(document, 'Quantity', wantedQuantity),
          save,
          remove,
        );
        editor.controls.replaceChildren(...content);
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
              (candidate) =>
                `${candidate.printingId} (${candidate.provider}, ${candidate.evidence})`,
            )
            .join('; ')}`;
          values.append(alternatives);
        }
        return values;
      }

      /** Searches the catalog for printings one entry's review may choose instead. */
      async function findPrintings(editor: UiImportEditor, text: string): Promise<void> {
        const record = pendingRecord(editor.entry.key);
        if (record === null) {
          return;
        }
        const entryId = record.entry.entryId;
        const request = Symbol();
        printingSearches.set(entryId, request);
        const current = () => !closed && printingSearches.get(entryId) === request;
        const wanted = text.trim();
        if (wanted.length === 0) {
          report(editor, 'Enter a card name to find its printings.');
          printingSearches.delete(entryId);
          return;
        }
        report(editor, 'Searching for printings…');
        try {
          const offered = await searchPrintings(search, catalog, wanted, context.signal);
          if (!current()) {
            return;
          }
          printings.set(entryId, offered);
          boundByWindow(printings);
          report(
            editor,
            offered.length === 0 ? 'The catalog published no printing for that search.' : '',
          );
        } catch (cause) {
          if (!current()) {
            return;
          }
          report(
            editor,
            `The printings could not be read: ${readMessage(cause, 'unknown failure')}`,
          );
        } finally {
          if (current()) {
            printingSearches.delete(entryId);
            // The row may have been redrawn while the search ran; drawing its tools fragment again
            // presents the choices now known to the page.
            pending?.reloadFragment(editor.entry.key, 'tools');
          }
        }
      }

      /**
       * Saves one entry's reviewed printing, finish, condition and quantity under the revision the
       * page read. A conflict keeps the draft for review; a lost response keeps it too and reloads
       * the stored values instead of presenting the review as saved.
       */
      async function saveReview(
        editor: UiImportEditor,
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
              (await resolvePrintings(catalog, [printingId])).get(printingId) ?? null;
          } catch (cause) {
            if (!closed && sessionId === record.entry.sessionId) {
              report(
                editor,
                `The selected printing could not be read: ${readMessage(cause, 'unknown failure')}`,
              );
            }
            return;
          }
        }
        if (closed) {
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
          context.signal,
        );
        if (closed) {
          return;
        }
        if (outcome.status === 'committed' && outcome.record !== null) {
          // Only the input this review committed leaves; a draft the owner changed while the
          // request was in flight stays for the next review
          // (docs/user-interface.md#browsing-and-organization).
          const draft = drafts.get(record.entry.entryId);
          if (draft !== undefined && sameReviewDraft(draft, submitted)) {
            drafts.delete(record.entry.entryId);
          }
          report(editor, 'Review saved.');
          adoptEntry(outcome.record.session);
          // The committed review reacquires the stored values and the printing the entry now names
          // through CardList's own change invalidation; the page owns no repair read of the list.
          return;
        }
        report(editor, outcome.message ?? 'The review was not saved.');
        if (outcome.status !== 'failed') {
          // A conflict or a lost response: the stored values are read again for review.
          await reconcileImport();
          if (closed) {
            return;
          }
          pending?.reloadFragment(editor.entry.key, 'tools');
        }
      }

      /** Discards one pending entry after a brief confirmation; no copy is created. */
      async function removeEntry(editor: UiImportEditor): Promise<void> {
        const record = pendingRecord(editor.entry.key);
        if (record === null) {
          return;
        }
        const accepted = await context.dialogs.confirm({
          title: 'Discard this pending entry?',
          message: 'The entry ends without creating a copy.',
          confirmLabel: 'Discard entry',
          cancelLabel: 'Keep it',
        });
        if (!accepted || closed) {
          return;
        }
        const outcome = await discardImportEntry(
          access,
          { entryId: record.entry.entryId, expectedRevision: record.entry.revision },
          context.signal,
        );
        if (closed) {
          return;
        }
        if (outcome.status === 'committed') {
          drafts.delete(record.entry.entryId);
          printings.delete(record.entry.entryId);
          printingSearches.delete(record.entry.entryId);
          messages.delete(editor.entry.key);
        } else {
          report(editor, outcome.message ?? 'The entry was not discarded.');
        }
        await reconcileImport(outcome.status !== 'committed');
      }

      /** Discards every pending entry of the presented import after a brief confirmation. */
      async function discardImport(): Promise<void> {
        const presented = sessionId;
        const current = session;
        if (presented === null || current === null) {
          reviewStatus.textContent = 'Read the pending import before discarding it.';
          return;
        }
        const accepted = await context.dialogs.confirm({
          title: 'Discard this import?',
          message: 'Every pending entry of this import ends without creating a copy.',
          confirmLabel: 'Discard import',
          cancelLabel: 'Keep it',
        });
        if (!accepted || closed) {
          return;
        }
        const outcome = await discardImportSession(
          access,
          { sessionId: presented, expectedRevision: current.revision },
          context.signal,
        );
        if (closed) {
          return;
        }
        reviewStatus.textContent =
          outcome.status === 'committed'
            ? 'The import was discarded; no copies were created.'
            : (outcome.message ?? 'The import was not discarded.');
        if (outcome.status === 'committed' && presented === sessionId) {
          // Only the discarded import's own review input ends; the unsaved work of another import
          // the page still presents stays (docs/user-interface.md#state-ownership-and-restoration).
          forgetPresentedEntries();
          paintConfirmation();
        }
        await reconcileImport(outcome.status !== 'committed');
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
          printingSearches.delete(record.entry.entryId);
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
        const presented = sessionId;
        if (presented === null) {
          return { status: 'failed', message: 'Read the pending import before confirming it.' };
        }
        const chosen: ConfirmImportEntryInput[] = [];
        for (const target of request.targets) {
          if (target.kind !== 'pending') {
            continue;
          }
          const key = cardListEntryKey(target);
          // The reviewed revision the page read with the row, or the one it keeps for an explicit
          // selection outside the loaded window
          // (docs/user-interface.md#state-ownership-and-restoration).
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
        // One request confirms at most the number of entries the provider bound accepts, so a
        // larger explicit selection is confirmed through further bounded requests whose operation
        // identities stay with the entries they cover (docs/user-cards.md#interface).
        confirming = true;
        paintConfirmation();
        let copies = 0;
        let note: string | null = null;
        let reported: UiOperationOutcome | null = null;
        try {
          for (const entries of inBatches(chosen, constraints.batch.confirmEntries)) {
            // The provider owns the operation identity; the page presents the attempt while its
            // outcome is not established, so a lost response is recovered through its receipt.
            const operation: UiConfirmationDraft = {
              sessionId: presented,
              entries,
              operation: access.confirm({ sessionId: presented, entries }, request.signal),
            };
            confirmation = operation;
            paintConfirmation();
            const outcome = await confirmImport(operation.operation);
            if (closed) {
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
          // The reviewed revisions changed under the selection, or a request failed: the page
          // presents the stored entries again before another confirmation.
          void reconcileImport();
          return reported;
        }
        const message = confirmationMessage(copies, note);
        reviewStatus.textContent = message;
        void reconcileImport(false);
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
          printingSearches.delete(entry.entryId);
        }
      }

      /**
       * Takes the committed session into the page's own view of it; the entry's stored values and
       * the records its review quotes are reacquired by the list from the same committed change.
       */
      function adoptEntry(changed: ImportSession): void {
        if (changed.sessionId !== sessionId) {
          // The review committed in an import the page no longer presents: its listed counts
          // follow the report, while the presented import's own state stays untouched
          // (docs/user-interface.md#pages-and-navigation).
          adoptSession(changed);
          return;
        }
        adoptSession(changed);
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
          // Every entry of the presented import is decided: the review moves to an import that
          // still has pending entries instead of presenting a finished one.
          present(defaultSessionId(sessions.filter((one) => one.pendingEntries > 0)));
          if (confirmation !== null && confirmation.sessionId === changed.sessionId) {
            // The entries of the kept confirmation are no longer pending, so its recorded outcome
            // decides whether they created copies (docs/user-interface.md#source-imports).
            void recoverPendingConfirmation();
          }
        }
      }

      /** The reviewed revision of one selected entry: the record the page read or its kept one. */
      function reviewedRevision(key: string, entryId: string): number | null {
        const record = pendingRecord(key);
        if (record !== null && record.entry.entryId === entryId) {
          return record.entry.revision;
        }
        const kept = selectedRevisions.get(key);
        return kept !== undefined && kept.entryId === entryId ? kept.revision : null;
      }

      /**
       * The confirmation context of the explicit selection: the reviewed revision of every
       * selected entry the page read, taken from its record or from the revision kept beside it.
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
       * Reads the recorded outcome of the confirmation the page kept, independently of the current
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
          outcome = await recoverConfirmation(outstanding.operation, context.signal);
        } finally {
          recovering = false;
          paintConfirmation();
        }
        if (closed || confirmation !== outstanding) {
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
          void reconcileImport(false);
          return;
        }
        reviewStatus.textContent = outcome.message ?? 'The confirmation outcome could not be read.';
      }

      /** Keeps one message with its entry, so a redraw of the row presents it again. */
      function report(editor: UiImportEditor, message: string): void {
        messages.set(editor.entry.key, message);
        boundByWindow(messages);
        (editors.get(editor.entry.key) ?? editor).status.textContent = message;
      }

      /** Drops the message of one entry when its owner edits the reviewed values again. */
      function clearMessage(editor: UiImportEditor): void {
        messages.delete(editor.entry.key);
        (editors.get(editor.entry.key) ?? editor).status.textContent = '';
      }

      /**
       * The unsaved review input of one entry, created from the values the page presented when the
       * owner first edits one of them: reviewing a single attribute keeps every other stored value
       * of that entry (docs/user-interface.md#capture-and-review).
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

      /** Only records in the current read sequence establish pending availability.
       * Retained selected revisions are action context, not evidence of continued existence.
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

      /** The tool that stages the explicit selected printings as manual pending lines. */
      function addTool(): UiListAction {
        return {
          id: 'add-to-review',
          label: 'Add to review',
          tool: {
            invoke: (request: UiActionRequest): Promise<UiOperationOutcome> =>
              addSelection(request),
          },
        };
      }

      /** The tool that confirms the explicit selected pending entries. */
      function confirmTool(): UiListAction {
        return {
          id: 'confirm-import',
          label: 'Confirm selected',
          tool: {
            invoke: (request: UiActionRequest): Promise<UiOperationOutcome> =>
              confirmSelection(request),
          },
        };
      }
    },
  };
}

/**
 * Printings one review search offers for a card name or expression. A search the index cannot
 * answer completely yet fails as a retryable read instead of offering no printing
 * (docs/search.md#freshness).
 */
async function searchPrintings(
  search: SearchClient,
  catalog: Catalog,
  text: string,
  signal: AbortSignal,
): Promise<readonly PrintingRecord[]> {
  const page = readableSearchPage(
    await search.execute(
      { resultLevel: 'printing', query: text, pageSize: UI_LIMITS.importPrintings },
      signal,
    ),
  );
  const printingIds = page.entries.flatMap((entry) =>
    entry.printing === null ? [] : [entry.printing.printingId],
  );
  const resolution = await catalog.resolve(
    printingIds.map((printingId) => ({ kind: 'printing' as const, printingId })),
  );
  return [...resolution.printings.values()];
}

/** The manual entry form state one history entry kept, or its defaults. */
function readManualDraft(value: unknown): {
  readonly text: string;
  readonly quantity: string;
  readonly finish: string;
  readonly condition: string;
} {
  const record = readPageState(value);
  return {
    text: readDraftValue(record?.text, UI_LIMITS.catalogQuery) ?? '',
    quantity: readDraftValue(record?.quantity, 8) ?? '1',
    finish: readDraftValue(record?.finish, 16) ?? '',
    condition: readDraftValue(record?.condition, 8) ?? '',
  };
}

/** The source method one control value names, or null when it names none the page presents. */
function readSourceFormat(value: string): UiSourceFormat | null {
  return (uiSourceFormats as readonly string[]).includes(value) ? (value as UiSourceFormat) : null;
}

/**
 * The source form one history entry kept. Every field is restored within the bound its own control
 * accepts, so a value the form took is presented again unchanged; the identity of an unfinished
 * import stays with the account and is presented as a waiting import instead
 * (docs/user-interface.md#source-imports, docs/user-cards.md#browser-operation-lifecycle).
 */
function readSourceDraft(value: unknown, bounds: UserCardsConstraints['text']): UiSourceDraft {
  const record = readPageState(value);
  return {
    format:
      readSourceFormat(typeof record?.format === 'string' ? record.format : '') ?? 'pasted-list',
    text: readDraftValue(record?.text, bounds.sourceText) ?? '',
    url: readDraftValue(record?.url, bounds.sourceReference) ?? '',
    identity: readDraftValue(record?.identity, bounds.identifier) ?? '',
    reference: readDraftValue(record?.reference, bounds.sourceReference) ?? '',
    lines: readDraftValue(record?.lines, bounds.sourceText) ?? '',
  };
}

/**
 * One unfinished import as the waiting list names it: the source method and the reference the
 * input carries, so the owner recognizes the import the reopen action reads back
 * (docs/user-interface.md#source-imports).
 */
function unfinishedSourceLabel(request: UserCardsSourceImportRequest): string {
  const method = uiImportSourceLabel(request.format);
  switch (request.format) {
    case 'pasted-list':
      return `${method} waiting for its recorded rows (${request.text.length} characters).`;
    case 'moxfield':
      return `${method} waiting for its recorded rows (${request.url}).`;
    case 'wizards-precon':
      return `${method} waiting for its recorded rows (${request.sourceId}, ${request.entries.length} lines).`;
  }
}

/**
 * One reviewed Wizards line as the provider receives it: the leading count the owner pasted, or
 * one copy when the row names none, and the card name that follows. A blank row is formatting, so
 * it carries no line and the readable rows keep their own positions
 * (docs/user-cards.md#source-imports).
 */
function reviewedWizardsLines(text: string): readonly ReviewedWizardsLine[] {
  const entries: ReviewedWizardsLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const row = raw.trim();
    if (row.length === 0) {
      continue;
    }
    const match = row.match(/^(\d+)\s+(.+)$/);
    entries.push(
      match === null
        ? { name: row, quantity: 1 }
        : { name: (match[2] ?? '').trim(), quantity: Number(match[1]) },
    );
  }
  return entries;
}

/**
 * The progress one source import reported, in the words of the decision it supports: what entered
 * review, what this import already held and which rows were unreadable. Parsing is never
 * confirmation, so the message says that the reviewed lines still need an explicit confirmation
 * (docs/user-interface.md#source-imports).
 */
function sourceImportMessage(result: SourceImportResult): string {
  const counts: Record<SourceImportOutcome, number> = {
    staged: 0,
    pending: 0,
    acquired: 0,
    invalid: 0,
  };
  for (const row of result.rows) {
    counts[row.outcome] += 1;
  }
  const listed: string[] = [];
  if (counts.staged > 0) {
    listed.push(`${counts.staged} ${counts.staged === 1 ? 'line is' : 'lines are'} in review`);
  }
  if (counts.pending > 0) {
    listed.push(
      `${counts.pending} ${counts.pending === 1 ? 'line was' : 'lines were'} already in review`,
    );
  }
  if (counts.acquired > 0) {
    listed.push(
      `${counts.acquired} ${counts.acquired === 1 ? 'line was' : 'lines were'} already acquired ` +
        'by this import',
    );
  }
  if (counts.invalid > 0) {
    listed.push(`${counts.invalid} ${counts.invalid === 1 ? 'row' : 'rows'} could not be read`);
  }
  const progress =
    listed.length === 0 ? 'The source listed no card line.' : `${listed.join('; ')}.`;
  return counts.staged === 0
    ? `${progress} Nothing new was staged; a reviewed line becomes a copy only through confirmation.`
    : `${progress} Confirm the reviewed lines to create their physical copies.`;
}

/**
 * One parsed source row as the page presents it: its position in the source, what it became and
 * the parsed line or the problem the provider reported for it
 * (docs/user-interface.md#source-imports).
 */
function sourceRow(document: Document, row: SourceImportRow): HTMLLIElement {
  const element = document.createElement('li');
  element.dataset.uiSourceRow = String(row.position);
  const outcome = document.createElement('span');
  outcome.dataset.uiSourceOutcome = row.outcome;
  outcome.textContent = `Row ${row.position} · ${sourceOutcomeLabel(row.outcome)}`;
  const detail = document.createElement('span');
  detail.textContent =
    row.line === null
      ? ` · ${row.problem ?? 'This row could not be read.'}`
      : ` · ${sourceLineText(row.line)}`;
  element.append(outcome, detail);
  return element;
}

/** What one parsed source row became, in the words of the review that follows it. */
function sourceOutcomeLabel(outcome: SourceImportOutcome): string {
  switch (outcome) {
    case 'staged':
      return 'added to review';
    case 'pending':
      return 'already in review';
    case 'acquired':
      return 'already acquired by this import';
    case 'invalid':
      return 'not read';
  }
}

/** The session identity one history entry kept, or null when it names none. */
function readSessionId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= UI_LIMITS.entryKey
    ? value
    : null;
}

/** The unsaved review input a history entry kept, keyed by entry identity. */
function readReviewDrafts(value: unknown): Map<string, UiReviewDraft> {
  const drafts = new Map<string, UiReviewDraft>();
  const record = readPageState(value);
  if (record === null) {
    return drafts;
  }
  for (const [entryId, candidate] of Object.entries(record)) {
    const draft = readPageState(candidate);
    if (draft === null || entryId.length === 0 || entryId.length > UI_LIMITS.entryKey) {
      continue;
    }
    drafts.set(entryId, {
      query: readDraftValue(draft.query, UI_LIMITS.catalogQuery) ?? '',
      printingId: readDraftValue(draft.printingId, UI_LIMITS.entryKey) ?? '',
      finish: readDraftValue(draft.finish, 16) ?? '',
      condition: readDraftValue(draft.condition, 8) ?? '',
      quantity: readDraftValue(draft.quantity, 8) ?? '',
    });
  }
  boundByWindow(drafts);
  return drafts;
}

/**
 * The pending list state one history entry kept, with the session it belongs to. The captured
 * `{ sessionId, list }` representation is read exactly once, so the list's own state reaches the
 * list that interprets it (docs/user-interface.md#state-ownership-and-restoration).
 */
function readRetainedPending(
  value: unknown,
  sessionId: string | null,
): { readonly sessionId: string; readonly list: CardListRetained<string> | undefined } | null {
  const record = readPageState(value);
  const retainedSession = readSessionId(record?.sessionId);
  if (record === null || retainedSession === null || retainedSession !== sessionId) {
    return null;
  }
  return { sessionId: retainedSession, list: readListState<string>(record) };
}

/** The reviewed revisions a history entry kept for its explicit selection, keyed by entry key. */
function readSelectedRevisions(value: unknown): Map<string, UiSelectedReview> {
  const selected = new Map<string, UiSelectedReview>();
  const record = readPageState(value);
  if (record === null) {
    return selected;
  }
  for (const [key, candidate] of Object.entries(record)) {
    const review = readPageState(candidate);
    const entryId = readDraftValue(review?.entryId, UI_LIMITS.entryKey);
    const revision = review?.revision;
    if (
      entryId === null ||
      key.length === 0 ||
      key.length > UI_LIMITS.entryKey ||
      !Number.isSafeInteger(revision) ||
      Number(revision) < 1
    ) {
      continue;
    }
    selected.set(key, { entryId, revision: Number(revision) });
  }
  return selected;
}

/** One retained draft value, bounded like the control that produced it. */
function readDraftValue(value: unknown, bound: number): string | null {
  return typeof value === 'string' ? value.slice(0, bound) : null;
}

/** The quantity one control names, or null when it is not a bounded positive whole number. */
function readQuantity(input: HTMLInputElement, bound: number): number | null {
  return readQuantityValue(input.value, bound);
}

/** One quantity value, or null when it is not a bounded positive whole number. */
function readQuantityValue(value: unknown, bound: number): number | null {
  const wanted = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(wanted) && wanted >= 1 && wanted <= bound ? wanted : null;
}

/** Finish one control value names, or null when it is empty or outside the vocabulary. */
function readFinishValue(value: string): Finish | null {
  return (uiCatalogFinishes as readonly string[]).includes(value) ? (value as Finish) : null;
}

/** Condition one control value names; an empty value is the explicit unknown condition. */
function readConditionValue(value: string): CopyCondition | null {
  return (uiCopyConditions as readonly string[]).includes(value) ? (value as CopyCondition) : null;
}

/** The first finish a printing offers as a physical card, or null when it is not known. */
function firstFinish(printing: PrintingRecord | null): Finish | null {
  return printing?.physical === true ? (printing.finishes[0] ?? null) : null;
}

/** The finishes one review may choose: the vocabulary, narrowed to a known printing's own. */
function finishOptions(): readonly UiSelectOption[] {
  return [
    { value: '', label: 'First offered finish' },
    ...uiCatalogFinishes.map((value) => ({ value, label: uiFinishLabel(value) })),
  ];
}

/** The conditions one review may choose; an empty value stays explicitly unknown. */
function conditionOptions(): readonly UiSelectOption[] {
  return [
    { value: '', label: 'Condition unknown' },
    ...uiCopyConditions.map((value) => ({ value, label: value })),
  ];
}

/**
 * The printing one review names: the record's own printing while the chosen identity is that one
 * — it is already read — and otherwise the printing the row's own search offered. A printing the
 * page cannot resolve stays unresolved instead of presenting the previously stored one
 * (docs/user-interface.md#capture-and-review).
 */
function knownPrinting(
  record: CardListPendingRecord,
  found: readonly PrintingRecord[],
  printingId: string,
): PrintingRecord | null {
  return (
    (record.printing?.printingId === printingId ? record.printing : null) ??
    found.find((printing) => printing.printingId === printingId) ??
    null
  );
}

/**
 * The printing choices of one review: the printing the entry already names and the printings its
 * own search found. A named printing outside those choices stays selectable, so a stored value is
 * never silently replaced by another printing.
 */
function printingSelect(
  document: Document,
  record: CardListPendingRecord,
  found: readonly PrintingRecord[],
  value: string,
): HTMLSelectElement {
  const known = [
    ...(record.printing === null ? [] : [record.printing]),
    ...found.filter((printing) => printing.printingId !== record.printing?.printingId),
  ];
  const options: UiSelectOption[] = [
    { value: '', label: 'Choose a printing' },
    ...known.map((printing) => ({ value: printing.printingId, label: printingLine(printing) })),
  ];
  if (value.length > 0 && !options.some((option) => option.value === value)) {
    options.push({ value, label: 'Selected printing (not loaded)' });
  }
  return selectControl(document, options, value);
}

/**
 * The finish choices of one review. A printing that the page could read narrows them to the
 * finishes it offers; a finish the entry already carries stays selectable, so reviewing another
 * field never changes the stored finish.
 */
function finishSelect(
  document: Document,
  printing: PrintingRecord | null,
  value: string,
): HTMLSelectElement {
  const offered = printing === null || !printing.physical ? uiCatalogFinishes : printing.finishes;
  const options: UiSelectOption[] = [
    { value: '', label: 'First offered finish' },
    ...offered.map((finish) => ({ value: finish, label: uiFinishLabel(finish) })),
  ];
  if (value.length > 0 && !options.some((option) => option.value === value)) {
    options.push({ value, label: `${value} (stored)` });
  }
  return selectControl(document, options, value);
}

/** One printing as the page presents it: its edition, collector number and language. */
function printingLine(printing: PrintingRecord): string {
  return `${printing.edition} ${printing.collectorNumber} · ${printing.language}`;
}

/** The source line of one pending entry as the review presents it. */
function sourceLineText(line: ImportSourceLine): string {
  const parts: string[] = [];
  if (line.name !== null) {
    parts.push(line.name);
  }
  if (line.set !== null || line.collectorNumber !== null) {
    parts.push(`(${line.set ?? ''} ${line.collectorNumber ?? ''})`.trim());
  }
  if (line.section !== null) {
    parts.push(line.section);
  }
  if (line.problem !== null) {
    parts.push(line.problem);
  }
  return parts.length === 0 ? 'the parsed source line' : parts.join(' · ');
}

/** One confirmation's receipt as the page presents it; a recovered outcome stays explicit. */
function confirmationMessage(copies: number, recovered: string | null): string {
  const line = `Confirmed: ${copies} ${copies === 1 ? 'physical copy' : 'physical copies'} created.`;
  return recovered === null ? line : `${line} ${recovered}`;
}

/** How the manual form reports the lines a staging attempt left in review. */
function stagedMessage(lines: number): string {
  return lines === 0
    ? 'Those lines were already in review; no new entries were added.'
    : `${lines} ${lines === 1 ? 'line is' : 'lines are'} in review. ` +
        'Confirmation creates the physical copies.';
}

/** One staging outcome as the manual form presents it, beside the lines an earlier request kept. */
function stagingOutcome(
  inReview: number,
  outcome: UiChangeCommit<ImportStageResult>,
): UiOperationOutcome {
  if (inReview === 0) {
    return { status: outcome.status, message: outcome.message };
  }
  return {
    status: outcome.status,
    message: `${stagedMessage(inReview)} ${outcome.message ?? ''}`.trim(),
  };
}

/** One sequence split into batches of at most `size` values, preserving its order. */
function inBatches<Value>(values: readonly Value[], size: number): readonly (readonly Value[])[] {
  const batches: Value[][] = [];
  for (let index = 0; index < values.length; index += size) {
    batches.push(values.slice(index, index + size));
  }
  return batches;
}

/** Whether one draft still holds exactly the reviewed input a save submitted. */
function sameReviewDraft(draft: UiReviewDraft, submitted: Readonly<UiReviewDraft>): boolean {
  return (
    draft.query === submitted.query &&
    draft.printingId === submitted.printingId &&
    draft.finish === submitted.finish &&
    draft.condition === submitted.condition &&
    draft.quantity === submitted.quantity
  );
}

/** The printing target whose entry key keeps one staged line's identity for an idempotent retry. */
function stagedLineTarget(line: UiImportLine): CardListTarget {
  return { kind: 'printing', printingId: line.printingId };
}

/** The first pending session of a page, preferring the account's manual entry queue. */
function defaultSessionId(sessions: readonly ImportSession[]): string | null {
  const manual = sessions.find((session) => session.sessionId === manualImport.sessionId);
  return manual?.sessionId ?? sessions[0]?.sessionId ?? null;
}

/** Each page keeps at most one window of drafts and records, independently of its rows. */
function boundByWindow<Value>(map: Map<string, Value>): void {
  while (map.size > UI_LIMITS.listWindow) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    map.delete(oldest);
  }
}

/** One note the page presents when it holds no list for an action. */
function note(document: Document, content: string): HTMLParagraphElement {
  const element = document.createElement('p');
  element.textContent = content;
  return element;
}

function text<K extends 'h2' | 'h3' | 'p'>(
  document: Document,
  tag: K,
  id: string,
  content: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.id = id;
  element.textContent = content;
  return element;
}

function statusLine(document: Document, id: string): HTMLParagraphElement {
  const element = document.createElement('p');
  element.id = id;
  element.setAttribute('role', 'status');
  element.setAttribute('aria-live', 'polite');
  return element;
}

function button(document: Document, id: string, label: string): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.id = id;
  element.textContent = label;
  return element;
}

function submitButton(document: Document, id: string, label: string): HTMLButtonElement {
  const element = button(document, id, label);
  element.type = 'submit';
  return element;
}

function textInput(document: Document, id: string, value: string): HTMLInputElement {
  const element = document.createElement('input');
  element.id = id;
  element.type = 'text';
  element.value = value;
  return element;
}

/** One bounded textarea control with the value the page retained. */
function textArea(
  document: Document,
  id: string,
  value: string,
  bound: number,
): HTMLTextAreaElement {
  const element = document.createElement('textarea');
  element.id = id;
  element.maxLength = bound;
  element.rows = 6;
  element.value = value;
  return element;
}

function numberInput(
  document: Document,
  id: string,
  value: string,
  bound: number,
): HTMLInputElement {
  const element = document.createElement('input');
  element.id = id;
  element.type = 'number';
  element.min = '1';
  element.max = String(bound);
  element.value = value;
  return element;
}

/** One select control with the supplied options and initial value. */
function select(
  document: Document,
  options: readonly UiSelectOption[],
  value: string,
): HTMLSelectElement {
  return selectControl(document, options, value);
}

function readMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}
