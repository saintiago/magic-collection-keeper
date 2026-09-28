/**
 * Reading of the values a source, a fragment reader or a consumer supplies
 * (docs/card-list.md#interface). A source answer, an entry, a fragment result and a retained
 * handle are all external input: unreadable input is rejected or reported as a failure instead of
 * being presented as an empty or successful result.
 */

import { CARD_LIST_LIMITS } from './limits.js';
import {
  cardListFragmentKinds,
  type CardListEntry,
  type CardListEntryImage,
  type CardListEntryOwnership,
  type CardListEntryTag,
  type CardListFocus,
  type CardListFragmentKind,
  type CardListFragmentReader,
  type CardListFragmentState,
  type CardListOperationOutcome,
  type CardListPage,
  type CardListPosition,
  type CardListRetained,
  type CardListSelectedTarget,
  type CardListSource,
  type CardListTarget,
  type CardListTool,
} from './contract.js';

/** One source answer, read as the page it supplies, its invalidation or the problem it carries. */
export type CardListReadReport =
  | { readonly status: 'page'; readonly page: CardListPage }
  | { readonly status: 'invalidated' }
  | { readonly status: 'unreadable'; readonly problem: string };

/**
 * One source answer: a page of at most the requested entries with unique keys and readable
 * information, or the report that the requested sequence is invalidated
 * (docs/card-list.md#interface).
 */
export function readCardListRead(value: unknown, pageSize: number): CardListReadReport {
  const report = readObject(value);
  if (report?.status === 'invalidated') {
    return { status: 'invalidated' };
  }
  if (report?.status !== 'page') {
    return unreadableRead('The list source reported neither a page nor an invalidated sequence.');
  }
  const entries = report.entries;
  if (!Array.isArray(entries)) {
    return unreadableRead('The list source did not report entries.');
  }
  if (entries.length > pageSize) {
    return unreadableRead(`The list source returned more than the ${pageSize} requested entries.`);
  }
  const continuation = report.continuation;
  if (continuation !== undefined && continuation !== null && typeof continuation !== 'string') {
    return unreadableRead('The list source reported an unreadable continuation.');
  }
  const current = report.current;
  if (current !== undefined && typeof current !== 'boolean') {
    return unreadableRead('The list source reported an unreadable freshness state.');
  }
  const read: CardListEntry[] = [];
  const keys = new Set<string>();
  for (const candidate of entries) {
    const entry = readEntry(candidate);
    if (entry === null) {
      return unreadableRead('The list source reported an unreadable entry.');
    }
    if (keys.has(entry.key)) {
      return unreadableRead('The list source reported one entry key twice.');
    }
    keys.add(entry.key);
    read.push(entry);
  }
  return {
    status: 'page',
    page: {
      entries: read,
      continuation:
        typeof continuation === 'string' && continuation.length > 0 ? continuation : null,
      current: current !== false,
    },
  };
}

function unreadableRead(problem: string): CardListReadReport {
  return { status: 'unreadable', problem };
}

export function readEntry(value: unknown): CardListEntry | null {
  const entry = readObject(value);
  const key = entry?.key;
  const target = readTarget(entry?.target);
  if (
    entry === null ||
    typeof key !== 'string' ||
    key.length === 0 ||
    key.length > CARD_LIST_LIMITS.entryKey ||
    target === null
  ) {
    return null;
  }
  const basic = readBasic(entry.basic);
  const quantity = readQuantity(entry.quantity);
  // An explicit null is the entry's own unresolved state; an unreadable value never becomes one.
  if (entry.basic !== null && basic === null) {
    return null;
  }
  if (entry.quantity !== null && quantity === null) {
    return null;
  }
  return { key, target, basic, quantity };
}

export function readTarget(value: unknown): CardListTarget | null {
  const target = readObject(value);
  const kind = target?.kind;
  const id = targetIdentity(kind, target);
  if (typeof id !== 'string' || id.length === 0 || id.length > CARD_LIST_LIMITS.entryKey) {
    return null;
  }
  switch (kind) {
    case 'card':
      return { kind: 'card', cardId: id };
    case 'printing':
      return { kind: 'printing', printingId: id };
    case 'copy':
      return { kind: 'copy', copyId: id };
    case 'pending':
      return { kind: 'pending', entryId: id };
    default:
      return null;
  }
}

