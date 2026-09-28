/**
 * Copy attribute editors of the collection and card-details views
 * (docs/ui/editors.md#internal-design, docs/ui/editors.md#drafts-and-asynchronous-outcomes).
 *
 * The collection's bulk editor owns the values its controls apply to the explicit selection and
 * runs one action per attribute through the private UserCards contract; the copy editor of one
 * physical copy owns its unsaved printing, finish and condition draft and presents its printing
 * choices through a supplied CardViews picker over the card's published printings. Neither editor
 * decides a business rule: revisions, conflicts, validation and committed values come from the
 * provider-owned operations.
 */

import type {
  CardListBrowser,
  CardListEntryPrinting,
  CardListFragmentReader,
  CardListToolSelection,
} from '../../../card-list/index.js';
import { resolvePrintings } from '../../../card-list/index.js';
import type { CardRecord, Catalog, Finish, PrintingRecord } from '../../../catalog/index.js';
import type { PhysicalCopy } from '../../../usercards/index.js';

import type { CardViews, UiCardList, UiListAction } from '../../card-views/index.js';
import type { UiActionIntent } from '../../shared/actions.js';
import {
  button,
  controlLabel,
  optionElement,
  readMessage,
  selectControl,
  text,
} from '../../shared/controls.js';
import { UI_LIMITS } from '../../shared/limits.js';
import { readUiCatalogFinish, uiCatalogFinishes, uiFinishLabel } from '../../shared/vocabulary.js';
import {
  copyChangeTool,
  correctCopy,
  uiCopyConditions,
  type UiCopyAccess,
  type UiCopyChange,
  type UiCopyCorrection,
} from './copy-edits.js';
import { applyAction, outcomeText, type UiOperationOutcome } from './operations.js';

/** Draft of the collection's bulk change controls. */
export interface UiCopyBulkDraft {
  readonly finish: string;
  readonly condition: string;
}

export interface UiCopyBulkEditorOptions {
  readonly document: Document;
  /** Private copy access the bulk tools act through. */
  readonly access: UiCopyAccess;
  /** Aborted when the view closes; a dispatched change stops then. */
  readonly signal: AbortSignal;
  /** Draft a previous visit retained, when it carried one. */
  readonly restored?: unknown;
}

/**
 * The bulk copy change editor: the values its controls apply beside the actions the list presents
 * for the explicit selection. The editor owns what one action does — it runs the private change
 * over the targets the list reported and presents its pending state and authoritative outcome.
 * Only a physical-copy selection carries the actions, so the page presents availability for the
 * `tools` fragment separately.
 */
export interface UiCopyBulkEditor {
  readonly element: HTMLFieldSetElement;
  /** Advisory actions the page hands to the list for its explicit selection. */
  readonly actions: readonly UiListAction[];
  /** Runs the action the list reported and presents its pending state and outcome. */
  apply(intent: UiActionIntent): void;
  capture(): UiCopyBulkDraft;
  restore(draft: unknown): void;
}

