/**
 * Browser-side harness of the collection pages (docs/user-interface.md#pages-and-navigation,
 * docs/user-interface.md#browsing-and-organization,
 * docs/testing.md#browser-and-recognition-evidence).
 *
 * The harness installs the real shell with the real collection and card-details pages and replaces
 * the boundaries around them: identity, the device capability and the component access Application
 * supplies. Every Search request, Catalog resolve, printing list, private copy read and copy
 * correction the pages issue is recorded and settled from the journey, so the journeys drive the
 * real query building, list presentation, navigation and copy editing while observing exactly what
 * crossed the component contracts.
 */

import {
  ApplicationError,
  type ApplicationFailureCode,
  type SearchClient,
  type UserCardsClient,
  type UserInterfaceCapabilities,
} from '../../src/application/index.js';
import type {
  CardPrintingsPage,
  Catalog,
  CatalogReference,
  CatalogResolution,
  ListCardPrintingsOptions,
  CardRecord,
  PrintingRecord,
} from '../../src/catalog/index.js';
import type { SearchPage, SearchRequestInput } from '../../src/search/index.js';
import type { CopyId, PhysicalCopy } from '../../src/usercards/index.js';
import {
  createCollectionPages,
  createUserInterface,
  type UiAccount,
  type UiIdentity,
  type UserInterface,
} from '../../src/ui/index.js';

import { unusedUserCards } from './unused-usercards.js';

/** One Search request the collection view issued. */
export interface UiCollectionSearchRequest {
  readonly id: number;
  readonly request: SearchRequestInput;
  /** Whether closing the page withdrew the request before the journey settled it. */
  readonly aborted: boolean;
}

/** One Catalog resolve the card-details page issued. */
export interface UiCollectionCatalogRequest {
  readonly id: number;
  readonly references: readonly CatalogReference[];
}

/** One printing-list read the card-details page issued. */
export interface UiCollectionPrintingsRequest {
  readonly id: number;
  readonly cardId: string;
  readonly options: ListCardPrintingsOptions;
}

/** One private copy read the collection or detail page issued. */
export interface UiCollectionCopyRead {
  readonly id: number;
  readonly copyIds: readonly string[];
  readonly aborted: boolean;
}

/** One copy correction the collection or detail page issued. */
export interface UiCollectionCorrection {
  readonly id: number;
  readonly input: {
    readonly copyId: string;
    readonly expectedRevision: number;
    readonly printingId: string;
    readonly finish: string;
    readonly condition: string | null;
  };
}

export interface UiCollectionControl {
  log(): string[];
  readonly accountId: string | null;
  searchRequests(): readonly UiCollectionSearchRequest[];
  settleSearch(id: number, page: SearchPage): void;
  failSearch(
    id: number,
    failure: { readonly code: ApplicationFailureCode; readonly message: string },
  ): void;
  catalogRequests(): readonly UiCollectionCatalogRequest[];
  settleCatalog(
    id: number,
    records: {
      readonly cards?: readonly CardRecord[];
      readonly printings?: readonly PrintingRecord[];
      readonly missing?: readonly CatalogReference[];
    },
  ): void;
  /** Settles the first waiting resolve that asks for the named reference. */
  settleCatalogFor(
    reference: CatalogReference,
    records: {
      readonly cards?: readonly CardRecord[];
      readonly printings?: readonly PrintingRecord[];
      readonly missing?: readonly CatalogReference[];
    },
  ): void;
  failCatalog(id: number, message: string): void;
  printingsRequests(): readonly UiCollectionPrintingsRequest[];
  settlePrintings(id: number, page: CardPrintingsPage): void;
  failPrintings(
    id: number,
    failure: { readonly code: ApplicationFailureCode; readonly message: string },
  ): void;
  copyReads(): readonly UiCollectionCopyRead[];
  settleCopyRead(
    id: number,
    result: { readonly copies: readonly PhysicalCopy[]; readonly missing?: readonly CopyId[] },
  ): void;
  failCopyRead(id: number, failure: { code: ApplicationFailureCode; message: string }): void;
  corrections(): readonly UiCollectionCorrection[];
  settleCorrection(id: number, copies: readonly PhysicalCopy[]): void;
  failCorrection(
    id: number,
    failure: { readonly code: ApplicationFailureCode; readonly message: string },
  ): void;
  navigate(view: Parameters<UserInterface['navigate']>[0]): void;
  dispose(): void;
}

