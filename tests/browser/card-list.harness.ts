/**
 * Browser-side harness of the CardList journeys (docs/user-interface.md#list-boundary,
 * docs/user-interface.md#cardlist, docs/user-interface.md#state-ownership-and-restoration,
 * docs/testing.md#browser-and-recognition-evidence).
 *
 * The harness installs real CardLists over controlled sources, fragment readers and tools. Every
 * page, fragment and tool request is recorded and settled from the journey, so response ordering,
 * independent fragment failure and retry, bounded requests and tool outcomes are driven exactly
 * while the journeys observe the real presentation. A page or fragment request also records
 * whether the list withdrew it before it settled. A journey can hand a previous visit's retained
 * state back to the list and read both the state the list retains now and the outcome of its
 * restoration, as the page composing the list does.
 */

import {
  createCardList,
  type CardListFragmentKind as UiFragmentKind,
  type CardListFragmentReader as UiFragmentReader,
  type CardListFragmentReaders as UiCardListFragments,
  type CardListFragmentResult as UiFragmentResult,
  type CardListOperationOutcome as UiOperationOutcome,
  type CardListRetained,
  type CardListSource as UiListSource,
  type CardListRead as UiListRead,
  type CardListTarget as UiListTarget,
  type CardListTool as UiCardListTool,
  type CardListEntry as UiListEntry,
  type CardListFocus as UiListFocus,
  type CardListChange as UiListChange,
} from '../../src/card-list/index.js';
import { createCardListView, type UiCardList } from '../../src/ui/index.js';

/**
 * State one visit restores, as a journey describes it: the shape a CardList retains when it
 * captures its query, position, window, selection and logical position. Journeys describe the
 * state directly, and the harness hands it to the list through the component's opaque handle.
 */
export interface UiCardListRetainedState<Context = string | null | undefined> {
  readonly kind?: 'card-list-retained';
  readonly accountId?: string;
  readonly context: Context;
  readonly window: number;
  readonly position: CardListPositionShape | null;
  readonly selection: readonly string[];
  readonly selectedTargets: readonly {
    readonly key: string;
    readonly target: UiListTarget;
  }[];
  readonly scrollTop: number;
  readonly focus: UiListFocus | null;
}

/** Source position of one retained window. */
export interface CardListPositionShape {
  readonly continuation: string | null;
  readonly offset: number;
}

/** Account every harness list belongs to, so one journey's retained state restores into it. */
const harnessAccount = 'contract-account';

/** One list the journey installs. */
export interface UiCardListInstall {
  /** Entries one request asks for; the CardList's declared bound applies. */
  readonly pageSize?: number;
  /** Makes the container a bounded scroll box, so list-local scroll is observable. */
  readonly scrollable?: boolean;
  /** State a previous visit of this list retained for its page's history entry. */
  readonly restored?: UiCardListRetainedState | null;
  /** Renders each entry as a link the page owns, as a browsing page does. */
  readonly openEntry?: boolean;
  /**
   * Renders each entry through the consumer's own content, named by the counts the snapshot
   * carries, so a journey observes that a refreshed entry reaches the consumer's renderer.
   */
  readonly customEntry?: boolean;
  /** Query context the list evaluates. */
  readonly context?: string;
  /** Fragment kinds the list reads; the others are not presented. */
  readonly fragments?: readonly UiFragmentKind[];
  /** Tools the list presents, in order. */
  readonly tools?: readonly { readonly id: string; readonly label: string }[];
  /** Gives the installed list a change source a journey can deliver notifications through. */
  readonly changes?: boolean;
  /** Gives the installed source a bounded observation capability, as Search supplies. */
  readonly observations?: boolean;
}

/** One page request the controlled source recorded. */
export interface UiCardListPageRequest {
  readonly id: number;
  readonly list: string;
  readonly context: string | null | undefined;
  readonly pageSize: number;
  readonly continuation: string | null;
  /** Positions the read required the source to have incorporated. */
  readonly required: readonly string[];
  readonly aborted: boolean;
}

/** One bounded observation the installed list asked its source for. */
export interface UiCardListObservationRequest {
  readonly id: number;
  readonly list: string;
  readonly positions: readonly string[];
  readonly aborted: boolean;
}

