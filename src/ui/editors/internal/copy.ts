/**
 * Copy attribute editors of the collection and card-details views
 * (docs/ui/editors.md#internal-design, docs/ui/editors.md#drafts-and-asynchronous-outcomes).
 *
 * The collection's bulk editor owns the values its controls apply to the explicit selection and
 * offers one tool per attribute through the private UserCards contract; the copy editor of one
 * physical copy owns its unsaved printing, language, finish and condition draft and presents the
 * provider's committed state separately. Neither editor decides a business rule: revisions,
 * conflicts, validation and committed values come from the provider-owned operations.
 */

import type {
  CardPrintingsPage,
  CardRecord,
  Catalog,
  Finish,
  PrintingRecord,
} from '../../../catalog/index.js';
import { readFailureCode } from '../../../card-list/index.js';
import type { PhysicalCopy } from '../../../usercards/index.js';

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
import type { UiListAction } from '../../shared/actions.js';

/** Draft of the collection's bulk change controls. */
export interface UiCopyBulkDraft {
  readonly finish: string;
  readonly condition: string;
}

export interface UiCopyBulkEditorOptions {
  readonly document: Document;
  /** Private copy access the bulk tools act through. */
  readonly access: UiCopyAccess;
  /** Draft a previous visit retained, when it carried one. */
  readonly restored?: unknown;
}

/**
 * The bulk copy change editor: the values its controls apply beside the tools the list presents
 * for the explicit selection. Only a physical-copy selection carries the tools, so the page
 * presents availability for the `tools` fragment separately.
 */