interface Pending<Value> {
  resolve(value: Value): void;
  reject(cause: Error): void;
}

/** The published revision the harness resolves catalog records against. */
const harnessRevision = {
  revisionId: 'collection-revision',
  sourceName: 'fixture',
  sourceVersion: '1',
  publishedAt: '2026-09-01T00:00:00.000Z',
};

/** Whether one requested reference names the same record as another. */
function sameReference(left: CatalogReference, right: CatalogReference): boolean {
  if (left.kind === 'card' && right.kind === 'card') {
    return left.cardId === right.cardId;
  }
  if (left.kind === 'printing' && right.kind === 'printing') {
    return left.printingId === right.printingId;
  }
  return false;
}

/** Installs the collection pages into `root`; identity starts signed in. */
export function installCollectionHarness(root: Element | null): UiCollectionControl {
  if (root === null) {
    throw new Error('The collection journey needs its root element.');
  }
  const log: string[] = [];
  let sequence = 0;
  let account: UiAccount | null = { accountId: 'alice', displayName: 'Alice' };
  const listeners = new Set<(account: UiAccount | null) => void>();

  const searches: { record: Omit<UiCollectionSearchRequest, 'aborted'>; isAborted(): boolean }[] =
    [];
  const pendingSearches = new Map<number, Pending<SearchPage>>();
  const catalogResolves: UiCollectionCatalogRequest[] = [];
  const pendingCatalog = new Map<number, Pending<CatalogResolution>>();
  const printings: UiCollectionPrintingsRequest[] = [];
  const pendingPrintings = new Map<number, Pending<CardPrintingsPage>>();
  const copyReads: { record: Omit<UiCollectionCopyRead, 'aborted'>; isAborted(): boolean }[] = [];
  const pendingCopyReads = new Map<
    number,
    Pending<{ copies: Map<CopyId, PhysicalCopy>; missing: CopyId[] }>
  >();
  const corrections: UiCollectionCorrection[] = [];
  const pendingCorrections = new Map<number, Pending<readonly PhysicalCopy[]>>();

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
    { endSession: () => log.push('session-ended') },
  );
  const search: SearchClient = {
    execute(input, signal) {
      const id = next();
      searches.push({ record: { id, request: input }, isAborted: () => signal?.aborted === true });
      return new Promise<SearchPage>((resolve, reject) => {
        pendingSearches.set(id, { resolve, reject });
      });
    },
    counts: () => Promise.reject(new Error('The collection journeys read no private counts.')),
  };
  const catalog: Catalog = {
    resolve(references) {
      const id = next();
      catalogResolves.push({ id, references: [...references] });
      return new Promise<CatalogResolution>((resolve, reject) => {
        pendingCatalog.set(id, { resolve, reject });
      });
    },
    listCardPrintings(cardId, options = {}) {
      const id = next();
      printings.push({ id, cardId, options });
      return new Promise<CardPrintingsPage>((resolve, reject) => {
        pendingPrintings.set(id, { resolve, reject });
      });
    },
  };
  const userCards: UserCardsClient = {
    ...unusedUserCards,
    readCopies(copyIds, signal) {
      const id = next();
      copyReads.push({
        record: { id, copyIds: [...copyIds] },
        isAborted: () => signal?.aborted === true,
      });
      return new Promise((resolve, reject) => {
        pendingCopyReads.set(id, {
          resolve: (value) =>
            resolve({ privateRevision: 'private-1', copies: value.copies, missing: value.missing }),
          reject,
        });
      });
    },
    correctCopy(input) {
      const id = next();
      corrections.push({ id, input: { ...input } });
      return new Promise((resolve, reject) => {
        pendingCorrections.set(id, {
          resolve: (copies) => resolve({ privateRevision: 'private-2', copies }),
          reject,
        });
      });
    },
  };
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
    userCards,
    createRecognition: () => {
      throw new Error('The collection journeys do not run recognition.');
    },
  };
  const shell: UserInterface = createUserInterface({
    root,
    capabilities,
    identity,
    pages: createCollectionPages(),
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

  /** The resolution one catalog response carries, as the component contracts return it. */
  function resolution(records: {
    readonly cards?: readonly CardRecord[];
    readonly printings?: readonly PrintingRecord[];
    readonly missing?: readonly CatalogReference[];
  }): CatalogResolution {
    return {
      revision: harnessRevision,
      cards: new Map((records.cards ?? []).map((card) => [card.cardId, card])),
      printings: new Map(
        (records.printings ?? []).map((printing) => [printing.printingId, printing]),
      ),
      missing: records.missing ?? [],
    };
  }

  function settle<Value>(
    pending: Map<number, Pending<Value>>,
    id: number,
    value: Value,
    what: string,
  ): void {
    const waiting = pending.get(id);
    if (waiting === undefined) {
      throw new Error(`No ${what} request ${id} is waiting.`);
    }
    pending.delete(id);
    waiting.resolve(value);
  }

  function fail<Value>(
    pending: Map<number, Pending<Value>>,
    id: number,
    failure: { readonly code: ApplicationFailureCode; readonly message: string },
    what: string,
  ): void {
    const waiting = pending.get(id);
    if (waiting === undefined) {
      throw new Error(`No ${what} request ${id} is waiting.`);
    }
    pending.delete(id);
    waiting.reject(new ApplicationError(failure.code, failure.message));
  }

  return {
    log: () => [...log],
    get accountId() {
      return account?.accountId ?? null;
    },
    searchRequests: () =>
      searches.map(({ record, isAborted }) => ({ ...record, aborted: isAborted() })),
    settleSearch: (id, page) => settle(pendingSearches, id, page, 'search'),
    failSearch: (id, failure) => fail(pendingSearches, id, failure, 'search'),
    catalogRequests: () => catalogResolves.map((entry) => ({ ...entry })),
    settleCatalog: (id, records) => settle(pendingCatalog, id, resolution(records), 'catalog'),
    settleCatalogFor: (reference, records) => {
      const requests = catalogResolves.filter(
        (entry) =>
          pendingCatalog.has(entry.id) &&
          entry.references.some((asked) => sameReference(asked, reference)),
      );
      if (requests.length === 0) {
        throw new Error('No waiting catalog resolve asks for that reference.');
      }
      for (const request of requests) {
        settle(pendingCatalog, request.id, resolution(records), 'catalog');
      }
    },
    failCatalog: (id, message) => {
      const waiting = pendingCatalog.get(id);
      if (waiting === undefined) {
        throw new Error(`No catalog resolve ${id} is waiting.`);
      }
      pendingCatalog.delete(id);
      waiting.reject(new Error(message));
    },
    printingsRequests: () =>
      printings.map((entry) => ({ ...entry, options: { ...entry.options } })),
    settlePrintings: (id, page) => settle(pendingPrintings, id, page, 'printings'),
    failPrintings: (id, failure) => fail(pendingPrintings, id, failure, 'printings'),
    copyReads: () =>
      copyReads.map(({ record, isAborted }) => ({ ...record, aborted: isAborted() })),
    settleCopyRead: (id, result) =>
      settle(
        pendingCopyReads,
        id,
        {
          copies: new Map(result.copies.map((copy) => [copy.copyId, copy])),
          missing: [...(result.missing ?? [])],
        },
        'copy read',
      ),
    failCopyRead: (id, failure) => fail(pendingCopyReads, id, failure, 'copy read'),
    corrections: () => corrections.map((entry) => ({ id: entry.id, input: { ...entry.input } })),
    settleCorrection: (id, copies) => settle(pendingCorrections, id, copies, 'correction'),
    failCorrection: (id, failure) => fail(pendingCorrections, id, failure, 'correction'),
    navigate: (view) => shell.navigate(view),
    dispose: () => shell.dispose(),
  };
}