/** One fragment request the controlled readers recorded. */
export interface UiCardListFragmentRequest {
  readonly id: number;
  readonly list: string;
  readonly kind: UiFragmentKind;
  readonly keys: readonly string[];
  /** Whether the list retired the read before it settled, as it does for obsolete work. */
  readonly aborted: boolean;
}

/** One tool invocation the controlled tools recorded. */
export interface UiCardListToolRequest {
  readonly id: number;
  readonly list: string;
  readonly tool: string;
  /** Targets the invocation named, as `kind:id`. */
  readonly targets: readonly string[];
  /** Keys of the explicit selection the invocation carried. */
  readonly selection: readonly string[];
}

/** The installed list's own window, selection and load state. */
export interface UiCardListState {
  readonly entries: readonly string[];
  readonly selection: readonly string[];
  /** Selected keys whose presented entry no longer carries the identity the selection holds. */
  readonly unavailableSelection: readonly string[];
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly error: string | null;
}

/** Outcome of the restoration one list performs for the state its page handed back. */
export interface UiCardListRestorationReport {
  readonly status: 'none' | 'pending' | 'presented' | 'interrupted';
  readonly message: string | null;
}

export interface UiCardListControl {
  install(id: string, options?: UiCardListInstall): void;
  /** Presents another query context through the list. */
  refine(id: string, context: string | null | undefined): void;
  invoke(id: string, toolId: string): Promise<UiOperationOutcome | null>;
  refresh(id: string): void;
  loadMore(id: string): void;
  setSelected(id: string, key: string, selected: boolean): void;
  clearSelection(id: string): void;
  reloadFragment(id: string, key: string, kind: UiFragmentKind): void;
  /** Aborts the page signal the list was installed with, as closing its page does. */
  close(id: string): void;
  state(id: string): UiCardListState;
  /** One list's current snapshot, as the presentation reads it. */
  snapshot(id: string): unknown;
  /** State the installed list retains for its page's history entry. */
  capture(id: string): UiCardListRetainedState;
  /** Lifecycle of the restoration the installed list performs, as the page reads it. */
  restoration(id: string): UiCardListRestorationReport;
  pageRequests(): readonly UiCardListPageRequest[];
  settlePage(
    id: number,
    page: {
      readonly entries: readonly UiListEntry[];
      readonly continuation?: string | null;
      readonly current?: boolean;
    },
  ): void;
  /** Answers a request with the report that its sequence was invalidated and must restart. */
  invalidatePage(id: number): void;
  failPage(id: number, message: string): void;
  fragmentRequests(): readonly UiCardListFragmentRequest[];
  settleFragment(id: number, results: readonly UiFragmentResult<unknown>[]): void;
  failFragment(id: number, message: string): void;
  toolRequests(): readonly UiCardListToolRequest[];
  settleTool(id: number, outcome: UiOperationOutcome): void;
  failTool(id: number, message: string): void;
  /** Delivers one committed-change notification to an installed list. */
  changed(id: string, change: UiListChange): void;
  observationRequests(): readonly UiCardListObservationRequest[];
  settleObservation(id: number, state: 'incorporated' | 'delayed' | 'failed'): void;
  failObservation(id: number, message: string): void;
}

interface Pending<Value> {
  resolve(value: Value): void;
  reject(cause: Error): void;
}

interface PageRecord {
  readonly id: number;
  readonly list: string;
  readonly context: string | null | undefined;
  readonly pageSize: number;
  readonly continuation: string | null;
  readonly required: readonly string[];
  isAborted(): boolean;
}

interface ObservationRecord {
  readonly id: number;
  readonly list: string;
  readonly positions: readonly string[];
  isAborted(): boolean;
}

