/**
 * CardList of the UserInterface (docs/user-interface.md#list-boundary,
 * docs/user-interface.md#cardlist, docs/user-interface.md#state-ownership-and-restoration).
 *
 * CardList turns one supplied source into a bounded, asynchronous working set: the first page
 * loads when the list is constructed, further pages extend the window on demand while the oldest
 * entries beyond the window bound leave it (with selected targets kept separately for tools), and
 * a refresh or refinement replaces the window while usable content stays until the fresh page
 * arrives. Every response belongs to the request that asked for it, so a withdrawn request or an
 * obsolete page never replaces the active view, and closing the page cancels its lists' work
 * (docs/user-interface.md#pages-and-navigation).
 *
 * Basic information renders with the entries. Images, ownership, tags and tool availability are
 * fragments: each kind loads and fails independently of the basic information and of the other
 * kinds, read in bounded batches over the active window and selected tool targets. A failed
 * fragment stays distinguishable from an empty answer and is retried on demand. A read answers
 * for the entry it was asked about: obsolete work is retired, so the read neither blocks nor
 * updates what the window presents now. Equivalent copies group for
 * convenient selection without losing their individual identities, and the tools invoke the owning
 * component's operation for the explicit selection and report its outcome; an invocation without a
 * receipt is unknown, never a definite failure. Each list owns its query, loaded window, selection
 * and presentation state, so one page can present several independent lists.
 *
 * Each list also owns its capture and restoration (docs/user-interface.md#cardlist): the page hands
 * the state a list returned when the history entry returns, and the list itself decides how to
 * re-acquire the window it held — reusing available data or requesting the retained source position
 * again — and restores its own query, selection, action targets and local scroll and focus. Until
 * the retained window is back the list keeps the intended state instead of capturing the partially
 * loaded one, explicit user input supersedes the retained interaction, and the list reports the
 * outcome of the restoration through its lifecycle contract.
 */

import { observeUiInput } from './interaction.js';
import { UI_LIMITS } from './limits.js';
import {
  uiFragmentKinds,
  type UiEntryTarget,
  type UiFragmentKind,
  type UiFragmentReader,
  type UiFragmentResult,
  type UiListEntry,
  type UiListPage,
  type UiListSource,
  type UiOperationOutcome,
  type UiTool,
  type UiToolRequest,
} from './list.js';

/** One image of an entry's images fragment; the presentation shows visible, named images only. */
export interface UiEntryImage {
  readonly src: string;
  readonly alt: string;
}

/** Ownership counts of one entry's ownership fragment. */
export interface UiEntryOwnership {
  /** Physical copies of the entry the account owns. */
  readonly owned: number;
  /** Physical locations holding those copies, or null when the count is unavailable. */
  readonly locations: number | null;
}

/** One label of an entry's tags fragment. */
export interface UiEntryTag {
  readonly tagId: string;
  readonly name: string;
}

/** Fragment readers of one list; a kind without a reader is not presented at all. */
export interface UiCardListFragments {
  readonly images?: UiFragmentReader<readonly UiEntryImage[]>;
  readonly ownership?: UiFragmentReader<UiEntryOwnership>;
  readonly tags?: UiFragmentReader<readonly UiEntryTag[]>;
  /** Tool ids available for the entry; a tool is offered once every selected entry reports it. */
  readonly tools?: UiFragmentReader<readonly string[]>;
}

/** One tool a list presents for its explicit selection (docs/user-interface.md#list-boundary). */
export interface UiCardListTool {
  /** Stable id the entry's tool availability fragment reports. */
  readonly id: string;
  /** Label of the tool's control. */
  readonly label: string;
  /** The owning component's operation. */
  readonly tool: UiTool;
}

/** Presentation adjustments over the default rendering of the list boundary's information. */
export interface UiCardListPresentation {
  /** Content of one entry's basic information; null keeps the default rendering. */
  renderEntry?(entry: UiListEntry): Node | null;
  /** Content of one ready fragment; null keeps the default rendering for its kind. */
  renderFragment?(kind: UiFragmentKind, entry: UiListEntry, values: unknown): Node | null;
}

/** One presented group; equivalent copies share it while keeping their individual identities. */
export interface UiCardListGroup {
  /** Identity of the group inside one rendering. */
  readonly key: string;
  readonly entries: readonly UiListEntry[];
}

/** Source position of the first entry of one list window (docs/user-interface.md#cardlist). */
export interface UiListPosition {
  /** Opaque continuation of the request that supplied the entry; null for the first page. */
  readonly continuation: string | null;
  /** Index of the entry among the entries that request returned. */
  readonly offset: number;
}

/** One control of a list that holds keyboard focus. */
export type UiListFocus =
  | { readonly control: 'select'; readonly key: string }
  | { readonly control: 'group'; readonly keys: readonly string[] }
  | { readonly control: 'fragment'; readonly key: string; readonly kind: UiFragmentKind }
  /** A control the page rendered for one entry, named by the stable element id the page gave it. */
  | { readonly control: 'element'; readonly id: string };

/** One selected entry the retained window no longer presents, with its typed target. */
export interface UiListSelectedTarget {
  readonly key: string;
  readonly target: UiEntryTarget;
}

/**
 * State one list retains for its page's history entry
 * (docs/user-interface.md#state-ownership-and-restoration): the query it evaluates, that query's
 * position, the window it presented, its selection with the action targets of entries outside that
 * window, and its own scroll and focus. The page keeps this representation with the rest of its
 * state and hands it back through `restored`; the list interprets it.
 */
export interface UiCardListState<Context = unknown> {
  /**
   * Query context the retained window belongs to. The list owns its query, so a state captured
   * while a refinement superseded the presented window names the query the list intends instead.
   */
  readonly context: Context;
  /** Source position of the first entry of the retained window, or null when it held none. */
  readonly position: UiListPosition | null;
  /** Entries the retained window held. */
  readonly window: number;
  /** Selected keys in selection order, including entries outside the loaded window. */
  readonly selection: readonly string[];
  /** Typed targets of the selected entries the retained window does not present, for the tools. */
  readonly selectedTargets: readonly UiListSelectedTarget[];
  /** Scroll offset of the list's container. */
  readonly scrollTop: number;
  /** Control of the list that held focus, or null. */
  readonly focus: UiListFocus | null;
}

/**
 * Lifecycle of the restoration one visit performs for the state its page handed back
 * (docs/user-interface.md#state-ownership-and-restoration). Resolves once the list presented the
 * retained window and restored the retained interaction; rejects when it could not present them,
 * and the page reports that result through its own lifecycle contract.
 */
export interface UiCardListRestoration {
  readonly presented: Promise<void>;
}

/**
 * Groups consecutive copy entries that share one printing. Copies of the same printing are
 * equivalent for bulk interaction, so they present together while every entry stays individually
 * presentable and selectable (docs/user-interface.md#cardlist).
 */
export function groupCardListEntries(entries: readonly UiListEntry[]): readonly UiCardListGroup[] {
  const groups: {
    readonly key: string;
    readonly printingId: string | null;
    entries: UiListEntry[];
  }[] = [];
  for (const entry of entries) {
    const printingId = equivalentPrintingId(entry);
    const previous = groups[groups.length - 1];
    if (printingId !== null && previous !== undefined && previous.printingId === printingId) {
      previous.entries.push(entry);
      continue;
    }
    groups.push({ key: `group-${groups.length}`, printingId, entries: [entry] });
  }
  return groups.map(({ key, entries: grouped }) => ({ key, entries: grouped }));
}

/** Printing that makes one copy entry equivalent to another; null when the entry is not a copy. */
function equivalentPrintingId(entry: UiListEntry): string | null {
  const printing = entry.basic?.printing;
  return entry.target.kind === 'copy' && printing != null ? printing.printingId : null;
}

/**
 * Basic information of one entry as the list presents it by default: the card name, the translated
 * or face name that matched, the printing of a printing or copy entry and the copy and intended
 * counts the source evaluated. A page that presents an entry as a link keeps this content as the
 * link's own content instead of rebuilding it (docs/user-interface.md#cardlist).
 */