/** Identity one entry target names, or undefined when the target names no known level. */
function targetIdentity(kind: unknown, target: Readonly<Record<string, unknown>> | null): unknown {
  switch (kind) {
    case 'card':
      return target?.cardId;
    case 'printing':
      return target?.printingId;
    case 'copy':
      return target?.copyId;
    case 'pending':
      return target?.entryId;
    default:
      return undefined;
  }
}

function readBasic(value: unknown): CardListEntry['basic'] {
  if (value === null || value === undefined) {
    return null;
  }
  const basic = readObject(value);
  const card = readObject(basic?.card);
  const cardId = card?.cardId;
  const name = card?.name;
  const matchedName = card?.matchedName ?? null;
  if (
    basic === null ||
    card === null ||
    typeof cardId !== 'string' ||
    cardId.length === 0 ||
    typeof name !== 'string' ||
    name.length === 0 ||
    (matchedName !== null && typeof matchedName !== 'string')
  ) {
    return null;
  }
  return {
    card: { cardId, name, matchedName: matchedName === null ? null : String(matchedName) },
    printing: readPrinting(basic.printing),
  };
}

/** Shape of the basic printing information one entry carries. */
interface EntryPrintingShape {
  readonly printingId: string;
  readonly edition: string;
  readonly collectorNumber: string;
  readonly language: string;
}

function readPrinting(value: unknown): EntryPrintingShape | null {
  if (value === null || value === undefined) {
    return null;
  }
  const printing = readObject(value);
  const printingId = printing?.printingId;
  const edition = printing?.edition;
  const collectorNumber = printing?.collectorNumber;
  const language = printing?.language;
  if (
    printing === null ||
    typeof printingId !== 'string' ||
    printingId.length === 0 ||
    typeof edition !== 'string' ||
    edition.length === 0 ||
    typeof collectorNumber !== 'string' ||
    collectorNumber.length === 0 ||
    typeof language !== 'string' ||
    language.length === 0
  ) {
    return null;
  }
  return { printingId, edition, collectorNumber, language };
}

function readQuantity(value: unknown): CardListEntry['quantity'] {
  if (value === null || value === undefined) {
    return null;
  }
  const quantity = readObject(value);
  const copies = readCount(quantity?.copies);
  const intended = readCount(quantity?.intended);
  if (quantity === null || copies === undefined || intended === undefined) {
    return null;
  }
  return { copies, intended };
}

/** One count, or null when it is unavailable; undefined when the value is unreadable. */
export function readCount(value: unknown): number | null | undefined {
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** One fragment's outcome per requested key; unreadable answers fail instead of reading empty. */
export function readFragmentResults(
  kind: CardListFragmentKind,
  value: unknown,
): ReadonlyMap<string, CardListFragmentState> {
  const states = new Map<string, CardListFragmentState>();
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const result = readObject(candidate);
      const key = result?.key;
      if (typeof key !== 'string' || key.length === 0 || states.has(key)) {
        continue;
      }
      const state = readFragmentResult(kind, result);
      if (state !== null) {
        states.set(key, state);
      }
    }
  }
  return states;
}

function readFragmentResult(
  kind: CardListFragmentKind,
  result: Readonly<Record<string, unknown>> | null,
): CardListFragmentState | null {
  if (result === null) {
    return null;
  }
  switch (result.status) {
    case 'ready': {
      const values = readFragmentValues(kind, result.values);
      return values.ok
        ? { status: 'ready', values: values.values }
        : { status: 'failed', message: values.problem };
    }
    case 'absent':
      return { status: 'absent' };
    case 'failed':
      return {
        status: 'failed',
        message:
          typeof result.message === 'string' && result.message.length > 0
            ? result.message
            : 'The fragment could not load.',
      };
    default:
      return null;
  }
}

