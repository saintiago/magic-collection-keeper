/**
 * Vocabulary, retained-state reading and presentation helpers of the Import editors
 * (docs/ui/editors.md#internal-design, docs/user-cards.md#source-imports).
 *
 * These helpers translate provider records and bounded retained input into the presentation
 * vocabulary the Import editors share. They own no draft, list or operation state of their own:
 * each editor keeps its own, and business decisions — parsing, import identity, replay, row
 * reconciliation and confirmation — stay with the provider-owned operations.
 */

import type { Finish, PrintingRecord } from '../../../catalog/index.js';
import type { CardListPendingRecord, CardListTarget } from '../../../card-list/index.js';
import type {
  CopyCondition,
  ImportSourceLine,
  ImportStageResult,
  ImportSession,
  ReviewedWizardsLine,
  SourceImportOutcome,
  SourceImportResult,
  SourceImportRow,
} from '../../../usercards/index.js';
import type {
  UserCardsRetainedAttempt,
  UserCardsSourceImportRequest,
  UserCardsConstraints,
} from '../../../usercards/browser.js';

import { selectControl, type UiSelectOption } from '../../shared/controls.js';
import { UI_LIMITS } from '../../shared/limits.js';
import { readState } from '../../shared/state.js';
import { uiImportSourceLabel, type UiImportLine } from './import-edits.js';
import { uiCatalogFinishes, uiFinishLabel } from '../../shared/vocabulary.js';
import { uiCopyConditions } from './copy-edits.js';
import type { UiChangeCommit } from './failure.js';
import type { UiOperationOutcome } from './operations.js';

/** The one manual entry queue of an account; its lines are reviewed and confirmed like any import. */
export const manualImport = {
  sessionId: 'manual',
  source: { kind: 'manual', id: 'manual' },
} as const;

/** The source methods the Import form offers, in the order it presents them. */
export const uiSourceFormats = ['pasted-list', 'moxfield', 'wizards-precon'] as const;

/** One source method the Import editors parse into review. */
export type UiSourceFormat = UserCardsSourceImportRequest['format'];

/** Unsaved review input of one entry, kept outside the rendered controls. */
export interface UiReviewDraft {
  query: string;
  printingId: string;
  finish: string;
  condition: string;
  quantity: string;
}

/** Reviewed revision of one explicitly selected entry the loaded window no longer presents. */
export interface UiSelectedReview {
  readonly entryId: string;
  readonly revision: number;
}

/** One unfinished source import the account retains, with the input it was begun with. */
export type UiSourceImportAttempt = Extract<
  UserCardsRetainedAttempt,
  { readonly kind: 'stageSourceImport' }
>;

/** One unfinished manual staging the account retains, with the lines it was begun with. */
export type UiStagingAttempt = Extract<
  UserCardsRetainedAttempt,
  { readonly kind: 'stageImportEntries' }
>;

/** The unsaved source input of one method, before the account begins the import it describes. */
export type UiSourceInput =
  | { readonly format: 'pasted-list'; readonly text: string }
  | { readonly format: 'moxfield'; readonly url: string }
  | {
      readonly format: 'wizards-precon';
      readonly identity: string;
      readonly reference: string;
      readonly lines: string;
    };

/**
 * Unsaved input of the source form. The editor keeps it with its history entry so leaving and
 * returning keeps the edits to retry. The identity of an import stays with UserCards.
 */
export interface UiSourceDraft {
  format: UiSourceFormat;
  text: string;
  url: string;
  identity: string;
  reference: string;
  lines: string;
}

/** The manual entry form state one history entry kept, or its defaults. */
export function readManualDraft(value: unknown): {
  readonly text: string;
  readonly quantity: string;
  readonly finish: string;
  readonly condition: string;
} {
  const record = readState(value);
  return {
    text: readDraftValue(record?.text, UI_LIMITS.catalogQuery) ?? '',
    quantity: readDraftValue(record?.quantity, 8) ?? '1',
    finish: readDraftValue(record?.finish, 16) ?? '',
    condition: readDraftValue(record?.condition, 8) ?? '',
  };
}

/** The source method one control value names, or null when it names none the form presents. */
export function readSourceFormat(value: string): UiSourceFormat | null {
  return (uiSourceFormats as readonly string[]).includes(value) ? (value as UiSourceFormat) : null;
}

/**
 * The source form one history entry kept. Every field is restored within the bound its own control
 * accepts, so a value the form took is presented again unchanged; the identity of an unfinished
 * import stays with the account and is presented as a waiting import instead
 * (docs/ui/editors.md#drafts-and-asynchronous-outcomes).
 */