export function cardListBasicContent(document: Document, entry: UiListEntry): HTMLSpanElement {
  const basic = document.createElement('span');
  basic.dataset.uiBasic = '';
  const name = document.createElement('span');
  name.dataset.uiName = '';
  name.textContent = entry.basic === null ? 'Unresolved entry' : entry.basic.card.name;
  basic.append(name);
  const matched = entry.basic?.card.matchedName ?? null;
  if (matched !== null) {
    const matchedName = document.createElement('span');
    matchedName.dataset.uiMatchedName = '';
    matchedName.textContent = ` (${matched})`;
    basic.append(matchedName);
  }
  const printing = entry.basic?.printing ?? null;
  if (printing !== null) {
    const line = document.createElement('span');
    line.dataset.uiPrinting = '';
    line.textContent = ` ${printing.edition} ${printing.collectorNumber} · ${printing.language}`;
    basic.append(line);
  }
  const quantity = entry.quantity;
  if (quantity?.copies != null) {
    const copies = document.createElement('span');
    copies.dataset.uiCopies = '';
    copies.textContent = ` Copies: ${quantity.copies}`;
    basic.append(copies);
  }
  if (quantity?.intended != null) {
    const intended = document.createElement('span');
    intended.dataset.uiIntended = '';
    intended.textContent = ` Intended: ${quantity.intended}`;
    basic.append(intended);
  }
  return basic;
}

export interface UiCardListOptions<Context = unknown> {
  /** Element the list renders into; the list replaces its content and leaves with the page. */
  readonly container: HTMLElement;
  /** Source of the entries, their continuation and the query context. */
  readonly source: UiListSource<Context>;
  /** Query context of the active result. */
  readonly context: Context;
  /** Entries one page asks for; from 1 to UI_LIMITS.listPage. */
  readonly pageSize: number;
  /**
   * State a previous visit of this list retained for its page's history entry. The list restores
   * its window, selection and local interaction through its own source and reports the outcome
   * through `restoration`; refresh and refinement start a fresh result instead.
   */
  readonly restored?: UiCardListState<Context> | null;
  /** Fragment readers; kinds without one are not presented. */
  readonly fragments?: UiCardListFragments;
  /** Tools presented for the explicit selection, in order. */
  readonly tools?: readonly UiCardListTool[];
  /** Presentation adjustments over the default rendering. */
  readonly presentation?: UiCardListPresentation;
  /** Aborted when the page closes; the list stops loading and drops late results. */
  readonly signal?: AbortSignal;
}

/** One presented list over one source; the page owns the container and the list's own state. */
export interface UiCardList<Context = unknown> {
  /**
   * Entries of the loaded window, in source order; at most UI_LIMITS.listWindow are rendered.
   */
  readonly entries: readonly UiListEntry[];
  /** Selected keys in result order, including entries retired by paging beyond the window. */
  readonly selection: readonly string[];
  /**
   * Whether the active result continues past the loaded window and may be paged now. False while
   * the presented window belongs to a query a refinement superseded and while the last request
   * failed; `retry` repeats that request.
   */
  readonly hasMore: boolean;
  /** Whether a window request is in flight. */
  readonly loading: boolean;
  /** Failure of the last window request, or null; the loaded window stays usable either way. */
  readonly error: string | null;
  /**
   * State this list retains for its page's history entry: its query, the position and size of the
   * presented window, the full selection with the typed targets of entries outside it, and the
   * list's own scroll and focus. While a restoration is still loading, it is the intended state the
   * list is restoring, never the partial window.
   */
  capture(): UiCardListState<Context>;
  /**
   * Lifecycle of restoring the state supplied in `restored`, or null when this visit restored none.
   */
  readonly restoration: UiCardListRestoration | null;
  /** Loads the next page of the active result; the window bound retires its oldest entries. */
  loadMore(): void;
  /** Starts a new result for `context`; usable content stays until the fresh page arrives. */
  refine(context: Context): void;
  /** Reloads the active result from its first page, keeping the window until it arrives. */
  refresh(): void;
  /** Repeats the failed request of the active result; never another query's continuation. */
  retry(): void;
  /**
   * Re-reads one fragment of one entry (also tool availability of a selected entry retired by
   * paging); the other fragments stay unchanged and an outstanding read of that entry's kind
   * is retired instead of answering the fresh one.
   */
  reloadFragment(key: string, kind: UiFragmentKind): void;
  /** Marks one entry selected; a key may be selected before its entry is loaded. */
  setSelected(key: string, selected: boolean): void;
  /** Unselects every entry. */
  clearSelection(): void;
  /** Invokes one tool for the explicit selection; null when nothing was invoked. */
  invoke(toolId: string): Promise<UiOperationOutcome | null>;
  /** Releases the list; outstanding responses are dropped and the list leaves the container. */
  dispose(): void;
}

/** One fragment's state in the presentation: loading, a resolved answer, or a reported failure. */
interface FragmentState {
  readonly status: 'loading' | 'ready' | 'absent' | 'failed';
  readonly values: unknown;
  readonly message: string | null;
}

/** One rendered entry and the elements the list updates in place. */
interface EntryRow {
  readonly entry: UiListEntry;
  readonly checkbox: HTMLInputElement;
  readonly fragments: Map<UiFragmentKind, HTMLElement>;
}

/** One presented group header and the entry keys its control toggles. */
interface GroupHeader {
  readonly checkbox: HTMLInputElement;
  readonly keys: readonly string[];
}

/** One fragment read in flight: the entries it asked about and the read token of each of them. */
interface FragmentRequest {
  readonly kind: UiFragmentKind;
  readonly keys: readonly string[];
  readonly tokens: ReadonlyMap<string, number>;
  readonly controller: AbortController;
}

/** One fragment kind's work: the entries waiting for their turn and the read in flight. */
interface FragmentQueue {
  readonly pending: Set<string>;
  active: FragmentRequest | null;
}

/** One entry control that holds focus, identified so a re-rendering retains it. */
type EntryFocus = UiListFocus;

