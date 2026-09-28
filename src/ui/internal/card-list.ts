/**
 * CardList presentation of the UserInterface (docs/card-list.md#interface).
 *
 * The UserInterface renders the headless CardList component: it mounts one list into the container
 * it owns, renders the snapshots the component publishes — entries with their basic information,
 * group controls for equivalent copies, the independent fragment states, the selection and the
 * paging and retry controls — and reports user intent back through the list's own contract.
 * Loading, windowing, enrichment scheduling, selection, recovery, freshness and restoration belong
 * to the component; this module owns the DOM, its focus and its scroll offset.
 *
 * The view reports the logical position it shows — its scroll offset and the control that holds
 * focus — whenever the user moves it, so the list retains a position it can restore without
 * keeping a DOM object. A restoration resolves with the position the previous visit retained; the
 * view applies it unless explicit user input already took the interaction over, and reports the
 * result back through the same contract.
 */

import { runAction } from './actions.js';
import type { UiOperationOutcome, UiListAction } from './actions.js';

import {
  cardListFragmentKinds,
  type CardList,
  type CardListChangeSource,
  type CardListEntry,
  type CardListEntryImage,
  type CardListEntryOwnership,
  type CardListEntrySnapshot,
  type CardListEntryTag,
  type CardListFocus,
  type CardListFragmentKind,
  type CardListFragmentReaders,
  type CardListFragmentState,
  type CardListOptions,
  type CardListRetained,
  type CardListSnapshot,
} from '../../card-list/index.js';

import { observeUiInput } from './interaction.js';

export type {
  CardListEntryImage as UiEntryImage,
  CardListEntryOwnership as UiEntryOwnership,
  CardListEntryTag as UiEntryTag,
} from '../../card-list/index.js';

/** Presentation adjustments over the default rendering of the list's information. */
export interface UiCardListPresentation {
  /** Content of one entry's basic information; null keeps the default rendering. */
  renderEntry?(entry: CardListEntry): Node | null;
  /** Content of one ready fragment; null keeps the default rendering for its kind. */
  renderFragment?(kind: CardListFragmentKind, entry: CardListEntry, values: unknown): Node | null;
}

export interface UiCardListOptions<Context = unknown> {
  /** Element the view renders into; it replaces the content and leaves with the page. */
  readonly container: HTMLElement;
  /**
   * Application-selected CardList implementation: the view describes the list it presents and the
   * supplied factory constructs it. Pages hand over the capability they received, so no UI module
   * names the component's own factory and a replacement needs no UI change
   * (docs/architecture.md#composition-and-replacement).
   */
  readonly create: UiCardListFactory;
  /** Source of the entries, their continuation and the query context. */
  readonly source: CardListOptions<Context>['source'];
  /** Query context of the active result. */
  readonly context: Context;
  /** Verified account the list belongs to; retained state is scoped to it. */
  readonly accountId: string;
  /** Entries one page asks for; from 1 to the component's declared page bound. */
  readonly pageSize: number;
  /** State a previous visit retained; the list restores it through its own source. */
  readonly restored?: CardListRetained<Context> | null;
  /** Fragment readers; kinds without one are not presented. */
  readonly fragments?: CardListFragmentReaders;
  /** Tools presented for the explicit selection, in order. */
  readonly tools?: readonly UiListAction[];
  /** Committed-change notifications of the account; the list reacquires affected content. */
  readonly changes?: CardListChangeSource;
  /** Presentation adjustments over the default rendering. */
  readonly presentation?: UiCardListPresentation;
  /** Aborted when the page closes; the view stops loading and drops late results. */
  readonly signal?: AbortSignal;
}

/** Creates one headless list over the description a page supplies. */
export type UiCardListFactory = <Context>(options: CardListOptions<Context>) => CardList<Context>;