/** Installs the CardList harness into `root`; journeys install and drive lists afterwards. */
export function installCardListHarness(root: Element | null): UiCardListControl {
  if (root === null) {
    throw new Error('The CardList journey needs its root element.');
  }
  const document = root.ownerDocument;
  const lists = new Map<string, UiCardList<string | null | undefined>>();
  const containers = new Map<string, HTMLElement>();
  const controllers = new Map<string, AbortController>();
  const pages: PageRecord[] = [];
  const fragments: UiCardListFragmentRequest[] = [];
  const invocations: UiCardListToolRequest[] = [];
  const restorations = new Map<string, UiCardListRestorationReport>();
  const pendingPages = new Map<number, Pending<UiListRead>>();
  const pendingFragments = new Map<number, Pending<readonly UiFragmentResult<unknown>[]>>();
  const retiredFragments = new Set<number>();
  const pendingTools = new Map<number, Pending<UiOperationOutcome>>();
  const changeSources = new Map<string, Set<(change: UiListChange) => void>>();
  const observations: ObservationRecord[] = [];
  const pendingObservations = new Map<number, Pending<'incorporated' | 'delayed' | 'failed'>>();
  let sequence = 0;

  return {
    install(id, options = {}) {
      const container = document.createElement('div');
      container.id = `list-${id}`;
      if (options.scrollable === true) {
        container.style.height = '60px';
        container.style.overflowY = 'auto';
      }
      root.append(container);
      containers.set(id, container);
      const readers: Record<string, UiFragmentReader<unknown>> = {};
      for (const kind of options.fragments ?? []) {
        readers[kind] = fragmentReader(id, kind);
      }
      const tools: UiCardListTool[] = (options.tools ?? []).map((tool) => ({
        id: tool.id,
        label: tool.label,
        tool: toolInvocation(id, tool.id),
      }));
      const controller = new AbortController();
      controllers.set(id, controller);
      const listeners = options.changes === true ? new Set<(change: UiListChange) => void>() : null;
      if (listeners !== null) {
        changeSources.set(id, listeners);
      }
      const installed = createCardListView<string | null | undefined>({
        container,
        // The journey installs the component's own default implementation behind the factory the
        // pages receive (docs/architecture.md#composition-and-replacement).
        create: createCardList,
        source: pageSource(id, options.observations === true),
        context: options.context ?? 'result',
        accountId: harnessAccount,
        pageSize: options.pageSize ?? 2,
        ...(options.restored === undefined
          ? {}
          : {
              restored: options.restored === null ? null : retainedHandleOf(options.restored),
            }),
        fragments: readers as unknown as UiCardListFragments,
        tools,
        ...(listeners === null
          ? {}
          : {
              changes: {
                subscribe(listener: (change: UiListChange) => void) {
                  listeners.add(listener);
                  return () => listeners.delete(listener);
                },
              },
            }),
        ...(options.openEntry === true
          ? { presentation: { renderEntry: (entry: UiListEntry) => openLink(document, entry) } }
          : options.customEntry === true
            ? {
                presentation: {
                  renderEntry: (entry: UiListEntry) => customEntry(document, entry),
                },
              }
            : {}),
        signal: controller.signal,
      });
      lists.set(id, installed);
      const restoration = installed.restoration;
      restorations.set(
        id,
        restoration === null
          ? { status: 'none', message: null }
          : { status: 'pending', message: null },
      );
      restoration?.presented.then(
        () => restorations.set(id, { status: 'presented', message: null }),
        (cause: unknown) =>
          restorations.set(id, {
            status: 'interrupted',
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      );
    },
    refine(id, context) {
      list(id).refine(context);
    },
    invoke(id, toolId) {
      return list(id).invoke(toolId);
    },
    refresh(id) {
      list(id).refresh();
    },
    loadMore(id) {
      list(id).loadMore();
    },
    setSelected(id, key, selected) {
      list(id).setSelected(key, selected);
    },
    clearSelection(id) {
      list(id).clearSelection();
    },
    reloadFragment(id, key, kind) {
      list(id).reloadFragment(key, kind);
    },
    close(id) {
      controllers.get(id)?.abort();
      // A closed page's container leaves with it; the list disposed into it already.
      containers.get(id)?.remove();
      lists.delete(id);
      controllers.delete(id);
      containers.delete(id);
    },
    state(id) {
      const installed = list(id);
      return {
        entries: installed.entries.map((entry) => entry.key),
        selection: [...installed.selection],
        unavailableSelection: [...installed.unavailableSelection],
        hasMore: installed.hasMore,
        loading: installed.loading,
        error: installed.error,
      };
    },
    snapshot(id) {
      return list(id).snapshot();
    },
    capture(id) {
      // The component's handle is opaque; the journey reads the state it recorded, without the
      // scope a handle carries.
      const handle = list(id).capture() as unknown as UiCardListRetainedState &
        Readonly<Record<string, unknown>>;
      const state: Record<string, unknown> = { ...handle };
      delete state.kind;
      delete state.accountId;
      return state as unknown as UiCardListRetainedState;
    },
    restoration(id) {
      const report = restorations.get(id);
      if (report === undefined) {
        throw new Error(`No list ${id} is installed.`);
      }
      return report;
    },
    pageRequests() {
      return pages.map((page) => ({
        id: page.id,
        list: page.list,
        context: page.context,
        pageSize: page.pageSize,
        continuation: page.continuation,
        required: [...page.required],
        aborted: page.isAborted(),
      }));
    },
    observationRequests() {
      return observations.map((observation) => ({
        id: observation.id,
        list: observation.list,
        positions: [...observation.positions],
        aborted: observation.isAborted(),
      }));
    },
    settleObservation(id, state) {
      const pending = pendingObservations.get(id);
      if (pending === undefined) {
        throw new Error(`No observation ${id} is waiting.`);
      }
      pendingObservations.delete(id);
      pending.resolve(state);
    },
    failObservation(id, message) {
      const pending = pendingObservations.get(id);
      if (pending === undefined) {
        throw new Error(`No observation ${id} is waiting.`);
      }
      pendingObservations.delete(id);
      pending.reject(new Error(message));
    },
    settlePage(id, page) {
      const pending = pendingPages.get(id);
      if (pending === undefined) {
        throw new Error(`No page request ${id} is waiting.`);
      }
      pendingPages.delete(id);
      pending.resolve({
        status: 'page',
        entries: page.entries,
        continuation: page.continuation ?? null,
        current: page.current !== false,
      });
    },
    invalidatePage(id) {
      const pending = pendingPages.get(id);
      if (pending === undefined) {
        throw new Error(`No page request ${id} is waiting.`);
      }
      pendingPages.delete(id);
      pending.resolve({ status: 'invalidated' });
    },
    failPage(id, message) {
      const pending = pendingPages.get(id);
      if (pending === undefined) {
        throw new Error(`No page request ${id} is waiting.`);
      }
      pendingPages.delete(id);
      pending.reject(new Error(message));
    },
    fragmentRequests() {
      return fragments.map((fragment) => ({
        ...fragment,
        keys: [...fragment.keys],
        aborted: retiredFragments.has(fragment.id),
      }));
    },
    settleFragment(id, results) {
      const pending = pendingFragments.get(id);
      if (pending === undefined) {
        throw new Error(`No fragment request ${id} is waiting.`);
      }
      pendingFragments.delete(id);
      pending.resolve(results);
    },
    failFragment(id, message) {
      const pending = pendingFragments.get(id);
      if (pending === undefined) {
        throw new Error(`No fragment request ${id} is waiting.`);
      }
      pendingFragments.delete(id);
      pending.reject(new Error(message));
    },
    toolRequests() {
      return invocations.map((invocation) => ({
        ...invocation,
        targets: [...invocation.targets],
        selection: [...invocation.selection],
      }));
    },
    settleTool(id, outcome) {
      const pending = pendingTools.get(id);
      if (pending === undefined) {
        throw new Error(`No tool invocation ${id} is waiting.`);
      }
      pendingTools.delete(id);
      pending.resolve(outcome);
    },
    failTool(id, message) {
      const pending = pendingTools.get(id);
      if (pending === undefined) {
        throw new Error(`No tool invocation ${id} is waiting.`);
      }
      pendingTools.delete(id);
      pending.reject(new Error(message));
    },
    changed(id, change) {
      for (const listener of changeSources.get(id) ?? []) {
        listener(change);
      }
    },
  };

  /** Wraps one journey's described state into the handle the component validates and restores. */
  function retainedHandleOf(
    state: UiCardListRetainedState,
  ): CardListRetained<string | null | undefined> {
    return {
      kind: 'card-list-retained',
      accountId: harnessAccount,
      ...state,
      context: state.context,
    } as unknown as CardListRetained<string | null | undefined>;
  }

  function list(id: string): UiCardList<string | null | undefined> {
    const installed = lists.get(id);
    if (installed === undefined) {
      throw new Error(`No list ${id} is installed.`);
    }
    return installed;
  }

  /**
   * The link one browsing page renders for an entry: the page owns its element and gives it a
   * stable id, so the list can keep the focused entry through its own re-renderings.
   */
  function openLink(document: Document, entry: UiListEntry): Node {
    const link = document.createElement('a');
    link.id = `open-${entry.key}`;
    link.href = '#/cards/open';
    link.textContent = `Open ${describeTarget(entry.target)}`;
    return link;
  }

  /** The consumer's own entry content: it presents the counts of the snapshot it was rendered for. */
  function customEntry(document: Document, entry: UiListEntry): Node {
    const content = document.createElement('span');
    content.dataset.uiCustomEntry = entry.key;
    content.textContent =
      entry.quantity === null
        ? 'no counts'
        : `copies ${entry.quantity.copies ?? 'none'} intended ${entry.quantity.intended ?? 'none'}`;
    return content;
  }

  function next(): number {
    sequence += 1;
    return sequence;
  }

  function pageSource(
    id: string,
    observationsEnabled: boolean,
  ): UiListSource<string | null | undefined> {
    return {
      load(request) {
        const requestId = next();
        let aborted = false;
        request.signal.addEventListener('abort', () => {
          aborted = true;
        });
        pages.push({
          id: requestId,
          list: id,
          context: request.context,
          pageSize: request.pageSize,
          continuation: request.continuation,
          required: [...request.required.positions],
          isAborted: () => aborted,
        });
        return new Promise<UiListRead>((resolve, reject) => {
          pendingPages.set(requestId, { resolve, reject });
        });
      },
      ...(observationsEnabled
        ? {
            observe(request: {
              readonly positions: readonly string[];
              readonly signal: AbortSignal;
            }) {
              const observationId = next();
              let aborted = false;
              request.signal.addEventListener('abort', () => {
                aborted = true;
              });
              observations.push({
                id: observationId,
                list: id,
                positions: [...request.positions],
                isAborted: () => aborted,
              });
              return new Promise<'incorporated' | 'delayed' | 'failed'>((resolve, reject) => {
                pendingObservations.set(observationId, { resolve, reject });
              });
            },
          }
        : {}),
    };
  }

  function fragmentReader(id: string, kind: UiFragmentKind): UiFragmentReader<unknown> {
    return {
      read(request) {
        const requestId = next();
        fragments.push({
          id: requestId,
          list: id,
          kind,
          keys: [...request.keys],
          aborted: false,
        });
        request.signal.addEventListener('abort', () => {
          retiredFragments.add(requestId);
        });
        return new Promise<readonly UiFragmentResult<unknown>[]>((resolve, reject) => {
          pendingFragments.set(requestId, { resolve, reject });
        });
      },
    };
  }

  function toolInvocation(
    id: string,
    tool: string,
  ): {
    invoke(request: {
      readonly targets: readonly UiListEntry['target'][];
      readonly selection: { readonly keys: readonly string[] };
    }): Promise<UiOperationOutcome>;
  } {
    return {
      invoke(request) {
        const requestId = next();
        invocations.push({
          id: requestId,
          list: id,
          tool,
          targets: request.targets.map(describeTarget),
          selection: [...request.selection.keys],
        });
        return new Promise<UiOperationOutcome>((resolve, reject) => {
          pendingTools.set(requestId, { resolve, reject });
        });
      },
    };
  }
}

/** Target of one entry as the journeys assert it. */
export function describeTarget(target: UiListTarget): string {
  switch (target.kind) {
    case 'card':
      return `card:${target.cardId}`;
    case 'printing':
      return `printing:${target.printingId}`;
    case 'copy':
      return `copy:${target.copyId}`;
    case 'pending':
      return `pending:${target.entryId}`;
  }
}