export function createCardList<Context>(options: UiCardListOptions<Context>): UiCardList<Context> {
  const container = readContainer(options?.container);
  const source = readSource<Context>(options?.source);
  const pageSize = readPageSize(options?.pageSize);
  const readers = readFragments(options?.fragments);
  const tools = readTools(options?.tools);
  const presentation = readPresentation(options?.presentation);
  const signal = readSignal(options?.signal);
  const restored = readRestoredState<Context>(options?.restored, pageSize, options?.context);
  const document = container.ownerDocument;

  const section = document.createElement('section');
  section.dataset.uiCardList = '';
  const toolbar = document.createElement('div');
  toolbar.dataset.uiToolbar = '';
  const selectionCount = document.createElement('span');
  selectionCount.dataset.uiSelectionCount = '';
  selectionCount.setAttribute('aria-live', 'polite');
  toolbar.append(selectionCount);
  const toolButtons = new Map<string, HTMLButtonElement>();
  for (const [id, definition] of tools) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = definition.label;
    button.dataset.uiTool = id;
    button.disabled = true;
    toolbar.append(button);
    toolButtons.set(id, button);
  }
  const outcomeLine = document.createElement('p');
  outcomeLine.dataset.uiOutcome = '';
  outcomeLine.setAttribute('role', 'status');
  const entriesHost = document.createElement('ul');
  entriesHost.dataset.uiEntries = '';
  const statusLine = document.createElement('p');
  statusLine.dataset.uiStatus = '';
  statusLine.setAttribute('role', 'status');
  const moreButton = document.createElement('button');
  moreButton.type = 'button';
  moreButton.textContent = 'Load more';
  moreButton.dataset.uiMore = '';
  const retryButton = document.createElement('button');
  retryButton.type = 'button';
  retryButton.textContent = 'Retry';
  retryButton.dataset.uiRetry = '';
  section.append(toolbar, outcomeLine, entriesHost, statusLine, moreButton, retryButton);
  container.replaceChildren(section);
  section.addEventListener('click', onClick);
  section.addEventListener('change', onChange);

  const rows = new Map<string, EntryRow>();
  const groupHeaders = new Map<string, GroupHeader>();
  const fragmentStates = new Map<string, Map<UiFragmentKind, FragmentState>>();
  /** Read token of one entry's outstanding fragment read of one kind; absent when there is none. */
  const fragmentTokens = new Map<string, Map<UiFragmentKind, number>>();
  const fragmentQueues = new Map<UiFragmentKind, FragmentQueue>();
  const selected = new Set<string>();
  for (const key of restored?.selection ?? []) {
    selected.add(key);
  }
  /**
   * Explicit targets survive paging and restoration; only their tool availability remains part of
   * fragment work.
   */
  const retiredSelection = new Map<string, UiListEntry['target']>();
  for (const selectedTarget of restored?.selectedTargets ?? []) {
    if (selected.has(selectedTarget.key)) {
      retiredSelection.set(selectedTarget.key, selectedTarget.target);
    }
  }
  /**
   * Source position of every entry of the presented window. Positions leave with their entries, so
   * even very deep pagination retains at most one window.
   */
  const positions = new Map<string, UiListPosition>();
  /**
   * The window one visit restores until the source presented it again, or null once it has; while
   * it is set, the list reports it instead of the partially loaded window.
   */
  let kept: UiCardListState<Context> | null =
    restored !== null && restored.window > 0 ? restored : null;
  const settled = kept === null ? null : Promise.withResolvers<void>();
  // The page reports the outcome through its own lifecycle; a page that never reads it must still
  // not surface the list's interruption as an unhandled rejection.
  settled?.promise.catch(() => {});
  let entries: readonly UiListEntry[] = [];
  let windowKeys: ReadonlySet<string> = new Set();
  let activeContext: Context = restored === null ? options.context : restored.context;
  let continuation: string | null = null;
  /** Whether the loaded window carries a continuation that has further results. */
  let continues = false;
  /** The presented window belongs to a query a refinement superseded; it is never paged with it. */
  let staleWindow = false;
  /**
   * Whether explicit user input took the interaction over while the retained window was still
   * loading: the list keeps the interaction the user chose instead of applying the retained focus
   * and scroll (docs/user-interface.md#state-ownership-and-restoration).
   */
  let interactionTaken = false;
  const interaction = new AbortController();
  if (kept !== null) {
    observeUiInput(
      container.ownerDocument.defaultView,
      () => {
        interactionTaken = true;
      },
      interaction.signal,
    );
  }
  let loading = false;
  let error: string | null = null;
  let outcome: UiOperationOutcome | null = null;
  let pending: AbortController | null = null;
  let invocation: AbortController | null = null;
  let failed: { readonly continuation: string | null; readonly offset: number } | null = null;
  let generation = 0;
  let fragmentSequence = 0;
  let disposed = false;

  renderStatus();
  renderSelection();
  renderOutcome();
  if (signal !== undefined && signal.aborted) {
    dispose();
  } else {
    signal?.addEventListener('abort', () => dispose());
    const start = kept?.position ?? null;
    startRequest(start?.continuation ?? null, start?.offset ?? 0);
  }

  return {
    get entries() {
      return [...entries];
    },
    get selection() {
      return selectedKeys();
    },
    get hasMore() {
      return pagingAvailable();
    },
    get loading() {
      return loading;
    },
    get error() {
      return error;
    },
    capture,
    restoration: settled === null ? null : { presented: settled.promise },
    loadMore,
    refine,
    refresh,
    retry,
    reloadFragment,
    setSelected,
    clearSelection,
    invoke,
    dispose,
  };

  /**
   * Requests one page of the active result. A request the user still waits for is the active one:
   * starting another withdraws it, and its late response belongs to a closed request and is
   * dropped instead of replacing the view the user now sees. `offset` skips the entries before the
   * retained position of one restoring window; it applies to the first page of that position only.
   */
  function startRequest(nextContinuation: string | null, offset = 0): void {
    if (disposed) {
      return;
    }
    pending?.abort();
    generation += 1;
    const current = generation;
    const controller = new AbortController();
    pending = controller;
    loading = true;
    error = null;
    failed = null;
    renderStatus();
    let request: Promise<UiListPage>;
    try {
      request = source.load({
        context: activeContext,
        pageSize,
        continuation: nextContinuation,
        signal: controller.signal,
      });
    } catch (cause) {
      settleFailure(
        current,
        nextContinuation,
        offset,
        readMessage(cause, 'The list could not load.'),
      );
      return;
    }
    Promise.resolve(request).then(
      (page) => settlePage(current, nextContinuation, offset, page),
      (cause) =>
        settleFailure(
          current,
          nextContinuation,
          offset,
          readMessage(cause, 'The list could not load.'),
        ),
    );
  }

  function settlePage(
    current: number,
    requested: string | null,
    offset: number,
    value: unknown,
  ): void {
    if (disposed || current !== generation) {
      return;
    }
    const read = readCardListPage(value, pageSize);
    if (!read.ok) {
      settleFailure(current, requested, offset, read.problem);
      return;
    }
    pending = null;
    loading = false;
    error = null;
    failed = null;
    const supplied = read.page.entries;
    const presented = offset === 0 ? supplied : supplied.slice(offset);
    const previousLength = entries.length;
    if (requested === null) {
      // The fresh first page belongs to the active query, so nothing older stays paged. A retained
      // window being re-acquired keeps the action context the state carried, while a result that
      // replaced another exposes its selected keys as they are found again.
      staleWindow = false;
      setWindow(presented, kept !== null);
    } else {
      appendWindow(presented);
    }
    rememberPositions(requested, supplied);
    continuation = read.page.continuation;
    continues = continuation !== null;
    renderStatus();
    requestFragments();
    if (kept !== null) {
      restoreWindow(previousLength);
    }
  }

  function settleFailure(
    current: number,
    requested: string | null,
    offset: number,
    message: string,
  ): void {
    if (disposed || current !== generation) {
      return;
    }
    pending = null;
    loading = false;
    error = message;
    // The failed request is repeated by `retry`: the same position of the same result, including
    // the offset that resumes inside the retained source page.
    failed = { continuation: requested, offset };
    renderStatus();
    if (kept !== null) {
      // The retained window could not be presented; the page reports the interruption and the
      // intended state stays retained, so leaving and returning retries it.
      settled?.reject(new Error(message));
    }
  }

  /**
   * Keeps loading the retained window from its own source position until the list presented the
   * same number of entries again, the result ends or a page adds nothing: the source stays
   * authoritative for membership and continuation, so a shorter result presents what it holds.
   */
  function restoreWindow(previousLength: number): void {
    const window = kept;
    if (window === null) {
      return;
    }
    if (
      entries.length >= window.window ||
      continuation === null ||
      entries.length === previousLength
    ) {
      presentWindow(window);
      return;
    }
    startRequest(continuation);
  }

  /**
   * The retained window is back: the list restores its own scroll and focus and reports the
   * presentation, so the page can hand the entry's shell-owned interaction back to the shell. The
   * retained interaction is applied only while the user has not taken it over, and the presented
   * window now decides the paging control the list shows.
   */
  function presentWindow(window: UiCardListState<Context>): void {
    kept = null;
    interaction.abort();
    if (!interactionTaken) {
      restoreEntryFocus(window.focus);
      if (window.scrollTop > 0) {
        container.scrollTop = window.scrollTop;
      }
    }
    renderStatus();
    settled?.resolve();
  }

  /** Replaces the window; entries the new result no longer holds leave it. */
  function setWindow(next: readonly UiListEntry[], keepingTargets = false): void {
    // A replacement result exposes selected keys as they are found again, as with other retained
    // selection keys; only paging and a retained window being re-acquired carry explicit action
    // context beyond the rendered window.
    if (!keepingTargets) {
      clearRetiredSelection();
    }
    applyWindow(next);
  }

  /** Extends the window; an entry key the window already holds arrives once. */
  function appendWindow(next: readonly UiListEntry[]): void {
    const known = new Set(windowKeys);
    const added = next.filter((entry) => !known.has(entry.key));
    if (added.length === 0) {
      return;
    }
    const combined = [...entries, ...added];
    for (const entry of combined.slice(0, -UI_LIMITS.listWindow)) {
      if (selected.has(entry.key)) {
        retiredSelection.set(entry.key, entry.target);
      }
    }
    applyWindow(combined);
  }

  /**
   * Records where in the source result the entries of one page sit, so the window the list presents
   * can be requested again from its own position. Only the presented window keeps positions, and a
   * replacement result replaces them: the source owns ordering, so an entry a fresh result moved
   * sits at its new position instead of the one the previous result recorded.
   */
  function rememberPositions(requested: string | null, supplied: readonly UiListEntry[]): void {
    supplied.forEach((entry, index) => {
      if (!windowKeys.has(entry.key)) {
        return;
      }
      // A page the window appends keeps the position an entry already had; the first page of a
      // fresh result replaces it.
      if (requested !== null && positions.has(entry.key)) {
        return;
      }
      positions.set(entry.key, { continuation: requested, offset: index });
    });
    for (const key of positions.keys()) {
      if (!windowKeys.has(key)) {
        positions.delete(key);
      }
    }
  }

  /**
   * State this list retains for the page's history entry. While a restoration is still loading it
   * is the state the list is restoring — the intended window, never the partial one — with the
   * selection and local interaction the user changed in the meantime. A refinement that superseded
   * the presented window retains the query the list intends, whose first page has not arrived yet,
   * so the captured position always belongs to the captured query.
   */
  function capture(): UiCardListState<Context> {
    const window = kept;
    const retainedInteraction = {
      selection: [...selected],
      selectedTargets: [...retiredSelection].map(([key, target]) => ({ key, target })),
      // While the retained window is still loading, the container holds no applied offset: the
      // state keeps the retained one unless the user scrolled it or took the interaction over.
      scrollTop:
        window !== null && !interactionTaken && container.scrollTop === 0
          ? window.scrollTop
          : container.scrollTop,
      focus: readEntryFocus() ?? (interactionTaken ? null : (window?.focus ?? null)),
    };
    if (staleWindow) {
      return {
        context: activeContext,
        position: null,
        window: 0,
        ...retainedInteraction,
      };
    }
    const first = entries[0];
    return {
      context: activeContext,
      position:
        window?.position ?? (first === undefined ? null : (positions.get(first.key) ?? null)),
      window: window?.window ?? entries.length,
      ...retainedInteraction,
    };
  }

  /**
   * Presents one window, bounded to UI_LIMITS.listWindow retained entries. The oldest entries
   * beyond the bound leave the rendering regardless of selection; paging retains selected action
   * context separately, so selection never hides further results. Enrichment follows the entry it
   * was read for: entries that leave or change retire their fragments and outstanding reads.
   * Only tool availability remains needed for selected targets retired by paging.
   */
  function applyWindow(next: readonly UiListEntry[]): void {
    const previous = new Map(entries.map((entry) => [entry.key, entryIdentity(entry)] as const));
    entries = next.slice(-UI_LIMITS.listWindow);
    windowKeys = new Set(entries.map((entry) => entry.key));
    for (const key of windowKeys) {
      if (retiredSelection.delete(key)) {
        // An entry returning to the window may have changed while it was away.
        invalidateFragment(key, 'tools');
      }
    }
    const identities = new Map(entries.map((entry) => [entry.key, entryIdentity(entry)] as const));
    for (const [key, identity] of previous) {
      if (identities.get(key) === identity) {
        continue;
      }
      invalidateFragments(key);
    }
    retireObsoleteFragments();
    renderEntries();
  }

  function loadMore(): void {
    const next = continuation;
    if (disposed || loading || !pagingAvailable() || next === null) {
      return;
    }
    startRequest(next);
  }

  /** Whether the active result offers further results right now. */
  function pagingAvailable(): boolean {
    // While a retained window is still loading, the list is re-presenting that window instead of
    // offering the further results of the active query.
    return continues && !staleWindow && error === null && kept === null;
  }

  function refresh(): void {
    abandonRestoration();
    startRequest(null);
  }

  function refine(next: Context): void {
    if (disposed) {
      return;
    }
    abandonRestoration();
    activeContext = next;
    // The presented window belongs to the previous query until the fresh page arrives: it is kept
    // as usable content, but paging it with the new context would mix two result sequences.
    staleWindow = true;
    outcome = null;
    renderOutcome();
    startRequest(null);
  }

  function retry(): void {
    if (disposed || failed === null) {
      return;
    }
    // A retry repeats the failed request of the same result, so a restoration still under way keeps
    // acquiring the retained window and the intended state stays retained until it is presented
    // (docs/user-interface.md#state-ownership-and-restoration).
    startRequest(failed.continuation, failed.offset);
  }

  /**
   * The user restarted or re-queried the list: the retained window is superseded and the page
   * learns that the restoration ended without presenting it.
   */
  function abandonRestoration(): void {
    if (kept === null) {
      return;
    }
    kept = null;
    interaction.abort();
    settled?.reject(new Error('The retained window was superseded before it was presented.'));
  }

  function setSelected(key: string, selectedNow: boolean): void {
    if (disposed || typeof key !== 'string' || key.length === 0) {
      return;
    }
    if (selectedNow) {
      selected.add(key);
    } else {
      selected.delete(key);
      if (retiredSelection.delete(key)) {
        invalidateFragment(key, 'tools');
        retireObsoleteFragments();
      }
    }
    renderSelection();
  }

  function clearSelection(): void {
    if (disposed || selected.size === 0) {
      return;
    }
    selected.clear();
    clearRetiredSelection();
    retireObsoleteFragments();
    renderSelection();
  }

  function clearRetiredSelection(): void {
    for (const key of retiredSelection.keys()) {
      invalidateFragment(key, 'tools');
    }
    retiredSelection.clear();
  }

  function setGroupSelected(groupKey: string, selectedNow: boolean): void {
    const header = groupHeaders.get(groupKey);
    if (header === undefined) {
      return;
    }
    for (const key of header.keys) {
      if (selectedNow) {
        selected.add(key);
      } else {
        selected.delete(key);
      }
    }
    renderSelection();
  }

  /** Selected result keys, including explicit targets retained when paging retires their rows. */
  function selectedKeys(): readonly string[] {
    return [
      ...retiredSelection.keys(),
      ...entries.filter((entry) => selected.has(entry.key)).map((entry) => entry.key),
    ];
  }

  /** Whether one tool acts on the whole selection: every selected entry reports it available. */
  function toolAvailable(id: string): boolean {
    const keys = selectedKeys();
    // A selection can name entries whose targets have not arrived yet, including later pages of
    // a restored window. Neither the button nor programmatic invocation may act on just a subset.
    if (keys.length === 0 || keys.length !== selected.size) {
      return false;
    }
    if (!readers.has('tools')) {
      return true;
    }
    return keys.every((key) => {
      const state = fragmentState(key, 'tools');
      return (
        state?.status === 'ready' &&
        Array.isArray(state.values) &&
        (state.values as readonly string[]).includes(id)
      );
    });
  }

  /**
   * Invokes one tool for the explicit selection: the selected targets and the selection context
   * the tool receives are read from the interaction state at this moment, never inferred from the
   * rendered view. The outcome is presented for a committed operation, kept for a conflict or
   * failure, and reported as unknown so the page can recover the recorded outcome.
   */
  async function invoke(toolId: string): Promise<UiOperationOutcome | null> {
    const definition = tools.get(toolId);
    const keys = selectedKeys();
    if (
      disposed ||
      definition === undefined ||
      invocation !== null ||
      keys.length === 0 ||
      !toolAvailable(toolId)
    ) {
      return null;
    }
    const chosen = entries.filter((entry) => selected.has(entry.key));
    const targets = [...retiredSelection.values(), ...chosen.map((entry) => entry.target)];
    const controller = new AbortController();
    invocation = controller;
    renderTools();
    const reported = await runTool(definition.tool, {
      targets,
      selection: { keys, targets },
      signal: controller.signal,
    });
    if (disposed || invocation !== controller) {
      return null;
    }
    invocation = null;
    outcome = reported;
    renderOutcome();
    renderTools();
    return reported;
  }

  async function runTool(tool: UiTool, request: UiToolRequest): Promise<UiOperationOutcome> {
    let value: unknown;
    try {
      value = await tool.invoke(request);
    } catch {
      // A lost response does not establish that the write failed: the operation may have committed
      // before its answer went missing, so its outcome stays unknown until the owning component's
      // recorded receipt is recovered (docs/application.md#construction-and-request-boundary).
      return { status: 'unknown', message: null };
    }
    return readOutcome(value);
  }

  function renderEntries(): void {
    const focus = readEntryFocus();
    rows.clear();
    groupHeaders.clear();
    entriesHost.replaceChildren();
    for (const group of groupCardListEntries(entries)) {
      entriesHost.append(
        group.entries.length === 1 ? renderRow(group.entries[0]!) : renderGroup(group),
      );
    }
    renderSelection();
    restoreEntryFocus(focus);
  }

  /** The control of one entry that holds keyboard focus, so a re-rendering of the window keeps it. */
  function readEntryFocus(): EntryFocus | null {
    const active = document.activeElement;
    if (active === null || !entriesHost.contains(active)) {
      return null;
    }
    const row = active.closest('[data-ui-entry]');
    if (row !== null) {
      const key = row.getAttribute('data-ui-entry') ?? '';
      const kind =
        active.getAttribute('data-ui-fragment-retry') ?? active.getAttribute('data-ui-fragment');
      if (kind !== null && isFragmentKind(kind)) {
        return { control: 'fragment', key, kind };
      }
      if (active.hasAttribute('data-ui-select')) {
        return { control: 'select', key };
      }
      // The page renders the entry's own control: its stable element id keeps that focus too.
      return active.id.length > 0 ? { control: 'element', id: active.id } : null;
    }
    const group = active.closest('[data-ui-group]');
    if (group !== null && active.hasAttribute('data-ui-group-select')) {
      const header = groupHeaders.get(group.getAttribute('data-ui-group') ?? '');
      return header === undefined ? null : { control: 'group', keys: header.keys };
    }
    return null;
  }

  /** Focuses the same control of the same entry again, when the update still presents it. */
  function restoreEntryFocus(focus: EntryFocus | null): void {
    if (focus === null) {
      return;
    }
    if (focus.control === 'element') {
      const control = document.getElementById(focus.id);
      if (control !== null && entriesHost.contains(control)) {
        control.focus({ preventScroll: true });
      }
      return;
    }
    if (focus.control === 'group') {
      // Group positions are local to one rendering. Follow the first surviving member even when
      // groups reorder, merge, or shrink to an individual entry.
      const key = focus.keys.find((key) => rows.has(key));
      if (key !== undefined) {
        const header = [...groupHeaders.values()].find((header) => header.keys.includes(key));
        (header?.checkbox ?? rows.get(key)?.checkbox)?.focus();
      }
      return;
    }
    const row = rows.get(focus.key);
    if (focus.control === 'select') {
      row?.checkbox.focus();
      return;
    }
    const slot = row?.fragments.get(focus.kind);
    // A fragment that now shows a retry keeps the button focused; another state keeps the slot.
    const control = slot?.querySelector<HTMLElement>('[data-ui-fragment-retry]') ?? slot;
    if (control !== undefined) {
      control.focus();
    }
  }

  function renderGroup(group: UiCardListGroup): HTMLLIElement {
    const first = group.entries[0]!;
    const row = document.createElement('li');
    row.dataset.uiGroup = group.key;
    const header = document.createElement('div');
    header.dataset.uiGroupHeader = '';
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.uiGroupSelect = group.key;
    if (container.id.length > 0) {
      // A stable container id scopes the ids the shell restores focus by; the first member names
      // the group so the id survives groups merging or reordering.
      checkbox.id = `${container.id}-group-${encodeURIComponent(first.key)}`;
    }
    checkbox.setAttribute('aria-label', `Select all ${describeEntry(first)}`);
    const basic = document.createElement('span');
    basic.dataset.uiGroupBasic = '';
    basic.textContent = describeEntry(first);
    const count = document.createElement('span');
    count.dataset.uiGroupCount = '';
    count.textContent = `${group.entries.length} equivalent copies`;
    label.append(checkbox, basic, count);
    header.append(label);
    const nested = document.createElement('ul');
    nested.dataset.uiGroupEntries = '';
    for (const entry of group.entries) {
      nested.append(renderRow(entry));
    }
    row.append(header, nested);
    groupHeaders.set(group.key, { checkbox, keys: group.entries.map((entry) => entry.key) });
    return row;
  }

  function renderRow(entry: UiListEntry): HTMLLIElement {
    const row = document.createElement('li');
    row.dataset.uiEntry = entry.key;
    row.dataset.uiLevel = entry.target.kind;
    if (container.id.length > 0) {
      row.id = `${container.id}-entry-${encodeURIComponent(entry.key)}`;
    }
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.uiSelect = entry.key;
    if (container.id.length > 0) {
      checkbox.id = `${container.id}-select-${encodeURIComponent(entry.key)}`;
    }
    checkbox.setAttribute('aria-label', `Select ${describeEntry(entry)}`);
    const basic = presentation.renderEntry?.(entry) ?? renderBasic(entry);
    label.append(checkbox, basic);
    row.append(label);
    const fragments = new Map<UiFragmentKind, HTMLElement>();
    if (readers.size > 0) {
      const host = document.createElement('div');
      host.dataset.uiFragments = '';
      for (const kind of uiFragmentKinds) {
        if (!readers.has(kind)) {
          continue;
        }
        const slot = document.createElement('span');
        slot.dataset.uiFragment = kind;
        // Re-rendering a fragment keeps keyboard focus inside the entry it belongs to.
        slot.tabIndex = -1;
        host.append(slot);
        fragments.set(kind, slot);
      }
      row.append(host);
    }
    rows.set(entry.key, { entry, checkbox, fragments });
    // The row is registered first, so retained and loading fragment states render with it.
    for (const kind of fragments.keys()) {
      renderFragmentSlot(entry.key, kind);
    }
    return row;
  }

  function renderSelection(): void {
    // The count names every selected identity the list retains, including entries whose window the
    // source has not presented yet.
    selectionCount.textContent = `${selected.size} selected`;
    for (const [key, row] of rows) {
      row.checkbox.checked = selected.has(key);
    }
    for (const header of groupHeaders.values()) {
      const chosen = header.keys.filter((key) => selected.has(key)).length;
      header.checkbox.checked = chosen === header.keys.length;
      header.checkbox.indeterminate = chosen > 0 && chosen < header.keys.length;
    }
    renderTools();
  }

  function renderTools(): void {
    for (const [id, button] of toolButtons) {
      button.disabled = disposed || invocation !== null || !toolAvailable(id);
    }
  }

  function renderStatus(): void {
    section.setAttribute('aria-busy', loading ? 'true' : 'false');
    moreButton.hidden = !pagingAvailable();
    moreButton.disabled = loading;
    retryButton.hidden = error === null;
    if (error !== null) {
      statusLine.textContent = error;
      return;
    }
    if (entries.length === 0) {
      statusLine.textContent = loading ? 'Loading…' : 'No entries';
      return;
    }
    statusLine.textContent = '';
  }

  function renderOutcome(): void {
    if (outcome === null) {
      outcomeLine.textContent = '';
      outcomeLine.removeAttribute('data-ui-outcome-status');
      return;
    }
    outcomeLine.dataset.uiOutcomeStatus = outcome.status;
    outcomeLine.textContent = outcome.message ?? outcomeText(outcome.status);
  }

  function renderBasic(entry: UiListEntry): Node {
    return cardListBasicContent(document, entry);
  }

  /** Text one entry is announced by; it names the entry without its optional fragments. */
  function describeEntry(entry: UiListEntry): string {
    if (entry.basic === null) {
      return `unresolved ${entry.target.kind} entry`;
    }
    const printing = entry.basic.printing;
    return printing === null
      ? entry.basic.card.name
      : `${entry.basic.card.name} (${printing.edition} ${printing.collectorNumber})`;
  }

  function requestFragments(): void {
    for (const kind of uiFragmentKinds) {
      if (!readers.has(kind)) {
        continue;
      }
      const queue = fragmentQueue(kind);
      for (const key of fragmentRequestKeys(kind)) {
        if (fragmentState(key, kind) === null) {
          setFragmentState(key, kind, { status: 'loading', values: null, message: null });
          queue.pending.add(key);
        }
      }
      pumpFragments(kind);
    }
  }

  /**
   * Entries one kind is read for: the presented window, plus the tool availability of a selected
   * target the window no longer presents (docs/user-interface.md#list-boundary).
   */
  function fragmentRequestKeys(kind: UiFragmentKind): ReadonlySet<string> {
    if (kind !== 'tools' || retiredSelection.size === 0) {
      return windowKeys;
    }
    return new Set([...windowKeys, ...retiredSelection.keys()]);
  }

  function reloadFragment(key: string, kind: UiFragmentKind): void {
    if (disposed || !fragmentKeyActive(key, kind) || !readers.has(kind)) {
      return;
    }
    // The outstanding read of this entry is retired so the fresh one is not blocked behind it and
    // its answer never replaces the fresh one.
    invalidateFragment(key, kind);
    setFragmentState(key, kind, { status: 'loading', values: null, message: null });
    fragmentQueue(kind).pending.add(key);
    retireObsoleteFragments();
    pumpFragments(kind);
  }

  /**
   * Reads the pending entries of one kind in bounded batches; one read is in flight per kind and
   * the entries requested meanwhile wait for their own batch.
   */
  function pumpFragments(kind: UiFragmentKind): void {
    const queue = fragmentQueue(kind);
    const reader = readers.get(kind);
    if (disposed || reader === undefined || queue.active !== null || queue.pending.size === 0) {
      return;
    }
    const keys = [...queue.pending].slice(0, UI_LIMITS.fragmentBatch);
    for (const key of keys) {
      queue.pending.delete(key);
    }
    const request: FragmentRequest = {
      kind,
      keys,
      tokens: new Map(keys.map((key) => [key, beginFragmentRead(kind, key)] as const)),
      controller: new AbortController(),
    };
    queue.active = request;
    const finish = (apply: () => void): void => {
      // A read the window retired meanwhile settled late: it no longer belongs to this queue.
      if (disposed || queue.active !== request) {
        return;
      }
      queue.active = null;
      apply();
      for (const key of request.keys) {
        endFragmentRead(kind, key);
      }
      pumpFragments(kind);
    };
    let reading: Promise<readonly UiFragmentResult<unknown>[]>;
    try {
      reading = reader.read({ keys, information: [kind], signal: request.controller.signal });
    } catch (cause) {
      finish(() =>
        applyFragmentFailure(kind, request, readMessage(cause, 'The fragment could not load.')),
      );
      return;
    }
    Promise.resolve(reading).then(
      (results) => finish(() => applyFragmentResults(kind, request, results)),
      (cause) =>
        finish(() =>
          applyFragmentFailure(kind, request, readMessage(cause, 'The fragment could not load.')),
        ),
    );
  }

  function applyFragmentResults(
    kind: UiFragmentKind,
    request: FragmentRequest,
    results: unknown,
  ): void {
    if (disposed) {
      return;
    }
    const read = readFragmentResults(kind, results);
    for (const key of request.keys) {
      // The values answer for this entry only while this read is still the one that was asked for.
      if (!fragmentResponseApplies(request, key)) {
        continue;
      }
      const state = read.get(key) ?? {
        status: 'failed' as const,
        values: null,
        message: 'The fragment response did not cover every requested entry.',
      };
      setFragmentState(key, kind, state);
    }
  }

  function applyFragmentFailure(
    kind: UiFragmentKind,
    request: FragmentRequest,
    message: string,
  ): void {
    if (disposed) {
      return;
    }
    for (const key of request.keys) {
      // A failure of a superseded read never reports for the entry its replacement now serves.
      if (fragmentResponseApplies(request, key)) {
        setFragmentState(key, kind, { status: 'failed', values: null, message });
      }
    }
  }

  /** Whether one read still answers for this entry: it is presented under the read's own token. */
  function fragmentResponseApplies(request: FragmentRequest, key: string): boolean {
    return (
      fragmentKeyActive(key, request.kind) &&
      fragmentToken(request.kind, key) === request.tokens.get(key)
    );
  }

  /** Only tool availability is needed beyond the rendered window, for explicit selected targets. */
  function fragmentKeyActive(key: string, kind: UiFragmentKind): boolean {
    return windowKeys.has(key) || (kind === 'tools' && retiredSelection.has(key));
  }

  function fragmentState(key: string, kind: UiFragmentKind): FragmentState | null {
    return fragmentStates.get(key)?.get(kind) ?? null;
  }

  function setFragmentState(key: string, kind: UiFragmentKind, state: FragmentState): void {
    const states = fragmentStates.get(key) ?? new Map<UiFragmentKind, FragmentState>();
    states.set(kind, state);
    fragmentStates.set(key, states);
    renderFragmentSlot(key, kind);
    if (kind === 'tools') {
      // Tool availability arrived for one entry: the offered controls follow it immediately.
      renderTools();
    }
  }

  /** Retires enrichment, keeping only tool availability needed for a selected target. */
  function invalidateFragments(key: string): void {
    for (const kind of uiFragmentKinds) {
      if (kind !== 'tools' || !retiredSelection.has(key)) {
        invalidateFragment(key, kind);
      }
    }
  }

  function invalidateFragment(key: string, kind: UiFragmentKind): void {
    const states = fragmentStates.get(key);
    states?.delete(kind);
    if (states !== undefined && states.size === 0) {
      fragmentStates.delete(key);
    }
    endFragmentRead(kind, key);
    fragmentQueues.get(kind)?.pending.delete(key);
  }

  /** The token of the read now answering for one entry's kind, or zero when none is outstanding. */
  function fragmentToken(kind: UiFragmentKind, key: string): number {
    return fragmentTokens.get(key)?.get(kind) ?? 0;
  }

  /** Marks one entry's kind as being read now, so earlier answers for it are retired. */
  function beginFragmentRead(kind: UiFragmentKind, key: string): number {
    fragmentSequence += 1;
    const tokens = fragmentTokens.get(key) ?? new Map<UiFragmentKind, number>();
    tokens.set(kind, fragmentSequence);
    fragmentTokens.set(key, tokens);
    return fragmentSequence;
  }

  function endFragmentRead(kind: UiFragmentKind, key: string): void {
    const tokens = fragmentTokens.get(key);
    if (tokens === undefined) {
      return;
    }
    tokens.delete(kind);
    if (tokens.size === 0) {
      fragmentTokens.delete(key);
    }
  }

  /** Whether the window still waits for one entry's fragment of one kind. */
  function fragmentReadWanted(kind: UiFragmentKind, key: string): boolean {
    return fragmentKeyActive(key, kind) && fragmentState(key, kind)?.status === 'loading';
  }

  /**
   * Retires the read in flight for a kind whose answer can no longer apply to the presented window,
   * so the entries that still wait for that kind are not blocked behind withdrawn work. The entries
   * that are still wanted are read again under a fresh token.
   */
  function retireObsoleteFragments(): void {
    for (const [kind, queue] of fragmentQueues) {
      const active = queue.active;
      if (active === null || !fragmentReadObsolete(kind, active)) {
        continue;
      }
      queue.active = null;
      active.controller.abort();
      for (const key of active.keys) {
        endFragmentRead(kind, key);
        if (fragmentReadWanted(kind, key)) {
          queue.pending.add(key);
        }
      }
      pumpFragments(kind);
    }
  }

  /** Whether one read in flight can no longer answer for a presented entry it asked about. */
  function fragmentReadObsolete(kind: UiFragmentKind, active: FragmentRequest): boolean {
    return active.keys.some(
      (key) =>
        !fragmentReadWanted(kind, key) || fragmentToken(kind, key) !== active.tokens.get(key),
    );
  }

  function fragmentQueue(kind: UiFragmentKind): FragmentQueue {
    let queue = fragmentQueues.get(kind);
    if (queue === undefined) {
      queue = { pending: new Set(), active: null };
      fragmentQueues.set(kind, queue);
    }
    return queue;
  }

  /** One fragment's own state: loading, the resolved values, a definitive absence or a failure. */
  function renderFragmentSlot(key: string, kind: UiFragmentKind): void {
    const slot = rows.get(key)?.fragments.get(kind);
    if (slot === undefined) {
      return;
    }
    // Replacing the slot's content must not drop keyboard focus from the entry it belongs to.
    const focused = slot.contains(document.activeElement);
    const state = fragmentState(key, kind) ?? {
      status: 'loading' as const,
      values: null,
      message: null,
    };
    slot.replaceChildren();
    slot.dataset.uiState = state.status;
    paintFragmentSlot(key, kind, state, slot);
    if (focused) {
      // A state that offers a retry keeps that control focused; another state keeps the slot.
      (slot.querySelector<HTMLElement>('[data-ui-fragment-retry]') ?? slot).focus();
    }
  }

  /** Draws one fragment state into its own slot, which the caller has already cleared. */
  function paintFragmentSlot(
    key: string,
    kind: UiFragmentKind,
    state: FragmentState,
    slot: HTMLElement,
  ): void {
    if (state.status === 'loading') {
      slot.textContent = `Loading ${uiFragmentLabel(kind)}…`;
      return;
    }
    if (state.status === 'absent') {
      slot.textContent = uiFragmentAbsent(kind);
      return;
    }
    if (state.status === 'failed') {
      const message = document.createElement('span');
      message.dataset.uiFragmentMessage = '';
      message.textContent = `${uiFragmentLabel(kind)} unavailable: ${state.message ?? ''}`;
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = 'Retry';
      retry.dataset.uiFragmentRetry = kind;
      retry.setAttribute('aria-label', `Retry ${uiFragmentLabel(kind)}`);
      slot.append(message, ' ', retry);
      return;
    }
    const entry = rows.get(key)?.entry ?? null;
    const overridden =
      entry === null ? null : (presentation.renderFragment?.(kind, entry, state.values) ?? null);
    slot.append(overridden ?? renderFragmentValues(kind, state.values));
  }

  function renderFragmentValues(kind: UiFragmentKind, values: unknown): Node {
    const content = document.createElement('span');
    content.dataset.uiFragmentValues = '';
    switch (kind) {
      case 'images': {
        const images = values as readonly UiEntryImage[];
        if (images.length === 0) {
          content.textContent = uiFragmentAbsent(kind);
          break;
        }
        for (const image of images) {
          const picture = document.createElement('img');
          picture.src = image.src;
          picture.alt = image.alt;
          content.append(picture);
        }
        break;
      }
      case 'ownership': {
        const ownership = values as UiEntryOwnership;
        content.textContent =
          ownership.locations === null
            ? `Owned: ${ownership.owned}`
            : `Owned: ${ownership.owned} · Locations: ${ownership.locations}`;
        break;
      }
      case 'tags': {
        const tags = values as readonly UiEntryTag[];
        content.textContent =
          tags.length === 0 ? uiFragmentAbsent(kind) : tags.map((tag) => tag.name).join(', ');
        break;
      }
      case 'tools': {
        const available = values as readonly string[];
        content.textContent =
          available.length === 0
            ? uiFragmentAbsent(kind)
            : available.map((id) => tools.get(id)?.label ?? id).join(', ');
        break;
      }
    }
    return content;
  }

  function onClick(event: Event): void {
    if (disposed) {
      return;
    }
    const target = event.target as Element | null;
    const control =
      target?.closest?.('[data-ui-more],[data-ui-retry],[data-ui-tool],[data-ui-fragment-retry]') ??
      null;
    if (control === null) {
      return;
    }
    if (control.hasAttribute('data-ui-more')) {
      loadMore();
      return;
    }
    if (control.hasAttribute('data-ui-retry')) {
      retry();
      return;
    }
    const toolId = control.getAttribute('data-ui-tool');
    if (toolId !== null) {
      void invoke(toolId);
      return;
    }
    const kind = control.getAttribute('data-ui-fragment-retry');
    const row = control.closest('[data-ui-entry]');
    if (kind !== null && row !== null && isFragmentKind(kind)) {
      reloadFragment(row.getAttribute('data-ui-entry') ?? '', kind);
    }
  }

  function onChange(event: Event): void {
    if (disposed) {
      return;
    }
    const input = event.target as HTMLInputElement | null;
    if (input === null || input.type !== 'checkbox') {
      return;
    }
    const row = input.closest('[data-ui-entry]');
    if (row !== null) {
      setSelected(row.getAttribute('data-ui-entry') ?? '', input.checked);
      return;
    }
    const group = input.closest('[data-ui-group]');
    if (group !== null) {
      setGroupSelected(group.getAttribute('data-ui-group') ?? '', input.checked);
    }
  }

  function dispose(): void {
    if (disposed) {
      return;
    }
    disposed = true;
    abandonRestoration();
    generation += 1;
    pending?.abort();
    pending = null;
    invocation?.abort();
    invocation = null;
    interaction.abort();
    for (const queue of fragmentQueues.values()) {
      queue.active?.controller.abort();
      queue.active = null;
      queue.pending.clear();
    }
    entries = [];
    windowKeys = new Set();
    positions.clear();
    rows.clear();
    groupHeaders.clear();
    fragmentStates.clear();
    fragmentTokens.clear();
    selected.clear();
    retiredSelection.clear();
    section.removeEventListener('click', onClick);
    section.removeEventListener('change', onChange);
    section.remove();
  }
}

