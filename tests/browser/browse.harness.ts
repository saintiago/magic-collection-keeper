/**
 * Browser-side harness of the browsing pages (docs/user-interface.md#pages-and-navigation,
 * docs/user-interface.md#browsing-and-organization,
 * docs/testing.md#browser-and-recognition-evidence).
 *
 * The harness installs the real shell with the real Home and catalog pages and replaces the
 * boundaries around them: identity, the device capability and the component access Application
 * supplies. Every Search request and Catalog resolve the pages issue is recorded and settled from
 * the journey, so the journeys drive the real query building, list presentation and navigation
 * while observing exactly what crossed the component contracts. The browsing journeys present a
 * marker fixture in place of the card-details page: they assert which card an entry opened, not
 * what the details present, and the marker proves that. Identity can
 * hold a sign-out until the journey completes or rejects it, so the journeys drive the session and
 * account transitions the private browsing state follows.
 */

import { idleProgress } from './card-list-progress.js';

import {
  ApplicationError,
  type ApplicationFailureCode,
  type SearchClient,
  type UserInterfaceCapabilities,
} from '../../src/application/index.js';
import type {
  Catalog,
  CatalogReference,
  CatalogResolution,
  PrintingRecord,
} from '../../src/catalog/index.js';
import { createCardListBrowser } from '../../src/card-list/index.js';
import type { SearchPage, SearchRequestInput } from '../../src/search/index.js';
import {
  createBrowsePages,
  createUserInterface,
  type UiAccount,
  type UiIdentity,
  type UiPageDefinition,
  type UserInterface,
} from '../../src/ui/index.js';

import { unusedUserCards } from './unused-usercards.js';
import { unusedCapture } from './unused-capture.js';

/** One Search request the catalog page issued. */
export interface UiBrowseSearchRequest {
  readonly id: number;
  readonly request: SearchRequestInput;
  /** Whether closing the page withdrew the request before the journey settled it. */
  readonly aborted: boolean;
}

/** One Catalog resolve the images fragment issued. */
export interface UiBrowseCatalogRequest {
  readonly id: number;
  readonly references: readonly CatalogReference[];
}

export interface UiBrowseStart {
  /** Holds each sign-out until the journey completes or rejects it through the control. */
  readonly deferredSignOut?: boolean;
}

export interface UiBrowseControl {
  /** Notes the harness recorded, oldest first. */
  log(): string[];
  readonly accountId: string | null;
  /** Reports a verified sign-in of another account, as the deployment's authentication would. */
  signInAs(accountId: string): void;
  /** Completes the sign-out the shell awaits, reporting the verified sign-out as it would. */
  completeSignOut(): void;
  /** Rejects the sign-out the shell awaits, as an authentication outage would. */
  failSignOut(message: string): void;
  searchRequests(): readonly UiBrowseSearchRequest[];
  settleSearch(id: number, page: SearchPage): void;
  failSearch(
    id: number,
    failure: { readonly code: ApplicationFailureCode; readonly message: string },
  ): void;
  catalogRequests(): readonly UiBrowseCatalogRequest[];
  /** Settles a resolve with the printings the catalog publishes for the requested references. */
  settleCatalog(id: number, printings: readonly PrintingRecord[]): void;
  failCatalog(id: number, message: string): void;
  /** Releases the shell and its listeners. */
  dispose(): void;
}

interface Pending<Value> {
  resolve(value: Value): void;
  reject(cause: Error): void;
}

interface SearchRecord {
  readonly id: number;
  readonly request: SearchRequestInput;
  isAborted(): boolean;
}

interface CatalogRecord {
  readonly id: number;
  readonly references: readonly CatalogReference[];
}

/** The published revision the harness resolves printings against. */
const harnessRevision = {
  revisionId: 'browse-revision',
  sourceName: 'fixture',
  sourceVersion: '1',
  publishedAt: '2026-09-01T00:00:00.000Z',
};

