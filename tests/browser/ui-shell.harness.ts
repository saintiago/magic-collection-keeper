/**
 * Browser-side harness of the UserInterface shell journeys (docs/user-interface.md#interface,
 * docs/testing.md#browser-and-recognition-evidence).
 *
 * The harness replaces the boundaries the shell receives — identity transitions, the device
 * capability, the Application capabilities and the page implementations — with controlled
 * substitutes, so the journeys exercise real navigation and presentation behavior in Chromium
 * without a backend or a production account.
 */

import {
  createUserInterface,
  uiHref,
  type UiAccount,
  type UiIdentity,
  type UiPageDefinition,
  type UserInterface,
} from '../../src/ui/index.js';
import type { UserInterfaceCapabilities } from '../../src/application/index.js';

export interface UiShellControl {
  /** Verified account the shell presents, or null while signed out. */
  accountId(): string | null;
  /** Reports a verified sign-in of another account, as the deployment's authentication would. */
  signInAs(accountId: string): void;
  /** Reports a sign-out. */
  signOut(): void;
  /** Completes the sign-out the shell awaits, reporting the verified sign-out as the deployment would. */
  completeSignOut(): void;
  /** Rejects the sign-out the shell awaits, as an authentication outage would. */
  failSignOut(message: string): void;
  /** Settles the controlled device release, rejecting when a message is supplied. */
  completeDeviceRelease(message?: string): void;
  /** Answers the asynchronous page's held result requests, as the source's response arriving would. */
  answerAsyncResults(): void;
  /** Inserts late content above the presented window, as decoded images or fragments would. */
  shiftAsyncLayout(): void;
  /** Result requests the asynchronous page holds, waiting for the journey to answer them. */
  asyncPending(): number;
  /** Notes the harness recorded, oldest first. */
  log(): string[];
  /** Releases the shell and its listeners. */
  dispose(): void;
}

export interface UiShellStart {
  /** Starts without a verified account instead of signed in as the first account. */
  readonly signedOut?: boolean;
  /** Holds each sign-out until the journey completes or rejects it through the control. */
  readonly deferredSignOut?: boolean;
  readonly deviceRelease?: 'deferred' | 'throw';
  /** Presents the asynchronous Home page instead of the immediate one. */
  readonly asyncResults?: boolean;
  /**
   * Presents the asynchronous page's restored entry by sending the user on to Collection, as a
   * page that redirects while presenting the entry does; `replace` keeps no way back to the entry.
   */
  readonly presentedRedirect?: 'navigate' | 'replace';
}

