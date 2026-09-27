/**
 * CardList of the UserInterface (docs/user-interface.md#list-boundary,
 * docs/user-interface.md#cardlist).
 *
 * CardList turns one supplied source into a bounded, asynchronous working set: the first page
 * loads when the list is constructed, further pages extend the window on demand, and a refresh or
 * refinement replaces the window while the usable content stays presented until the fresh page
 * arrives. Every response belongs to the request that asked for it, so a withdrawn request and an
 * obsolete page never replaces the active view, and closing the page a list belongs to cancels its
 * work (docs/user-interface.md#pages-and-navigation).
 *
 * Basic information renders with the entries. Images, ownership, tags and tool availability are
 * fragments: each kind loads and fails independently of the basic information and of the other
 * kinds, batched over the active window, and a failed fragment stays distinguishable from an empty
 * answer and is retried on demand. Equivalent copies group for convenient selection without losing
 * their individual identities, and the tools invoke the owning component's operation for the
 * explicit selection and report its outcome. Each list owns its query, loaded window, selection and
 * presentation state, so one page can present several independent lists.
 */

import { UI_LIMITS } from './limits.js';
import {
  uiFragmentKinds,
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

export interface UiCardListOptions<Context = unknown> {
  /** Element the list renders into; the list replaces its content and leaves with the page. */
  readonly container: HTMLElement;
  /** Source of the entries, their continuation and the query context. */
  readonly source: UiListSource<Context>;
  /** Query context of the active result. */
  readonly context: Context;
  /** Entries one page asks for; from 1 to UI_LIMITS.listPage. */
  readonly pageSize: number;
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
  /** Entries of the loaded window, in source order. */
  readonly entries: readonly UiListEntry[];
  /** Keys of loaded entries the user selected, in entry order. */
  readonly selection: readonly string[];
  /** Whether the active result continues past the loaded window. */
  readonly hasMore: boolean;
  /** Whether a window request is in flight. */
  readonly loading: boolean;
  /** Failure of the last window request, or null; the loaded window stays usable either way. */
  readonly error: string | null;
  /** Loads the next page of the active result. */
  loadMore(): void;
  /** Starts a new result for `context`; usable content stays until the fresh page arrives. */
  refine(context: Context): void;
  /** Reloads the active result from its first page, keeping the window until it arrives. */
  refresh(): void;
  /** Repeats the failed request of the active result. */
  retry(): void;
  /** Re-reads one fragment of one entry; the entry's other fragments stay unchanged. */
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

export function createCardList<Context>(options: UiCardListOptions<Context>): UiCardList<Context> {
  const container = readContainer(options?.container);
  const source = readSource<Context>(options?.source);
  const pageSize = readPageSize(options?.pageSize);
  const readers = readFragments(options?.fragments);
  const tools = readTools(options?.tools);
  const presentation = readPresentation(options?.presentation);
  const signal = readSignal(options?.signal);
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
  const fragmentQueues = new Map<
    UiFragmentKind,
    { readonly pending: Set<string>; controller: AbortController | null }
  >();
  const selected = new Set<string>();
  let entries: readonly UiListEntry[] = [];
  let windowKeys: ReadonlySet<string> = new Set();
  let activeContext = options.context;
  let continuation: string | null = null;
  let hasMore = false;
  let loading = false;
  let error: string | null = null;
  let outcome: UiOperationOutcome | null = null;
  let pending: AbortController | null = null;
  let invocation: AbortController | null = null;
  let failed: { readonly continuation: string | null } | null = null;
  let generation = 0;
  let disposed = false;

  renderStatus();
  renderSelection();
  renderOutcome();
  if (signal !== undefined && signal.aborted) {
    dispose();
  } else {
    signal?.addEventListener('abort', () => dispose());
    startRequest(null);
  }

  return {
    get entries() {
      return [...entries];
    },
    get selection() {
      return selectedKeys();
    },
    get hasMore() {
      return hasMore;
    },
    get loading() {
      return loading;
    },
    get error() {
      return error;
    },
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
   * dropped instead of replacing the view the user now sees.
   */
  function startRequest(nextContinuation: string | null): void {
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
      settleFailure(current, nextContinuation, readMessage(cause, 'The list could not load.'));
      return;
    }
    Promise.resolve(request).then(
      (page) => settlePage(current, nextContinuation, page),
      (cause) =>
        settleFailure(current, nextContinuation, readMessage(cause, 'The list could not load.')),
    );
  }

  function settlePage(current: number, requested: string | null, value: unknown): void {
    if (disposed || current !== generation) {
      return;
    }
    const read = readCardListPage(value, pageSize);
    if (!read.ok) {
      settleFailure(current, requested, read.problem);
      return;
    }
    pending = null;
    loading = false;
    error = null;
    failed = null;
    if (requested === null) {
      setWindow(read.page.entries);
    } else {
      appendWindow(read.page.entries);
    }
    continuation = read.page.continuation;
    hasMore = continuation !== null;
    renderStatus();
    requestFragments();
  }

  function settleFailure(current: number, requested: string | null, message: string): void {
    if (disposed || current !== generation) {
      return;
    }
    pending = null;
    loading = false;
    error = message;
    failed = { continuation: requested };
    renderStatus();
  }

  /** Replaces the window; entries the new result no longer holds leave it. */
  function setWindow(next: readonly UiListEntry[]): void {
    entries = [...next];
    windowKeys = new Set(entries.map((entry) => entry.key));
    for (const key of [...fragmentStates.keys()]) {
      if (!windowKeys.has(key)) {
        fragmentStates.delete(key);
      }
    }
    renderEntries();
  }

  /** Extends the window; an entry key the window already holds arrives once. */
  function appendWindow(next: readonly UiListEntry[]): void {
    const known = new Set(windowKeys);
    const added = next.filter((entry) => !known.has(entry.key));
    if (added.length === 0) {
      return;
    }
    entries = [...entries, ...added];
    windowKeys = new Set(entries.map((entry) => entry.key));
    renderEntries();
  }

  function loadMore(): void {
    if (disposed || loading || !hasMore || continuation === null) {
      return;
    }
    startRequest(continuation);
  }

  function refresh(): void {
    startRequest(null);
  }

  function refine(next: Context): void {
    if (disposed) {
      return;
    }
    activeContext = next;
    outcome = null;
    renderOutcome();
    startRequest(null);
  }

  function retry(): void {
    if (disposed || failed === null) {
      return;
    }
    startRequest(failed.continuation);
  }

  function setSelected(key: string, selectedNow: boolean): void {
    if (disposed || typeof key !== 'string' || key.length === 0) {
      return;
    }
    if (selectedNow) {
      selected.add(key);
    } else {
      selected.delete(key);
    }
    renderSelection();
  }

  function clearSelection(): void {
    if (disposed || selected.size === 0) {
      return;
    }
    selected.clear();
    renderSelection();
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

  /** Keys of the loaded window the user selected, in entry order. */
  function selectedKeys(): readonly string[] {
    return entries.filter((entry) => selected.has(entry.key)).map((entry) => entry.key);
  }

  /** Whether one tool acts on the whole selection: every selected entry reports it available. */
  function toolAvailable(id: string): boolean {
    const keys = selectedKeys();
    if (keys.length === 0) {
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
    const targets = chosen.map((entry) => entry.target);
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
    try {
      return readOutcome(await tool.invoke(request));
    } catch (cause) {
      return { status: 'failed', message: readMessage(cause, 'The action failed.') };
    }
  }

  function renderEntries(): void {
    rows.clear();
    groupHeaders.clear();
    entriesHost.replaceChildren();
    for (const group of groupCardListEntries(entries)) {
      entriesHost.append(
        group.entries.length === 1 ? renderRow(group.entries[0]!) : renderGroup(group),
      );
    }
    renderSelection();
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
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.uiSelect = entry.key;
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
    const keys = selectedKeys();
    selectionCount.textContent = `${keys.length} selected`;
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
    moreButton.hidden = !hasMore;
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
      for (const key of windowKeys) {
        if (fragmentState(key, kind) === null) {
          setFragmentState(key, kind, { status: 'loading', values: null, message: null });
          queue.pending.add(key);
        }
      }
      pumpFragments(kind);
    }
  }

  function reloadFragment(key: string, kind: UiFragmentKind): void {
    if (disposed || !windowKeys.has(key) || !readers.has(kind)) {
      return;
    }
    setFragmentState(key, kind, { status: 'loading', values: null, message: null });
    fragmentQueue(kind).pending.add(key);
    pumpFragments(kind);
  }

  /** One in-flight request per kind; keys requested meanwhile are read after it settles. */
  function pumpFragments(kind: UiFragmentKind): void {
    const queue = fragmentQueue(kind);
    const reader = readers.get(kind);
    if (disposed || reader === undefined || queue.controller !== null || queue.pending.size === 0) {
      return;
    }
    const keys = [...queue.pending];
    queue.pending.clear();
    const controller = new AbortController();
    queue.controller = controller;
    const finish = (): void => {
      queue.controller = null;
      pumpFragments(kind);
    };
    let request: Promise<readonly UiFragmentResult<unknown>[]>;
    try {
      request = reader.read({ keys, information: [kind], signal: controller.signal });
    } catch (cause) {
      applyFragmentFailure(kind, keys, readMessage(cause, 'The fragment could not load.'));
      finish();
      return;
    }
    Promise.resolve(request).then(
      (results) => {
        applyFragmentResults(kind, keys, results);
        finish();
      },
      (cause) => {
        applyFragmentFailure(kind, keys, readMessage(cause, 'The fragment could not load.'));
        finish();
      },
    );
  }

  function applyFragmentResults(
    kind: UiFragmentKind,
    keys: readonly string[],
    results: unknown,
  ): void {
    if (disposed) {
      return;
    }
    const read = readFragmentResults(kind, results);
    for (const key of keys) {
      // A key requested again while the response was in flight is read by the queued request.
      if (!windowKeys.has(key) || fragmentQueue(kind).pending.has(key)) {
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
    keys: readonly string[],
    message: string,
  ): void {
    if (disposed) {
      return;
    }
    for (const key of keys) {
      if (windowKeys.has(key)) {
        setFragmentState(key, kind, { status: 'failed', values: null, message });
      }
    }
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

  function fragmentQueue(kind: UiFragmentKind): {
    readonly pending: Set<string>;
    controller: AbortController | null;
  } {
    let queue = fragmentQueues.get(kind);
    if (queue === undefined) {
      queue = { pending: new Set(), controller: null };
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
    const state = fragmentState(key, kind) ?? {
      status: 'loading' as const,
      values: null,
      message: null,
    };
    slot.replaceChildren();
    slot.dataset.uiState = state.status;
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
    generation += 1;
    pending?.abort();
    pending = null;
    invocation?.abort();
    invocation = null;
    for (const queue of fragmentQueues.values()) {
      queue.controller?.abort();
      queue.controller = null;
      queue.pending.clear();
    }
    entries = [];
    windowKeys = new Set();
    rows.clear();
    groupHeaders.clear();
    fragmentStates.clear();
    selected.clear();
    section.removeEventListener('click', onClick);
    section.removeEventListener('change', onChange);
    section.remove();
  }
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
    key.length > UI_LIMITS.restorationText ||
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
  if (typeof id !== 'string' || id.length === 0 || id.length > UI_LIMITS.restorationText) {
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
    return { status: 'failed', message: 'The operation reported an unreadable outcome.' };
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