/** One mounted list of the UserInterface: the component list plus its rendered presentation. */
export interface UiCardList<Context = unknown> {
  /** Current snapshot of the list, as the component publishes it. */
  snapshot(): CardListSnapshot<Context>;
  /** Entries of the loaded window, in source order. */
  readonly entries: readonly CardListEntry[];
  /** Selected keys in result order, including entries retired by paging beyond the window. */
  readonly selection: readonly string[];
  /** Selected keys whose presented entry no longer carries the identity the selection holds. */
  readonly unavailableSelection: readonly string[];
  /** Whether the active result continues past the loaded window and may be paged now. */
  readonly hasMore: boolean;
  /** Whether a window request is in flight. */
  readonly loading: boolean;
  /** Failure of the last window request, or null; the loaded window stays usable either way. */
  readonly error: string | null;
  /** State this list retains for the page's history entry; the page keeps it without decoding it. */
  capture(): CardListRetained<Context>;
  /** Lifecycle of restoring the state supplied in `restored`, or null when this visit had none. */
  readonly restoration: CardList<Context>['restoration'];
  /** Loads the next page of the active result; the window bound retires its oldest entries. */
  loadMore(): void;
  /** Starts a new result for `context`; usable content stays until the fresh page arrives. */
  refine(context: Context): void;
  /** Reloads the active result from its first page, keeping the window until it arrives. */
  refresh(): void;
  /** Repeats the failed request of the active result. */
  retry(): void;
  /** Re-reads one fragment of one entry. */
  reloadFragment(key: string, kind: CardListFragmentKind): void;
  /** Re-reads one kind across the active working set. */
  reloadFragments(kind: CardListFragmentKind): void;
  /** Marks one entry selected. */
  setSelected(key: string, selected: boolean): void;
  /** Unselects every entry. */
  clearSelection(): void;
  /** Invokes one tool for the explicit selection; null when nothing was invoked. */
  invoke(toolId: string): Promise<UiOperationOutcome | null>;
  /** Observes the list's own snapshots; the returned call stops delivery. */
  subscribe(listener: (snapshot: CardListSnapshot<Context>) => void): () => void;
  /** Releases the view and the list behind it. */
  dispose(): void;
}

/** One rendered entry and the elements the view updates in place. */
interface EntryRow {
  readonly row: HTMLLIElement;
  readonly checkbox: HTMLInputElement;
  readonly fragments: Map<CardListFragmentKind, HTMLElement>;
}

/** One presented group header and the entry keys its control toggles. */
interface GroupHeader {
  readonly checkbox: HTMLInputElement;
  readonly keys: readonly string[];
}