/**
 * Identity the enrichment of one entry belongs to: its key, its typed target and its basic
 * information. A result that presents the same key with another target or other basic information
 * is another entry, whose fragments are read again instead of answering for the previous one.
 */
function entryIdentity(entry: UiListEntry): string {
  return JSON.stringify([entry.key, entry.target, entry.basic]);
}

/** One source page: at most the requested entries, their keys unique and their information read. */
function readCardListPage(
  value: unknown,
  pageSize: number,
):
  | { readonly ok: true; readonly page: UiListPage }
  | { readonly ok: false; readonly problem: string } {
  const page = readObject(value);
  const entries = page?.entries;
  if (page === null || !Array.isArray(entries)) {
    return unreadablePage('The list source did not report entries.');
  }
  if (entries.length > pageSize) {
    return unreadablePage(`The list source returned more than the ${pageSize} requested entries.`);
  }
  const continuation = page.continuation;
  if (continuation !== undefined && continuation !== null && typeof continuation !== 'string') {
    return unreadablePage('The list source reported an unreadable continuation.');
  }
  const read: UiListEntry[] = [];
  const keys = new Set<string>();
  for (const candidate of entries) {
    const entry = readEntry(candidate);
    if (entry === null) {
      return unreadablePage('The list source reported an unreadable entry.');
    }
    if (keys.has(entry.key)) {
      return unreadablePage('The list source reported one entry key twice.');
    }
    keys.add(entry.key);
    read.push(entry);
  }
  return {
    ok: true,
    page: {
      entries: read,
      continuation:
        typeof continuation === 'string' && continuation.length > 0 ? continuation : null,
    },
  };
}

