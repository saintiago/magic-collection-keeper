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
  /** Notes the harness recorded, oldest first. */
  log(): string[];
  /** Releases the shell and its listeners. */
  dispose(): void;
}

/** Installs the shell into `root`; its identity starts signed in unless `signedOut` is set. */
export function installUiShell(
  root: Element | null,
  start: { readonly signedOut?: boolean } = {},
): UiShellControl {
  if (root === null) {
    throw new Error('The shell journey needs its root element.');
  }
  const document = root.ownerDocument;
  const log: string[] = [];
  let account: UiAccount | null =
    start.signedOut === true ? null : { accountId: 'alice', displayName: 'Alice' };
  const listeners = new Set<(account: UiAccount | null) => void>();

  const identity: UiIdentity = {
    current: () => account,
    signIn: () => {
      report({ accountId: 'bob', displayName: 'Bob' });
    },
    signOut: () => {
      report(null);
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
      container.append(query, guard, bolt, lead, open, edit, answer, tail);

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
      context.signal.addEventListener('abort', () => {
        log.push('card-aborted');
      });
      container.ownerDocument.defaultView?.setTimeout(() => {
        late.textContent = 'Card loaded';
        log.push('card-loaded');
      }, 150);
    },
  };
}

function collectionPage(document: Document): UiPageDefinition {
  return {
    page: 'collection',
    mount(container) {
      const marker = document.createElement('p');
      marker.id = 'collection-marker';
      marker.textContent = 'Collection page';
      container.append(marker);
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