export function createCopyBulkEditor(options: UiCopyBulkEditorOptions): UiCopyBulkEditor {
  const document = options.document;
  const fieldset = document.createElement('fieldset');
  fieldset.id = 'collection-changes';
  const legend = document.createElement('legend');
  legend.textContent = 'Bulk copy changes';
  const hint = document.createElement('p');
  hint.textContent =
    'Select physical copies in the list, choose a value and apply it to the whole selection.';
  const finish = selectControl(
    document,
    [
      { value: '', label: 'Choose finish' },
      ...uiCatalogFinishes.map((value) => ({ value, label: uiFinishLabel(value) })),
    ],
    '',
  );
  finish.id = 'collection-finish';
  const condition = selectControl(
    document,
    [
      { value: '', label: 'Choose condition' },
      { value: 'unknown', label: 'Unknown' },
      ...uiCopyConditions.map((code) => ({ value: code, label: conditionName(code) })),
    ],
    '',
  );
  condition.id = 'collection-condition';
  fieldset.append(
    legend,
    hint,
    controlLabel(document, 'Finish to apply', finish),
    controlLabel(document, 'Condition to apply', condition),
  );
  const status = document.createElement('p');
  status.id = 'collection-changes-status';
  status.dataset.uiOutcome = '';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  fieldset.append(status);
  const actions = new Map<string, ReturnType<typeof copyChangeTool>>();
  for (const action of [
    copyChangeTool({
      id: 'apply-finish',
      label: 'Apply finish',
      access: options.access,
      change: () => readFinishChange(finish.value),
      guidance: 'Choose the finish to apply to the selected copies.',
    }),
    copyChangeTool({
      id: 'apply-condition',
      label: 'Apply condition',
      access: options.access,
      change: () => readConditionChange(condition.value),
      guidance: 'Choose the condition to apply to the selected copies.',
    }),
  ]) {
    actions.set(action.id, action);
  }
  /** Whether one change is in flight; a further intent is ignored instead of run twice. */
  let applying = false;
  const editor: UiCopyBulkEditor = {
    element: fieldset,
    actions: [...actions.values()].map(({ id, label }) => ({ id, label })),
    apply(intent) {
      const action = actions.get(intent.id);
      if (action === undefined || applying) {
        return;
      }
      applying = true;
      status.removeAttribute('data-ui-outcome-status');
      status.textContent = 'Applying…';
      void applyAction(action, { selection: intent.selection, signal: options.signal }).then(
        (outcome) => {
          applying = false;
          paintOutcome(outcome);
        },
      );
    },
    capture: () => ({ finish: finish.value, condition: condition.value }),
    restore(draft) {
      const restored = readDraft(draft);
      if (restored === null) {
        return;
      }
      if (typeof restored.finish === 'string') {
        finish.value = restored.finish;
      }
      if (typeof restored.condition === 'string') {
        condition.value = restored.condition;
      }
    },
  };
  editor.restore(options.restored);
  return editor;

  /** Presents one change's outcome; only a committed change reports success. */
  function paintOutcome(outcome: UiOperationOutcome): void {
    status.dataset.uiOutcomeStatus = outcome.status;
    status.textContent = outcome.message ?? outcomeText(outcome.status);
  }
}

/** The finish one bulk control names, or null while it names none. */
function readFinishChange(value: string): UiCopyChange | null {
  const finish = readUiCatalogFinish(value);
  return finish === null ? null : { finish };
}

/** The condition one bulk control names, or null while it names none. */
function readConditionChange(value: string): UiCopyChange | null {
  switch (value) {
    case '':
      return null;
    case 'unknown':
      return { condition: null };
    default:
      return uiCopyConditions.includes(value as (typeof uiCopyConditions)[number])
        ? { condition: value as (typeof uiCopyConditions)[number] }
        : null;
  }
}

/** Display name of one condition code. */
function conditionName(condition: (typeof uiCopyConditions)[number]): string {
  switch (condition) {
    case 'NM':
      return 'Near mint';
    case 'LP':
      return 'Lightly played';
    case 'MP':
      return 'Moderately played';
    case 'HP':
      return 'Heavily played';
    case 'DMG':
      return 'Damaged';
  }
}

/** One retained draft as a record of values, or null when it carries none. */
function readDraft(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Readonly<Record<string, unknown>>;
}

/**
 * The copy form's values as the owner keeps them: the printing the copy is corrected to, its
 * finish and its condition (`unknown` or a code). The copy's language is the language of the
 * printing it is corrected to, so the printing choice edits it
 * (docs/ui/editors.md#internal-design).
 */
export interface UiCopyDraft {
  readonly printingId: string;
  readonly finish: string;
  readonly condition: string;
}

/** Outcome of one read of the corrected copy: the recorded copy, its absence or a failed read. */
type UiCopyReadResult =
  | { readonly work: number; readonly status: 'read'; readonly copy: PhysicalCopy }
  | { readonly work: number; readonly status: 'missing' }
  | { readonly work: number; readonly status: 'failed'; readonly message: string };

export interface UiCopyEditorOptions {
  readonly document: Document;
  /** Private read and correction access over the supplied UserCards contract. */
  readonly access: UiCopyAccess;
  /** CardList capability the printing picker describes its list to. */
  readonly cardList: CardListBrowser;
  /** CardViews module the printing picker renders through. */
  readonly cardViews: CardViews;
  /** Verified account whose published printings the picker presents. */
  readonly accountId: string;
  /** Catalog the valid finishes of a chosen printing are read from. */
  readonly catalog: Catalog;
  /** Authoritative copy the editor presents. */
  readonly copy: PhysicalCopy;
  /** Published card of the copy, when the catalog resolves it. */
  readonly card: CardRecord | null;
  /** Printing the copy records now, when the catalog resolves it. */
  readonly printing: PrintingRecord | null;
  /** Draft a previous visit retained, when it carried one. */
  readonly restored?: unknown;
  /** Aborted when the view closes; the editor drops late results then. */
  readonly signal: AbortSignal;
  /** Location the saved copy's printing details are presented at. */
  printingHref(copy: PhysicalCopy): string;
}

