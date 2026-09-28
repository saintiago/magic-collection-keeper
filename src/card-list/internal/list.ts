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
 * group for convenient selection without losing their individual identities. Advisory tools use
 * the explicit selection; the consumer owns dispatch and operation outcomes.
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
  type CardListIndexingStatus,
  type CardListOptions,
  type CardListPage,
  type CardListPosition,
  type CardListPositionReport,
  type CardListRestoration,
  type CardListRetained,
  type CardListSelection,
  type CardListSnapshot,
  type CardListToolSelection,
  type CardListViewportDemand,
} from './contract.js';
import {
  readAccountId,
  readCardListRead,
  readDemand,
  readFragments,
  readFragmentResults,
  readObservation,
  readMessage,
  readObject,
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
   * Explicit identities of the selection, independent of the loaded window: the target one entry
   * key was selected at. Paging, refinement and refresh never substitute them for whatever the
   * source presents under the same key; only an explicit selection (or reselection) recaptures
   * one (docs/card-list.md#selection-and-restoration).
   */
  const selectionTargets = new Map<string, CardListEntry['target']>();
  /** Selected keys whose entry has not been presented yet, so no identity is captured for them. */
  const pendingSelection = new Set<string>();
  /** Selected keys whose presented entry carries another identity than the selection holds. */
  const unavailableSelection = new Map<string, 'unchecked' | 'changed'>(
    [...selected].map((key) => [key, 'unchecked']),
  );
  for (const selectedTarget of restored?.selectedTargets ?? []) {
    if (selected.has(selectedTarget.key)) {
      selectionTargets.set(selectedTarget.key, selectedTarget.target);
    }
  }
  for (const key of selected) {
    if (!selectionTargets.has(key)) {
      pendingSelection.add(key);
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
  /**
   * Committed positions the presented result still awaits incorporation of. A restored visit keeps
   * the requirements its history entry held, so returning to a page never turns a known stale
   * result into an apparently current one (docs/card-list.md#loading-and-recovery).
   */
  let awaiting: readonly string[] = [...(restored?.awaiting ?? [])];
  /** How the awaited committed changes stand; never `current` while a position is awaited. */
  let freshness: CardListIndexingStatus = awaiting.length === 0 ? 'current' : 'indexing';
  /** The bounded observation of the awaited positions in flight, or null when none is. */
  let observation: { readonly id: number; readonly controller: AbortController } | null = null;
  let observationSequence = 0;
  /** Entries the viewport demanded, as far as the list has acquired them. */
  let demandedEntries = 0;
  /**
   * Entries the presentation demanded while the first page of the active generation is still
   * outstanding. A demand reported for the incoming generation survives its load; the extent the
   * previous generation was acquired to does not, because the fresh sequence starts over.
   */
  let pendingDemand = 0;
  /** Whether the active generation's first page is still outstanding. */
  let firstPagePending = false;
  /** Entries the active sequence has supplied, including those the window bound retired. */
  let acquiredEntries = 0;
  /** Whether the last appended page added nothing, so acquiring stops until a new demand. */
  let stalled = false;
  let loading = false;
  let error: string | null = null;
  let pending: AbortController | null = null;
  let failed: { readonly continuation: string | null; readonly offset: number } | null = null;
  let generation = 0;
  /** Generation of the presented window, advanced whenever the source supplied entries again. */
  let windowGeneration = 0;
  let fragmentSequence = 0;
  let disposed = false;
  let published: CardListSnapshot<Context> | null = null;
  const listeners = new Set<(snapshot: CardListSnapshot<Context>) => void>();

  const unsubscribeFragments = [...readers].flatMap(([kind, reader]) =>
    reader.subscribe === undefined ? [] : [reader.subscribe(() => reloadFragments(kind))],
  );
  publish();
  const unsubscribeChanges =
    changes === null ? null : changes.subscribe((change) => changed(change));
  if (signal !== undefined && signal.aborted) {
    dispose();
  } else {
    signal?.addEventListener('abort', () => dispose());
    const start = kept?.position ?? null;
    startRequest(start?.continuation ?? null, start?.offset ?? 0);
    startObservation();
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
      selection: selectionReport(),
      tools: [...tools].map(([id, definition]) => ({
        id,
        label: definition.label,
        available: toolAvailable(id),
      })),
      loading,
      error,
      hasMore: pagingAvailable(),
      empty: entries.length === 0 && !loading && error === null && awaiting.length === 0,
      acquired: acquiredEntries,
      generation: windowGeneration,
      awaiting: [...awaiting],
      freshness,
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

  /** The selection the snapshot reports: explicit keys, their identities and conflicting ones. */
  function selectionReport(): CardListSelection {
    const keys = selectedKeys();
    return {
      keys,
      targets: selectedTargets(),
      unavailable: keys.filter((key) => unavailableSelection.has(key)),
    };
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
    if (nextContinuation === null) {
      firstPagePending = true;
    }
    pending?.abort();
    generation += 1;
    const current = generation;
    const controller = new AbortController();
    pending = controller;
    loading = true;
    error = null;
    failed = null;
    // The positions this request must incorporate are fixed when it starts: a change arriving
    // while it is outstanding extends the required progress instead of being cleared with it.
    const required = [...awaiting];
    publish();
    let request: Promise<unknown>;
    try {
      request = source.load({
        context: activeContext,
        pageSize,
        continuation: nextContinuation,
        signal: controller.signal,
        required: { positions: required },
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
      (read) => settleRead(current, nextContinuation, offset, required, read),
      (cause) =>
        settleFailure(
          current,
          nextContinuation,
          offset,
          readMessage(cause, 'The list could not load.'),
        ),
    );
  }

  /** Superseding a sequence drops demand submitted for its pending first page. */
  function startReplacement(): void {
    pendingDemand = 0;
    startRequest(null);
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
    required: readonly string[],
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
      // The replacement sequence may carry other private values than the rejected one, so the
      // enrichment of the window it replaces is read again through the list's own bindings.
      staleFragments();
      forgetSequence();
      startReplacement();
      return;
    }
    if (read.status === 'unreadable') {
      settleFailure(current, requested, offset, read.problem);
      return;
    }
    settlePage(current, requested, offset, required, read.page);
  }

  function settlePage(
    current: number,
    requested: string | null,
    offset: number,
    required: readonly string[],
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
      // A replacement must validate selected identities again. Eviction by ordinary paging
      // leaves selection available; an identity missing from a replacement is unvalidated.
      for (const key of selected) {
        if (!unavailableSelection.has(key)) unavailableSelection.set(key, 'unchecked');
      }
      setWindow(presented);
      staleFragments();
      acquiredEntries = presented.length;
      // A demand the presentation reported while this first page was outstanding stays part of
      // the active generation: the list acquires the extent the viewport asked for instead of
      // leaving it underfilled until an unrelated interaction repeats the demand.
      demandedEntries = pendingDemand;
      pendingDemand = 0;
      firstPagePending = false;
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
    // The result is current once the source incorporated the positions this read required; an
    // updating page keeps them labelled instead of presenting content as caught up. Only the
    // positions this answer actually established leave the requirement: a change that arrived
    // while it was outstanding stays awaited until its own read or observation establishes it.
    if (page.current && required.length > 0) {
      const established = new Set(required);
      awaiting = awaiting.filter((position) => !established.has(position));
      if (awaiting.length === 0) cancelObservation();
    }
    noteFreshness();
    publish();
    requestFragments();
    startObservation();
    if (kept !== null) {
      restoreWindow(baseline);
      return;
    }
    acquireDemanded();
  }

  /**
   * Reconciles the reported freshness with the awaited positions: current without them, indexing
   * while none of the explicit outcomes (delayed, failed, unavailable) stands. The list observes
   * again from `startObservation` whenever work can still progress.
   */
  function noteFreshness(): void {
    if (awaiting.length === 0) {
      freshness = 'current';
      return;
    }
    if (freshness === 'current') {
      freshness = 'indexing';
    }
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

  /** Replaces the window; entries the new result no longer holds leave it, their selection stays. */
  function setWindow(next: readonly CardListEntry[]): void {
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
        captureSelectionTarget(entry);
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
      selectedTargets: [...selectionTargets].map(([key, target]) => ({ key, target })),
      awaiting: [...awaiting],
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
    const previousWindow = windowKeys;
    entries = next.slice(-CARD_LIST_LIMITS.window);
    windowKeys = new Set(entries.map((entry) => entry.key));
    for (const key of windowKeys) {
      if (selectionTargets.has(key) && !previousWindow.has(key)) {
        // A selected identity that returns to the window may have changed while it was away; its
        // availability is read again instead of answering for the previous presentation.
        invalidateFragment(key, 'tools');
      }
    }
    reconcileSelection();
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
   * Reconciles the explicit selection with the window the source now presents: a selected key
   * whose entry arrives for the first time captures its identity, and a presented entry that no
   * longer carries the identity the selection holds marks it unavailable instead of substituting
   * the replacement (docs/card-list.md#selection-and-restoration). An entry that left the window
   * keeps the identity it was selected at.
   */
  function reconcileSelection(): void {
    for (const entry of entries) {
      if (!selected.has(entry.key)) {
        continue;
      }
      if (pendingSelection.delete(entry.key)) {
        selectionTargets.set(entry.key, entry.target);
        unavailableSelection.delete(entry.key);
        continue;
      }
      const chosen = selectionTargets.get(entry.key);
      if (chosen !== undefined && !sameTarget(chosen, entry.target)) {
        unavailableSelection.set(entry.key, 'changed');
      } else if (chosen !== undefined) {
        unavailableSelection.delete(entry.key);
      }
    }
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
    if (firstPagePending) {
      pendingDemand = Math.max(pendingDemand, read.entries);
    } else {
      demandedEntries = Math.max(demandedEntries, read.entries);
    }
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
    // An explicit refresh rechecks the enrichment too: a committed change the list was not told
    // about may have altered counts, tags or offered tools (docs/card-list.md#loading-and-recovery).
    staleFragments();
    startReplacement();
    startObservation();
  }

  function refine(next: Context): void {
    if (disposed) {
      return;
    }
    abandonRestoration();
    activeContext = next;
    // The new description supersedes the extent the previous sequence was acquired to; a demand
    // reported while the fresh page is outstanding is kept for the new generation.
    demandedEntries = 0;
    cancelObservation();
    // The presented window belongs to the previous query until the fresh page arrives: it is kept
    // as usable content, but paging it with the new context would mix two result sequences.
    staleWindow = true;
    startReplacement();
    startObservation();
  }

  function retry(): void {
    if (disposed) {
      return;
    }
    if (failed !== null) {
      // A retry repeats the failed request of the same result, so a restoration still under way
      // keeps acquiring the retained window and the intended state stays retained until it is
      // presented.
      startRequest(failed.continuation, failed.offset);
      return;
    }
    if (awaiting.length > 0) {
      // A delayed, failed or unavailable observation is explicitly recoverable: checking again
      // starts no business write and never resets the presented content.
      freshness = 'indexing';
      publish();
      startObservation();
    }
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
    const position = readChangePosition(change);
    if (position !== null && !awaiting.includes(position)) {
      awaiting = [...awaiting, position];
    }
    noteFreshness();
    // Local committed changes mark affected data stale: the source read reacquires entries, basic
    // information and quantities, and the enrichment is read again through the list's own bindings
    // instead of a page repairing rows (docs/card-list.md#loading-and-recovery).
    staleFragments();
    startReplacement();
    startObservation();
  }

  /** The bounded publication position one notification names, or null when it names none. */
  function readChangePosition(change: CardListChange): string | null {
    const position = change.position;
    if (
      typeof position !== 'string' ||
      position.length === 0 ||
      position.length > CARD_LIST_LIMITS.position
    ) {
      return null;
    }
    return position;
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
   * Observes the awaited committed positions through the source's own bounded freshness
   * capability. Starting with empty awaiting work, without the capability or with an observation
   * already in flight does nothing; an observation that cannot answer reports unavailable and is
   * recovered explicitly through `retry` or `refresh` (docs/card-list.md#loading-and-recovery).
   */
  function startObservation(): void {
    const observe = source.observe;
    if (
      disposed ||
      observation !== null ||
      awaiting.length === 0 ||
      typeof observe !== 'function'
    ) {
      return;
    }
    const controller = new AbortController();
    observationSequence += 1;
    const id = observationSequence;
    const positions = [...awaiting];
    observation = { id, controller };
    let pending: unknown;
    try {
      pending = observe({ positions, signal: controller.signal });
    } catch (cause) {
      settleObservation(id, null, cause);
      return;
    }
    Promise.resolve(pending).then(
      (state) => settleObservation(id, state, null),
      (cause) => settleObservation(id, null, cause),
    );
  }

  /** Withdraws the observation in flight, if any; its late answer never reports afterwards. */
  function cancelObservation(): void {
    const active = observation;
    if (active === null) {
      return;
    }
    observation = null;
    active.controller.abort();
  }

  /**
   * Accepts one observation: incorporation starts a replacement read; only its result releases
   * the requirements. The presented generation is read again, a delay or failure is exposed as such, and an unreadable or
   * withdrawn answer is unavailable. The list never infers incorporation from notification order.
   */
  function settleObservation(id: number, value: unknown, cause: unknown): void {
    const active = observation;
    if (disposed || active === null || active.id !== id) {
      return;
    }
    observation = null;
    const state = cause === null || cause === undefined ? readObservation(value) : null;
    if (state === 'incorporated') {
      // Keep the requirements until the replacement read establishes them. The old visible
      // window must remain updating while that read is pending or fails.
      staleFragments();
      // The indexed state advanced: the presented generation is re-read from its source, and a
      // change that arrived while this observation waited extends the required progress.
      startReplacement();
      return;
    }
    if (awaiting.length === 0) {
      freshness = 'current';
    } else if (state === 'failed') {
      freshness = 'failed';
    } else if (state === 'delayed') {
      freshness = 'delayed';
    } else {
      freshness = 'unavailable';
    }
    publish();
  }

  /**
   * Marks the enrichment of the active window stale: the settled page reads the kinds the
   * presentation demands again through the list's own bindings, so the values a read answered
   * before the change never answer for the fresh window. The presented value stays visible while
   * the fresh read is outstanding instead of collapsing a row the user is editing, and entries
   * without a value show as loading (docs/card-list.md#loading-and-recovery).
   */
  function staleFragments(): void {
    for (const kind of cardListFragmentKinds) {
      if (!readers.has(kind) || !demandedKinds.has(kind)) {
        continue;
      }
      staleFragmentKind(kind);
    }
    publish();
  }

  function staleFragmentKind(kind: CardListFragmentKind): void {
    const queue = fragmentQueue(kind);
    queue.active?.controller.abort();
    queue.active = null;
    for (const key of fragmentRequestKeys(kind)) {
      endFragmentRead(kind, key);
      if (fragmentState(key, kind) === null) {
        setFragmentState(key, kind, { status: 'loading' });
      }
      queue.pending.add(key);
    }
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
      // An explicit selection (or reselection) captures the identity the source presents now; a
      // key selected before its entry arrived captures it when the entry arrives.
      const entry = entries.find((candidate) => candidate.key === key);
      if (entry === undefined) {
        pendingSelection.add(key);
      } else {
        selectionTargets.set(key, entry.target);
        pendingSelection.delete(key);
        unavailableSelection.delete(key);
      }
      selected.add(key);
    } else {
      selected.delete(key);
      pendingSelection.delete(key);
      unavailableSelection.delete(key);
      // Only the tool availability a retired selected target still needs is invalidated: the
      // fragment of a presented entry belongs to the row, not to the selection.
      const retired = selectionTargets.has(key) && !windowKeys.has(key);
      selectionTargets.delete(key);
      if (retired) {
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
        const entry = entries.find((candidate) => candidate.key === key);
        if (entry === undefined) {
          pendingSelection.add(key);
        } else {
          selectionTargets.set(key, entry.target);
          pendingSelection.delete(key);
          unavailableSelection.delete(key);
        }
        selected.add(key);
      } else {
        selected.delete(key);
        pendingSelection.delete(key);
        unavailableSelection.delete(key);
        const retired = selectionTargets.has(key) && !windowKeys.has(key);
        selectionTargets.delete(key);
        if (retired) {
          invalidateFragment(key, 'tools');
        }
      }
    }
    publish();
  }

  function clearSelection(): void {
    if (disposed || selected.size === 0) {
      return;
    }
    selected.clear();
    clearSelectionTargets();
    retireObsoleteFragments();
    publish();
  }

  function clearSelectionTargets(): void {
    for (const key of selectionTargets.keys()) {
      if (!windowKeys.has(key)) {
        invalidateFragment(key, 'tools');
      }
    }
    selectionTargets.clear();
    pendingSelection.clear();
    unavailableSelection.clear();
  }

  /**
   * Selected result keys with an explicit identity: the identities the presented window no longer
   * holds first, then the presented ones in result order, so the report is stable whatever order
   * the user selected in. A key the list holds without a target yet is not part of the report, and
   * `toolAvailable` refuses a selection that names one, so an invocation never acts on a subset.
   */
  function selectedKeys(): readonly string[] {
    const beyondWindow = [...selectionTargets.keys()].filter(
      (key) => selected.has(key) && !windowKeys.has(key),
    );
    const presented = entries
      .filter((entry) => selected.has(entry.key) && selectionTargets.has(entry.key))
      .map((entry) => entry.key);
    return [...beyondWindow, ...presented];
  }

  /** Typed targets of the selection, aligned with its keys and independent of the window. */
  function selectedTargets(): readonly CardListEntry['target'][] {
    return selectedKeys().map((key) => selectionTargets.get(key)!);
  }

  /** Captures one presented entry's identity for a selection that holds only its key. */
  function captureSelectionTarget(entry: CardListEntry): void {
    if (!selected.has(entry.key)) {
      return;
    }
    if (!selectionTargets.has(entry.key) || pendingSelection.has(entry.key)) {
      selectionTargets.set(entry.key, entry.target);
      pendingSelection.delete(entry.key);
      unavailableSelection.delete(entry.key);
      return;
    }
    if (!sameTarget(selectionTargets.get(entry.key)!, entry.target)) {
      unavailableSelection.set(entry.key, 'changed');
    }
  }

  /** Whether one tool acts on the whole selection: every selected entry reports it available. */
  function toolAvailable(id: string): boolean {
    const keys = selectedKeys();
    // A selection can name entries whose targets have not arrived yet, including later pages of a
    // restored window, and a presented entry may no longer carry the identity the selection holds.
    // Neither the control nor programmatic invocation may act on just a subset or on a
    // replacement (docs/card-list.md#selection-and-restoration).
    if (keys.length === 0 || keys.length !== selected.size || unavailableSelection.size > 0) {
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
    const beyondWindow = selectionOutsideWindow();
    if (kind !== 'tools' || beyondWindow.length === 0) {
      return windowKeys;
    }
    return new Set([...windowKeys, ...beyondWindow]);
  }

  /** Selected keys whose explicit identity is outside the presented window. */
  function selectionOutsideWindow(): readonly string[] {
    return [...selectionTargets.keys()].filter((key) => !windowKeys.has(key));
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
    staleFragmentKind(kind);
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
      // Fresh provider availability validates a target outside the replacement window. It never
      // substitutes a target whose identity changed under its selected key.
      if (
        kind === 'tools' &&
        state.status === 'ready' &&
        Array.isArray(state.values) &&
        state.values.length > 0 &&
        unavailableSelection.get(key) === 'unchecked'
      ) {
        unavailableSelection.delete(key);
      }
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
    return windowKeys.has(key) || (kind === 'tools' && selectionTargets.has(key));
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
      const keepForRetiredSelection =
        kind === 'tools' && selectionTargets.has(key) && !windowKeys.has(key);
      if (!keepForRetiredSelection) {
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
  function retireObsoleteFragments(repump = true): void {
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
      if (repump) {
        pumpFragments(kind);
      }
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
    for (const unsubscribe of unsubscribeFragments) unsubscribe();
    kept = null;
    settled?.reject(new Error('The list was disposed before its retained window was presented.'));
    cancelObservation();
    generation += 1;
    pending?.abort();
    pending = null;
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
    selectionTargets.clear();
    pendingSelection.clear();
    unavailableSelection.clear();
    listeners.clear();
    published = null;
  }
}

/** Whether two entries carry the same typed target, independently of their other information. */
function sameTarget(left: CardListEntry['target'], right: CardListEntry['target']): boolean {
  return left.kind === right.kind && targetIdentityOf(left) === targetIdentityOf(right);
}

/** Identity one typed target names; the key of the entry that carries it. */
function targetIdentityOf(target: CardListEntry['target']): string {
  switch (target.kind) {
    case 'card':
      return target.cardId;
    case 'printing':
      return target.printingId;
    case 'copy':
      return target.copyId;
    case 'pending':
      return target.entryId;
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