function readFragmentValues(
  kind: CardListFragmentKind,
  value: unknown,
):
  | { readonly ok: true; readonly values: unknown }
  | { readonly ok: false; readonly problem: string } {
  const unreadable = {
    ok: false as const,
    problem: `The ${fragmentLabel(kind)} response is not readable.`,
  };
  if (!Array.isArray(value) && kind !== 'ownership') {
    return unreadable;
  }
  switch (kind) {
    case 'images': {
      const images = readItems(value as readonly unknown[]);
      if (images === null) {
        return unreadable;
      }
      for (const candidate of images) {
        const image = readObject(candidate);
        if (
          image === null ||
          typeof image.src !== 'string' ||
          image.src.length === 0 ||
          typeof image.alt !== 'string'
        ) {
          return unreadable;
        }
      }
      return { ok: true, values: images as readonly CardListEntryImage[] };
    }
    case 'ownership': {
      const ownership = readObject(value);
      const owned = readCount(ownership?.owned);
      const locations = readCount(ownership?.locations);
      if (ownership === null || typeof owned !== 'number' || locations === undefined) {
        return unreadable;
      }
      const intended = readCount(ownership.intended ?? null);
      if (intended === undefined) {
        return unreadable;
      }
      return {
        ok: true,
        values: { owned, locations, intended } satisfies CardListEntryOwnership,
      };
    }
    case 'tags': {
      const tags = readItems(value as readonly unknown[]);
      if (tags === null) {
        return unreadable;
      }
      const read: CardListEntryTag[] = [];
      for (const candidate of tags) {
        const tag = readObject(candidate);
        if (
          tag === null ||
          typeof tag.tagId !== 'string' ||
          tag.tagId.length === 0 ||
          typeof tag.name !== 'string' ||
          tag.name.length === 0
        ) {
          return unreadable;
        }
        read.push({ tagId: tag.tagId, name: tag.name });
      }
      return { ok: true, values: read };
    }
    case 'tools': {
      const values = readItems(value as readonly unknown[]);
      if (values === null) {
        return unreadable;
      }
      for (const candidate of values) {
        if (typeof candidate !== 'string' || candidate.length === 0) {
          return unreadable;
        }
      }
      return { ok: true, values: values as readonly string[] };
    }
  }
}

/** Bounded items of one fragment response; a broken source cannot grow a row without limit. */
function readItems(values: readonly unknown[]): readonly unknown[] | null {
  return values.length <= CARD_LIST_LIMITS.fragmentItems ? values : null;
}

/** Reading of one tool's outcome; an unreadable outcome is never presented as committed. */
export function readOutcome(value: unknown): CardListOperationOutcome {
  const outcome = readObject(value);
  const status = readOutcomeStatus(outcome?.status);
  if (outcome === null || status === null) {
    return { status: 'unknown', message: null };
  }
  const message = outcome.message;
  return {
    status,
    message: typeof message === 'string' && message.length > 0 ? message : null,
  };
}

function readOutcomeStatus(value: unknown): CardListOperationOutcome['status'] | null {
  switch (value) {
    case 'committed':
    case 'conflict':
    case 'failed':
    case 'unknown':
      return value;
    default:
      return null;
  }
}

/** Human label of one fragment kind; used by the default messages of a failed read. */
export function fragmentLabel(kind: CardListFragmentKind): string {
  switch (kind) {
    case 'images':
      return 'images';
    case 'ownership':
      return 'ownership';
    case 'tags':
      return 'tags';
    case 'tools':
      return 'tools';
  }
}

export function isFragmentKind(value: string): value is CardListFragmentKind {
  return (cardListFragmentKinds as readonly string[]).includes(value);
}

export function readSource<Context>(value: unknown): CardListSource<Context> {
  const source = readObject(value);
  if (source === null || typeof source.load !== 'function') {
    throw new TypeError('The CardList reads its entries through one supplied source.');
  }
  return value as CardListSource<Context>;
}

export function readPageSize(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > CARD_LIST_LIMITS.page
  ) {
    throw new TypeError(`The CardList asks for 1 to ${CARD_LIST_LIMITS.page} entries per page.`);
  }
  return value;
}

export function readAccountId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('A CardList belongs to one verified account.');
  }
  return value;
}

/**
 * State one list retains while it is alive. The handle is opaque to its consumer: only a list
 * reads it back, and it names the account and instance type that produced it
 * (docs/card-list.md#selection-and-restoration).
 */
export interface RetainedState<Context> {
  readonly kind: 'card-list-retained';
  readonly accountId: string;
  readonly context: Context;
  readonly position: CardListPosition | null;
  readonly window: number;
  readonly selection: readonly string[];
  readonly selectedTargets: readonly CardListSelectedTarget[];
  readonly scrollTop: number;
  readonly focus: CardListFocus | null;
}