/**
 * The copy attributes editor of one physical copy: its stored attributes beside the unsaved
 * change. The stored values come from the copy the page read; the form keeps the draft, and a
 * change that committed replaces the stored values without touching the draft.
 */
export interface UiCopyEditor {
  /** The form section this editor presents. */
  readonly element: HTMLElement;
  /** Link to the printing details of the saved copy; the editor keeps it current. */
  readonly printingLink: HTMLAnchorElement;
  /** Draft the page retains for its history entry, or null while the owner edited nothing. */
  capture(): UiCopyDraft | null;
  dispose(): void;
}

export function createCopyEditor(options: UiCopyEditorOptions): UiCopyEditor {
  const document = options.document;
  const access = options.access;
  const catalog = options.catalog;
  const card = options.card;
  const printing = options.printing;
  let saved = options.copy;
  let draft = readCopyDraft(options.restored);
  let disposed = options.signal.aborted;
  options.signal.addEventListener(
    'abort',
    () => {
      disposed = true;
    },
    { once: true },
  );
  /**
   * Sequence of the newest copy-state work of this form: feedback of a request a later operation
   * superseded is not presented, so an obsolete reload never overwrites the outcome of a save
   * that followed it.
   */
  let work = 0;
  /**
   * Full records of the printings the form knows: the picker presents basic information only, so
   * the finishes a chosen printing offers are read through Catalog on demand
   * (docs/ui/editors.md#interface).
   */
  const knownPrintings = new Map<string, PrintingRecord>();
  if (printing !== null) {
    knownPrintings.set(printing.printingId, printing);
  }
  /** Printings whose record is being read or could not be read; neither is asked twice. */
  const learnedPrintings = new Set<string>();
  const savedLine = text(document, 'p', 'copy-saved', '');
  const copyStatus = text(document, 'p', 'copy-status', '');
  copyStatus.setAttribute('role', 'status');
  copyStatus.setAttribute('aria-live', 'polite');
  const printingLine = document.createElement('span');
  printingLine.id = 'copy-printing-line';
  const finish = document.createElement('select');
  finish.id = 'copy-finish-choice';
  const condition = document.createElement('select');
  condition.id = 'copy-condition-choice';
  const save = document.createElement('button');
  save.type = 'submit';
  save.id = 'copy-save';
  save.textContent = 'Save changes';
  const reload = button(document, 'copy-reload', 'Reload copy');
  const form = document.createElement('form');
  form.id = 'copy-form';
  form.append(
    controlLabel(document, 'Printing', printingLine),
    controlLabel(document, 'Finish', finish),
    controlLabel(document, 'Condition', condition),
    save,
    ' ',
    reload,
  );
  // The picker is mounted as the form is composed; its own source owns acquiring the card's
  // printings, their continuation and the recovery of a failed page
  // (docs/ui/editors.md#interface).
  const pickerHost = document.createElement('div');
  pickerHost.id = 'copy-printing-picker';
  let picker: UiCardList<string> | null = null;
  if (card !== null) {
    picker = options.cardViews.picker<string>({
      container: pickerHost,
      create: options.cardList.create,
      source: options.cardList.account(options.accountId).cardPrintings(card),
      context: card.cardId,
      accountId: options.accountId,
      pageSize: UI_LIMITS.printingPage,
      fragments: { tools: printingChoicesReader() },
      choice: { id: 'choose-printing', label: 'Use this printing' },
      onChoose: (selection) => choosePrintingTarget(selection),
      signal: options.signal,
    });
    picker.subscribe(() => paint());
  }
  const printingLink = document.createElement('a');
  printingLink.id = 'copy-printing-link';
  printingLink.textContent = 'Printing details';
  const section = document.createElement('section');
  section.append(
    text(document, 'h2', 'copy-name', card?.name ?? 'Physical copy'),
    savedLine,
    text(document, 'p', 'copy-id', `Copy ${saved.copyId}`),
    form,
    pickerHost,
    copyStatus,
  );
  paintSaved();
  paint();
  // The controls the owner edits are the draft: reading them on change keeps the intended values
  // while the picker's own window keeps loading (docs/ui/editors.md#drafts-and-asynchronous-outcomes).
  form.addEventListener('change', () => {
    draft = readForm();
  });
  reload.addEventListener('click', () => {
    void reloadCopy();
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void saveCopy();
  });
  return {
    element: section,
    printingLink,
    capture: () => draft,
    dispose() {
      disposed = true;
      picker?.dispose();
    },
  };

  /**
   * Presents the draft in the controls. The draft keeps the intended values: a printing,
   * finish or condition whose catalog data has not loaded stays the presented choice, named by
   * its identity until its record arrives, and the controls fall back only for a value outside
   * the published vocabulary. The effective values become the draft.
   */
  function paint(): void {
    if (disposed) {
      return;
    }
    const wanted = draft ?? {
      printingId: saved.printingId,
      finish: saved.finish,
      condition: saved.condition ?? 'unknown',
    };
    const wantedPrintingId = wanted.printingId.length > 0 ? wanted.printingId : saved.printingId;
    const chosenPrinting = knownPrintings.get(wantedPrintingId) ?? null;
    // An intended printing whose record has not loaded stays presented by its identity instead
    // of being replaced by one that happens to be loaded.
    printingLine.textContent = printingLineFor(wantedPrintingId);
    learnPrinting(wantedPrintingId);
    const finishes =
      chosenPrinting === null || chosenPrinting.finishes.length === 0
        ? uiCatalogFinishes
        : chosenPrinting.finishes;
    finish.replaceChildren(
      ...finishes.map((value) => optionElement(document, value, uiFinishLabel(value))),
    );
    const finishValue = finishes.includes(wanted.finish as Finish)
      ? wanted.finish
      : (finishes[0] ?? '');
    finish.value = finishValue;

    const conditionValue =
      wanted.condition === 'unknown' ||
      uiCopyConditions.includes(wanted.condition as (typeof uiCopyConditions)[number])
        ? wanted.condition
        : 'unknown';
    condition.replaceChildren(
      optionElement(document, 'unknown', 'Unknown'),
      ...uiCopyConditions.map((code) => optionElement(document, code, conditionLabel(code))),
    );
    condition.value = conditionValue;

    draft = {
      printingId: wantedPrintingId,
      finish: finishValue,
      condition: conditionValue,
    };
  }

  /** One printing as the form presents it: its published line, or its identity until it loads. */
  function printingLineFor(printingId: string): string {
    const record = knownPrintings.get(printingId) ?? null;
    if (record !== null) {
      return printingLineOf(record);
    }
    const basic = presentedPrinting(printingId);
    return basic === null
      ? `Printing ${printingId}`
      : `${basic.edition} ${basic.collectorNumber} · ${basic.language}`;
  }

  /** Basic information of one printing the picker's presented window carries. */
  function presentedPrinting(printingId: string): CardListEntryPrinting | null {
    for (const entry of picker?.entries ?? []) {
      if (entry.target.kind === 'printing' && entry.target.printingId === printingId) {
        return entry.basic?.printing ?? null;
      }
    }
    return null;
  }

  /**
   * Reads the full record of one printing the form presents, so the finish vocabulary of the
   * chosen printing constrains the control. A read that fails leaves the catalog's published
   * finishes standing; the provider still validates the change it receives.
   */
  function learnPrinting(printingId: string): void {
    if (disposed || printingId.length === 0 || learnedPrintings.has(printingId)) {
      return;
    }
    learnedPrintings.add(printingId);
    void resolvePrintings(catalog, [printingId]).then(
      (resolved) => {
        const record = resolved.get(printingId) ?? null;
        if (record === null || disposed) {
          return;
        }
        knownPrintings.set(printingId, record);
        paint();
      },
      () => {
        // The published finish vocabulary stays usable while the record is unavailable.
      },
    );
  }

  /** Takes the printing the picker's explicit selection names into the draft. */
  function choosePrintingTarget(selection: CardListToolSelection): void {
    const target = selection.targets.find((candidate) => candidate.kind === 'printing');
    if (target === undefined || target.kind !== 'printing') {
      return;
    }
    draft = { ...readForm(), printingId: target.printingId };
    paint();
  }

  /** Availability of the picker's choice for the printings of the card it presents. */
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

  /** The attributes the account stores now, distinct from the unsaved draft. */
  function paintSaved(): void {
    if (disposed) {
      return;
    }
    savedLine.textContent =
      `${printingLineFor(saved.printingId)} · ${saved.finish} · ` +
      `${conditionLabel(saved.condition)}`;
    learnPrinting(saved.printingId);
    printingLink.href = options.printingHref(saved);
  }

  function readForm(): UiCopyDraft {
    return {
      printingId: draft?.printingId ?? saved.printingId,
      finish: finish.value,
      condition: condition.value,
    };
  }

  /** The correction the form currently names, or null while a control names no value. */
  function correction(): UiCopyCorrection | null {
    draft = readForm();
    const finishValue = uiCatalogFinishes.find((value) => value === finish.value);
    if (finishValue === undefined || draft.printingId.length === 0) {
      return null;
    }
    return {
      copyId: saved.copyId,
      expectedRevision: saved.revision,
      printingId: draft.printingId,
      finish: finishValue,
      condition:
        condition.value === 'unknown'
          ? null
          : (uiCopyConditions.find((code) => code === condition.value) ?? null),
    };
  }

  async function saveCopy(): Promise<void> {
    const input = correction();
    if (input === null) {
      copyStatus.textContent = 'Choose a printing, a finish and a condition before saving.';
      return;
    }
    const current = ++work;
    save.disabled = true;
    copyStatus.textContent = 'Saving…';
    const outcome = await correctCopy(access, input, options.signal);
    if (disposed) {
      return;
    }
    save.disabled = false;
    if (outcome.copy !== null) {
      presentCopy(outcome.copy);
    }
    if (current === work) {
      copyStatus.textContent = outcome.message ?? 'Saved.';
    }
    if (outcome.status === 'conflict') {
      // The copy changed meanwhile: its current state is offered for review while the draft
      // the user wrote stays in the form for the retry.
      const reread = await readCurrent();
      if (!disposed && reread.work === work && reread.status !== 'read') {
        copyStatus.textContent = readProblem(reread);
      }
    }
  }

  async function reloadCopy(): Promise<void> {
    copyStatus.textContent = 'Reloading…';
    const result = await readCurrent();
    if (disposed || result.work !== work) {
      // A newer operation owns the feedback; the obsolete reload presents nothing.
      return;
    }
    copyStatus.textContent = result.status === 'read' ? 'Reloaded the copy.' : readProblem(result);
  }

  /**
   * Re-reads the copy the editor corrects; the unsaved draft stays untouched. The presented
   * state never regresses, and a read that failed stays distinct from a copy the account no
   * longer holds, so a caller never reports an unavailable read as absence
   * (docs/user-cards.md#interface, docs/ui/architecture.md#state-ownership-and-restoration).
   */
  async function readCurrent(): Promise<UiCopyReadResult> {
    const current = ++work;
    try {
      const read = await access.read([saved.copyId], options.signal);
      const found = read.copies[0] ?? null;
      if (found === null) {
        return { work: current, status: 'missing' };
      }
      presentCopy(found);
      return { work: current, status: 'read', copy: found };
    } catch (cause) {
      return {
        work: current,
        status: 'failed',
        message: readMessage(cause, 'The copy could not be reloaded.'),
      };
    }
  }

  /**
   * Presents the recorded state one read or write reported, unless the view presents a newer
   * revision already: a response that arrives after a newer operation never replaces the state
   * the user is looking at.
   */
  function presentCopy(found: PhysicalCopy): void {
    if (found.revision < saved.revision) {
      return;
    }
    saved = found;
    paintSaved();
    paint();
  }

  /** The problem one copy read reports; only a failed read carries a message of its own. */
  function readProblem(result: Exclude<UiCopyReadResult, { status: 'read' }>): string {
    return result.status === 'failed'
      ? result.message
      : 'This copy is no longer in the collection.';
  }
}

/** One printing as the form presents it: its edition, collector number and language. */
function printingLineOf(printing: PrintingRecord): string {
  return `${printing.edition} ${printing.collectorNumber} · ${printing.language}`;
}

function conditionLabel(condition: string | null): string {
  switch (condition) {
    case null:
      return 'condition unknown';
    case 'NM':
      return 'near mint';
    case 'LP':
      return 'lightly played';
    case 'MP':
      return 'moderately played';
    case 'HP':
      return 'heavily played';
    case 'DMG':
      return 'damaged';
    default:
      return condition;
  }
}

/** The copy draft a history entry kept, or null when this visit restored none. */
function readCopyDraft(state: unknown): UiCopyDraft | null {
  const values = readDraft(state);
  if (values === null) {
    return null;
  }
  const printingId = values.printingId;
  const finish = values.finish;
  const condition = values.condition;
  if (
    typeof printingId !== 'string' ||
    typeof finish !== 'string' ||
    typeof condition !== 'string'
  ) {
    return null;
  }
  return { printingId, finish, condition };
}
