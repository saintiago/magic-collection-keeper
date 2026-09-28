/**
 * Browser-side harness of the Import page (docs/user-interface.md#capture-and-review,
 * docs/user-cards.md#import-and-capture-state, docs/testing.md#browser-and-recognition-evidence).
 *
 * The harness installs the real shell with the real Import page and replaces the boundaries around
 * them: identity and the component access Application supplies. Every pending-import read, staging,
 * source parsing, review, discard, confirmation and recovery the page issues is recorded and settled
 * from the journey, so the journeys drive the real query building, list presentation, review
 * controls and confirmation handling while observing exactly what crossed the component contracts.
 */

import {
  ApplicationError,
  type ApplicationFailureCode,
  type SearchClient,
  type UserInterfaceCapabilities,
} from '../../src/application/index.js';
import {
  createUserCardsOperations,
  usercardsBrowserOperations,
  type UserCardsBrowserClient,
} from '../../src/usercards/browser.js';
// A type-only import of the Catalog public entry keeps the provider barrel, including its Node-only
// synchronization job, out of the browser bundle (docs/application.md#interface).
import type {
  CardRecord,
  Catalog,
  CatalogReference,
  CatalogResolution,
  PrintingRecord,
} from '../../src/catalog/index.js';
import type { SearchPage, SearchRequestInput } from '../../src/search/index.js';
import type {
  ConfirmImportInput,
  DiscardImportEntryInput,
  DiscardImportSessionInput,
  ImportConfirmationResult,
  ImportEntry,
  ImportEntryChangeResult,
  ImportEntryListResult,
  ImportOperationRecoveryResult,
  ImportSession,
  ImportSessionChange,
  ImportSessionListResult,
  ImportStageResult,
  ReviewImportEntryInput,
  SourceImportResult,
  StageImportEntriesInput,
  StageSourceImportInput,
} from '../../src/usercards/index.js';
import {
  createImportPages,
  createUserInterface,
  type UiAccount,
  type UiIdentity,
  type UiView,
  type UserInterface,
} from '../../src/ui/index.js';

import { browserAttemptStorage, unusedUserCardsClient } from './unused-usercards.js';

interface Pending {
  resolve(value: unknown): void;
  reject(cause: Error): void;
}

/** One recorded request of one operation: its identity, arguments and withdrawal state. */
export interface UiImportRequest<Arguments = unknown> {
  readonly id: number;
  readonly arguments: Arguments;
  readonly aborted: boolean;
}

/** One pending session list request the page issued. */
export interface UiImportSessionsRequest {
  readonly pageSize: number | null;
  readonly continuation: string | null;
}

/** One pending entry page request the page issued. */
export interface UiImportEntriesRequest {
  readonly sessionId: string;
  readonly pageSize: number | null;
  readonly continuation: string | null;
}

/** One catalog resolve the page issued for the printings of its pending entries or its search. */
export interface UiImportCatalogRequest {
  readonly references: readonly CatalogReference[];
}