export interface UiCopyBulkEditor {
  readonly element: HTMLFieldSetElement;
  /** Tools the page hands to the list for its explicit selection. */
  readonly tools: readonly UiListAction[];
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
  const editor: UiCopyBulkEditor = {
    element: fieldset,
    tools: [
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
    ],
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
 * The copy form's values as the owner keeps them: the language the printing choices are narrowed
 * to, the printing the copy is corrected to, its finish and its condition (`unknown` or a code).
 */
export interface UiCopyDraft {
  readonly language: string;
  readonly printingId: string;
  readonly finish: string;
  readonly condition: string;
}

/**
 * One card's published printings as the copy form loaded them so far: the bounded window the form
 * offers, the continuation of the page after it, whether a request is in flight and the failure
 * of the last request. A failure is not the end of the list.
 */
interface UiPrintingsWindow {
  readonly printings: Map<string, PrintingRecord>;
  continuation: string | null;
  loading: boolean;
  error: string | null;
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
  /** Catalog the printing offer is read through; its vocabulary constrains the controls. */
  readonly catalog: Catalog;
  /** Card whose printings correct the copy. */
  readonly cardId: string;
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
  const window: UiPrintingsWindow = {
    printings: new Map(printing === null ? [] : [[printing.printingId, printing]]),
    continuation: null,
    loading: false,
    error: null,
  };
  const savedLine = text(document, 'p', 'copy-saved', '');
  const copyStatus = text(document, 'p', 'copy-status', '');
  copyStatus.setAttribute('role', 'status');
  copyStatus.setAttribute('aria-live', 'polite');
  const printingsStatus = text(document, 'p', 'copy-printings-status', '');
  printingsStatus.setAttribute('role', 'status');
  printingsStatus.setAttribute('aria-live', 'polite');
  const language = document.createElement('select');
  language.id = 'copy-language';
  const printingChoice = document.createElement('select');
  printingChoice.id = 'copy-printing-choice';
  const finish = document.createElement('select');
  finish.id = 'copy-finish-choice';
  const condition = document.createElement('select');
  condition.id = 'copy-condition-choice';
  const more = button(document, 'copy-printings-more', 'More printings');
  const save = document.createElement('button');
  save.type = 'submit';
  save.id = 'copy-save';
  save.textContent = 'Save changes';
  const reload = button(document, 'copy-reload', 'Reload copy');
  const form = document.createElement('form');
  form.id = 'copy-form';
  form.append(
    controlLabel(document, 'Language', language),
    controlLabel(document, 'Printing', printingChoice),
    controlLabel(document, 'Finish', finish),
    controlLabel(document, 'Condition', condition),
    more,
    save,
    ' ',
    reload,
  );
  const printingLink = document.createElement('a');
  printingLink.id = 'copy-printing-link';
  printingLink.textContent = 'Printing details';
  const section = document.createElement('section');
  section.append(
    text(document, 'h2', 'copy-name', card?.name ?? 'Physical copy'),
    savedLine,
    text(document, 'p', 'copy-id', `Copy ${saved.copyId}`),
    form,
    copyStatus,
    printingsStatus,
  );
  paintSaved();
  paint();
  form.addEventListener('change', () => {
    draft = readForm();
    paint();
  });
  more.addEventListener('click', () => {
    void loadMorePrintings();
  });
  reload.addEventListener('click', () => {
    void reloadCopy();
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void saveCopy();
  });
  if (card !== null) {
    // The published printings are an offer: the copy's own printing stays correctable even when
    // the catalog list cannot be read.
    void loadMorePrintings();
  }
  return {
    element: section,
    printingLink,
    capture: () => draft,
    dispose() {
      disposed = true;
    },
  };

  /**
   * Presents the draft in the controls. The draft keeps the intended values: a printing,
   * language or finish whose catalog data has not loaded stays the presented choice, named by
   * its identity until its record arrives, and the controls fall back only for a value outside
   * the published vocabulary. The effective values become the draft.
   */
  function paint(): void {
    const wanted = draft ?? {
      language: '',
      printingId: saved.printingId,
      finish: saved.finish,
      condition: saved.condition ?? 'unknown',
    };
    const languages = new Set<string>();
    for (const known of window.printings.values()) {
      languages.add(known.language);
    }
    if (printing !== null) {
      languages.add(printing.language);
    }
    if (wanted.language.length > 0) {
      // The intended language stays selectable while the printing that names it is loading.
      languages.add(wanted.language);
    }
    language.replaceChildren(
      optionElement(document, '', 'Any language'),
      ...[...languages]
        .filter((code) => code.length > 0)
        .sort()
        .map((code) => optionElement(document, code, code)),
    );
    const chosenLanguage = wanted.language;
    language.value = chosenLanguage;

    const wantedPrintingId = wanted.printingId.length > 0 ? wanted.printingId : saved.printingId;
    const choices = [...window.printings.values()].filter(
      (known) => chosenLanguage === '' || known.language === chosenLanguage,
    );
    const chosenPrinting = window.printings.get(wantedPrintingId) ?? null;
    if (chosenPrinting !== null && !choices.includes(chosenPrinting)) {
      // The intended printing stays reachable even when the language facet excludes it.
      choices.push(chosenPrinting);
    }
    printingChoice.replaceChildren(
      // An intended printing whose record has not loaded stays the selected choice, named by
      // its identity, instead of being replaced by one that happens to be loaded.
      ...(chosenPrinting === null
        ? [optionElement(document, wantedPrintingId, `Printing ${wantedPrintingId}`)]
        : []),
      ...choices.map((known) => optionElement(document, known.printingId, printingLine(known))),
    );
    printingChoice.value = wantedPrintingId;

    const selected = window.printings.get(wantedPrintingId) ?? null;
    const finishes =
      selected === null || selected.finishes.length === 0 ? uiCatalogFinishes : selected.finishes;
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
      language: chosenLanguage,
      printingId: wantedPrintingId,
      finish: finishValue,
      condition: conditionValue,
    };
    // A failed request keeps its retry reachable: only the end of the list hides the control.
    more.hidden = window.continuation === null && window.error === null;
    more.disabled = window.loading;
    more.textContent = window.error === null ? 'More printings' : 'Retry printings';
  }

  /** The attributes the account stores now, distinct from the unsaved draft. */
  function paintSaved(): void {
    const stored = window.printings.get(saved.printingId) ?? null;
    savedLine.textContent = `${
      stored === null ? `Printing ${saved.printingId}` : printingLine(stored)
    } · ${saved.finish} · ${conditionLabel(saved.condition)}`;
    printingLink.href = options.printingHref(saved);
  }

  function readForm(): UiCopyDraft {
    return {
      language: language.value,
      printingId: printingChoice.value,
      finish: finish.value,
      condition: condition.value,
    };
  }

  /** The correction the form currently names, or null while a control names no value. */
  function correction(): UiCopyCorrection | null {
    draft = readForm();
    const finishValue = uiCatalogFinishes.find((value) => value === finish.value);
    if (finishValue === undefined || printingChoice.value.length === 0) {
      return null;
    }
    return {
      copyId: saved.copyId,
      expectedRevision: saved.revision,
      printingId: printingChoice.value,
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

  /**
   * Loads the next page of the card's published printings into the bounded window the form
   * offers, or reports the failure beside the retry the same control offers. The window keeps
   * the printing the copy records and the intended draft; the rest of the working set is
   * bounded, so repeated pagination never retains every visited printing. A continuation the
   * catalog rejects as stale stays unusable, so the offer does not hold it: its paging position
   * starts again at the first page the published revision lists
   * (docs/catalog.md#provided-operations).
   */
  async function loadMorePrintings(): Promise<void> {
    if (window.loading || options.signal.aborted) {
      return;
    }
    window.loading = true;
    paint();
    let continuation = window.continuation;
    try {
      let page: CardPrintingsPage;
      for (;;) {
        try {
          page = await catalog.listCardPrintings(options.cardId, {
            pageSize: UI_LIMITS.printingPage,
            ...(continuation === null ? {} : { continuation }),
          });
          break;
        } catch (cause) {
          if (
            continuation === null ||
            options.signal.aborted ||
            readFailureCode(cause) !== 'stale-continuation'
          ) {
            throw cause;
          }
          // The catalog changed after the page this continuation names was read, so the
          // provider keeps refusing it: the offer reads the printing list again from its first
          // page instead of keeping a cursor that can only fail again.
          continuation = null;
        }
      }
      for (const known of page.printings) {
        window.printings.set(known.printingId, known);
      }
      window.continuation = page.continuation;
      window.error = null;
      retirePrintings();
    } catch (cause) {
      // A continuation the catalog rejected as stale is not retained, not even when the
      // restarted read failed: the retry the control offers starts the printing list again.
      window.continuation = continuation;
      window.error = readMessage(cause, 'The printings could not be loaded.');
    } finally {
      window.loading = false;
    }
    if (disposed) {
      return;
    }
    printingsStatus.textContent = window.error ?? '';
    paint();
  }

  /** Retires the oldest printings beyond the working set, keeping the presented choices. */
  function retirePrintings(): void {
    const kept = new Set([saved.printingId, draft?.printingId ?? '']);
    const keys = [...window.printings.keys()];
    const surplus = keys.slice(0, Math.max(0, keys.length - UI_LIMITS.listWindow));
    for (const key of surplus) {
      if (!kept.has(key)) {
        window.printings.delete(key);
      }
    }
  }
}

/** One printing as the form presents it: its edition, collector number and language. */
function printingLine(printing: PrintingRecord): string {
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
  const language = values.language;
  const printingId = values.printingId;
  const finish = values.finish;
  const condition = values.condition;
  if (
    typeof language !== 'string' ||
    typeof printingId !== 'string' ||
    typeof finish !== 'string' ||
    typeof condition !== 'string'
  ) {
    return null;
  }
  return { language, printingId, finish, condition };
}
