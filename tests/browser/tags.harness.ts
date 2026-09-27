/**
 * Browser-side harness of the organization pages (docs/user-interface.md#pages-and-navigation,
 * docs/user-interface.md#browsing-and-organization, docs/user-cards.md#records-and-associations,
 * docs/testing.md#browser-and-recognition-evidence).
 *
 * The harness installs the real shell with the real tags page and tag view and replaces the
 * boundaries around them: identity, the device capability and the component access Application
 * supplies. Every tag read, association page, private change, catalog resolve and search the pages
 * issue is recorded and settled from the journey, so the journeys drive the real query building,
 * list presentation, editing and navigation while observing exactly what crossed the component
 * contracts.
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
  CardRecord,
  Catalog,
  CatalogReference,
  CatalogResolution,
  ListCardPrintingsOptions,
  PrintingRecord,
} from '../../src/catalog/index.js';
import type { SearchPage, SearchRequestInput } from '../../src/search/index.js';
import type {
  Association,
  AssociationChangeResult,
  AssociationListResult,
  AssociationReadResult,
  AssociationRemovalResult,
  ChangeAssociationInput,
  CopyLocationResult,
  CreateAssociationInput,
  CreateTagInput,
  PhysicalCopy,
  RemoveAssociationInput,
  RenameTagInput,
  SetCopyLocationInput,
  Tag,
  TagChangeResult,
  TagListResult,
  TagReadResult,
} from '../../src/usercards/index.js';
import {
  createOrganizationPages,
  createUserInterface,
  type UiAccount,
  type UiIdentity,
  type UiView,
  type UserInterface,
} from '../../src/ui/index.js';

import { unusedUserCards } from './unused-usercards.js';

interface Pending {
  resolve(value: unknown): void;
  reject(cause: Error): void;
}

/** One recorded request of one operation: its identity, arguments and withdrawal state. */
export interface UiTagsRequest<Arguments = unknown> {
  readonly id: number;
  readonly arguments: Arguments;
  readonly aborted: boolean;
}

/** One tag page or association page request. */
export interface UiTagsListRequest {
  readonly pageSize: number | null;
  readonly continuation: string | null;
}

/** One tag association page request. */
export interface UiTagsAssociationListRequest extends UiTagsListRequest {
  readonly tagId: string;
}

/** One add search request. */
export interface UiTagsSearchRequest {
  readonly request: SearchRequestInput;
}

/** One catalog resolve the pages issued. */
export interface UiTagsCatalogRequest {
  readonly references: readonly CatalogReference[];
}

/** One printing-list read a tag view issued to refine a card association. */
export interface UiTagsPrintingsRequest {
  readonly cardId: string;
  readonly options: ListCardPrintingsOptions;
}

export interface UiTagsControl {
  log(): string[];
  readonly accountId: string | null;
  /** Requests of one operation, oldest first, with the arguments the page supplied. */
  listTags(): readonly UiTagsRequest<UiTagsListRequest>[];
  readTags(): readonly UiTagsRequest<readonly string[]>[];
  listAssociations(): readonly UiTagsRequest<UiTagsAssociationListRequest>[];
  readAssociations(): readonly UiTagsRequest<readonly string[]>[];
  readCopies(): readonly UiTagsRequest<readonly string[]>[];
  createTag(): readonly UiTagsRequest<CreateTagInput>[];
  renameTag(): readonly UiTagsRequest<RenameTagInput>[];
  createAssociation(): readonly UiTagsRequest<CreateAssociationInput>[];
  changeAssociation(): readonly UiTagsRequest<ChangeAssociationInput>[];
  removeAssociation(): readonly UiTagsRequest<RemoveAssociationInput>[];
  setCopyLocation(): readonly UiTagsRequest<SetCopyLocationInput>[];
  searches(): readonly UiTagsRequest<UiTagsSearchRequest>[];
  catalogRequests(): readonly UiTagsRequest<UiTagsCatalogRequest>[];
  printingsRequests(): readonly UiTagsRequest<UiTagsPrintingsRequest>[];
  settleListTags(
    id: number,
    result: {
      readonly tags: readonly Tag[];
      readonly continuation?: string | null;
      readonly privateRevision?: string;
    },
  ): void;
  settleReadTags(id: number, tags: readonly Tag[]): void;
  settleListAssociations(
    id: number,
    result: {
      readonly associations: readonly Association[];
      readonly continuation?: string | null;
      readonly privateRevision?: string;
    },
  ): void;
  settleReadAssociations(id: number, associations: readonly Association[]): void;
  settleReadCopies(id: number, copies: readonly PhysicalCopy[]): void;
  settleCreateTag(id: number, tag: Tag): void;
  settleRenameTag(id: number, tag: Tag): void;
  settleCreateAssociation(id: number, association: Association): void;
  settleChangeAssociation(id: number, association: Association): void;
  settleRemoveAssociation(id: number, associationId: string): void;
  settleSetCopyLocation(
    id: number,
    result: { readonly copy: PhysicalCopy; readonly location: Association | null },
  ): void;
  settleSearch(id: number, page: SearchPage): void;
  settleCatalog(
    id: number,
    records: {
      readonly cards?: readonly CardRecord[];
      readonly printings?: readonly PrintingRecord[];
      readonly missing?: readonly CatalogReference[];
    },
  ): void;
  settlePrintings(id: number, page: CardPrintingsPage): void;
  fail(
    id: number,
    failure: { readonly code: ApplicationFailureCode; readonly message: string },
  ): void;
  navigate(view: UiView): void;
  dispose(): void;
}