export function readSourceDraft(
  value: unknown,
  bounds: UserCardsConstraints['text'],
): UiSourceDraft {
  const record = readState(value);
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
 * input carries, so the owner recognizes the import the reopen action reads back.
 */
export function unfinishedSourceLabel(request: UserCardsSourceImportRequest): string {
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
export function reviewedWizardsLines(text: string): readonly ReviewedWizardsLine[] {
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
 * confirmation, so the message says that the reviewed lines still need an explicit confirmation.
 */
export function sourceImportMessage(result: SourceImportResult): string {
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
 * One parsed source row as the editor presents it: its position in the source, what it became and
 * the parsed line or the problem the provider reported for it.
 */
export function sourceRow(document: Document, row: SourceImportRow): HTMLLIElement {
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
export function sourceOutcomeLabel(outcome: SourceImportOutcome): string {
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

/** The session identity one retained state kept, or null when it names none. */
export function readSessionId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= UI_LIMITS.entryKey
    ? value
    : null;
}

/** The unsaved review input a history entry kept, keyed by entry identity. */
export function readReviewDrafts(value: unknown): Map<string, UiReviewDraft> {
  const drafts = new Map<string, UiReviewDraft>();
  const record = readState(value);
  if (record === null) {
    return drafts;
  }
  for (const [entryId, candidate] of Object.entries(record)) {
    const draft = readState(candidate);
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

/** The reviewed revisions a history entry kept for its explicit selection, keyed by entry key. */
export function readSelectedRevisions(value: unknown): Map<string, UiSelectedReview> {
  const selected = new Map<string, UiSelectedReview>();
  const record = readState(value);
  if (record === null) {
    return selected;
  }
  for (const [key, candidate] of Object.entries(record)) {
    const review = readState(candidate);
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
export function readDraftValue(value: unknown, bound: number): string | null {
  return typeof value === 'string' ? value.slice(0, bound) : null;
}

/** The quantity one control names, or null when it is not a bounded positive whole number. */
export function readQuantity(input: HTMLInputElement, bound: number): number | null {
  return readQuantityValue(input.value, bound);
}

/** One quantity value, or null when it is not a bounded positive whole number. */
export function readQuantityValue(value: unknown, bound: number): number | null {
  const wanted = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(wanted) && wanted >= 1 && wanted <= bound ? wanted : null;
}

/** Finish one control value names, or null when it is empty or outside the vocabulary. */
export function readFinishValue(value: string): Finish | null {
  return (uiCatalogFinishes as readonly string[]).includes(value) ? (value as Finish) : null;
}

/** Condition one control value names; an empty value is the explicit unknown condition. */
export function readConditionValue(value: string): CopyCondition | null {
  return (uiCopyConditions as readonly string[]).includes(value) ? (value as CopyCondition) : null;
}

/** The first finish a printing offers as a physical card, or null when it is not known. */
export function firstFinish(printing: PrintingRecord | null): Finish | null {
  return printing?.physical === true ? (printing.finishes[0] ?? null) : null;
}

/** The finishes one review may choose: the vocabulary, narrowed to a known printing's own. */
export function finishOptions(): readonly UiSelectOption[] {
  return [
    { value: '', label: 'First offered finish' },
    ...uiCatalogFinishes.map((value) => ({ value, label: uiFinishLabel(value) })),
  ];
}

/** The conditions one review may choose; an empty value stays explicitly unknown. */
export function conditionOptions(): readonly UiSelectOption[] {
  return [
    { value: '', label: 'Condition unknown' },
    ...uiCopyConditions.map((value) => ({ value, label: value })),
  ];
}

/**
 * The printing one review names: the record's own printing while the chosen identity is that one
 * — it is already read — and otherwise the printing the row's own search offered. A printing the
 * editor cannot resolve stays unresolved instead of presenting the previously stored one.
 */
export function knownPrinting(
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
 * The finish choices of one review. A printing that the editor could read narrows them to the
 * finishes it offers; a finish the entry already carries stays selectable, so reviewing another
 * field never changes the stored finish.
 */
export function finishSelect(
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

/** One printing as the review presents it: its edition, collector number and language. */
export function printingLine(printing: PrintingRecord): string {
  return `${printing.edition} ${printing.collectorNumber} · ${printing.language}`;
}

/** The source line of one pending entry as the review presents it. */
export function sourceLineText(line: ImportSourceLine): string {
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

/** One confirmation's receipt as the review presents it; a recovered outcome stays explicit. */
export function confirmationMessage(copies: number, recovered: string | null): string {
  const line = `Confirmed: ${copies} ${copies === 1 ? 'physical copy' : 'physical copies'} created.`;
  return recovered === null ? line : `${line} ${recovered}`;
}

/** How the manual form reports the lines a staging attempt left in review. */
export function stagedMessage(lines: number): string {
  return lines === 0
    ? 'Those lines were already in review; no new entries were added.'
    : `${lines} ${lines === 1 ? 'line is' : 'lines are'} in review. ` +
        'Confirmation creates the physical copies.';
}

/** One staging outcome as the manual form presents it, beside the lines an earlier request kept. */
export function stagingOutcome(
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
export function inBatches<Value>(
  values: readonly Value[],
  size: number,
): readonly (readonly Value[])[] {
  const batches: Value[][] = [];
  for (let index = 0; index < values.length; index += size) {
    batches.push(values.slice(index, index + size));
  }
  return batches;
}

/** Whether one draft still holds exactly the reviewed input a save submitted. */
export function sameReviewDraft(draft: UiReviewDraft, submitted: Readonly<UiReviewDraft>): boolean {
  return (
    draft.query === submitted.query &&
    draft.printingId === submitted.printingId &&
    draft.finish === submitted.finish &&
    draft.condition === submitted.condition &&
    draft.quantity === submitted.quantity
  );
}

/** The printing target whose entry key keeps one staged line's identity for an idempotent retry. */
export function stagedLineTarget(line: UiImportLine): CardListTarget {
  return { kind: 'printing', printingId: line.printingId };
}

/** The first pending session of a page, preferring the account's manual entry queue. */
export function defaultSessionId(sessions: readonly ImportSession[]): string | null {
  const manual = sessions.find((session) => session.sessionId === manualImport.sessionId);
  return manual?.sessionId ?? sessions[0]?.sessionId ?? null;
}

/** Each editor keeps at most one window of drafts and records, independently of its rows. */
export function boundByWindow<Value>(map: Map<string, Value>): void {
  while (map.size > UI_LIMITS.listWindow) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    map.delete(oldest);
  }
}
