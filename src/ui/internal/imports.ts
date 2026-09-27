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
 * them with its history entry. The identity of a source import stays with the account in browser
 * storage instead: an unfinished import whose response was lost or that is still pending keeps the
 * input and the identity it was dispatched under across a reload and a source-method change, so its
 * retry quotes that identity rather than composing a second import, while an established import
 * releases it and the next list the owner starts gets its own identity and stays a separate import
 * (docs/user-interface.md#source-imports). The lists own their windows, selection and restoration,
 * and the pending entries and operation receipts themselves stay with UserCards. Leaving the view
 * releases its lists and aborts their work, so a late response cannot change another view or
 * account.
 */

import type { SearchClient } from '../../application/index.js';
import type { CardRecord, Catalog, Finish, PrintingRecord } from '../../catalog/index.js';
import { recognitionEngineNames } from '../../recognition/index.js';
import type {
  ConfirmImportEntryInput,
  CopyCondition,
  ImportEntry,
  ImportEntryListResult,
  ImportReceipt,
  ImportSession,
  ImportSessionListResult,
  ImportStageResult,
  ImportSourceLine,
  ReviewedWizardsLine,
  SourceImportOutcome,
  SourceImportResult,
  SourceImportRow,
  StageSourceImportInput,
} from '../../usercards/index.js';

import { createCaptureControls, type UiCaptureReviewChange } from './capture.js';
import {
  cardListBasicContent,
  createCardList,
  type UiCardList,
  type UiCardListState,
  type UiCardListTool,
} from './card-list.js';
import { uiCopyConditions } from './copy-edits.js';
import {
  confirmImport,
  createImportAccess,
  discardImportEntry,
  discardImportSession,
  recoverConfirmation,
  reviewImportEntry,
  stageImportLines,
  stageSourceImport,
  uiImportCandidates,
  uiImportIdentity,
  uiImportSourceLabel,
  uiUnfinishedSourceMessage,
  type UiImportLine,
} from './import-edits.js';
import { isUiInvalidatedContinuation, type UiChangeCommit } from './failure.js';
import {
  createSourceImportRecovery,
  releaseSourceImports,
  type UiSourceFormat,
  type UiSourceImportRecovery,
  type UiSourceInput,
  type UiUnfinishedSourceImport,
} from './import-recovery.js';
import { UI_LIMITS } from './limits.js';
import type {
  UiEntryTarget,
  UiFragmentReader,
  UiListEntry,
  UiListSource,
  UiOperationOutcome,
  UiToolRequest,
} from './list.js';
import type { UiPageDefinition } from './pages.js';
import {
  controlLabel,
  readListState,
  readPageState,
  selectControl,
  type UiSelectOption,
} from './page-support.js';
import { uiCatalogFinishes, uiFinishLabel } from './routes.js';
import { createCatalogSearchAccess, uiEntryKey, type UiCatalogQuery } from './search-source.js';

/** The one manual entry queue of an account; its lines are reviewed and confirmed like any import. */
const manualImport = {
  sessionId: 'manual',
  source: { kind: 'manual', id: 'manual' },
} as const;

/** Largest pending quantity one manual line may declare; the value mirrors the provider's bound. */
export const uiMaxImportQuantity = 100;

/** The source methods the Import page offers, in the order its form presents them. */
const uiSourceFormats = ['pasted-list', 'moxfield', 'wizards-precon'] as const;

/** The Import page: manual entry beside the pending review and confirmation of one import. */
export function createImportPages(): readonly UiPageDefinition[] {
  // The storage the Import page keeps its account's unfinished source imports in, learned when the
  // page is presented: an account's records end with the account even when another page is the one
  // presented when identity changes
  // (docs/user-interface.md#state-ownership-and-restoration).
  const sourceStorage: { current: Storage | null } = { current: null };
  return [
    {
      ...importPage(sourceStorage),
      accountEnded: (accountId) => releaseSourceImports(sourceStorage.current, accountId),
    },
  ];
}

/** One pending entry as the page interprets it: its stored record and the catalog record it names. */
interface UiPendingRecord {
  readonly entry: ImportEntry;
  /** Printing the entry names, or null while the entry is unresolved. */
  readonly printing: PrintingRecord | null;
  /** Card of the printing, used to render the entry's basic information. */
  readonly card: CardRecord | null;
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

/** One manual line a failed or uncertain staging keeps, so its retry reuses its identity. */
interface UiStagingDraft {
  readonly entryId: string;
  readonly finish: string;
  readonly condition: string;
  readonly quantity: number;
}

/**
 * Unsaved input of the source form. The page keeps it with its history entry so leaving and
 * returning keeps the edits to retry; the identity of the import an input composes stays with the
 * account instead, because importing the same source again under that identity is what replays the
 * rows the provider recorded instead of staging them twice
 * (docs/user-interface.md#source-imports).
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
 * One outstanding confirmation, retained until its own operation outcome is established.
 */
interface UiConfirmationDraft {
  /** Import session the confirmed entries belong to. */
  readonly sessionId: string;
  readonly operationId: string;
  readonly entries: readonly ConfirmImportEntryInput[];
}

/** One presented pending-entry editor, redrawn as its draft or its stored record changes. */
interface UiImportEditor {
  readonly controls: HTMLSpanElement;
  readonly entry: UiListEntry;
  readonly status: HTMLParagraphElement;
}

function importPage(sourceStorage: { current: Storage | null }): UiPageDefinition {
  return {
    page: 'import',
    mount(container, context) {
      const document = container.ownerDocument;
      const access = createImportAccess(context.capabilities.userCards);
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
        uiMaxImportQuantity,
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
      const resultsHost = document.createElement('div');
      resultsHost.id = 'import-results';
      const resultsHeading = text(document, 'h3', 'import-results-heading', 'Add a printing');

      // Source imports are the deployment's capability: when the configuration disables them, the
      // page presents no method the backend would refuse (docs/user-interface.md#source-imports).
      const sourceEnabled = context.capabilities.settings.capabilities.sourceImports;
      sourceStorage.current = pageStorage(document);
      const recovery: UiSourceImportRecovery | null = sourceEnabled
        ? createSourceImportRecovery(sourceStorage.current, context.account.accountId)
        : null;
      const source = readSourceDraft(restored?.source, recovery?.outstanding);
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
        UI_LIMITS.importSourceText,
      );
      const sourceUrl = textInput(document, 'import-source-url', source.url);
      sourceUrl.type = 'url';
      sourceUrl.maxLength = UI_LIMITS.entryKey;
      sourceUrl.placeholder = 'https://moxfield.com/decks/…';
      const sourceIdentity = textInput(document, 'import-source-identity', source.identity);
      sourceIdentity.maxLength = UI_LIMITS.entryKey;
      sourceIdentity.placeholder = 'wizards:mkm:deadly-disguise:regular:en';
      const sourceReference = textInput(document, 'import-source-reference', source.reference);
      sourceReference.type = 'url';
      sourceReference.maxLength = UI_LIMITS.entryKey;
      sourceReference.placeholder = 'https://magic.wizards.com/en/news/feature/decklist';
      const sourceLines = textArea(
        document,
        'import-source-lines',
        source.lines,
        UI_LIMITS.importSourceText,
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
      const sourceNote = note(
        document,
        'Parsing a source only stages pending entries. Confirm the reviewed lines to create ' +
          'their physical copies.',
      );
      sourceNote.id = 'import-source-note';

      // Hands-free camera capture feeds the same pending review as manual entry and stays with the
      // page: closing the view disposes it, releasing the camera and the Recognition session
      // (docs/user-interface.md#capture-and-review).
      const capture = createCaptureControls({
        document,
        access,
        device: context.device,
        createRecognition: context.capabilities.createRecognition,
        engines: recognitionEngineNames(context.capabilities.settings.recognition.cloudEnabled),
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
        resultsHeading,
        resultsHost,
        ...(sourceEnabled ? [sourceHeading, sourceForm, sourceStatus, sourceRows, sourceNote] : []),
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
      /** Stored records of the presented pending entries, keyed by their entry key. */
      const records = new Map<string, UiPendingRecord>();
      /**
       * Reviewed revision of every explicitly selected entry the page has read, kept while the
       * selection names it so a confirmation covers entries outside the loaded window
       * (docs/user-interface.md#state-ownership-and-restoration).
       */
      const selectedRevisions = readSelectedRevisions(restored?.selection);
      /** Per-entry messages the page presents, kept across the redraws of their editor. */
      const messages = new Map<string, string>();
      /** Printings one row's own search offered, keyed by entry identity. */
      const printings = new Map<string, readonly PrintingRecord[]>();
      /** Current search per entry; editing its query or leaving its session retires the request. */
      const printingSearches = new Map<string, symbol>();
      /** Unsaved manual lines kept for an idempotent retry, keyed by the entry key they stage. */
      const staging = readStagingDrafts(restored?.staging);
      /** Unsaved review input per entry, kept across redraws and with the history entry. */
      const drafts = readReviewDrafts(restored?.review);
      let confirmation = readConfirmationDraft(restored?.confirmation);
      let results: UiCardList<UiCatalogQuery> | null = null;
      let pending: UiCardList<string> | null = null;
      /** Whether a confirmation or a recovery of one is in flight, so only one acts at a time. */
      let confirming = false;
      let recovering = false;
      /** Whether a source is being parsed, so one import is in flight at a time. */
      let sourcing = false;
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
      discard.addEventListener('click', () => {
        void discardImport();
      });

      if (retainedResults !== null) {
        composeResults(readListState<UiCatalogQuery>(retainedResults));
      }
      if (retainedPending !== null) {
        composePending(retainedPending.sessionId, retainedPending.list);
      }
      paintSourceForm();
      paintUnfinishedSource();
      paintConfirmation();
      if (confirmation !== null) {
        // A confirmation the page kept without an established outcome stays recoverable through
        // its operation identity, also after returning to the view
        // (docs/application.md#construction-and-request-boundary).
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
          // edits to retry, and the account keeps the identity of an import whose outcome was not
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
          // Unsaved lines and review input stay with the entry, so leaving the view and returning to
          // it keeps the edits the user must review and retry
          // (docs/user-interface.md#state-ownership-and-restoration).
          staging: Object.fromEntries([...staging].map(([key, line]) => [key, { ...line }])),
          review: Object.fromEntries([...drafts].map(([id, draft]) => [id, { ...draft }])),
          // The reviewed revisions of the explicit selection stay with the entry, so a
          // confirmation still covers entries the loaded window no longer presents.
          selection: Object.fromEntries(
            [...selectionContext()].map(([key, review]) => [key, { ...review }]),
          ),
          confirmation:
            confirmation === null
              ? null
              : {
                  sessionId: confirmation.sessionId,
                  operationId: confirmation.operationId,
                  entries: confirmation.entries.map((entry) => ({ ...entry })),
                },
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
          results?.restoration?.presented ?? null,
          pending?.restoration?.presented ?? null,
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
              pageSize: UI_LIMITS.importSessions,
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
        records.clear();
        selectedRevisions.clear();
        messages.clear();
        session = null;
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
        restoredState: UiCardListState<string> | undefined,
      ): void {
        pending?.dispose();
        pending = createCardList<string>({
          container: pendingHost,
          source: pendingSource(),
          context: presentedSession,
          pageSize: UI_LIMITS.importPage,
          restored: restoredState,
          fragments: { tools: pendingToolsReader() },
          tools: [confirmTool()],
          presentation: {
            renderEntry: (entry) => entryContent(entry),
            renderFragment: (kind, entry) => (kind === 'tools' ? entryEditor(entry) : null),
          },
          signal: context.signal,
        });
      }

      /** Composes the catalog result list of the manual entry search. */
      function composeResults(restoredState: UiCardListState<UiCatalogQuery> | undefined): void {
        const resultsAccess = createCatalogSearchAccess(search, catalog);
        results = createCardList<UiCatalogQuery>({
          container: resultsHost,
          source: resultsAccess.source,
          context: { text: query.value.trim(), level: 'printing', owned: false, finish: null },
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
        const wanted: UiCatalogQuery = {
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
        sourceSubmit.disabled = sourcing;
        sourceSubmit.textContent = sourcing ? 'Reading the source…' : 'Add source to review';
      }

      /**
       * Explains an unfinished import of the presented method: the account still keeps the input
       * the page dispatched under one identity, and importing that input again reads the rows the
       * provider recorded instead of staging a second list
       * (docs/user-interface.md#source-imports).
       */
      function paintUnfinishedSource(): void {
        const format = readSourceFormat(sourceFormat.value);
        if (format === null || recovery === null || !recovery.outstanding.has(format)) {
          return;
        }
        sourceStatus.textContent = uiUnfinishedSourceMessage;
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

      /** The request one source input dispatches, quoting the import identity it composes. */
      function sourceRequest(input: UiSourceInput, sessionId: string): StageSourceImportInput {
        switch (input.format) {
          case 'pasted-list':
            return { format: input.format, sessionId, text: input.text };
          case 'moxfield':
            return { format: input.format, sessionId, url: input.url };
          case 'wizards-precon':
            return {
              format: input.format,
              sessionId,
              sourceId: input.identity,
              reference: input.reference,
              entries: reviewedWizardsLines(input.lines),
            };
        }
      }

      /**
       * Parses the source method the form presents into pending entries of the account and
       * presents what every row became. The provider never confirms ownership, so the outcome
       * reports the lines that entered review beside the ones it had already staged or acquired;
       * a source whose response is lost stays retained with the identity of the import it composes
       * and is recovered by importing that input again
       * (docs/user-interface.md#source-imports).
       */
      async function importSource(): Promise<void> {
        if (sourcing) {
          return;
        }
        const input = sourceInput();
        if (input === null) {
          return;
        }
        // Retrying an input whose import has no established outcome keeps that import's identity;
        // any other input composes an import of its own
        // (docs/user-interface.md#source-imports).
        const retained = recovery?.retained(input) ?? null;
        const request = sourceRequest(input, retained ?? uiImportIdentity());
        // The identity is kept before the request is dispatched, so a reload while it is pending,
        // or a response that never arrives, still retries this import instead of staging another
        // one (docs/user-interface.md#source-imports).
        recovery?.remember(request.sessionId, input);
        sourcing = true;
        paintSourceForm();
        let outcome: UiChangeCommit<SourceImportResult>;
        try {
          outcome = await stageSourceImport(access, request, context.signal);
        } finally {
          sourcing = false;
          paintSourceForm();
        }
        // An outcome the provider established decides this import: a committed parse leaves nothing
        // to retry, and an input that was refused before writing composes a new import on its next
        // submission. A refused retry leaves the earlier uncertain attempt standing.
        if (outcome.status === 'committed' || (outcome.status === 'failed' && retained === null)) {
          recovery?.forget(input.format);
        }
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
       * condition the form presents. The line identity of a line that did not commit stays, so a
       * retry replays the same staging instead of adding the line twice
       * (docs/user-cards.md#import-and-capture-state).
       */
      async function addSelection(request: UiToolRequest): Promise<UiOperationOutcome> {
        const wantedQuantity = readQuantity(quantity, uiMaxImportQuantity);
        if (wantedQuantity === null) {
          return {
            status: 'failed',
            message: `Choose a quantity from 1 to ${uiMaxImportQuantity}.`,
          };
        }
        const wantedFinish = readFinishValue(finish.value);
        const wantedCondition = readConditionValue(condition.value);
        const lines: UiImportLine[] = [];
        const retained = new Set(staging.keys());
        for (const target of request.targets) {
          if (target.kind !== 'printing') {
            continue;
          }
          const key = uiEntryKey(target);
          const kept = staging.get(key);
          if (
            kept !== undefined &&
            (kept.finish !== finish.value ||
              kept.condition !== condition.value ||
              kept.quantity !== wantedQuantity)
          ) {
            return {
              status: 'failed',
              message:
                'Retry the pending staging with its original finish, condition and quantity ' +
                'before adding changed values.',
            };
          }
          const line: UiImportLine = {
            entryId: kept?.entryId ?? uiImportIdentity(),
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
        // keeping its identity for an idempotent retry (docs/user-cards.md#interface).
        let inReview = 0;
        let reported: UiOperationOutcome | null = null;
        for (const batch of inBatches(lines, UI_LIMITS.importBatch)) {
          const keys = batch.map((line) => uiEntryKey(stagedLineTarget(line)));
          for (const line of batch) {
            staging.set(uiEntryKey(stagedLineTarget(line)), {
              entryId: line.entryId,
              finish: line.finish ?? '',
              condition: line.condition ?? '',
              quantity: line.quantity,
            });
          }
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
            // The lines are in review now; only a confirmation creates the physical copies.
            forgetStaged(keys);
            inReview += outcome.record?.staged ?? 0;
            continue;
          }
          if (outcome.status === 'failed') {
            // A first attempt rejected before writing can be corrected. A rejected retry does
            // not establish the outcome of an earlier uncertain attempt with that identity.
            forgetStaged(keys.filter((key) => !retained.has(key)));
          }
          reported = stagingOutcome(inReview, outcome);
          break;
        }
        // Reading the pending entries shows whether a staging committed even though its response
        // was lost (docs/user-interface.md#capture-and-review).
        void reconcileImport();
        return reported ?? { status: 'committed', message: stagedMessage(inReview) };
      }

      /** Drops the kept line identities of the given entries after their staging was decided. */
      function forgetStaged(keys: Iterable<string>): void {
        for (const key of keys) {
          staging.delete(key);
        }
      }

      /** Reloads the pending sessions and entries after a change that may have committed. */
      async function reconcileImport(): Promise<void> {
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
        pending?.refresh();
      }

      /**
       * Takes one capture change into the review. A staged observation is presented in its capture
       * session, so the candidate the success cue announced is visible in review; late alternatives
       * reload the session that holds them when the review presents it; an unknown outcome re-reads
       * what the provider holds instead of inferring an entry
       * (docs/user-interface.md#capture-and-review).
       */
      async function reconcileCapture(change: UiCaptureReviewChange): Promise<void> {
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
        pending?.refresh();
      }

      /** One row's basic information: the printing it will create and its reviewed values. */
      function entryContent(entry: UiListEntry): Node {
        return cardListBasicContent(document, entry);
      }

      /**
       * The editor of one pending entry: the reviewed printing, finish, condition and quantity it
       * exposes before confirmation, the printing search that corrects them and the controls that
       * save the review or discard the entry (docs/user-interface.md#capture-and-review).
       */
      function entryEditor(entry: UiListEntry): Node | null {
        const record = records.get(entry.key);
        if (record === undefined) {
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
        const record = records.get(editor.entry.key);
        if (record === undefined) {
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
          uiMaxImportQuantity,
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
      function reviewedContent(record: UiPendingRecord): Node {
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
        const record = records.get(editor.entry.key);
        if (record === undefined) {
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
            // The row may have been redrawn while the search ran; update its current editor.
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
        const record = records.get(editor.entry.key);
        if (record === undefined) {
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
        const wantedQuantity = readQuantityValue(submitted.quantity, uiMaxImportQuantity);
        if (wantedQuantity === null) {
          report(editor, `Choose a quantity from 1 to ${uiMaxImportQuantity}.`);
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
          adoptEntry(outcome.record.entry, outcome.record.session);
          if (outcome.record.session.sessionId === sessionId) {
            // The stored values and the printing the entry now names are read again, so the row
            // presents what the review committed rather than the values it started from.
            pending?.refresh();
          }
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
        const record = records.get(editor.entry.key);
        if (record === undefined) {
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
        await reconcileImport();
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
        if (outcome.status === 'committed') {
          // The discarded import is abandoned: the account keeps no identity to retry it under, so
          // the next submission of that input composes a new list
          // (docs/user-interface.md#source-imports).
          recovery?.forgetImport(presented);
        }
        if (outcome.status === 'committed' && presented === sessionId) {
          // Only the discarded import's own review input ends; the unsaved work of another import
          // the page still presents stays (docs/user-interface.md#state-ownership-and-restoration).
          forgetPresentedEntries();
          paintConfirmation();
        }
        await reconcileImport();
      }

      /** Drops the drafts, searches and messages of the presented import's loaded entries. */
      function forgetPresentedEntries(): void {
        for (const [key, record] of records) {
          drafts.delete(record.entry.entryId);
          printings.delete(record.entry.entryId);
          printingSearches.delete(record.entry.entryId);
          messages.delete(key);
        }
        records.clear();
        selectedRevisions.clear();
      }

      /** Confirms the selected entries and presents the copies its receipt names. */
      async function confirmSelection(request: UiToolRequest): Promise<UiOperationOutcome> {
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
          const key = uiEntryKey(target);
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
          for (const entries of inBatches(chosen, UI_LIMITS.importBatch)) {
            const operation: UiConfirmationDraft = {
              sessionId: presented,
              operationId: uiImportIdentity(),
              entries,
            };
            confirmation = operation;
            paintConfirmation();
            const outcome = await confirmImport(
              access,
              { operationId: operation.operationId, sessionId: presented, entries },
              request.signal,
            );
            if (closed) {
              return { status: 'unknown', message: null };
            }
            if (outcome.status !== 'unknown' && confirmation === operation) {
              confirmation = null;
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
        void reconcileImport();
        return { status: 'committed', message };
      }

      /** Clears only the selection and drafts covered by this established confirmation. */
      function forgetConfirmed(operation: UiConfirmationDraft): void {
        for (const entry of operation.entries) {
          const key = uiEntryKey({ kind: 'pending', entryId: entry.entryId });
          if (sessionId === operation.sessionId) {
            pending?.setSelected(key, false);
            selectedRevisions.delete(key);
          }
          drafts.delete(entry.entryId);
          printings.delete(entry.entryId);
          printingSearches.delete(entry.entryId);
        }
      }

      /** Takes the committed entry and session into the page's own view of them. */
      function adoptEntry(entry: ImportEntry, changed: ImportSession): void {
        if (changed.sessionId !== sessionId) {
          // The review committed in an import the page no longer presents: its listed counts
          // follow the report, while the presented import's own state stays untouched
          // (docs/user-interface.md#pages-and-navigation).
          adoptSession(changed);
          return;
        }
        const key = uiEntryKey({ kind: 'pending', entryId: entry.entryId });
        const record = records.get(key);
        if (record !== undefined) {
          records.delete(key);
          records.set(key, { ...record, entry });
        }
        adoptSession(changed);
        pending?.reloadFragment(key, 'tools');
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
        const record = records.get(key);
        if (record !== undefined && record.entry.entryId === entryId) {
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
          const record = records.get(key);
          const known =
            record === undefined
              ? selectedRevisions.get(key)
              : { entryId: record.entry.entryId, revision: record.entry.revision };
          if (known !== undefined) {
            context.set(key, known);
          }
        }
        return context;
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
          outcome = await recoverConfirmation(access, outstanding.operationId, context.signal);
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
          void reconcileImport();
          return;
        }
        reviewStatus.textContent = outcome.message ?? 'The confirmation outcome could not be read.';
      }

      /** Keeps one message with its entry, so a redraw of the row presents it again. */
      function report(editor: UiImportEditor, message: string): void {
        messages.set(editor.entry.key, message);
        boundByWindow(messages);
        editor.status.textContent = message;
      }

      /** Drops the message of one entry when its owner edits the reviewed values again. */
      function clearMessage(editor: UiImportEditor): void {
        messages.delete(editor.entry.key);
        editor.status.textContent = '';
      }

      /**
       * The unsaved review input of one entry, created from the values the page presented when the
       * owner first edits one of them: reviewing a single attribute keeps every other stored value
       * of that entry (docs/user-interface.md#capture-and-review).
       */
      function draftFor(record: UiPendingRecord): UiReviewDraft {
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

      /** Whether each presented entry's stored revision is known for a confirmation. */
      function pendingToolsReader(): UiFragmentReader<readonly string[]> {
        return {
          read(request) {
            return Promise.resolve(
              request.keys.map((key) => ({
                key,
                status: 'ready' as const,
                values: records.has(key) || selectedRevisions.has(key) ? ['confirm-import'] : [],
              })),
            );
          },
        };
      }

      /** Whether each printed search result can enter the manual import. */
      function resultToolsReader(): UiFragmentReader<readonly string[]> {
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
      function addTool(): UiCardListTool {
        return {
          id: 'add-to-review',
          label: 'Add to review',
          tool: {
            invoke: (request: UiToolRequest): Promise<UiOperationOutcome> => addSelection(request),
          },
        };
      }

      /** The tool that confirms the explicit selected pending entries. */
      function confirmTool(): UiCardListTool {
        return {
          id: 'confirm-import',
          label: 'Confirm selected',
          tool: {
            invoke: (request: UiToolRequest): Promise<UiOperationOutcome> =>
              confirmSelection(request),
          },
        };
      }

      /**
       * The pending entries of one session through the list boundary: each entry keeps its own
       * identity as a pending target and is enriched with the catalog record its printing names.
       * An entry the catalog cannot resolve stays explicitly unresolved instead of presenting
       * another card's information.
       */
      function pendingSource(): UiListSource<string> {
        return {
          async load(request) {
            let page: ImportEntryListResult;
            try {
              page = await access.entries(
                {
                  sessionId: request.context,
                  pageSize: request.pageSize,
                  ...(request.continuation === null ? {} : { continuation: request.continuation }),
                },
                request.signal,
              );
            } catch (cause) {
              if (request.continuation !== null && isUiInvalidatedContinuation(cause)) {
                // The session's private revision changed after the continuation was read: the
                // list restarts the pending entries from their first page instead of repeating a
                // continuation the provider keeps refusing (docs/user-cards.md#interface).
                return { status: 'invalidated' };
              }
              throw cause;
            }
            const read = await resolvePending(catalog, page.entries);
            const presented = request.context;
            if (request.signal.aborted || closed || presented !== sessionId) {
              // A withdrawn request, or a response of an import the review no longer presents,
              // cannot change the page's own records or the session it presents
              // (docs/user-interface.md#pages-and-navigation).
              return {
                status: 'page',
                entries: read.map((record) => pendingListEntry(entryKeyOf(record), record)),
                continuation: page.continuation,
              };
            }
            const selected = new Set(pending?.selection ?? []);
            for (const record of read) {
              const key = entryKeyOf(record);
              records.delete(key);
              records.set(key, record);
            }
            for (const key of selected) {
              const record = records.get(key);
              if (record !== undefined) {
                // The confirmation needs the revision the page read even after the row leaves the
                // loaded window (docs/user-interface.md#state-ownership-and-restoration).
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
            boundByWindow(records);
            adoptSession(page.session);
            return {
              status: 'page',
              entries: read.map((record) => pendingListEntry(entryKeyOf(record), record)),
              continuation: page.continuation,
            };
          },
        };
      }
    },
  };
}

/** One pending entry as the list boundary presents it, with the catalog record it names. */
function pendingListEntry(key: string, record: UiPendingRecord): UiListEntry {
  const printing = record.printing;
  return {
    key,
    target: { kind: 'pending', entryId: record.entry.entryId },
    // The reviewed quantity is pending input, not an owned copy count, so the entry carries no
    // quantity context and the review presents its own value.
    quantity: null,
    basic:
      printing === null || record.card === null
        ? null
        : {
            card: {
              cardId: record.card.cardId,
              name: record.card.name,
              matchedName: null,
            },
            printing: {
              printingId: printing.printingId,
              edition: printing.edition,
              collectorNumber: printing.collectorNumber,
              language: printing.language,
            },
          },
  };
}

/** Entry key of one pending record, taken from its own identity. */
function entryKeyOf(record: UiPendingRecord): string {
  return uiEntryKey({ kind: 'pending', entryId: record.entry.entryId });
}

/** Resolves the printings and cards the pending entries name through Catalog. */
async function resolvePending(
  catalog: Catalog,
  entries: readonly ImportEntry[],
): Promise<readonly UiPendingRecord[]> {
  const printingIds = entries.flatMap((entry) =>
    entry.printingId === null ? [] : [entry.printingId],
  );
  const printings = await resolvePrintings(catalog, printingIds);
  const cardIds = [...new Set([...printings.values()].map((printing) => printing.cardId))];
  const cards = await resolveCards(catalog, cardIds);
  return entries.map((entry) => {
    const printing = entry.printingId === null ? null : (printings.get(entry.printingId) ?? null);
    const card = printing === null ? null : (cards.get(printing.cardId) ?? null);
    return { entry, printing, card };
  });
}

/** Printings one pending entry may name, resolved through Catalog in bounded batches. */
async function resolvePrintings(
  catalog: Catalog,
  printingIds: readonly string[],
): Promise<ReadonlyMap<string, PrintingRecord>> {
  const printings = new Map<string, PrintingRecord>();
  const distinct = [...new Set(printingIds)];
  for (let index = 0; index < distinct.length; index += UI_LIMITS.copyBatch) {
    const batch = distinct.slice(index, index + UI_LIMITS.copyBatch);
    const resolution = await catalog.resolve(
      batch.map((printingId) => ({ kind: 'printing' as const, printingId })),
    );
    for (const printing of resolution.printings.values()) {
      printings.set(printing.printingId, printing);
    }
  }
  return printings;
}

/** Cards the pending entries reach, resolved through Catalog in bounded batches. */
async function resolveCards(
  catalog: Catalog,
  cardIds: readonly string[],
): Promise<ReadonlyMap<string, CardRecord>> {
  const cards = new Map<string, CardRecord>();
  const distinct = [...new Set(cardIds)];
  for (let index = 0; index < distinct.length; index += UI_LIMITS.copyBatch) {
    const batch = distinct.slice(index, index + UI_LIMITS.copyBatch);
    const resolution = await catalog.resolve(
      batch.map((cardId) => ({ kind: 'card' as const, cardId })),
    );
    for (const card of resolution.cards.values()) {
      cards.set(card.cardId, card);
    }
  }
  return cards;
}

/** Printings one review search offers for a card name or expression. */
async function searchPrintings(
  search: SearchClient,
  catalog: Catalog,
  text: string,
  signal: AbortSignal,
): Promise<readonly PrintingRecord[]> {
  const page = await search.execute(
    { resultLevel: 'printing', query: text, pageSize: UI_LIMITS.importPrintings },
    signal,
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
 * The session storage of the page's browsing context, or null when the context offers none. The
 * storage keeps an account's unfinished source imports across a reload
 * (docs/user-cards.md#persistence-and-recovery).
 */
function pageStorage(document: Document): Storage | null {
  try {
    return document.defaultView?.sessionStorage ?? null;
  } catch {
    // A browsing context that refuses storage keeps the page's in-memory records only.
    return null;
  }
}

/**
 * The source form one history entry kept, or the unfinished imports the account kept across a
 * reload. An unfinished import is presented beside the input it composes, so submitting that input
 * again retries its own list instead of staging another one
 * (docs/user-interface.md#source-imports).
 */
function readSourceDraft(
  value: unknown,
  outstanding: ReadonlyMap<UiSourceFormat, UiUnfinishedSourceImport> | undefined,
): UiSourceDraft {
  const record = readPageState(value);
  if (record === null) {
    return unfinishedSourceDraft(outstanding ?? new Map());
  }
  return {
    format: readSourceFormat(readDraftValue(record.format, 32) ?? '') ?? 'pasted-list',
    text: readDraftValue(record.text, UI_LIMITS.importSourceText) ?? '',
    url: readDraftValue(record.url, UI_LIMITS.entryKey) ?? '',
    identity: readDraftValue(record.identity, UI_LIMITS.entryKey) ?? '',
    reference: readDraftValue(record.reference, UI_LIMITS.entryKey) ?? '',
    lines: readDraftValue(record.lines, UI_LIMITS.importSourceText) ?? '',
  };
}

/**
 * The fields of the account's unfinished imports, each method filling its own controls, most
 * recently dispatched last (docs/user-interface.md#source-imports).
 */
function unfinishedSourceDraft(
  outstanding: ReadonlyMap<UiSourceFormat, UiUnfinishedSourceImport>,
): UiSourceDraft {
  const draft: UiSourceDraft = {
    format: uiSourceFormats[0],
    text: '',
    url: '',
    identity: '',
    reference: '',
    lines: '',
  };
  for (const unfinished of outstanding.values()) {
    draft.format = unfinished.input.format;
    switch (unfinished.input.format) {
      case 'pasted-list':
        draft.text = unfinished.input.text;
        break;
      case 'moxfield':
        draft.url = unfinished.input.url;
        break;
      case 'wizards-precon':
        draft.identity = unfinished.input.identity;
        draft.reference = unfinished.input.reference;
        draft.lines = unfinished.input.lines;
        break;
    }
  }
  return draft;
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

/** The manual lines a history entry kept for an idempotent retry. */
function readStagingDrafts(value: unknown): Map<string, UiStagingDraft> {
  const drafts = new Map<string, UiStagingDraft>();
  const record = readPageState(value);
  if (record === null) {
    return drafts;
  }
  for (const [key, candidate] of Object.entries(record)) {
    const line = readPageState(candidate);
    const entryId = readDraftValue(line?.entryId, UI_LIMITS.entryKey);
    const quantity = readQuantityValue(line?.quantity, uiMaxImportQuantity);
    if (line === null || entryId === null || quantity === null) {
      continue;
    }
    drafts.set(key, {
      entryId,
      finish: readDraftValue(line.finish, 16) ?? '',
      condition: readDraftValue(line.condition, 8) ?? '',
      quantity,
    });
  }
  // Retry identities belong to the outstanding action, not the rendered working window.
  return drafts;
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
 * The outstanding confirmation one history entry kept, recoverable through its operation identity
 * independently of the pending entries it covered.
 */
function readConfirmationDraft(value: unknown): UiConfirmationDraft | null {
  const record = readPageState(value);
  const sessionId = readSessionId(record?.sessionId);
  const operationId = readDraftValue(record?.operationId, UI_LIMITS.entryKey);
  const entries = record?.entries;
  if (sessionId === null || operationId === null || !Array.isArray(entries)) {
    return null;
  }
  const read: ConfirmImportEntryInput[] = [];
  for (const candidate of entries) {
    const entry = readPageState(candidate);
    const entryId = readDraftValue(entry?.entryId, UI_LIMITS.entryKey);
    const revision = entry?.expectedRevision;
    if (entryId === null || !Number.isSafeInteger(revision) || Number(revision) < 1) {
      return null;
    }
    read.push({ entryId, expectedRevision: Number(revision) });
  }
  return read.length === 0 ? null : { sessionId, operationId, entries: read };
}

/**
 * The pending list state one history entry kept, with the session it belongs to. The captured
 * `{ sessionId, list }` representation is read exactly once, so the list's own state reaches the
 * list that interprets it (docs/user-interface.md#state-ownership-and-restoration).
 */
function readRetainedPending(
  value: unknown,
  sessionId: string | null,
): { readonly sessionId: string; readonly list: UiCardListState<string> | undefined } | null {
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
  record: UiPendingRecord,
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
  record: UiPendingRecord,
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
function stagedLineTarget(line: UiImportLine): UiEntryTarget {
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
