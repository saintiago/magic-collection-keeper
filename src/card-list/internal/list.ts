/**
 * The headless list (docs/card-list.md#internal-design, docs/card-list.md#loading-and-recovery,
 * docs/card-list.md#selection-and-restoration).
 *
 * One list turns a supplied source into a bounded, asynchronous working window: the first page is
 * acquired when the list is constructed, further entries arrive on viewport demand while the oldest
 * entries beyond the window bound leave it (with selected targets kept separately for tools), and a
 * refresh or refinement replaces the window while usable content stays until the fresh page
 * arrives. Every response belongs to the request that asked for it, so a withdrawn request or an
 * obsolete page never replaces the active window, and disposing the list cancels its work.
 *
 * The list also owns read recovery: a source answer that reports the requested sequence as
 * invalidated restarts it from its first page, keeping the presented window, selection and
 * consumer drafts until the replacement arrives, never appending the new sequence to the rejected
 * one and leaving no position of the rejected sequence capturable. A read that merely failed
 * temporarily keeps the position it asked for, and `retry` repeats that position — or the first
 * page of a restart that failed — without an automatic retry loop.
 *
 * Basic information arrives with the entries. Images, ownership, tags and tool availability are
 * fragments: each kind loads and fails independently of the basic information and of the other
 * kinds, read in bounded batches over the active window and selected tool targets. A failed
 * fragment stays distinguishable from an empty answer and is retried on demand. Equivalent copies
 * group for convenient selection without losing their individual identities, and a tool runs
 * against the explicit selection and reports the owning component's outcome; an invocation without
 * a receipt is unknown, never a definite failure.
 *
 * Each list owns its retention and restoration: its consumer keeps the opaque handle `retain`
 * returns, hands it back when the history entry returns, and the list decides how to re-acquire the
 * window it held. Until the retained window is back the list keeps the intended state instead of
 * capturing the partially loaded one, and explicit user input reported by the presentation
 * supersedes the retained interaction.
 *
 * A local committed change marks affected content stale: the list records the publication position
 * the change reported as awaiting indexing, reacquires the active result with that position
 * required, and keeps usable content labelled as updating until the source incorporated it
 * (docs/card-list.md#loading-and-recovery).
 */

import { CARD_LIST_LIMITS } from './limits.js';
import {
  cardListFragmentKinds,
  type CardList,
  type CardListChange,
  type CardListChangeSource,
  type CardListEntry,
  type CardListFocus,
  type CardListFragmentKind,
  type CardListFragmentReader,
  type CardListFragmentState,
  type CardListGroup,
  type CardListOperationOutcome,
  type CardListOptions,
  type CardListPage,
  type CardListPosition,
  type CardListPositionReport,
  type CardListRequiredProgress,
  type CardListRestoration,
  type CardListRetained,
  type CardListSnapshot,
  type CardListTool,
  type CardListToolRequest,
  type CardListToolSelection,
  type CardListViewportDemand,
} from './contract.js';
import {
  readAccountId,
  readCardListRead,
  readDemand,
  readFragments,
  readFragmentResults,
  readMessage,
  readObject,
  readOutcome,
  readPageSize,
  readRetainedState,
  readSignal,
  readSource,
  readTools,
  retainedHandle,
  type RetainedState,
} from './reader.js';

/** One fragment read in flight: the entries it asked about and the read token of each of them. */
interface FragmentRequest {
  readonly kind: CardListFragmentKind;
  readonly keys: readonly string[];
  readonly tokens: ReadonlyMap<string, number>;
  readonly controller: AbortController;
}

/** One fragment kind's work: the entries waiting for their turn and the read in flight. */
interface FragmentQueue {
  readonly pending: Set<string>;
  active: FragmentRequest | null;
}