export interface UiImportControl {
  log(): string[];
  readonly accountId: string | null;
  sessions(): readonly UiImportRequest<UiImportSessionsRequest>[];
  entries(): readonly UiImportRequest<UiImportEntriesRequest>[];
  stage(): readonly UiImportRequest<StageImportEntriesInput>[];
  source(): readonly UiImportRequest<StageSourceImportInput>[];
  review(): readonly UiImportRequest<ReviewImportEntryInput>[];
  discardEntry(): readonly UiImportRequest<DiscardImportEntryInput>[];
  discardSession(): readonly UiImportRequest<DiscardImportSessionInput>[];
  confirm(): readonly UiImportRequest<ConfirmImportInput>[];
  recover(): readonly UiImportRequest<string>[];
  searches(): readonly UiImportRequest<SearchRequestInput>[];
  catalogRequests(): readonly UiImportRequest<UiImportCatalogRequest>[];
  settleSessions(
    id: number,
    sessions: readonly ImportSession[],
    continuation?: string | null,
  ): void;
  settleEntries(
    id: number,
    result: {
      readonly session: ImportSession;
      readonly entries: readonly ImportEntry[];
      readonly continuation?: string | null;
    },
  ): void;
  settleStage(id: number, result: Omit<ImportStageResult, 'privateRevision'>): void;
  settleSource(id: number, result: Omit<SourceImportResult, 'privateRevision'>): void;
  settleReview(
    id: number,
    result: { readonly entry: ImportEntry; readonly session: ImportSession },
  ): void;
  settleDiscardEntry(
    id: number,
    result: { readonly entry: ImportEntry; readonly session: ImportSession },
  ): void;
  settleDiscardSession(id: number, session: ImportSession): void;
  settleConfirm(id: number, result: Omit<ImportConfirmationResult, 'privateRevision'>): void;
  settleRecover(id: number, result: ImportOperationRecoveryResult): void;
  settleSearch(id: number, page: SearchPage): void;
  /** Answers every following catalog resolve from this table, like the provider the page reads. */
  scriptCatalog(
    records: {
      readonly cards?: readonly CardRecord[];
      readonly printings?: readonly PrintingRecord[];
      readonly missing?: readonly CatalogReference[];
    } | null,
  ): void;
  settleCatalog(
    id: number,
    records: {
      readonly cards?: readonly CardRecord[];
      readonly printings?: readonly PrintingRecord[];
      readonly missing?: readonly CatalogReference[];
    },
  ): void;
  fail(
    id: number,
    failure: { readonly code: ApplicationFailureCode; readonly message: string },
  ): void;
  /** Presents another verified account of the same deployment, as a sign-in does. */
  signInAs(accountId: string): void;
  signOut(): void;
  navigate(view: UiView): void;
  back(): void;
  dispose(): void;
}

/** The published revision the harness resolves catalog records against. */
const harnessRevision = {
  revisionId: 'imports-revision',
  sourceName: 'fixture',
  sourceVersion: '1',
  publishedAt: '2026-09-01T00:00:00.000Z',
};

/** Capabilities of the deployment one Import journey presents. */
export interface UiImportHarnessOptions {
  /** Whether the deployment parses source imports; a journey may present one that refuses them. */
  readonly sourceImports?: boolean;
}

