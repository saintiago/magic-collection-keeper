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
    pages: fixturePages(document, log),
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
    log: () => [...log],
    dispose: () => {
      shell.dispose();
    },
  };
}

/** The pages this harness presents: the shell frame plus the content the journeys assert on. */
function fixturePages(document: Document, log: string[]): readonly UiPageDefinition[] {
  return [
    homePage(document, log),
    catalogPage(document),
    cardPage(document, log),
    collectionPage(document),
    redirectPage(document, log),
    devicePage(document, log),
  ];
}

/** Home keeps a query, two independent selections, an opening link, a dialog and long content. */
function homePage(document: Document, log: string[]): UiPageDefinition {
  return {
    page: 'home',
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

      const restored = context.restored?.state ?? null;
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
