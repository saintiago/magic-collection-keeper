/**
 * Browser-side harness of the CardList journeys (docs/user-interface.md#list-boundary,
 * docs/user-interface.md#cardlist, docs/testing.md#browser-and-recognition-evidence).
 *
 * The harness installs real CardLists over controlled sources, fragment readers and tools. Every
 * page, fragment and tool request is recorded and settled from the journey, so response ordering,
 * independent fragment failure and retry, bounded requests and tool outcomes are driven exactly
 * while the journeys observe the real presentation.
 */

import {
  createCardList,
  type UiCardList,
  type UiCardListFragments,
  type UiCardListTool,
  type UiFragmentKind,
  type UiFragmentReader,
  type UiFragmentResult,
  type UiListEntry,
  type UiListPage,
  type UiListSource,
  type UiOperationOutcome,
} from '../../src/ui/index.js';

/** One list the journey installs. */
export interface UiCardListInstall {
  /** Entries one request asks for; the CardList's declared bound applies. */
  readonly pageSize?: number;
  /** Query context the list evaluates. */
  readonly context?: string;
  /** Fragment kinds the list reads; the others are not presented. */
  readonly fragments?: readonly UiFragmentKind[];
  /** Tools the list presents, in order. */
  readonly tools?: readonly { readonly id: string; readonly label: string }[];
}

/** One page request the controlled source recorded. */
export interface UiCardListPageRequest {
  readonly id: number;
  readonly list: string;
  readonly context: string;
  readonly pageSize: number;
  readonly continuation: string | null;
  readonly aborted: boolean;
}

/** One fragment request the controlled readers recorded. */
export interface UiCardListFragmentRequest {
  readonly id: number;
  readonly list: string;
  readonly kind: UiFragmentKind;
  readonly keys: readonly string[];
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
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly error: string | null;
}

export interface UiCardListControl {
  install(id: string, options?: UiCardListInstall): void;
  /** Presents another query context through the list. */
  refine(id: string, context: string): void;
  refresh(id: string): void;
  reloadFragment(id: string, key: string, kind: UiFragmentKind): void;
  /** Aborts the page signal the list was installed with, as closing its page does. */
  close(id: string): void;
  state(id: string): UiCardListState;
  pageRequests(): readonly UiCardListPageRequest[];
  settlePage(
    id: number,
    page: { readonly entries: readonly UiListEntry[]; readonly continuation?: string | null },
  ): void;
  failPage(id: number, message: string): void;
  fragmentRequests(): readonly UiCardListFragmentRequest[];
  settleFragment(id: number, results: readonly UiFragmentResult<unknown>[]): void;
  failFragment(id: number, message: string): void;
  toolRequests(): readonly UiCardListToolRequest[];
  settleTool(id: number, outcome: UiOperationOutcome): void;
  failTool(id: number, message: string): void;
}

interface Pending<Value> {
  resolve(value: Value): void;
  reject(cause: Error): void;
}

interface PageRecord {
  readonly id: number;
  readonly list: string;
  readonly context: string;
  readonly pageSize: number;
  readonly continuation: string | null;
  isAborted(): boolean;
}

/** Installs the CardList harness into `root`; journeys install and drive lists afterwards. */
export function installCardListHarness(root: Element | null): UiCardListControl {
  if (root === null) {
    throw new Error('The CardList journey needs its root element.');
  }
  const document = root.ownerDocument;
  const lists = new Map<string, UiCardList<string>>();
  const controllers = new Map<string, AbortController>();
  const pages: PageRecord[] = [];
  const fragments: UiCardListFragmentRequest[] = [];
  const invocations: UiCardListToolRequest[] = [];
  const pendingPages = new Map<number, Pending<UiListPage>>();
  const pendingFragments = new Map<number, Pending<readonly UiFragmentResult<unknown>[]>>();
  const pendingTools = new Map<number, Pending<UiOperationOutcome>>();
  let sequence = 0;

  return {
    install(id, options = {}) {
      const container = document.createElement('div');
      container.id = `list-${id}`;
      root.append(container);
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
      lists.set(
        id,
        createCardList({
          container,
          source: pageSource(id),
          context: options.context ?? 'result',
          pageSize: options.pageSize ?? 2,
          fragments: readers as unknown as UiCardListFragments,
          tools,
          signal: controller.signal,
        }),
      );
    },
    refine(id, context) {
      list(id).refine(context);
    },
    refresh(id) {
      list(id).refresh();
    },
    reloadFragment(id, key, kind) {
      list(id).reloadFragment(key, kind);
    },
    close(id) {
      controllers.get(id)?.abort();
    },
    state(id) {
      const installed = list(id);
      return {
        entries: installed.entries.map((entry) => entry.key),
        selection: [...installed.selection],
        hasMore: installed.hasMore,
        loading: installed.loading,
        error: installed.error,
      };
    },
    pageRequests() {
      return pages.map((page) => ({
        id: page.id,
        list: page.list,
        context: page.context,
        pageSize: page.pageSize,
        continuation: page.continuation,
        aborted: page.isAborted(),
      }));
    },
    settlePage(id, page) {
      const pending = pendingPages.get(id);
      if (pending === undefined) {
        throw new Error(`No page request ${id} is waiting.`);
      }
      pendingPages.delete(id);
      pending.resolve({ entries: page.entries, continuation: page.continuation ?? null });
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
      return fragments.map((fragment) => ({ ...fragment, keys: [...fragment.keys] }));
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
  };

  function list(id: string): UiCardList<string> {
    const installed = lists.get(id);
    if (installed === undefined) {
      throw new Error(`No list ${id} is installed.`);
    }
    return installed;
  }

  function next(): number {
    sequence += 1;
    return sequence;
  }

  function pageSource(id: string): UiListSource<string> {
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
          context: String(request.context),
          pageSize: request.pageSize,
          continuation: request.continuation,
          isAborted: () => aborted,
        });
        return new Promise<UiListPage>((resolve, reject) => {
          pendingPages.set(requestId, { resolve, reject });
        });
      },
    };
  }

  function fragmentReader(id: string, kind: UiFragmentKind): UiFragmentReader<unknown> {
    return {
      read(request) {
        const requestId = next();
        fragments.push({ id: requestId, list: id, kind, keys: [...request.keys] });
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
export function describeTarget(target: UiListEntry['target']): string {
  switch (target.kind) {
    case 'card':
      return `card:${target.cardId}`;
    case 'printing':
      return `printing:${target.printingId}`;
    case 'copy':
      return `copy:${target.copyId}`;
  }
}