/** One retained handle as the list that produced it exposes it to its consumer. */
export function retainedHandle<Context>(state: RetainedState<Context>): CardListRetained<Context> {
  return state as unknown as CardListRetained<Context>;
}

/**
 * Reads the state a consumer handed back to this list. An unreadable handle is a consumer bug, not
 * partial input: the list refuses it instead of re-presenting a window nobody asked for. A handle
 * another account or instance type produced is not this list's state and restores nothing.
 */
export function readRetainedState<Context>(
  value: unknown,
  accountId: string,
  pageSize: number,
  context: Context,
): RetainedState<Context> | null {
  if (value === undefined || value === null) {
    return null;
  }
  const state = readObject(value);
  if (state?.kind !== 'card-list-retained') {
    return null;
  }
  if (readAccountOf(state) !== accountId) {
    return null;
  }
  const window = state.window;
  if (
    typeof window !== 'number' ||
    !Number.isSafeInteger(window) ||
    window < 0 ||
    window > CARD_LIST_LIMITS.window
  ) {
    throw new TypeError('A retained list window names the entries it presented.');
  }
  const position = readRetainedPosition(state.position, pageSize);
  if ((window === 0) !== (position === null)) {
    throw new TypeError('A retained list window starts at the position of its first entry.');
  }
  const selection = state.selection;
  if (!Array.isArray(selection)) {
    throw new TypeError('A retained list selection names its entry keys.');
  }
  const keys: string[] = [];
  for (const key of selection) {
    if (typeof key !== 'string' || key.length === 0 || key.length > CARD_LIST_LIMITS.entryKey) {
      throw new TypeError('A retained list selection holds bounded entry keys.');
    }
    if (!keys.includes(key)) {
      keys.push(key);
    }
  }
  const targets = readSelectedTargets(state.selectedTargets);
  const restoredContext = Object.hasOwn(state, 'context') ? (state.context as Context) : context;
  const scrollTop = state.scrollTop;
  if (typeof scrollTop !== 'number' || !Number.isFinite(scrollTop) || scrollTop < 0) {
    throw new TypeError('A retained list scroll offset is a finite, non-negative number.');
  }
  return {
    kind: 'card-list-retained',
    accountId,
    context: restoredContext,
    position,
    window,
    selection: keys,
    selectedTargets: targets,
    scrollTop,
    focus: readRetainedFocus(state.focus),
  };
}

function readAccountOf(state: Readonly<Record<string, unknown>>): string | null {
  const accountId = state.accountId;
  return typeof accountId === 'string' && accountId.length > 0 ? accountId : null;
}

/** Typed targets one retained selection carried for the entries outside its window. */
function readSelectedTargets(value: unknown): readonly CardListSelectedTarget[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new TypeError('A retained list selection carries the typed targets of its entries.');
  }
  const targets: CardListSelectedTarget[] = [];
  for (const candidate of value) {
    const selectedTarget = readObject(candidate);
    const key = selectedTarget?.key;
    const target = readTarget(selectedTarget?.target);
    if (
      selectedTarget === null ||
      typeof key !== 'string' ||
      key.length === 0 ||
      key.length > CARD_LIST_LIMITS.entryKey ||
      target === null
    ) {
      throw new TypeError('A retained list selection carries bounded entry targets.');
    }
    targets.push({ key, target });
  }
  return targets;
}

function readRetainedPosition(value: unknown, pageSize: number): CardListPosition | null {
  if (value === null || value === undefined) {
    return null;
  }
  const position = readObject(value);
  const continuation = position?.continuation ?? null;
  const offset = position?.offset;
  if (
    position === null ||
    (continuation !== null && (typeof continuation !== 'string' || continuation.length === 0)) ||
    typeof offset !== 'number' ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset >= pageSize
  ) {
    throw new TypeError('A retained list position resumes inside one bounded source page.');
  }
  return { continuation, offset };
}