export function createCardListView<Context>(
  options: UiCardListOptions<Context>,
): UiCardList<Context> {
  const container = readContainer(options?.container);
  const presentation = readPresentation(options?.presentation);
  const pageSize = readPageSize(options?.pageSize);
  const document = container.ownerDocument;
  const tools = new Map<string, UiListAction>();
  for (const tool of options?.tools ?? []) {
    tools.set(tool.id, tool);
  }

  const section = document.createElement('section');
  section.dataset.uiCardList = '';
  const toolbar = document.createElement('div');
  toolbar.dataset.uiToolbar = '';
  const selectionCount = document.createElement('span');
  selectionCount.dataset.uiSelectionCount = '';
  selectionCount.setAttribute('aria-live', 'polite');
  toolbar.append(selectionCount);
  for (const [id, definition] of tools) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = definition.label;
    button.dataset.uiTool = id;
    button.disabled = true;
    toolbar.append(button);
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

  const list = options.create<Context>({
    source: options?.source,
    context: options?.context,
    accountId: options?.accountId,
    pageSize: options?.pageSize,
    ...(options?.restored === undefined ? {} : { restored: options.restored }),
    ...(options?.fragments === undefined ? {} : { fragments: options.fragments }),
    ...(options?.tools === undefined
      ? {}
      : { tools: options.tools.map(({ id, label }) => ({ id, label })) }),
    ...(options?.changes === undefined ? {} : { changes: options.changes }),
    ...(options?.signal === undefined ? {} : { signal: options.signal }),
  });
  const rows = new Map<string, EntryRow>();
  const groupHeaders = new Map<string, GroupHeader>();
  let renderedStructure = '';
  let renderedSelection = '';
  let renderedGeneration = -1;
  let renderedEntries = new Map<string, string>();
  let renderedFragments = new Map<string, CardListFragmentState>();
  let invocation: AbortController | null = null;
  let disposed = false;
  let pendingEditorFocus: (() => boolean) | null = null;
  const editorInteraction = new AbortController();
  const cancelEditorFocus = (): void => {
    pendingEditorFocus = null;
  };
  observeUiInput(document.defaultView, cancelEditorFocus, editorInteraction.signal);
  document.addEventListener('focusin', cancelEditorFocus, { signal: editorInteraction.signal });

  section.addEventListener('click', onClick);
  section.addEventListener('change', onChange);
  container.addEventListener('scroll', reportPosition);
  section.addEventListener('focusin', reportPosition);
  section.addEventListener('focusout', reportPosition);
  const unsubscribe = list.subscribe(render);
  const interaction = new AbortController();
  const restoration = list.restoration;
  if (restoration !== null) {
    // Explicit user input while the retained window is still loading takes the interaction over,
    // so the arriving window never moves the scroll offset or focus the user chose.
    observeUiInput(
      document.defaultView,
      () => list.reportPosition({ applied: false }),
      interaction.signal,
    );
    restoration.presented.then(
      (position) => {
        if (disposed) {
          return;
        }
        applyPosition(position);
        interaction.abort();
        reportPosition();
      },
      () => {
        interaction.abort();
      },
    );
  }
  render(list.snapshot());

  return {
    snapshot: () => list.snapshot(),
    get entries() {
      return list.snapshot().entries.map((entry) => entry.entry);
    },
    get selection() {
      return [...list.snapshot().selection.keys];
    },
    get unavailableSelection() {
      return [...list.snapshot().selection.unavailable];
    },
    get hasMore() {
      return list.snapshot().hasMore;
    },
    get loading() {
      return list.snapshot().loading;
    },
    get error() {
      return list.snapshot().error;
    },
    capture: () => {
      // The presentation holds the physical scroll offset and focus, so it reports them as the
      // page captures the state this history entry retains.
      reportPosition();
      return list.retain();
    },
    restoration,
    loadMore,
    refine: (context) => list.refine(context),
    refresh: () => list.refresh(),
    retry: () => list.retry(),
    reloadFragment: (key, kind) => list.reloadFragment(key, kind),
    reloadFragments: (kind) => list.reloadFragments(kind),
    setSelected: (key, selected) => list.setSelected(key, selected),
    clearSelection: () => list.clearSelection(),
    invoke,
    subscribe: (listener) => list.subscribe(listener),
    dispose,
  };

  /** Acquires the next page the presentation needs; the list keeps its own window bound. */
  function loadMore(): void {
    if (disposed) {
      return;
    }
    list.demand({ entries: list.snapshot().acquired + pageSize });
  }

  /** Invokes one tool for the explicit selection and presents the outcome it reports. */
  async function invoke(toolId: string): Promise<UiOperationOutcome | null> {
    if (disposed || invocation !== null) {
      return null;
    }
    const action = tools.get(toolId);
    if (
      action === undefined ||
      !list.snapshot().tools.some((tool) => tool.id === toolId && tool.available)
    ) {
      return null;
    }
    const controller = new AbortController();
    invocation = controller;
    renderTools(list.snapshot());
    const selection = list.actionContext();
    const outcome = await runAction(action, {
      targets: selection.targets,
      selection,
      signal: controller.signal,
    });
    if (disposed || invocation !== controller) {
      return null;
    }
    invocation = null;
    renderTools(list.snapshot());
    renderOutcome(outcome);
    return outcome;
  }

  /** Renders one published snapshot: the window, its fragments, its selection and its controls. */
  function render(snapshot: CardListSnapshot<Context>): void {
    if (disposed) {
      return;
    }
    pendingEditorFocus = preserveEditorFocus() ?? pendingEditorFocus;
    const structure = structureOf(snapshot);
    const generationChanged = snapshot.generation !== renderedGeneration;
    renderedGeneration = snapshot.generation;
    if (structure !== renderedStructure) {
      renderedStructure = structure;
      renderedFragments = new Map();
      renderedSelection = '';
      renderedEntries = new Map(
        snapshot.entries.map((entry) => [entry.entry.key, entrySignature(entry.entry)] as const),
      );
      renderWindow(snapshot);
    } else {
      // The window and its grouping stayed; an entry whose snapshot changed is rendered again in
      // place, so current quantities and the consumer's own content reach the DOM without
      // discarding the rest of the presentation (docs/card-list.md#interface).
      for (const entrySnapshot of snapshot.entries) {
        const key = entrySnapshot.entry.key;
        const signature = entrySignature(entrySnapshot.entry);
        if (renderedEntries.get(key) === signature) {
          continue;
        }
        renderedEntries.set(key, signature);
        renderEntryInPlace(entrySnapshot);
      }
      if (generationChanged) {
        // The source supplied the window again: content a consumer renders from outside the
        // snapshot — provider records, kept drafts — may have changed with it, so every fragment
        // is drawn again from the state the list now holds (docs/card-list.md#interface).
        renderedFragments.clear();
      }
    }
    renderFragments(snapshot);
    renderSelection(snapshot);
    renderTools(snapshot);
    renderStatus(snapshot);
    if (pendingEditorFocus?.()) pendingEditorFocus = null;
  }

  /** Identity of the rendered window and its grouping; entry content is not part of it. */
  function structureOf(snapshot: CardListSnapshot<Context>): string {
    return JSON.stringify([
      snapshot.groups.map((group) => [group.key, group.printingId, group.keys]),
      snapshot.entries.map((entry) => [
        entry.entry.key,
        // The kinds an entry presents decide which slots exist; their states are drawn in place.
        [...entry.fragments.keys()].sort(),
      ]),
    ]);
  }

  /**
   * Everything a rendered entry presents: its identity, basic information and quantity context.
   * The signature decides when the consumer's own entry content is rendered again.
   */
  function entrySignature(entry: CardListEntry): string {
    return JSON.stringify([entry.key, entry.target, entry.basic, entry.quantity]);
  }

  /**
   * Renders one entry again under the same window, keeping the keyboard focus of the control the
   * user holds and the rest of the rendered window untouched.
   */
  function renderEntryInPlace(entrySnapshot: CardListEntrySnapshot): void {
    const key = entrySnapshot.entry.key;
    const previous = rows.get(key);
    if (previous === undefined) {
      return;
    }
    const replacement = renderRow(entrySnapshot);
    previous.row.replaceWith(replacement);
    for (const kind of cardListFragmentKinds) {
      // The replaced row carries fresh slots, so their states are painted again.
      renderedFragments.delete(fragmentSlotKey(key, kind));
    }
    // The replaced checkbox carries no checked state; the selection is drawn again with it.
    renderedSelection = '';
  }

  function renderWindow(snapshot: CardListSnapshot<Context>): void {
    rows.clear();
    groupHeaders.clear();
    entriesHost.replaceChildren();
    const entries = new Map(snapshot.entries.map((entry) => [entry.entry.key, entry] as const));
    for (const group of snapshot.groups) {
      const members = group.keys.flatMap((key) => {
        const entry = entries.get(key);
        return entry === undefined ? [] : [entry];
      });
      if (members.length === 0) {
        continue;
      }
      entriesHost.append(
        members.length === 1 ? renderRow(members[0]!) : renderGroup(group, members),
      );
    }
  }

  function renderGroup(
    group: CardListSnapshot<Context>['groups'][number],
    members: readonly CardListEntrySnapshot[],
  ): HTMLLIElement {
    const first = members[0]!.entry;
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
    count.textContent = `${members.length} equivalent copies`;
    label.append(checkbox, basic, count);
    header.append(label);
    const nested = document.createElement('ul');
    nested.dataset.uiGroupEntries = '';
    for (const member of members) {
      nested.append(renderRow(member));
    }
    row.append(header, nested);
    groupHeaders.set(group.key, {
      checkbox,
      keys: members.map((member) => member.entry.key),
    });
    return row;
  }

  function renderRow(entrySnapshot: CardListEntrySnapshot): HTMLLIElement {
    const entry = entrySnapshot.entry;
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
    const fragments = new Map<CardListFragmentKind, HTMLElement>();
    if (entrySnapshot.fragments.size > 0) {
      const host = document.createElement('div');
      host.dataset.uiFragments = '';
      for (const kind of cardListFragmentKinds) {
        if (!entrySnapshot.fragments.has(kind)) {
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
    rows.set(entry.key, { row, checkbox, fragments });
    return row;
  }

  /** Draws the fragment state of every entry, skipping a state that did not change. */
  function renderFragments(snapshot: CardListSnapshot<Context>): void {
    for (const entrySnapshot of snapshot.entries) {
      for (const [kind, state] of entrySnapshot.fragments) {
        const slotKey = fragmentSlotKey(entrySnapshot.entry.key, kind);
        if (renderedFragments.get(slotKey) === state) {
          continue;
        }
        renderedFragments.set(slotKey, state);
        renderFragmentSlot(entrySnapshot.entry, kind, state);
      }
    }
  }

  function renderFragmentSlot(
    entry: CardListEntry,
    kind: CardListFragmentKind,
    state: CardListFragmentState,
  ): void {
    const slot = rows.get(entry.key)?.fragments.get(kind);
    if (slot === undefined) {
      return;
    }
    // Replacing the slot's content must not drop keyboard focus from the entry it belongs to.
    slot.replaceChildren();
    slot.dataset.uiState = state.status;
    paintFragmentSlot(entry, kind, state, slot);
  }

  /** Draws one fragment state into its own slot, which the caller has already cleared. */
  function paintFragmentSlot(
    entry: CardListEntry,
    kind: CardListFragmentKind,
    state: CardListFragmentState,
    slot: HTMLElement,
  ): void {
    if (state.status === 'loading') {
      slot.textContent = `Loading ${fragmentLabel(kind)}…`;
      return;
    }
    if (state.status === 'absent') {
      slot.textContent = fragmentAbsent(kind);
      return;
    }
    if (state.status === 'failed') {
      const message = document.createElement('span');
      message.dataset.uiFragmentMessage = '';
      message.textContent = `${fragmentLabel(kind)} unavailable: ${state.message}`;
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = 'Retry';
      retry.dataset.uiFragmentRetry = kind;
      retry.setAttribute('aria-label', `Retry ${fragmentLabel(kind)}`);
      slot.append(message, ' ', retry);
      return;
    }
    const overridden = presentation.renderFragment?.(kind, entry, state.values) ?? null;
    slot.append(overridden ?? renderFragmentValues(kind, state.values));
  }

  function renderFragmentValues(kind: CardListFragmentKind, values: unknown): Node {
    const content = document.createElement('span');
    content.dataset.uiFragmentValues = '';
    switch (kind) {
      case 'images': {
        const images = values as readonly CardListEntryImage[];
        if (images.length === 0) {
          content.textContent = fragmentAbsent(kind);
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
        const ownership = values as CardListEntryOwnership;
        content.textContent =
          ownership.locations === null
            ? `Owned: ${ownership.owned}`
            : `Owned: ${ownership.owned} · Locations: ${ownership.locations}`;
        break;
      }
      case 'tags': {
        const tags = values as readonly CardListEntryTag[];
        content.textContent =
          tags.length === 0 ? fragmentAbsent(kind) : tags.map((tag) => tag.name).join(', ');
        break;
      }
      case 'tools': {
        const available = values as readonly string[];
        content.textContent =
          available.length === 0
            ? fragmentAbsent(kind)
            : available.map((id) => tools.get(id)?.label ?? id).join(', ');
        break;
      }
    }
    return content;
  }

  function renderSelection(snapshot: CardListSnapshot<Context>): void {
    const signature = JSON.stringify(snapshot.selection.keys);
    if (signature === renderedSelection) {
      return;
    }
    renderedSelection = signature;
    const selected = new Set(snapshot.selection.keys);
    selectionCount.textContent = `${snapshot.selection.keys.length} selected`;
    for (const [key, row] of rows) {
      row.checkbox.checked = selected.has(key);
    }
    for (const header of groupHeaders.values()) {
      const chosen = header.keys.filter((key) => selected.has(key)).length;
      header.checkbox.checked = chosen === header.keys.length;
      header.checkbox.indeterminate = chosen > 0 && chosen < header.keys.length;
    }
  }

  function renderTools(snapshot: CardListSnapshot<Context>): void {
    for (const state of snapshot.tools) {
      const button = toolbar.querySelector<HTMLButtonElement>(`[data-ui-tool="${state.id}"]`);
      if (button !== null) {
        button.disabled = disposed || invocation !== null || !state.available;
      }
    }
  }

  function renderStatus(snapshot: CardListSnapshot<Context>): void {
    section.setAttribute('aria-busy', snapshot.loading ? 'true' : 'false');
    moreButton.hidden = !snapshot.hasMore;
    moreButton.disabled = snapshot.loading;
    // A delayed, failed or unavailable indexing status is explicit and recoverable: checking
    // again starts no business write and never resets the presented content
    // (docs/card-list.md#loading-and-recovery).
    retryButton.hidden =
      snapshot.error === null &&
      snapshot.freshness !== 'delayed' &&
      snapshot.freshness !== 'failed' &&
      snapshot.freshness !== 'unavailable';
    if (snapshot.error !== null) {
      statusLine.textContent = snapshot.error;
      statusLine.dataset.uiFreshness = snapshot.freshness;
      return;
    }
    statusLine.dataset.uiFreshness = snapshot.freshness;
    const parts: string[] = [];
    // Freshness is presented independently of the number of entries: an empty result that still
    // awaits known committed changes is updating, never a successful empty result
    // (docs/card-list.md#loading-and-recovery).
    if (snapshot.freshness === 'indexing') {
      parts.push('Results are still being indexed.');
    } else if (snapshot.freshness === 'delayed') {
      parts.push('Results are still being indexed; this is taking longer than expected.');
    } else if (snapshot.freshness === 'failed') {
      parts.push('Indexing failed; retry to check the results again.');
    } else if (snapshot.freshness === 'unavailable') {
      parts.push('The indexing status is unavailable; retry to check again.');
    } else if (snapshot.entries.length === 0) {
      // An updating result without usable entries is a retryable read, so this state only shows
      // while that read is pending or the result is a successful empty one.
      parts.push(snapshot.loading ? 'Loading…' : 'No entries');
    }
    if (snapshot.selection.unavailable.length > 0) {
      const unavailable = snapshot.selection.unavailable.length;
      parts.push(
        unavailable === 1
          ? '1 selected entry changed; select it again to act on the presented entry.'
          : `${unavailable} selected entries changed; select them again to act on the presented entries.`,
      );
    }
    statusLine.textContent = parts.join(' ');
  }

  function renderOutcome(outcome: UiOperationOutcome | null): void {
    if (outcome === null) {
      outcomeLine.textContent = '';
      outcomeLine.removeAttribute('data-ui-outcome-status');
      return;
    }
    outcomeLine.dataset.uiOutcomeStatus = outcome.status;
    outcomeLine.textContent = outcome.message ?? outcomeText(outcome.status);
  }

  function renderBasic(entry: CardListEntry): Node {
    return cardListBasicContent(document, entry);
  }

  /** Text one entry is announced by; it names the entry without its optional fragments. */
  function describeEntry(entry: CardListEntry): string {
    if (entry.basic === null) {
      return `unresolved ${entry.target.kind} entry`;
    }
    const printing = entry.basic.printing;
    return printing === null
      ? entry.basic.card.name
      : `${entry.basic.card.name} (${printing.edition} ${printing.collectorNumber})`;
  }

  /** Preserve the actual editor field after all replacement fragments have mounted. */
  function preserveEditorFocus(): (() => boolean) | null {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !entriesHost.contains(active)) return null;
    const focus = readEntryFocus();
    const row = active.closest<HTMLElement>('[data-ui-entry]');
    const path: number[] = [];
    let child: Element = active;
    while (row !== null && child !== row && child.parentElement !== null) {
      path.unshift([...child.parentElement.children].indexOf(child));
      child = child.parentElement;
    }
    const key = row?.dataset.uiEntry;
    const textField = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
    const field = textField || active instanceof HTMLSelectElement;
    const value = field ? active.value : null;
    const start = textField ? active.selectionStart : null;
    const end = textField ? active.selectionEnd : null;
    const direction = textField ? active.selectionDirection : null;
    return () => {
      if (document.activeElement === active) return true;
      if (key !== undefined && !rows.has(key)) return true;
      let replacement: Element | null = active.id ? document.getElementById(active.id) : null;
      if (replacement === null && active.id.length === 0 && key !== undefined) {
        replacement = rows.get(key)?.row ?? null;
        for (const index of path) replacement = replacement?.children.item(index) ?? null;
        if (replacement?.tagName !== active.tagName) replacement = null;
      }
      if (replacement instanceof HTMLElement && entriesHost.contains(replacement)) {
        if (
          value !== null &&
          (replacement instanceof HTMLInputElement ||
            replacement instanceof HTMLTextAreaElement ||
            replacement instanceof HTMLSelectElement)
        ) {
          replacement.value = value;
          if (start !== null && end !== null && !(replacement instanceof HTMLSelectElement))
            replacement.setSelectionRange(start, end, direction ?? undefined);
        }
        replacement.focus({ preventScroll: true });
        return true;
      }
      // Basic-information changes may temporarily remove the editor's fragment. Keep the
      // precise field, draft and selection until it mounts, unless input or focus takes over.
      if (focus === null || focus.control === 'element') return false;
      restoreEntryFocus(focus);
      return true;
    };
  }

  /** The control of one entry that holds keyboard focus, so a re-rendering of the window keeps it. */
  function readEntryFocus(): CardListFocus | null {
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
  function restoreEntryFocus(focus: CardListFocus | null): void {
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
      const key = focus.keys.find((candidate) => rows.has(candidate));
      if (key !== undefined) {
        const header = [...groupHeaders.values()].find((candidate) => candidate.keys.includes(key));
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

  /** Applies the logical position a restoration retained to this presentation. */
  function applyPosition(position: {
    readonly scrollTop?: number;
    readonly focus?: CardListFocus | null;
  }): void {
    restoreEntryFocus(position.focus ?? null);
    if (typeof position.scrollTop === 'number' && position.scrollTop > 0) {
      container.scrollTop = position.scrollTop;
    }
  }

  /** Reports the logical position this presentation shows to the list that retains it. */
  function reportPosition(): void {
    if (disposed) {
      return;
    }
    list.reportPosition({
      scrollTop: container.scrollTop,
      focus: readEntryFocus(),
    });
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
      list.retry();
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
      list.reloadFragment(row.getAttribute('data-ui-entry') ?? '', kind);
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
      list.setSelected(row.getAttribute('data-ui-entry') ?? '', input.checked);
      return;
    }
    const group = input.closest('[data-ui-group]');
    if (group !== null) {
      const header = groupHeaders.get(group.getAttribute('data-ui-group') ?? '');
      if (header !== undefined) {
        list.setGroupSelected(header.keys, input.checked);
      }
    }
  }

  function dispose(): void {
    if (disposed) {
      return;
    }
    disposed = true;
    invocation?.abort();
    invocation = null;
    unsubscribe();
    interaction.abort();
    editorInteraction.abort();
    pendingEditorFocus = null;
    section.removeEventListener('click', onClick);
    section.removeEventListener('change', onChange);
    container.removeEventListener('scroll', reportPosition);
    section.removeEventListener('focusin', reportPosition);
    section.removeEventListener('focusout', reportPosition);
    list.dispose();
    rows.clear();
    groupHeaders.clear();
    section.remove();
  }
}

/**
 * Basic information of one entry as the list presents it by default: the card name, the translated
 * or face name that matched, the printing of a printing or copy entry and the copy and intended
 * counts the source evaluated. A page that presents an entry as a link keeps this content as the
 * link's own content instead of rebuilding it.
 */
export function cardListBasicContent(document: Document, entry: CardListEntry): HTMLSpanElement {
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

/** One fragment kind's human label, used by the default fragment messages. */
function fragmentLabel(kind: CardListFragmentKind): string {
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

/** Identity of one rendered fragment slot inside its entry's row. */
function fragmentSlotKey(key: string, kind: CardListFragmentKind): string {
  return `${key}\u0000${kind}`;
}

/** What a definitive empty fragment presents. */
function fragmentAbsent(kind: CardListFragmentKind): string {
  return kind === 'tools' ? 'No tools available' : `No ${fragmentLabel(kind)}`;
}

/** Human text of one operation outcome, used when the outcome carries no message of its own. */
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

function isFragmentKind(value: string): value is CardListFragmentKind {
  return (cardListFragmentKinds as readonly string[]).includes(value);
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

function readPageSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('The CardList asks for a positive number of entries per page.');
  }
  return value;
}

function readPresentation(value: unknown): UiCardListPresentation {
  if (value === undefined) {
    return {};
  }
  const record = value as Readonly<Record<string, unknown>> | null;
  if (
    typeof record !== 'object' ||
    record === null ||
    (record.renderEntry !== undefined && typeof record.renderEntry !== 'function') ||
    (record.renderFragment !== undefined && typeof record.renderFragment !== 'function')
  ) {
    throw new TypeError('CardList presentation overrides rendering through functions.');
  }
  return value as UiCardListPresentation;
}