/** Installs the shell into `root`; its identity starts signed in unless `signedOut` is set. */
export function installUiShell(root: Element | null, start: UiShellStart = {}): UiShellControl {
  if (root === null) {
    throw new Error('The shell journey needs its root element.');
  }
  const document = root.ownerDocument;
  const log: string[] = [];
  let account: UiAccount | null =
    start.signedOut === true ? null : { accountId: 'alice', displayName: 'Alice' };
  const listeners = new Set<(account: UiAccount | null) => void>();
  let pendingSignOut: { resolve(): void; reject(cause: Error): void } | null = null;

  let pendingDeviceRelease: { resolve(): void; reject(cause: Error): void } | null = null;
  const asyncResults = createAsyncResults();

  const identity: UiIdentity = {
    current: () => account,
    signIn: () => {
      report({ accountId: 'bob', displayName: 'Bob' });
    },
    signOut: () => {
      if (start.deferredSignOut !== true) {
        report(null);
        return;
      }
      return new Promise<void>((resolve, reject) => {
        pendingSignOut = { resolve, reject };
      });
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const request = Object.assign(
    async (path: string) => {
      log.push(`request:${path}`);
      return {};
    },
    {
      endSession: () => {
        log.push('session-ended');
      },
    },
  );
  const capabilities: UserInterfaceCapabilities = {
    settings: {
      environment: 'test',
      apiBaseUrl: 'https://api.test.keeper.example',
      authentication: { region: 'us-east-1', appClientId: 'keeper-test-client' },
      recognition: { cloudEnabled: false, computeBaseUrl: null },
      capabilities: { sourceImports: false },
    },
    request,
    createRecognition: () => {
      throw new Error('The shell journey does not run recognition.');
    },
  };
  const shell: UserInterface = createUserInterface({
    root,
    capabilities,
    identity,
    device: {
      release: () => {
        log.push('device-released');
        if (start.deviceRelease === 'throw') {
          throw new Error('Device unavailable');
        }
        if (start.deviceRelease === 'deferred') {
          return new Promise<void>((resolve, reject) => {
            pendingDeviceRelease = { resolve, reject };
          });
        }
      },
    },
    pages: fixturePages(
      document,
      log,
      start.asyncResults === true ? asyncResults : null,
      start.presentedRedirect ?? null,
    ),
  });

  function report(next: UiAccount | null): void {
    account = next;
    for (const listener of [...listeners]) {
      listener(next);
    }
  }

  return {
    accountId: () => account?.accountId ?? null,
    signInAs: (accountId) => {
      report({ accountId, displayName: accountId });
    },
    signOut: () => {
      report(null);
    },
    completeSignOut: () => {
      const pending = pendingSignOut;
      pendingSignOut = null;
      report(null);
      pending?.resolve();
    },
    failSignOut: (message) => {
      const pending = pendingSignOut;
      pendingSignOut = null;
      pending?.reject(new Error(message));
    },
    completeDeviceRelease: (message) => {
      const pending = pendingDeviceRelease;
      pendingDeviceRelease = null;
      if (pending === null) throw new Error('No device release is pending.');
      if (message === undefined) pending.resolve();
      else pending.reject(new Error(message));
    },
    answerAsyncResults: () => {
      asyncResults.answer();
    },
    shiftAsyncLayout: () => {
      asyncResults.grow();
    },
    asyncPending: () => asyncResults.pending(),
    log: () => [...log],
    dispose: () => {
      shell.dispose();
    },
  };
}

/** The pages this harness presents: the shell frame plus the content the journeys assert on. */
function fixturePages(
  document: Document,
  log: string[],
  asyncResults: AsyncResults | null,
  presentedRedirect: 'navigate' | 'replace' | null,
): readonly UiPageDefinition[] {
  return [
    asyncResults === null
      ? homePage(document, log)
      : asyncHomePage(document, log, asyncResults, presentedRedirect),
    catalogPage(document),
    cardPage(document, log),
    collectionPage(document),
    statePage(document),
    redirectPage(document, log),
    devicePage(document, log),
  ];
}

/**
 * Held result requests of the asynchronous fixture. A journey answers them one response at a time,
 * so it can interrupt a history restoration before or between the pages it reloads.
 */
interface AsyncResults {
  /** Waits until the journey answers this request. */
  hold(): Promise<void>;
  /** Answers every request waiting now, as those source responses arriving would. */
  answer(): void;
  /** Requests waiting for their answer. */
  pending(): number;
  /** Inserts content above the presented window, as late layout arriving would. */
  grow(): void;
  /** Adopts the presented page's own way of growing; the mount presented now is the one that grows. */
  adoptGrow(apply: () => void): void;
}

function createAsyncResults(): AsyncResults {
  const waiting: (() => void)[] = [];
  let grow = (): void => {};
  return {
    hold: () => new Promise<void>((resolve) => waiting.push(resolve)),
    answer: () => {
      for (const resolve of waiting.splice(0)) {
        resolve();
      }
    },
    pending: () => waiting.length,
    grow: () => {
      grow();
    },
    adoptGrow: (apply) => {
      grow = apply;
    },
  };
}

/** Entries the asynchronous fixture serves and the entries one response of it carries. */
const asyncResultTotal = 100;
const asyncResultPageSize = 50;

/**
 * Asynchronous Home of the interrupted-restoration journeys: it serves its results in pages a
 * journey answers one response at a time, keeps the entries it presented as its own restoration
 * state, and a visit that restores them reports the presentation only once the window the history
 * entry kept is back (docs/user-interface.md#pages-and-navigation). A visit that redirects while
 * presenting sends the user to Collection instead.
 */
function asyncHomePage(
  document: Document,
  log: string[],
  results: AsyncResults,
  redirect: 'navigate' | 'replace' | null,
): UiPageDefinition {
  return {
    page: 'home',
    mount(container, context) {
      const restored = context.restored?.state ?? null;
      const kept = readLoadedWindow(restored);
      const target = kept > 0 ? kept : asyncResultTotal;
      const status = document.createElement('p');
      status.id = 'async-loaded';
      const host = document.createElement('ol');
      const tail = document.createElement('div');
      tail.style.height = '600px';
      // Late content the journey inserts above the presented window, as decoded images would.
      const late = document.createElement('div');
      late.style.height = '400px';
      results.adoptGrow(() => {
        if (!container.contains(late)) {
          container.prepend(late);
        }
      });
      container.append(status, host, tail);
      const presented = Promise.withResolvers<void>();
      let loaded = 0;
      let next = 1;
      let done = false;
      renderLoaded();
      load();
      return {
        // The entry keeps the window it is restoring until the source has presented it again, so a
        // history entry interrupted while loading it keeps that window
        // (docs/user-interface.md#state-ownership-and-restoration).
        capture: () => ({ loaded: done || kept === 0 ? loaded : kept }),
        ...(kept > 0 ? { presented: () => presentKeptWindow() } : {}),
      };

      /**
       * Reports the presentation of the kept window, or — a page that presents the restored entry
       * by redirecting — sends the user on while the shell is restoring that entry.
       */
      function presentKeptWindow(): void | Promise<void> {
        if (redirect === null) {
          return presented.promise;
        }
        log.push(`async-presented:${redirect}`);
        if (redirect === 'replace') {
          context.replace({ page: 'collection' });
          return;
        }
        context.navigate({ page: 'collection' });
      }

      /** Asks for the next page of the result; the journey answers it as the source would. */
      function load(): void {
        if (done || next > asyncResultTotal) {
          return;
        }
        const from = next;
        const to = Math.min(from + asyncResultPageSize - 1, asyncResultTotal);
        next = to + 1;
        void results.hold().then(() => {
          if (context.signal.aborted) {
            return;
          }
          for (let index = from; index <= to; index += 1) {
            host.append(resultRow(document, index));
          }
          loaded = to;
          renderLoaded();
          log.push(`async-loaded:${loaded}`);
          if (loaded >= target) {
            done = true;
            presented.resolve();
            return;
          }
          load();
        });
      }

      function renderLoaded(): void {
        status.textContent = `${loaded} results`;
      }
    },
  };
}

/** One result of the asynchronous fixture; a journey focuses and opens it. */
function resultRow(document: Document, index: number): HTMLLIElement {
  const row = document.createElement('li');
  row.style.height = '60px';
  const link = document.createElement('a');
  link.id = `async-result-${index}`;
  link.href = uiHref({ page: 'card', cardId: `card-${index}`, printingId: null, copyId: null });
  link.textContent = `Result ${index}`;
  row.append(link);
  return row;
}

/** Entries the restored history entry had presented, or zero when it kept none. */
function readLoadedWindow(state: unknown): number {
  const value = readRecord(state)?.loaded;
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= asyncResultTotal
    ? value
    : 0;
}

/** One page-owned state object, or null when the entry kept none or kept another shape. */
function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

/** Home keeps a query, two independent selections, an opening link, a dialog and long content. */
function homePage(document: Document, log: string[]): UiPageDefinition {
  return {
    page: 'home',
    // Reported for every account the shell leaves, whatever page is presented at that moment.
    accountEnded: (accountId) => log.push(`account-ended:${accountId}`),
    mount(container, context) {
      const query = document.createElement('input');
      query.id = 'home-query';
      query.setAttribute('aria-label', 'Search cards');
      const guard = checkbox(document, 'home-guard', 'Select Guard');
      const bolt = checkbox(document, 'home-bolt', 'Select Bolt');
      // The lead keeps the opening link near the top of a scrolled window, and the tail keeps the
      // page long enough that a journey can restore a non-zero scroll offset.
      const lead = document.createElement('div');
      lead.style.height = '600px';
      const tail = document.createElement('div');
      tail.style.height = '3000px';
      const open = document.createElement('a');
      open.id = 'home-open';
      open.href = uiHref({
        page: 'card',
        cardId: 'card-1',
        printingId: 'printing-1',
        copyId: null,
      });
      open.textContent = 'Open printing';
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.textContent = 'Edit tag';
      // The page itself navigates, so a journey can prove the shell still honours its context.
      const go = document.createElement('button');
      go.type = 'button';
      go.textContent = 'Go to collection';
      go.addEventListener('click', () => {
        context.navigate({ page: 'collection' });
      });
      const answer = document.createElement('p');
      answer.id = 'home-dialog-answer';
      answer.textContent = 'no dialog';
      edit.addEventListener('click', () => {
        void context.dialogs
          .confirm({
            title: 'Rename tag',
            message: 'Rename this tag?',
            confirmLabel: 'Rename',
            cancelLabel: 'Cancel',
          })
          .then((confirmed) => {
            answer.textContent = confirmed ? 'confirmed' : 'cancelled';
          });
      });
      container.append(query, guard, bolt, lead, open, edit, go, answer, tail);

      const restored = readRecord(context.restored?.state);
      if (restored !== null) {
        query.value = typeof restored.query === 'string' ? restored.query : '';
        guard.checked = restored.guard === true;
        bolt.checked = restored.bolt === true;
        log.push('home-restored');
      }
      return {
        capture: () => ({ query: query.value, guard: guard.checked, bolt: bolt.checked }),
      };
    },
  };
}

/**
 * State ownership fixture: the page keeps its own representation — a selection far beyond any
 * history storage bound beside an unrelated draft — and hands the very same shape back, so a
 * journey proves that navigation retains the page state without reading or restricting it
 * (docs/user-interface.md#state-ownership-and-restoration).
 */
function statePage(document: Document): UiPageDefinition {
  return {
    page: 'tags',
    mount(container, context) {
      const draft = document.createElement('input');
      draft.id = 'state-draft';
      draft.setAttribute('aria-label', 'State draft');
      const selectMany = document.createElement('button');
      selectMany.type = 'button';
      selectMany.textContent = 'Select many';
      const count = document.createElement('p');
      count.id = 'state-count';
      const open = document.createElement('a');
      open.id = 'state-open';
      open.href = uiHref({ page: 'collection' });
      open.textContent = 'Open collection';
      container.append(draft, selectMany, count, open);

      const restored = readRecord(context.restored?.state);
      const kept = Array.isArray(restored?.selection) ? restored.selection : [];
      const selection = new Set<string>(
        kept.filter((key): key is string => typeof key === 'string'),
      );
      if (typeof restored?.draft === 'string') {
        draft.value = restored.draft;
      }
      selectMany.addEventListener('click', () => {
        for (let index = 0; index < 150; index += 1) {
          selection.add(`card:${index}`);
        }
        render();
      });
      render();
      return {
        capture: () => ({
          selection: [...selection],
          draft: draft.value,
          nested: { only: 'the page interprets this' },
        }),
      };

      function render(): void {
        count.textContent = `${selection.size} selected`;
      }
    },
  };
}

/** Catalog presents the query the URL identified, so a deep link can be observed. */
function catalogPage(document: Document): UiPageDefinition {
  return {
    page: 'catalog',
    mount(container, context) {
      const query = document.createElement('p');
      query.id = 'catalog-query';
      query.textContent =
        context.view.page === 'catalog' ? `Query: ${context.view.query}` : 'Query:';
      container.append(query);
    },
  };
}

/**
 * Card details name their specificity level and start work that outlives the view: the delayed
 * result writes into the container the page owns, so a journey can prove that a late result never
 * reaches the view that replaced it.
 */
function cardPage(document: Document, log: string[]): UiPageDefinition {
  return {
    page: 'card',
    mount(container, context) {
      const level = document.createElement('p');
      level.id = 'card-level';
      level.textContent =
        context.view.page === 'card'
          ? `${context.view.cardId}/${context.view.printingId ?? '-'}/${context.view.copyId ?? '-'}`
          : 'none';
      const late = document.createElement('p');
      late.id = 'card-late';
      container.append(level, late);
      log.push('card-mounted');
      const view = container.ownerDocument.defaultView;
      context.signal.addEventListener('abort', () => {
        log.push('card-aborted');
        // Work a closed page still holds must reach neither the new view nor its resources.
        view?.setTimeout(() => {
          late.textContent = 'Card loaded';
          log.push('card-loaded');
          context.device.release();
          log.push('card-device-released');
          void context.dialogs
            .confirm({
              title: 'Card detail',
              message: 'Detail of the closed card view',
              confirmLabel: 'Confirm',
              cancelLabel: 'Cancel',
            })
            .then((confirmed) => log.push(`card-dialog:${confirmed}`));
        }, 150);
      });
    },
  };
}

/**
 * Collection returns no handle at all, yet the shell still owns its focus and scroll; the page is
 * long enough and holds a link, so a journey can leave it scrolled and focused and return.
 */
function collectionPage(document: Document): UiPageDefinition {
  return {
    page: 'collection',
    mount(container) {
      const marker = document.createElement('p');
      marker.id = 'collection-marker';
      marker.textContent = 'Collection page';
      const lead = document.createElement('div');
      lead.style.height = '600px';
      const open = document.createElement('a');
      open.id = 'collection-open';
      open.href = uiHref({ page: 'tags' });
      open.textContent = 'Open tags';
      const tail = document.createElement('div');
      tail.style.height = '3000px';
      container.append(marker, lead, open, tail);
    },
  };
}

/**
 * A tag view that presents Home while mounting and still returns its own handle, so a journey can
 * prove the page that redirected away owns no handle of the view it replaced.
 */
function redirectPage(document: Document, log: string[]): UiPageDefinition {
  return {
    page: 'tag',
    mount(container, context) {
      const marker = document.createElement('p');
      marker.id = 'tag-marker';
      marker.textContent = 'Tag view';
      container.append(marker);
      if (context.view.page !== 'tag' || context.view.tagId !== 'redirect') {
        return;
      }
      log.push('redirect-mounted');
      context.replace({ page: 'home' });
      return {
        capture: () => ({ from: 'redirect' }),
        dispose: () => log.push('redirect-disposed'),
      };
    },
  };
}

function checkbox(document: Document, id: string, label: string): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.id = id;
  input.setAttribute('aria-label', label);
  return input;
}

/** Exercises the supplied device through an active page and its synchronous teardown. */
function devicePage(document: Document, log: string[]): UiPageDefinition {
  return {
    page: 'import',
    mount(container, context) {
      const release = document.createElement('button');
      release.textContent = 'Release device';
      const result = document.createElement('p');
      result.setAttribute('role', 'status');
      release.addEventListener('click', () => {
        void (async () => {
          result.textContent = 'Releasing';
          try {
            await context.device.release();
            result.textContent = 'Released';
          } catch {
            result.textContent = 'Release failed';
          }
        })();
      });
      const replace = document.createElement('button');
      replace.textContent = 'Replace with collection';
      replace.addEventListener('click', () => context.replace({ page: 'collection' }));
      container.append(release, replace, result);
      context.signal.addEventListener('abort', () => {
        context.device.release();
        log.push('abort-release-called');
        // Microtasks already run after synchronous teardown and must lose access.
        queueMicrotask(() => {
          context.device.release();
          log.push('late-release-called');
        });
      });
      return {
        dispose() {
          context.device.release();
          log.push('dispose-release-called');
        },
      };
    },
  };
}