/** Installs the browsing pages into `root`; identity starts signed in as the first account. */
export function installBrowseHarness(
  root: Element | null,
  start: UiBrowseStart = {},
): UiBrowseControl {
  if (root === null) {
    throw new Error('The browsing journey needs its root element.');
  }
  const document = root.ownerDocument;
  const log: string[] = [];
  const searches: SearchRecord[] = [];
  const catalogs: CatalogRecord[] = [];
  const pendingSearches = new Map<number, Pending<SearchPage>>();
  const pendingCatalogs = new Map<number, Pending<CatalogResolution>>();
  let sequence = 0;
  let account: UiAccount | null = { accountId: 'alice', displayName: 'Alice' };
  const listeners = new Set<(account: UiAccount | null) => void>();
  let pendingSignOut: Pending<void> | null = null;

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
  const search: SearchClient = {
    execute(input, signal) {
      const id = next();
      searches.push({ id, request: input, isAborted: () => signal?.aborted === true });
      return new Promise<SearchPage>((resolve, reject) => {
        pendingSearches.set(id, { resolve, reject });
      });
    },
    counts: () => Promise.reject(new Error('The browsing journeys read no private counts.')),
    observe: () => Promise.reject(new Error('The browsing journeys observe no progress.')),
  };
  const catalog: Catalog = {
    resolve(references) {
      const id = next();
      catalogs.push({ id, references: [...references] });
      return new Promise<CatalogResolution>((resolve, reject) => {
        pendingCatalogs.set(id, { resolve, reject });
      });
    },
    listCardPrintings() {
      return Promise.reject(new Error('The browsing journeys read printings through resolve.'));
    },
  };
  // Application's own account lifecycle: leaving an account releases its local activity before
  // another account can present it (docs/architecture.md#runtime-boundaries).
  const cardList = createCardListBrowser({
    progress: idleProgress,
    search,
    catalog,
    userCards: unusedUserCards,
  });
  let presentedAccount: string | null = account?.accountId ?? null;
  identity.subscribe((next) => {
    const nextAccountId = next?.accountId ?? null;
    if (nextAccountId !== presentedAccount) {
      if (presentedAccount !== null) {
        cardList.endAccount(presentedAccount);
      }
      presentedAccount = nextAccountId;
    }
  });
  const capabilities: UserInterfaceCapabilities = {
    settings: {
      environment: 'test',
      apiBaseUrl: 'https://api.test.keeper.example',
      authentication: { region: 'us-east-1', appClientId: 'keeper-test-client' },
      recognition: { cloudEnabled: false, computeBaseUrl: null },
      capabilities: { sourceImports: false },
    },
    identity,
    request,
    catalog,
    search,
    // The browsing journeys present no private record, so the contract is only present to satisfy
    // the capabilities Application supplies.
    userCards: unusedUserCards,
    cardList,
    capture: unusedCapture(unusedUserCards),
    indexing: idleProgress,
  };
  const pages: readonly UiPageDefinition[] = [...createBrowsePages(), cardPage(document)];
  const shell: UserInterface = createUserInterface({
    root,
    capabilities,
    identity,
    pages,
  });

  function report(next: UiAccount | null): void {
    account = next;
    for (const listener of [...listeners]) {
      listener(next);
    }
  }

  function next(): number {
    sequence += 1;
    return sequence;
  }

  return {
    log: () => [...log],
    get accountId() {
      return account?.accountId ?? null;
    },
    signInAs: (accountId) => {
      report({ accountId, displayName: accountId });
    },
    completeSignOut() {
      const pending = pendingSignOut;
      pendingSignOut = null;
      report(null);
      pending?.resolve();
    },
    failSignOut(message) {
      const pending = pendingSignOut;
      pendingSignOut = null;
      pending?.reject(new Error(message));
    },
    searchRequests: () =>
      searches.map((record) => ({
        id: record.id,
        request: record.request,
        aborted: record.isAborted(),
      })),
    settleSearch(id, page) {
      const pending = pendingSearches.get(id);
      if (pending === undefined) {
        throw new Error(`No search request ${id} is waiting.`);
      }
      pendingSearches.delete(id);
      pending.resolve(page);
    },
    failSearch(id, failure) {
      const pending = pendingSearches.get(id);
      if (pending === undefined) {
        throw new Error(`No search request ${id} is waiting.`);
      }
      pendingSearches.delete(id);
      pending.reject(new ApplicationError(failure.code, failure.message));
    },
    catalogRequests: () =>
      catalogs.map((record) => ({ id: record.id, references: [...record.references] })),
    settleCatalog(id, printings) {
      const pending = pendingCatalogs.get(id);
      if (pending === undefined) {
        throw new Error(`No catalog resolve ${id} is waiting.`);
      }
      pendingCatalogs.delete(id);
      pending.resolve({
        revision: harnessRevision,
        cards: new Map(),
        printings: new Map(printings.map((printing) => [printing.printingId, printing])),
        missing: [],
      });
    },
    failCatalog(id, message) {
      const pending = pendingCatalogs.get(id);
      if (pending === undefined) {
        throw new Error(`No catalog resolve ${id} is waiting.`);
      }
      pendingCatalogs.delete(id);
      pending.reject(new Error(message));
    },
    dispose() {
      shell.dispose();
    },
  };
}

/** The card-details stand-in of the browsing journeys: it names the specificity level it opened. */
function cardPage(document: Document): UiPageDefinition {
  return {
    page: 'card',
    mount(container, context) {
      const marker = document.createElement('p');
      marker.id = 'card-level';
      marker.textContent =
        context.view.page === 'card'
          ? `${context.view.cardId}/${context.view.printingId ?? '-'}/${context.view.copyId ?? '-'}`
          : 'none';
      container.append(marker);
    },
  };
}