function readRetainedFocus(value: unknown): CardListFocus | null {
  if (value === null || value === undefined) {
    return null;
  }
  const focus = readObject(value);
  const key = focus?.key;
  const named = typeof key === 'string' && key.length > 0;
  switch (focus?.control) {
    case 'select':
      if (named) {
        return { control: 'select', key: key as string };
      }
      break;
    case 'fragment': {
      const kind = focus.kind;
      if (named && typeof kind === 'string' && isFragmentKind(kind)) {
        return { control: 'fragment', key: key as string, kind };
      }
      break;
    }
    case 'element': {
      const id = focus.id;
      // This is the presentation's DOM id, not a source key: prefixes and encoding can expand a
      // bounded key. Retain the one id the presentation reported unchanged; restoration only
      // focuses a matching element inside this list.
      if (typeof id === 'string' && id.length > 0) {
        return { control: 'element', id };
      }
      break;
    }
    case 'group': {
      const keys = focus.keys;
      if (
        Array.isArray(keys) &&
        keys.length > 0 &&
        keys.every((entry) => typeof entry === 'string' && entry.length > 0)
      ) {
        return { control: 'group', keys: keys.map(String) };
      }
      break;
    }
    default:
      break;
  }
  throw new TypeError('A retained list focus names one control of the list.');
}

export function readFragments(
  value: unknown,
): ReadonlyMap<CardListFragmentKind, CardListFragmentReader> {
  const readers = new Map<CardListFragmentKind, CardListFragmentReader>();
  if (value === undefined) {
    return readers;
  }
  const record = readObject(value);
  if (record === null) {
    throw new TypeError('CardList fragments are supplied as one reader per kind.');
  }
  for (const kind of cardListFragmentKinds) {
    const reader = record[kind];
    if (reader === undefined) {
      continue;
    }
    const candidate = readObject(reader);
    if (candidate === null || typeof candidate.read !== 'function') {
      throw new TypeError(`The ${kind} fragment is read through one supplied reader.`);
    }
    readers.set(kind, reader as CardListFragmentReader);
  }
  return readers;
}

export function readTools(value: unknown): ReadonlyMap<string, CardListTool> {
  const tools = new Map<string, CardListTool>();
  if (value === undefined) {
    return tools;
  }
  if (!Array.isArray(value)) {
    throw new TypeError('CardList tools are supplied as one list.');
  }
  for (const entry of value) {
    const definition = readObject(entry);
    const id = definition?.id;
    const label = definition?.label;
    const tool = readObject(definition?.tool);
    if (
      definition === null ||
      typeof id !== 'string' ||
      id.length === 0 ||
      typeof label !== 'string' ||
      label.length === 0 ||
      tool === null ||
      typeof tool.invoke !== 'function'
    ) {
      throw new TypeError('A CardList tool names one id and label and invokes one operation.');
    }
    if (tools.has(id)) {
      throw new TypeError('A CardList tool id is used once.');
    }
    tools.set(id, entry as CardListTool);
  }
  return tools;
}

/** Reads one read request's viewport demand; an unreadable demand is a consumer bug. */
export function readDemand(value: unknown): {
  entries: number;
  information: readonly CardListFragmentKind[] | null;
} {
  const demand = readObject(value);
  const entries = demand?.entries;
  if (
    demand === null ||
    typeof entries !== 'number' ||
    !Number.isSafeInteger(entries) ||
    entries < 0
  ) {
    throw new TypeError('A viewport demand names the number of entries it needs.');
  }
  const information = demand.information;
  if (information === undefined) {
    return { entries, information: null };
  }
  if (!Array.isArray(information)) {
    throw new TypeError('A viewport demand lists the fragment kinds it needs.');
  }
  const kinds: CardListFragmentKind[] = [];
  for (const kind of information) {
    if (typeof kind !== 'string' || !isFragmentKind(kind) || kinds.includes(kind)) {
      throw new TypeError('A viewport demand names each fragment kind at most once.');
    }
    kinds.push(kind);
  }
  return { entries, information: kinds };
}

export function readSignal(value: unknown): AbortSignal | undefined {
  if (value === undefined) {
    return undefined;
  }
  const signal = readObject(value);
  if (
    signal === null ||
    typeof signal.aborted !== 'boolean' ||
    typeof signal.addEventListener !== 'function'
  ) {
    throw new TypeError('The CardList cancels its work through one supplied signal.');
  }
  return value as AbortSignal;
}

export function readObject(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Readonly<Record<string, unknown>>;
}

export function readMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}