/** The published revision the harness resolves catalog records against. */
const harnessRevision = {
  revisionId: 'tags-revision',
  sourceName: 'fixture',
  sourceVersion: '1',
  publishedAt: '2026-09-01T00:00:00.000Z',
};

/** Installs the organization pages into `root`; identity starts signed in. */
export function installTagsHarness(root: Element | null): UiTagsControl {
  if (root === null) {
    throw new Error('The organization journey needs its root element.');
  }
  const log: string[] = [];
  let sequence = 0;
  let account: UiAccount | null = { accountId: 'alice', displayName: 'Alice' };
  const listeners = new Set<(account: UiAccount | null) => void>();
  const pending = new Map<number, Pending>();

  const listTagsRequests: UiTagsRequest<UiTagsListRequest>[] = [];
  const readTagsRequests: UiTagsRequest<readonly string[]>[] = [];
  const listAssociationRequests: UiTagsRequest<UiTagsAssociationListRequest>[] = [];
  const readAssociationRequests: UiTagsRequest<readonly string[]>[] = [];
  const readCopyRequests: UiTagsRequest<readonly string[]>[] = [];
  const createTagRequests: UiTagsRequest<CreateTagInput>[] = [];
  const renameTagRequests: UiTagsRequest<RenameTagInput>[] = [];
  const createAssociationRequests: UiTagsRequest<CreateAssociationInput>[] = [];
  const changeAssociationRequests: UiTagsRequest<ChangeAssociationInput>[] = [];
  const removeAssociationRequests: UiTagsRequest<RemoveAssociationInput>[] = [];
  const setCopyLocationRequests: UiTagsRequest<SetCopyLocationInput>[] = [];
  const searchRequests: UiTagsRequest<UiTagsSearchRequest>[] = [];
  const catalogRequests: UiTagsRequest<UiTagsCatalogRequest>[] = [];
  const printingsRequests: UiTagsRequest<UiTagsPrintingsRequest>[] = [];

  /** Records one request and returns the promise the journey settles by its identity. */
  function begin<Arguments>(
    requests: UiTagsRequest<Arguments>[],
    arguments_: Arguments,
    signal?: AbortSignal,
  ): Promise<unknown> {
    sequence += 1;
    const id = sequence;
    requests.push({
      id,
      arguments: arguments_,
      get aborted() {
        return signal?.aborted === true;
      },
    });
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
  }

  function settle<Value>(id: number, value: Value, wrap: (value: Value) => unknown): void {
    const waiting = pending.get(id);
    if (waiting === undefined) {
      throw new Error(`No organization request ${id} is waiting.`);
    }
    pending.delete(id);
    waiting.resolve(wrap(value));
  }

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
  const catalog: Catalog = {
    resolve(references) {
      return begin(catalogRequests, { references: [...references] }) as Promise<CatalogResolution>;
    },
    listCardPrintings(cardId, options = {}) {
      return begin(printingsRequests, {
        cardId,
        options,
      }) as Promise<CardPrintingsPage>;
    },
  };
  const search: SearchClient = {
    execute(input, signal) {
      return begin(searchRequests, { request: input }, signal) as Promise<SearchPage>;
    },
  };
  const userCards: UserCardsClient = {
    ...unusedUserCards,
    readCopies(copyIds, signal) {
      return begin(readCopyRequests, [...copyIds], signal) as ReturnType<
        UserCardsClient['readCopies']
      >;
    },
    listTags(options, signal) {
      return begin(
        listTagsRequests,
        { pageSize: options?.pageSize ?? null, continuation: options?.continuation ?? null },
        signal,
      ) as Promise<TagListResult>;
    },
    readTags(tagIds, signal) {
      return begin(readTagsRequests, [...tagIds], signal) as Promise<TagReadResult>;
    },
    createTag(input, signal) {
      return begin(createTagRequests, input, signal) as Promise<TagChangeResult>;
    },
    renameTag(input, signal) {
      return begin(renameTagRequests, input, signal) as Promise<TagChangeResult>;
    },
    listAssociations(tagId, options, signal) {
      return begin(
        listAssociationRequests,
        {
          tagId,
          pageSize: options?.pageSize ?? null,
          continuation: options?.continuation ?? null,
        },
        signal,
      ) as Promise<AssociationListResult>;
    },
    readAssociations(associationIds, signal) {
      return begin(
        readAssociationRequests,
        [...associationIds],
        signal,
      ) as Promise<AssociationReadResult>;
    },
    createAssociation(input, signal) {
      return begin(createAssociationRequests, input, signal) as Promise<AssociationChangeResult>;
    },
    changeAssociation(input, signal) {
      return begin(changeAssociationRequests, input, signal) as Promise<AssociationChangeResult>;
    },
    removeAssociation(input, signal) {
      return begin(removeAssociationRequests, input, signal) as Promise<AssociationRemovalResult>;
    },
    setCopyLocation(input, signal) {
      return begin(setCopyLocationRequests, input, signal) as Promise<CopyLocationResult>;
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
    request,
    catalog,
    search,
    userCards,
    createRecognition: () => {
      throw new Error('The organization journeys do not run recognition.');
    },
  };
  const shell: UserInterface = createUserInterface({
    root,
    capabilities,
    identity,
    pages: createOrganizationPages(),
  });

  function report(next: UiAccount | null): void {
    account = next;
    for (const listener of [...listeners]) {
      listener(next);
    }
  }

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

  return {
    log: () => [...log],
    get accountId() {
      return account?.accountId ?? null;
    },
    listTags: () => listTagsRequests.map((entry) => ({ ...entry })),
    readTags: () => readTagsRequests.map((entry) => ({ ...entry })),
    listAssociations: () => listAssociationRequests.map((entry) => ({ ...entry })),
    readAssociations: () => readAssociationRequests.map((entry) => ({ ...entry })),
    readCopies: () => readCopyRequests.map((entry) => ({ ...entry })),
    createTag: () => createTagRequests.map((entry) => ({ ...entry })),
    renameTag: () => renameTagRequests.map((entry) => ({ ...entry })),
    createAssociation: () => createAssociationRequests.map((entry) => ({ ...entry })),
    changeAssociation: () => changeAssociationRequests.map((entry) => ({ ...entry })),
    removeAssociation: () => removeAssociationRequests.map((entry) => ({ ...entry })),
    setCopyLocation: () => setCopyLocationRequests.map((entry) => ({ ...entry })),
    searches: () => searchRequests.map((entry) => ({ ...entry })),
    catalogRequests: () => catalogRequests.map((entry) => ({ ...entry })),
    printingsRequests: () => printingsRequests.map((entry) => ({ ...entry })),
    settleListTags: (id, result) =>
      settle(id, result, (value) => ({
        privateRevision: value.privateRevision ?? 'private-1',
        tags: value.tags,
        continuation: value.continuation ?? null,
      })),
    settleReadTags: (id, tags) =>
      settle(id, tags, (value) => ({
        privateRevision: 'private-1',
        tags: new Map(value.map((tag) => [tag.tagId, tag] as const)),
        missing: [],
      })),
    settleListAssociations: (id, result) =>
      settle(id, result, (value) => ({
        privateRevision: value.privateRevision ?? 'private-1',
        associations: value.associations,
        continuation: value.continuation ?? null,
      })),
    settleReadAssociations: (id, associations) =>
      settle(id, associations, (value) => ({
        privateRevision: 'private-1',
        associations: new Map(
          value.map((association) => [association.associationId, association] as const),
        ),
        missing: [],
      })),
    settleReadCopies: (id, copies) =>
      settle(id, copies, (value) => ({
        privateRevision: 'private-1',
        copies: new Map(value.map((copy) => [copy.copyId, copy] as const)),
        missing: [],
      })),
    settleCreateTag: (id, tag) =>
      settle(id, tag, (value) => ({ privateRevision: 'private-1', tag: value })),
    settleRenameTag: (id, tag) =>
      settle(id, tag, (value) => ({ privateRevision: 'private-1', tag: value })),
    settleCreateAssociation: (id, association) =>
      settle(id, association, (value) => ({ privateRevision: 'private-1', association: value })),
    settleChangeAssociation: (id, association) =>
      settle(id, association, (value) => ({ privateRevision: 'private-1', association: value })),
    settleRemoveAssociation: (id, associationId) =>
      settle(id, associationId, (value) => ({
        privateRevision: 'private-1',
        associationId: value,
      })),
    settleSetCopyLocation: (id, result) =>
      settle(id, result, (value) => ({ privateRevision: 'private-1', ...value })),
    settleSearch: (id, page) => settle(id, page, (value) => value),
    settleCatalog: (id, records) => settle(id, records, resolution),
    settlePrintings: (id, page) => settle(id, page, (value) => value),
    fail: (id, failure) => {
      const waiting = pending.get(id);
      if (waiting === undefined) {
        throw new Error(`No organization request ${id} is waiting.`);
      }
      pending.delete(id);
      waiting.reject(new ApplicationError(failure.code, failure.message));
    },
    navigate: (view) => shell.navigate(view),
    dispose: () => shell.dispose(),
  };
}