function unreadablePage(problem: string): { readonly ok: false; readonly problem: string } {
  return { ok: false, problem };
}

function readEntry(value: unknown): UiListEntry | null {
  const entry = readObject(value);
  const key = entry?.key;
  const target = readTarget(entry?.target);
  if (
    entry === null ||
    typeof key !== 'string' ||
    key.length === 0 ||
    key.length > UI_LIMITS.entryKey ||
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
  return {
    key,
    target,
    basic,
    quantity,
  };
}

function readTarget(value: unknown): UiListEntry['target'] | null {
  const target = readObject(value);
  const kind = target?.kind;
  const id =
    kind === 'card'
      ? target?.cardId
      : kind === 'printing'
        ? target?.printingId
        : kind === 'copy'
          ? target?.copyId
          : undefined;
  if (typeof id !== 'string' || id.length === 0 || id.length > UI_LIMITS.entryKey) {
    return null;
  }
  switch (kind) {
    case 'card':
      return { kind: 'card', cardId: id };
    case 'printing':
      return { kind: 'printing', printingId: id };
    case 'copy':
      return { kind: 'copy', copyId: id };
    default:
      return null;
  }
}

function readBasic(value: unknown): UiListEntry['basic'] {
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

function readPrinting(value: unknown): UiEntryPrintingShape | null {
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

/** Shape of the basic printing information one entry carries. */
interface UiEntryPrintingShape {
  readonly printingId: string;
  readonly edition: string;
  readonly collectorNumber: string;
  readonly language: string;
}

function readQuantity(value: unknown): UiListEntry['quantity'] {
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
function readCount(value: unknown): number | null | undefined {
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** One fragment's outcome per requested key; unreadable answers fail instead of reading empty. */
function readFragmentResults(
  kind: UiFragmentKind,
  value: unknown,
): ReadonlyMap<string, FragmentState> {
  const states = new Map<string, FragmentState>();
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
  kind: UiFragmentKind,
  result: Readonly<Record<string, unknown>> | null,
): FragmentState | null {
  if (result === null) {
    return null;
  }
  switch (result.status) {
    case 'ready': {
      const values = readFragmentValues(kind, result.values);
      return values.ok
        ? { status: 'ready', values: values.values, message: null }
        : { status: 'failed', values: null, message: values.problem };
    }
    case 'absent':
      return { status: 'absent', values: null, message: null };
    case 'failed':
      return {
        status: 'failed',
        values: null,
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
  kind: UiFragmentKind,
  value: unknown,
):
  | { readonly ok: true; readonly values: unknown }
  | { readonly ok: false; readonly problem: string } {
  const unreadable = {
    ok: false as const,
    problem: `The ${uiFragmentLabel(kind)} response is not readable.`,
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
      return { ok: true, values: images as readonly UiEntryImage[] };
    }
    case 'ownership': {
      const ownership = readObject(value);
      const owned = readCount(ownership?.owned);
      const locations = readCount(ownership?.locations);
      if (ownership === null || typeof owned !== 'number' || locations === undefined) {
        return unreadable;
      }
      return { ok: true, values: { owned, locations } satisfies UiEntryOwnership };
    }
    case 'tags': {
      const tags = readItems(value as readonly unknown[]);
      if (tags === null) {
        return unreadable;
      }
      const read: UiEntryTag[] = [];
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
  return values.length <= UI_LIMITS.fragmentItems ? values : null;
}

function readOutcome(value: unknown): UiOperationOutcome {
  const outcome = readObject(value);
  const status = readOutcomeStatus(outcome?.status);
  const message = outcome?.message ?? null;
  if (status === null || (message !== null && typeof message !== 'string')) {
    // An unreadable answer carries no receipt either, so it reports no committed or failed outcome.
    return { status: 'unknown', message: null };
  }
  return { status, message };
}

function readOutcomeStatus(value: unknown): UiOperationOutcome['status'] | null {
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

function outcomeText(status: UiOperationOutcome['status']): string {
  switch (status) {
    case 'committed':
      return 'Saved.';
    case 'conflict':
      return 'The change conflicts with a newer version; review and retry.';
    case 'failed':
      return 'The action failed. Please retry.';
    case 'unknown':
      return 'The outcome is unknown; recover the recorded operation outcome.';
  }
}

function uiFragmentLabel(kind: UiFragmentKind): string {
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

function uiFragmentAbsent(kind: UiFragmentKind): string {
  return kind === 'tools' ? 'No tools available' : `No ${uiFragmentLabel(kind)}`;
}

function isFragmentKind(value: string): value is UiFragmentKind {
  return (uiFragmentKinds as readonly string[]).includes(value);
}

function readContainer(value: unknown): HTMLElement {
  const element = value as HTMLElement | null | undefined;
  if (
    typeof element !== 'object' ||
    element === null ||
    typeof element.ownerDocument !== 'object' ||
    element.ownerDocument === null ||
    typeof element.replaceChildren !== 'function' ||
    typeof element.append !== 'function'
  ) {
    throw new TypeError('The CardList renders into one supplied element.');
  }
  return element;
}

function readSource<Context>(value: unknown): UiListSource<Context> {
  const source = readObject(value);
  if (source === null || typeof source.load !== 'function') {
    throw new TypeError('The CardList reads its entries through one supplied source.');
  }
  return value as UiListSource<Context>;
}

function readPageSize(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > UI_LIMITS.listPage
  ) {
    throw new TypeError(`The CardList asks for 1 to ${UI_LIMITS.listPage} entries per page.`);
  }
  return value;
}

/**
 * Reads the state a page handed back to this list. An unreadable state is a page bug, not partial
 * input: the list refuses it instead of re-presenting a window nobody asked for. A state that names
 * no query keeps the context the list was created with; a page that hands back what `capture`
 * returned always names the query the list owns.
 */
function readRestoredState<Context>(
  value: unknown,
  pageSize: number,
  context: Context,
): UiCardListState<Context> | null {
  if (value === undefined || value === null) {
    return null;
  }
  const state = readObject(value);
  const window = state?.window;
  if (
    state === null ||
    typeof window !== 'number' ||
    !Number.isSafeInteger(window) ||
    window < 0 ||
    window > UI_LIMITS.listWindow
  ) {
    throw new TypeError('A retained list window names the entries it presented.');
  }
  const position = readRestoredPosition(state.position, pageSize);
  if ((window === 0) !== (position === null)) {
    throw new TypeError('A retained list window starts at the position of its first entry.');
  }
  const selection = state.selection;
  if (!Array.isArray(selection)) {
    throw new TypeError('A retained list selection names its entry keys.');
  }
  const keys: string[] = [];
  for (const key of selection) {
    if (typeof key !== 'string' || key.length === 0 || key.length > UI_LIMITS.entryKey) {
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
    context: restoredContext,
    position,
    window,
    selection: keys,
    selectedTargets: targets,
    scrollTop,
    focus: readRestoredFocus(state.focus),
  };
}

/** Typed targets one retained selection carried for the entries outside its window. */
function readSelectedTargets(value: unknown): readonly UiListSelectedTarget[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new TypeError('A retained list selection carries the typed targets of its entries.');
  }
  const targets: UiListSelectedTarget[] = [];
  for (const candidate of value) {
    const selectedTarget = readObject(candidate);
    const key = selectedTarget?.key;
    const target = readTarget(selectedTarget?.target);
    if (
      selectedTarget === null ||
      typeof key !== 'string' ||
      key.length === 0 ||
      key.length > UI_LIMITS.entryKey ||
      target === null
    ) {
      throw new TypeError('A retained list selection carries bounded entry targets.');
    }
    targets.push({ key, target });
  }
  return targets;
}

function readRestoredPosition(value: unknown, pageSize: number): UiListPosition | null {
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

function readRestoredFocus(value: unknown): UiListFocus | null {
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
      if (typeof id === 'string' && id.length > 0 && id.length <= UI_LIMITS.entryKey) {
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

function readFragments(value: unknown): ReadonlyMap<UiFragmentKind, UiFragmentReader<unknown>> {
  const readers = new Map<UiFragmentKind, UiFragmentReader<unknown>>();
  if (value === undefined) {
    return readers;
  }
  const record = readObject(value);
  if (record === null) {
    throw new TypeError('CardList fragments are supplied as one reader per kind.');
  }
  for (const kind of uiFragmentKinds) {
    const reader = record[kind];
    if (reader === undefined) {
      continue;
    }
    const candidate = readObject(reader);
    if (candidate === null || typeof candidate.read !== 'function') {
      throw new TypeError(`The ${kind} fragment is read through one supplied reader.`);
    }
    readers.set(kind, reader as UiFragmentReader<unknown>);
  }
  return readers;
}

function readTools(value: unknown): ReadonlyMap<string, UiCardListTool> {
  const tools = new Map<string, UiCardListTool>();
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
    tools.set(id, entry as UiCardListTool);
  }
  return tools;
}

function readPresentation(value: unknown): UiCardListPresentation {
  if (value === undefined) {
    return {};
  }
  const record = readObject(value);
  if (
    record === null ||
    (record.renderEntry !== undefined && typeof record.renderEntry !== 'function') ||
    (record.renderFragment !== undefined && typeof record.renderFragment !== 'function')
  ) {
    throw new TypeError('CardList presentation overrides rendering through functions.');
  }
  return value as UiCardListPresentation;
}

function readSignal(value: unknown): AbortSignal | undefined {
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

function readObject(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Readonly<Record<string, unknown>>;
}

function readMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}