/** Installs the Import page into `root`; identity starts signed in as one account. */
export function installImportHarness(
  root: Element | null,
  options: UiImportHarnessOptions = {},
): UiImportControl {
  if (root === null) {
    throw new Error('The Import journey needs its root element.');
  }
  const log: string[] = [];
  let sequence = 0;
  let account: UiAccount | null = { accountId: 'alice', displayName: 'Alice' };
  const listeners = new Set<(account: UiAccount | null) => void>();
  const pending = new Map<number, Pending>();
  const sessionRequests: UiImportRequest<UiImportSessionsRequest>[] = [];
  const entryRequests: UiImportRequest<UiImportEntriesRequest>[] = [];
  const stageRequests: UiImportRequest<StageImportEntriesInput>[] = [];
  const sourceRequests: UiImportRequest<StageSourceImportInput>[] = [];
  const reviewRequests: UiImportRequest<ReviewImportEntryInput>[] = [];
  const discardEntryRequests: UiImportRequest<DiscardImportEntryInput>[] = [];
  const discardSessionRequests: UiImportRequest<DiscardImportSessionInput>[] = [];
  const confirmRequests: UiImportRequest<ConfirmImportInput>[] = [];
  const recoverRequests: UiImportRequest<string>[] = [];
  const searchRequests: UiImportRequest<SearchRequestInput>[] = [];
  const catalogRequests: UiImportRequest<UiImportCatalogRequest>[] = [];
  /** Catalog records every following resolve answers from, or null while each one is settled. */
  let scriptedCatalog: {
    readonly cards: readonly CardRecord[];
    readonly printings: readonly PrintingRecord[];
  } | null = null;

  /** Records one request and returns the promise the journey settles by its identity. */
  function begin<Arguments>(
    requests: UiImportRequest<Arguments>[],
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
      throw new Error(`No Import request ${id} is waiting.`);
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
  function report(next: UiAccount | null): void {
    account = next;
    for (const listener of [...listeners]) {
      listener(next);
    }
  }
  const request = Object.assign(
    async (path: string) => {
      log.push(`request:${path}`);
      return {};
    },
    { endSession: () => log.push('session-ended') },
  );
  const catalog: Catalog = {
    resolve(references) {
      if (scriptedCatalog !== null) {
        sequence += 1;
        catalogRequests.push({
          id: sequence,
          arguments: { references: [...references] },
          aborted: false,
        });
        return Promise.resolve(scriptedResolution(scriptedCatalog, references));
      }
      return begin(catalogRequests, {
        references: [...references],
      }) as Promise<CatalogResolution>;
    },
    listCardPrintings() {
      return Promise.reject(new Error('The Import page reads no card printing page.'));
    },
  };
  const search: SearchClient = {
    execute(input, signal) {
      return begin(searchRequests, input, signal) as Promise<SearchPage>;
    },
    counts() {
      return Promise.reject(new Error('The Import page reads no private counts.'));
    },
  };
  const scriptedUserCards: UserCardsBrowserClient = {
    ...unusedUserCardsClient,
    listImportSessions(options, signal) {
      return begin(
        sessionRequests,
        { pageSize: options?.pageSize ?? null, continuation: options?.continuation ?? null },
        signal,
      ) as Promise<ImportSessionListResult>;
    },
    listImportEntries(input, signal) {
      return begin(
        entryRequests,
        {
          sessionId: input.sessionId,
          pageSize: input.pageSize ?? null,
          continuation: input.continuation ?? null,
        },
        signal,
      ) as Promise<ImportEntryListResult>;
    },
    stageImportEntries(input, signal) {
      return begin(stageRequests, input, signal) as Promise<ImportStageResult>;
    },
    stageSourceImport(input, signal) {
      return begin(sourceRequests, input, signal) as Promise<SourceImportResult>;
    },
    reviewImportEntry(input, signal) {
      return begin(reviewRequests, input, signal) as Promise<ImportEntryChangeResult>;
    },
    discardImportEntry(input, signal) {
      return begin(discardEntryRequests, input, signal) as Promise<ImportEntryChangeResult>;
    },
    discardImportSession(input, signal) {
      return begin(discardSessionRequests, input, signal) as Promise<ImportSessionChange>;
    },
    confirmImport(input, signal) {
      return begin(confirmRequests, input, signal) as Promise<ImportConfirmationResult>;
    },
    recoverImportOperation(operationId, signal) {
      return begin(recoverRequests, operationId, signal) as Promise<ImportOperationRecoveryResult>;
    },
  };
  // Source imports are the deployment's capability: Application enables the operations this
  // environment serves, and the page presents only the published ones.
  const userCards = createUserCardsOperations({
    client: scriptedUserCards,
    storage: browserAttemptStorage(),
    ...((options.sourceImports ?? true)
      ? {}
      : {
          operations: usercardsBrowserOperations.filter(
            (operation) => operation !== 'stageSourceImport',
          ),
        }),
  });
  // Application ends the UserCards scope of the account it leaves, so no retained attempt or read
  // of that account reaches the account that signs in next (docs/architecture.md#runtime-boundaries).
  let scopedAccountId: string | null = account?.accountId ?? null;
  listeners.add((next) => {
    const nextAccountId = next?.accountId ?? null;
    if (nextAccountId !== scopedAccountId) {
      if (scopedAccountId !== null) {
        userCards.release(scopedAccountId);
      }
      scopedAccountId = nextAccountId;
    }
  });
  const capabilities: UserInterfaceCapabilities = {
    settings: {
      environment: 'test',
      apiBaseUrl: 'https://api.test.keeper.example',
      authentication: { region: 'us-east-1', appClientId: 'keeper-test-client' },
      recognition: { cloudEnabled: false, computeBaseUrl: null },
      capabilities: { sourceImports: options.sourceImports ?? true },
    },
    identity,
    request,
    catalog,
    search,
    userCards,
    createRecognition: () => {
      throw new Error('The Import journeys do not run recognition.');
    },
  };
  const shell: UserInterface = createUserInterface({
    root,
    capabilities,
    identity,
    pages: createImportPages(),
  });

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

  /**
   * The catalog answer for exactly the requested references: a reference the table does not name
   * is missing, exactly like a provider read that does not publish it.
   */
  function scriptedResolution(
    records: {
      readonly cards: readonly CardRecord[];
      readonly printings: readonly PrintingRecord[];
    },
    references: readonly CatalogReference[],
  ): CatalogResolution {
    const cards = new Map(records.cards.map((card) => [card.cardId, card] as const));
    const printings = new Map(
      records.printings.map((printing) => [printing.printingId, printing] as const),
    );
    return {
      revision: harnessRevision,
      cards: new Map(
        references.flatMap((reference) =>
          reference.kind === 'card' && cards.has(reference.cardId)
            ? [[reference.cardId, cards.get(reference.cardId)!] as const]
            : [],
        ),
      ),
      printings: new Map(
        references.flatMap((reference) =>
          reference.kind === 'printing' && printings.has(reference.printingId)
            ? [[reference.printingId, printings.get(reference.printingId)!] as const]
            : [],
        ),
      ),
      missing: references.filter((reference) =>
        reference.kind === 'card'
          ? !cards.has(reference.cardId)
          : !printings.has(reference.printingId),
      ),
    };
  }

  return {
    log: () => [...log],
    get accountId() {
      return account?.accountId ?? null;
    },
    sessions: () => sessionRequests.map((entry) => ({ ...entry })),
    entries: () => entryRequests.map((entry) => ({ ...entry })),
    stage: () => stageRequests.map((entry) => ({ ...entry })),
    source: () => sourceRequests.map((entry) => ({ ...entry })),
    review: () => reviewRequests.map((entry) => ({ ...entry })),
    discardEntry: () => discardEntryRequests.map((entry) => ({ ...entry })),
    discardSession: () => discardSessionRequests.map((entry) => ({ ...entry })),
    confirm: () => confirmRequests.map((entry) => ({ ...entry })),
    recover: () => recoverRequests.map((entry) => ({ ...entry })),
    searches: () => searchRequests.map((entry) => ({ ...entry })),
    catalogRequests: () => catalogRequests.map((entry) => ({ ...entry })),
    settleSessions: (id, sessions, continuation = null) =>
      settle(id, { sessions, continuation }, (value) => ({
        privateRevision: 'private-1',
        sessions: value.sessions,
        continuation: value.continuation,
      })),
    settleEntries: (id, result) =>
      settle(id, result, (value) => ({
        privateRevision: 'private-1',
        session: value.session,
        entries: value.entries,
        continuation: value.continuation ?? null,
      })),
    settleStage: (id, result) =>
      settle(id, result, (value) => ({ privateRevision: 'private-1', ...value })),
    settleSource: (id, result) =>
      settle(id, result, (value) => ({ privateRevision: 'private-1', ...value })),
    settleReview: (id, result) =>
      settle(id, result, (value) => ({ privateRevision: 'private-1', ...value })),
    settleDiscardEntry: (id, result) =>
      settle(id, result, (value) => ({ privateRevision: 'private-1', ...value })),
    settleDiscardSession: (id, session) =>
      settle(id, session, (value) => ({ privateRevision: 'private-1', session: value })),
    settleConfirm: (id, result) =>
      settle(id, result, (value) => ({ privateRevision: 'private-1', ...value })),
    settleRecover: (id, result) => settle(id, result, (value) => value),
    settleSearch: (id, page) => settle(id, page, (value) => value),
    scriptCatalog: (records) => {
      scriptedCatalog =
        records === null
          ? null
          : { cards: records.cards ?? [], printings: records.printings ?? [] };
    },
    settleCatalog: (id, records) => settle(id, records, resolution),
    fail: (id, failure) => {
      const waiting = pending.get(id);
      if (waiting === undefined) {
        throw new Error(`No Import request ${id} is waiting.`);
      }
      pending.delete(id);
      waiting.reject(new ApplicationError(failure.code, failure.message));
    },
    signOut: () => report(null),
    signInAs: (accountId) => report({ accountId, displayName: accountId }),
    navigate: (view) => shell.navigate(view),
    back: () => shell.back(),
    dispose: () => shell.dispose(),
  };
}