export function createCardList<Context>(options: CardListOptions<Context>): CardList<Context> {
  const source = readSource<Context>(options?.source);
  const pageSize = readPageSize(options?.pageSize);
  const accountId = readAccountId(options?.accountId);
  const readers = readFragments(options?.fragments);
  const tools = readTools(options?.tools);
  const signal = readSignal(options?.signal);
  const restored = readRetainedState<Context>(
    options?.restored,
    accountId,
    pageSize,
    options?.context,
  );
  const changes = readChangeSource(options?.changes);

  const fragmentStates = new Map<string, Map<CardListFragmentKind, CardListFragmentState>>();
  /** Read token of one entry's outstanding fragment read of one kind; absent when there is none. */
  const fragmentTokens = new Map<string, Map<CardListFragmentKind, number>>();
  const fragmentQueues = new Map<CardListFragmentKind, FragmentQueue>();
  /** Fragment kinds the presentation asked to see; every bound kind until a demand narrows it. */
  let demandedKinds: ReadonlySet<CardListFragmentKind> = new Set(readers.keys());
  const selected = new Set<string>();
  for (const key of restored?.selection ?? []) {
    selected.add(key);
  }
  /**
   * Explicit targets survive paging and restoration; only their tool availability remains part of
   * fragment work.
   */
  const retiredSelection = new Map<string, CardListEntry['target']>();
  for (const selectedTarget of restored?.selectedTargets ?? []) {
    if (selected.has(selectedTarget.key)) {
      retiredSelection.set(selectedTarget.key, selectedTarget.target);
    }
  }
  /**
   * Source position of every entry of the presented window. Positions leave with their entries, so
   * even very deep paging retains at most one window.
   */
  const positions = new Map<string, CardListPosition>();
  /**
   * Start of the replacement sequence a restart reads after the source invalidated the sequence the
   * presented window came from, or null while the window holds the position of its own sequence.
   * The replacement's first page clears it and records the positions it begins.
   */
  let restartPosition: CardListPosition | null = null;
  /**
   * The window one visit restores until the source presented it again, or null once it has; while
   * it is set, the list reports it instead of the partially loaded window.
   */
  let kept: RetainedState<Context> | null =
    restored !== null && restored.window > 0 ? restored : null;
  const settled = kept === null ? null : Promise.withResolvers<CardListPositionReport>();
  // The consumer reports the outcome through its own lifecycle; one that never reads it must still
  // not surface the list's interruption as an unhandled rejection.
  settled?.promise.catch(() => {});
  let entries: readonly CardListEntry[] = [];
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
   * and scroll.
   */
  let interactionTaken = false;
  /** Logical position the presentation reported; the list never reads a DOM object itself. */
  let reportedScrollTop = 0;
  let reportedFocus: CardListFocus | null = null;
  /** Committed positions the presented result still awaits incorporation of. */
  let awaiting: readonly string[] = [];
  /** Entries the viewport demanded, as far as the list has acquired them. */
  let demandedEntries = 0;
  /** Entries the active sequence has supplied, including those the window bound retired. */
  let acquiredEntries = 0;
  /** Whether the last appended page added nothing, so acquiring stops until a new demand. */
  let stalled = false;
  let loading = false;
  let error: string | null = null;
  let pending: AbortController | null = null;
  let invocation: AbortController | null = null;
  let failed: { readonly continuation: string | null; readonly offset: number } | null = null;
  let generation = 0;
  /** Generation of the presented window, advanced whenever the source supplied entries again. */
  let windowGeneration = 0;
  let fragmentSequence = 0;
  let disposed = false;
  let published: CardListSnapshot<Context> | null = null;
  const listeners = new Set<(snapshot: CardListSnapshot<Context>) => void>();

  publish();
  const unsubscribeChanges =
    changes === null ? null : changes.subscribe((change) => changed(change));
  if (signal !== undefined && signal.aborted) {
    dispose();
  } else {
    signal?.addEventListener('abort', () => dispose());
    const start = kept?.position ?? null;
    startRequest(start?.continuation ?? null, start?.offset ?? 0);
  }

  return {
    snapshot,
    subscribe,
    retain,
    restoration: settled === null ? null : restoration(),
    demand,
    refine,
    refresh,
    retry,
    reloadFragment,
    reloadFragments,
    setSelected,
    setGroupSelected,
    clearSelection,
    actionContext,
    invoke,
    changed,
    reportPosition,
    release,
    dispose,
  };

  /** The immutable value every observer reads; it changes only when published. */
  function snapshot(): CardListSnapshot<Context> {
    return published ?? buildSnapshot();
  }

  function subscribe(listener: (snapshot: CardListSnapshot<Context>) => void): () => void {
    if (typeof listener !== 'function') {
      throw new TypeError('A CardList subscriber is a function.');
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  /** One supplied change source, or null when the consumer forwards notifications itself. */
  function readChangeSource(value: unknown): CardListChangeSource | null {
    if (value === undefined) {
      return null;
    }
    const source = readObject(value);
    if (source === null || typeof source.subscribe !== 'function') {
      throw new TypeError('CardList changes are observed through one supplied source.');
    }
    return value as CardListChangeSource;
  }

  /** Publishes the current state to every observer; a disposed list publishes nothing again. */
  function publish(): void {
    if (disposed) {
      return;
    }
    published = buildSnapshot();
    if (listeners.size === 0) {
      return;
    }
    for (const listener of [...listeners]) {
      try {
        listener(published);
      } catch {
        // An observer that throws never breaks the list work it observes.
      }
    }
  }

  function buildSnapshot(): CardListSnapshot<Context> {
    const entriesSnapshot = entries.map((entry) => ({
      entry,
      fragments: new Map(fragmentStates.get(entry.key) ?? []),
    }));
    return {
      context: activeContext,
      entries: entriesSnapshot,
      groups: groupWindow(entries),
      selection: { keys: selectedKeys(), targets: selectedTargets() },
      tools: [...tools].map(([id, definition]) => ({
        id,
        label: definition.label,
        available: toolAvailable(id),
        running: invocation !== null,
      })),
      loading,
      error,
      hasMore: pagingAvailable(),
      empty: entries.length === 0 && !loading && error === null && awaiting.length === 0,
      acquired: acquiredEntries,
      generation: windowGeneration,
      awaiting: [...awaiting],
    };
  }

  /**
   * Explicit action context of the current selection: the keys the list reports and the typed
   * targets aligned with them, including entries the loaded window no longer presents. A key the
   * list holds without a target yet is not part of the report, and `toolAvailable` refuses a
   * selection that names one, so an invocation never acts on a subset.
   */
  function actionContext(): CardListToolSelection {
    return { keys: selectedKeys(), targets: selectedTargets() };
  }

  /** Lifecycle of this visit's restoration; it stays the same promise for the list's lifetime. */
  function restoration(): CardListRestoration {
    return {
      presented: settled!.promise,
    };
  }

  /**
   * Requests one page of the active result. A request the user still waits for is the active one:
   * starting another withdraws it, and its late response belongs to a closed request and is
   * dropped instead of replacing the window the user now sees. `offset` skips the entries before
   * the retained position of one restoring window; it applies to the first page of that position
   * only.
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
    publish();
    let request: Promise<unknown>;
    try {
      request = source.load({
        context: activeContext,
        pageSize,
        continuation: nextContinuation,
        signal: controller.signal,
        required: requiredProgress(),
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
      (read) => settleRead(current, nextContinuation, offset, read),
      (cause) =>
        settleFailure(
          current,
          nextContinuation,
          offset,
          readMessage(cause, 'The list could not load.'),
        ),
    );
  }

  /**
   * Committed progress a read should incorporate. A query source passes the positions to its
   * provider's freshness read; a source whose reads are already authoritative ignores them.
   */
  function requiredProgress(): CardListRequiredProgress {
    return { positions: [...awaiting] };
  }

  /**
   * Accepts one source answer. A report that the requested sequence was invalidated restarts the
   * sequence from its first page, so the rejected continuation is never repeated, while the
   * presented window, the selection and the consumer's drafts stay until the replacement arrives
   * and no position of the rejected sequence stays capturable. A report that names no
   * continuation cannot restart anything, so it fails at the position it asked for and `retry`
   * repeats it.
   */
  function settleRead(
    current: number,
    requested: string | null,
    offset: number,
    value: unknown,
  ): void {
    if (disposed || current !== generation) {
      return;
    }
    const read = readCardListRead(value, pageSize);
    if (read.status === 'invalidated') {
      if (requested === null) {
        settleFailure(current, requested, offset, 'The list changed while it was read.');
        return;
      }
      // The answer arrived and is dropped with its sequence; the restart asks again from the
      // beginning of the result rather than from the continuation the source rejected, and the
      // rejected sequence leaves nothing a later visit could be sent back to.
      pending = null;
      forgetSequence();
      startRequest(null);
      return;
    }
    if (read.status === 'unreadable') {
      settleFailure(current, requested, offset, read.problem);
      return;
    }
    settlePage(current, requested, offset, read.page);
  }

  function settlePage(
    current: number,
    requested: string | null,
    offset: number,
    page: CardListPage,
  ): void {
    if (disposed || current !== generation) {
      return;
    }
    pending = null;
    loading = false;
    error = null;
    failed = null;
    const supplied = page.entries;
    const presented = offset === 0 ? supplied : supplied.slice(offset);
    windowGeneration += 1;
    // A page requested without a continuation replaced the presented window with the beginning of
    // the sequence it belongs to, so the retained window is measured against that sequence's
    // progress from zero; a page that extends the window is measured against the length the window
    // reached before the page arrived. Comparing the replacement's length against the length of
    // the sequence it replaced would treat an equally sized replacement as no progress at all.
    const baseline = requested === null ? 0 : entries.length;
    if (requested === null) {
      // The fresh first page belongs to the active query and begins its sequence, so nothing older
      // stays paged and the recorded positions are this sequence's own. A retained window being
      // re-acquired keeps the action context the state carried, while a result that replaced
      // another exposes its selected keys as they are found again.
      staleWindow = false;
      restartPosition = null;
      setWindow(presented, kept !== null);
      acquiredEntries = presented.length;
      // The replacement begins a new sequence: a demand the previous sequence had not reached is
      // superseded with it, and the presentation demands its range again for the new result.
      demandedEntries = 0;
      stalled = false;
    } else {
      const added = appendWindow(presented);
      acquiredEntries += added;
      // A page that adds nothing ends this demand; a later demand may still ask for more.
      stalled = added === 0;
    }
    rememberPositions(requested, supplied);
    continuation = page.continuation;
    continues = continuation !== null;
    // The result is current once the source incorporated the positions the read required; an
    // updating page keeps them labelled instead of presenting content as caught up.
    if (page.current) {
      awaiting = [];
    }
    publish();
    requestFragments();
    if (kept !== null) {
      restoreWindow(baseline);
      return;
    }
    acquireDemanded();
  }

  /**
   * Forgets the source positions of a sequence the source rejected. The restart re-reads the
   * result from its beginning, so the window the list presents is re-acquired from there until the
   * replacement's first page records its own positions: neither the retained window's position nor
   * a presented entry's recorded position may name a rejected continuation when the list is
   * retained and reacquired. Usable content, the intended window size and the interaction state
   * stay.
   */
  function forgetSequence(): void {
    positions.clear();
    const start: CardListPosition = { continuation: null, offset: 0 };
    restartPosition = start;
    if (kept !== null) {
      kept = { ...kept, position: start };
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
    publish();
    if (kept !== null) {
      // The retained window could not be presented; the consumer reports the interruption and the
      // intended state stays retained, so leaving and returning retries it.
      settled?.reject(new Error(message));
    }
  }

  /**
   * Keeps loading the retained window from its own source position until the list presented the
   * intended number of entries again, the result ends or a page of the replacement sequence adds
   * nothing: the source stays authoritative for membership and continuation, so a shorter result
   * presents what it holds. `baseline` is the window length the previous page of the sequence being
   * acquired left, so progress is evaluated inside that sequence rather than against a sequence a
   * restart discarded.
   */
  function restoreWindow(baseline: number): void {
    const window = kept;
    if (window === null) {
      return;
    }
    if (entries.length >= window.window || continuation === null || entries.length === baseline) {
      presentWindow(window);
      return;
    }
    startRequest(continuation);
  }

  /**
   * The retained window is back: the list reports the presentation with the logical position the
   * consumer applies. The retained interaction is applied only while the user has not taken it
   * over, and the presented window now decides the paging control the list offers.
   */
  function presentWindow(window: RetainedState<Context>): void {
    kept = null;
    publish();
    settled?.resolve(interactionTaken ? { scrollTop: 0, focus: null } : positionOfRetained(window));
  }

  function positionOfRetained(window: RetainedState<Context>): CardListPositionReport {
    return { scrollTop: window.scrollTop, focus: window.focus };
  }

  /** Replaces the window; entries the new result no longer holds leave it. */
  function setWindow(next: readonly CardListEntry[], keepingTargets = false): void {
    // A replacement result exposes selected keys as they are found again, as with other retained
    // selection keys; only paging and a retained window being re-acquired carry explicit action
    // context beyond the presented window.
    if (!keepingTargets) {
      clearRetiredSelection();
    }
    applyWindow(next);
  }

  /** Extends the window; an entry key the window already holds arrives once. */
  function appendWindow(next: readonly CardListEntry[]): number {
    const known = new Set(windowKeys);
    const added = next.filter((entry) => !known.has(entry.key));
    if (added.length === 0) {
      return 0;
    }
    const combined = [...entries, ...added];
    for (const entry of combined.slice(0, -CARD_LIST_LIMITS.window)) {
      if (selected.has(entry.key)) {
        retiredSelection.set(entry.key, entry.target);
      }
    }
    applyWindow(combined);
    return added.length;
  }

  /**
   * Records where in the source result the entries of one page sit, so the window the list presents
   * can be requested again from its own position. Only the presented window keeps positions, and a
   * replacement result replaces them: the source owns ordering, so an entry a fresh result moved
   * sits at its new position instead of the one the previous result recorded.
   */
  function rememberPositions(requested: string | null, supplied: readonly CardListEntry[]): void {
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
   * State this list retains for the consumer's history entry. While a restoration is still loading
   * it is the state the list is restoring — the intended window, never the partial one — with the
   * selection and logical position the consumer reported in the meantime. A refinement that
   * superseded the presented window retains the query the list intends, whose first page has not
   * arrived yet, so the retained position always belongs to the retained query. A restart under way
   * retains the beginning of the sequence it reads instead of any position of the one the source
   * rejected.
   */
  function retain(): CardListRetained<Context> {
    const window = kept;
    const retainedInteraction = {
      selection: [...selected],
      selectedTargets: [...retiredSelection].map(([key, target]) => ({ key, target })),
      // While the retained window is still loading the presentation holds no applied offset: the
      // state keeps the retained one unless the user scrolled it or took the interaction over.
      scrollTop:
        window !== null && !interactionTaken && reportedScrollTop === 0
          ? window.scrollTop
          : reportedScrollTop,
      focus: reportedFocus ?? (interactionTaken ? null : (window?.focus ?? null)),
    };
    const first = entries[0];
    const state: RetainedState<Context> = {
      kind: 'card-list-retained',
      accountId,
      context: activeContext,
      position: staleWindow
        ? null
        : (window?.position ??
          restartPosition ??
          (first === undefined ? null : (positions.get(first.key) ?? null))),
      window: staleWindow ? 0 : (window?.window ?? entries.length),
      ...retainedInteraction,
    };
    return retainedHandle(state);
  }

  /**
   * Presents one window, bounded to the list's window bound. The oldest entries beyond the bound
   * leave the window regardless of selection; paging retains selected action context separately, so
   * selection never hides further results. Enrichment follows the entry it was read for: entries
   * that leave or change retire their fragments and outstanding reads. Only tool availability
   * remains needed for selected targets retired by paging.
   */
  function applyWindow(next: readonly CardListEntry[]): void {
    const previous = new Map(entries.map((entry) => [entry.key, entryIdentity(entry)] as const));
    entries = next.slice(-CARD_LIST_LIMITS.window);
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
    publish();
  }

  /**
   * Reports the visible range and the fragment kinds it needs. The list acquires further pages
   * until it holds the demanded entries or the result ends, and reads exactly the demanded kinds
   * for the presented window: bounded content and enrichment work instead of a request per row.
   */
  function demand(request: CardListViewportDemand): void {
    if (disposed) {
      return;
    }
    const read = readDemand(request);
    if (read.information !== null) {
      const kinds = read.information.filter((kind) => readers.has(kind));
      demandedKinds = new Set(kinds);
      requestFragments();
      publish();
    }
    demandedEntries = Math.max(demandedEntries, read.entries);
    stalled = false;
    acquireDemanded();
  }

  /** Acquires further pages while the presented window is shorter than the demanded range. */
  function acquireDemanded(): void {
    const next = continuation;
    if (
      disposed ||
      loading ||
      kept !== null ||
      staleWindow ||
      error !== null ||
      next === null ||
      stalled ||
      acquiredEntries >= demandedEntries
    ) {
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
    publish();
    startRequest(null);
  }

  function retry(): void {
    if (disposed || failed === null) {
      return;
    }
    // A retry repeats the failed request of the same result, so a restoration still under way keeps
    // acquiring the retained window and the intended state stays retained until it is presented.
    startRequest(failed.continuation, failed.offset);
  }

  /**
   * Applies one committed-change notification. The source decides whether the change touches the
   * sequence it reads; an affected result is reacquired through its source with the reported
   * publication position required, so usable content stays labelled as updating until the source
   * incorporated it. A consumer never patches rows for a change.
   */
  function changed(change: CardListChange): void {
    if (disposed || !sourceAffected(change)) {
      return;
    }
    if (change.position !== null && !awaiting.includes(change.position)) {
      awaiting = [...awaiting, change.position];
    }
    startRequest(null);
  }

  /** Whether one notification touches the sequence this list reads. */
  function sourceAffected(change: CardListChange): boolean {
    const affects = source.affects;
    if (typeof affects === 'function') {
      return affects(change, activeContext) === true;
    }
    return true;
  }

  /**
   * The consumer restarted or re-queried the list, or released the retained state: the retained
   * window is superseded and the consumer learns that the restoration ended without presenting it.
   */
  function release(): void {
    abandonRestoration();
  }

  function abandonRestoration(): void {
    if (kept === null) {
      return;
    }
    kept = null;
    settled?.reject(new Error('The retained window was superseded before it was presented.'));
    publish();
  }

  /**
   * Retains the logical position the presentation reports: its scroll offset and the control that
   * holds focus. A report that the presentation did not apply the retained position marks explicit
   * user input, and the list then keeps the user's interaction forever after.
   */
  function reportPosition(position: CardListPositionReport): void {
    if (disposed) {
      return;
    }
    const report = readObject(position);
    if (report === null) {
      throw new TypeError('A position report names the position the presentation shows.');
    }
    if (report.applied === false) {
      interactionTaken = true;
    }
    const scrollTop = report.scrollTop;
    if (scrollTop !== undefined) {
      if (typeof scrollTop !== 'number' || !Number.isFinite(scrollTop) || scrollTop < 0) {
        throw new TypeError('A reported scroll offset is a finite, non-negative number.');
      }
      reportedScrollTop = scrollTop;
    }
    if (Object.hasOwn(report, 'focus')) {
      reportedFocus = readReportedFocus(report.focus);
    }
  }

  function readReportedFocus(value: unknown): CardListFocus | null {
    if (value === null || value === undefined) {
      return null;
    }
    const focus = readObject(value);
    const control = focus?.control;
    if (
      focus === null ||
      (control !== 'select' &&
        control !== 'group' &&
        control !== 'fragment' &&
        control !== 'element')
    ) {
      throw new TypeError('A reported focus names one control of the list.');
    }
    return value as CardListFocus;
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
    publish();
  }

  function setGroupSelected(keys: readonly string[], selectedNow: boolean): void {
    if (disposed) {
      return;
    }
    if (!Array.isArray(keys)) {
      throw new TypeError('A group selection names the entry keys it toggles.');
    }
    for (const key of keys) {
      if (typeof key !== 'string' || key.length === 0) {
        throw new TypeError('A group selection names bounded entry keys.');
      }
      if (selectedNow) {
        selected.add(key);
      } else {
        selected.delete(key);
      }
    }
    publish();
  }

  function clearSelection(): void {
    if (disposed || selected.size === 0) {
      return;
    }
    selected.clear();
    clearRetiredSelection();
    retireObsoleteFragments();
    publish();
  }

  function clearRetiredSelection(): void {
    for (const key of retiredSelection.keys()) {
      invalidateFragment(key, 'tools');
    }
    retiredSelection.clear();
  }

  /** Selected result keys, including explicit targets retained when paging retires their rows. */
  function selectedKeys(): readonly string[] {
    return [
      ...retiredSelection.keys(),
      ...entries.filter((entry) => selected.has(entry.key)).map((entry) => entry.key),
    ];
  }

  /** Typed targets of the selection, aligned with its keys and including retired entries. */
  function selectedTargets(): readonly CardListEntry['target'][] {
    const chosen = new Map(entries.map((entry) => [entry.key, entry.target] as const));
    return selectedKeys().map((key) => retiredSelection.get(key) ?? chosen.get(key)!);
  }

  /** Whether one tool acts on the whole selection: every selected entry reports it available. */
  function toolAvailable(id: string): boolean {
    const keys = selectedKeys();
    // A selection can name entries whose targets have not arrived yet, including later pages of a
    // restored window. Neither the control nor programmatic invocation may act on just a subset.
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
   * presentation. The outcome is returned for a committed operation, kept for a conflict or
   * failure, and reported as unknown so the consumer can recover the recorded outcome.
   */
  async function invoke(toolId: string): Promise<CardListOperationOutcome | null> {
    const definition = tools.get(toolId);
    const context = actionContext();
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
    const controller = new AbortController();
    invocation = controller;
    publish();
    const reported = await runTool(definition.tool, {
      targets: context.targets,
      selection: context,
      signal: controller.signal,
    });
    if (disposed || invocation !== controller) {
      return null;
    }
    invocation = null;
    publish();
    return reported;
  }

  async function runTool(
    tool: CardListTool['tool'],
    request: CardListToolRequest,
  ): Promise<CardListOperationOutcome> {
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

  function requestFragments(): void {
    let changed = false;
    for (const kind of cardListFragmentKinds) {
      if (!readers.has(kind) || !demandedKinds.has(kind)) {
        continue;
      }
      const queue = fragmentQueue(kind);
      for (const key of fragmentRequestKeys(kind)) {
        if (fragmentState(key, kind) === null) {
          setFragmentState(key, kind, { status: 'loading' });
          queue.pending.add(key);
          changed = true;
        }
      }
      pumpFragments(kind);
    }
    if (changed) {
      publish();
    }
  }

  /**
   * Entries one kind is read for: the presented window, plus the tool availability of a selected
   * target the window no longer presents.
   */
  function fragmentRequestKeys(kind: CardListFragmentKind): ReadonlySet<string> {
    if (kind !== 'tools' || retiredSelection.size === 0) {
      return windowKeys;
    }
    return new Set([...windowKeys, ...retiredSelection.keys()]);
  }

  function reloadFragment(key: string, kind: CardListFragmentKind): void {
    if (disposed || !fragmentKeyActive(key, kind) || !readers.has(kind)) {
      return;
    }
    // The outstanding read of this entry is retired so the fresh one is not blocked behind it and
    // its answer never replaces the fresh one.
    invalidateFragment(key, kind);
    setFragmentState(key, kind, { status: 'loading' });
    fragmentQueue(kind).pending.add(key);
    retireObsoleteFragments();
    pumpFragments(kind);
    publish();
  }

  function reloadFragments(kind: CardListFragmentKind): void {
    if (disposed || !readers.has(kind)) {
      return;
    }
    // Invalidate the whole batch before pumping so no request mixes old and fresh tokens.
    for (const key of fragmentRequestKeys(kind)) {
      invalidateFragment(key, kind);
      setFragmentState(key, kind, { status: 'loading' });
      fragmentQueue(kind).pending.add(key);
    }
    retireObsoleteFragments();
    pumpFragments(kind);
    publish();
  }

  /**
   * Reads the pending entries of one kind in bounded batches; one read is in flight per kind and
   * the entries requested meanwhile wait for their own batch.
   */
  function pumpFragments(kind: CardListFragmentKind): void {
    const queue = fragmentQueue(kind);
    const reader = readers.get(kind);
    if (disposed || reader === undefined || queue.active !== null || queue.pending.size === 0) {
      return;
    }
    const keys = [...queue.pending].slice(0, CARD_LIST_LIMITS.fragmentBatch);
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
      publish();
      pumpFragments(kind);
    };
    let reading: Promise<readonly unknown[]>;
    try {
      reading = reader.read({
        keys,
        information: [kind],
        signal: request.controller.signal,
      }) as Promise<readonly unknown[]>;
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
    kind: CardListFragmentKind,
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
      const state: CardListFragmentState = read.get(key) ?? {
        status: 'failed',
        message: 'The fragment response did not cover every requested entry.',
      };
      setFragmentState(key, kind, state);
    }
  }

  function applyFragmentFailure(
    kind: CardListFragmentKind,
    request: FragmentRequest,
    message: string,
  ): void {
    if (disposed) {
      return;
    }
    for (const key of request.keys) {
      // A failure of a superseded read never reports for the entry its replacement now serves.
      if (fragmentResponseApplies(request, key)) {
        setFragmentState(key, kind, { status: 'failed', message });
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

  /** Only tool availability is needed beyond the presented window, for explicit selected targets. */
  function fragmentKeyActive(key: string, kind: CardListFragmentKind): boolean {
    return windowKeys.has(key) || (kind === 'tools' && retiredSelection.has(key));
  }

  function fragmentState(key: string, kind: CardListFragmentKind): CardListFragmentState | null {
    return fragmentStates.get(key)?.get(kind) ?? null;
  }

  function setFragmentState(
    key: string,
    kind: CardListFragmentKind,
    state: CardListFragmentState,
  ): void {
    const states =
      fragmentStates.get(key) ?? new Map<CardListFragmentKind, CardListFragmentState>();
    states.set(kind, state);
    fragmentStates.set(key, states);
  }

  /** Retires enrichment, keeping only tool availability needed for a selected target. */
  function invalidateFragments(key: string): void {
    for (const kind of cardListFragmentKinds) {
      if (kind !== 'tools' || !retiredSelection.has(key)) {
        invalidateFragment(key, kind);
      }
    }
  }

  function invalidateFragment(key: string, kind: CardListFragmentKind): void {
    const states = fragmentStates.get(key);
    states?.delete(kind);
    if (states !== undefined && states.size === 0) {
      fragmentStates.delete(key);
    }
    endFragmentRead(kind, key);
    fragmentQueues.get(kind)?.pending.delete(key);
  }

  /** The token of the read now answering for one entry's kind, or zero when none is outstanding. */
  function fragmentToken(kind: CardListFragmentKind, key: string): number {
    return fragmentTokens.get(key)?.get(kind) ?? 0;
  }

  /** Marks one entry's kind as being read now, so earlier answers for it are retired. */
  function beginFragmentRead(kind: CardListFragmentKind, key: string): number {
    fragmentSequence += 1;
    const tokens = fragmentTokens.get(key) ?? new Map<CardListFragmentKind, number>();
    tokens.set(kind, fragmentSequence);
    fragmentTokens.set(key, tokens);
    return fragmentSequence;
  }

  function endFragmentRead(kind: CardListFragmentKind, key: string): void {
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
  function fragmentReadWanted(kind: CardListFragmentKind, key: string): boolean {
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
  function fragmentReadObsolete(kind: CardListFragmentKind, active: FragmentRequest): boolean {
    return active.keys.some(
      (key) =>
        !fragmentReadWanted(kind, key) || fragmentToken(kind, key) !== active.tokens.get(key),
    );
  }

  function fragmentQueue(kind: CardListFragmentKind): FragmentQueue {
    let queue = fragmentQueues.get(kind);
    if (queue === undefined) {
      queue = { pending: new Set(), active: null };
      fragmentQueues.set(kind, queue);
    }
    return queue;
  }

  function dispose(): void {
    if (disposed) {
      return;
    }
    disposed = true;
    unsubscribeChanges?.();
    kept = null;
    settled?.reject(new Error('The list was disposed before its retained window was presented.'));
    generation += 1;
    pending?.abort();
    pending = null;
    invocation?.abort();
    invocation = null;
    for (const queue of fragmentQueues.values()) {
      queue.active?.controller.abort();
      queue.active = null;
      queue.pending.clear();
    }
    entries = [];
    windowKeys = new Set();
    positions.clear();
    fragmentStates.clear();
    fragmentTokens.clear();
    selected.clear();
    retiredSelection.clear();
    listeners.clear();
    published = null;
  }
}

/**
 * Identity the enrichment of one entry belongs to: its key, its typed target and its basic
 * information. A result that presents the same key with another target or other basic information
 * is another entry, whose fragments are read again instead of answering for the previous one.
 */
function entryIdentity(entry: CardListEntry): string {
  return JSON.stringify([entry.key, entry.target, entry.basic]);
}

/**
 * Groups consecutive copy entries that share one printing. Copies of the same printing are
 * equivalent for bulk interaction, so they present together while every entry stays individually
 * presentable and selectable (docs/card-list.md#interface).
 */
export function groupCardListEntries(entries: readonly CardListEntry[]): readonly CardListGroup[] {
  const groups: {
    readonly key: string;
    readonly printingId: string | null;
    keys: string[];
  }[] = [];
  for (const entry of entries) {
    const printingId = equivalentPrintingId(entry);
    const previous = groups[groups.length - 1];
    if (printingId !== null && previous !== undefined && previous.printingId === printingId) {
      previous.keys.push(entry.key);
      continue;
    }
    groups.push({ key: `group-${groups.length}`, printingId, keys: [entry.key] });
  }
  return groups;
}

/** Printing that makes one copy entry equivalent to another; null when the entry is not a copy. */
function equivalentPrintingId(entry: CardListEntry): string | null {
  const printing = entry.basic?.printing;
  return entry.target.kind === 'copy' && printing != null ? printing.printingId : null;
}

function groupWindow(entries: readonly CardListEntry[]): readonly CardListGroup[] {
  return groupCardListEntries(entries);
}

export type { CardListFragmentReader };
