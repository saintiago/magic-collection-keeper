/**
 * Helpers shared by the Application cases: one valid environment configuration, the verified
 * claims of one account, and stub component contracts whose calls the transport cases observe.
 * The stubs implement the provider-owned public contracts, so the real route table, identity
 * verification and response mapping run for every case.
 */

import { vi, type Mock } from 'vitest';

import { type Diagnostics, type IdentityVerifier } from '../../../src/application/index.js';
import { createPostgresApplication, type Application } from '../../../src/application/backend.js';
import type { CardPrintingsPage, Catalog, CatalogResolution } from '../../../src/catalog/index.js';
import type { CatalogSnapshotSource } from '../../../src/catalog/index.js';
import type { Search } from '../../../src/search/index.js';
import type {
  AssociationReadResult,
  CopyReadResult,
  SourceImportOperations,
  TagReadResult,
  UserCardsSqlRow,
  UserCardsSqlTransactor,
  UserCardsSqlValue,
  UserCards,
} from '../../../src/usercards/index.js';
import {
  claimsFor,
  testAccount,
  testConfiguration,
  testIdentityVerifier,
  testRevision,
  type TestConfiguration,
} from '../../support/application.js';
import { createSnapshotSource } from '../../support/catalog-snapshot.js';

export { claimsFor, testAccount, testConfiguration, testIdentityVerifier, testRevision };
export type { TestConfiguration };

export interface CatalogSpy {
  readonly contract: Catalog;
  readonly resolve: Mock<(references: unknown) => Promise<CatalogResolution>>;
  readonly listCardPrintings: Mock<
    (cardId: string, options?: unknown) => Promise<CardPrintingsPage>
  >;
}

/** A Catalog contract whose reads the case scripts and observes. */
export function createCatalogSpy(): CatalogSpy {
  const resolve = vi.fn(async (): Promise<CatalogResolution> => ({
    revision: testRevision,
    cards: new Map(),
    printings: new Map(),
    missing: [],
  }));
  const listCardPrintings = vi.fn(async (cardId: string): Promise<CardPrintingsPage> => ({
    cardId,
    cardExists: true,
    revision: testRevision,
    printings: [],
    continuation: null,
  }));
  return {
    resolve,
    listCardPrintings,
    contract: { resolve, listCardPrintings } as unknown as Catalog,
  };
}

export interface SearchSpy {
  readonly contract: Search;
  readonly execute: Mock;
}

/** A Search contract whose evaluation the case scripts and observes. */
export function createSearchSpy(): SearchSpy {
  const execute = vi.fn(async () => ({
    entries: [],
    totalCount: 0,
    continuation: null,
    revisions: { catalogRevision: testRevision.revisionId, privateRevision: null },
  }));
  return { execute, contract: { execute } as unknown as Search };
}

export interface UserCardsSpy {
  readonly contract: UserCards;
  readonly readCopies: Mock;
  readonly createCopies: Mock;
  readonly correctCopy: Mock;
  readonly setCopyLocation: Mock;
  readonly listTags: Mock;
  readonly readTags: Mock;
  readonly createTag: Mock;
  readonly renameTag: Mock;
  readonly readAssociations: Mock;
  readonly createAssociation: Mock;
  readonly changeAssociation: Mock;
  readonly removeAssociation: Mock;
  readonly listImportSessions: Mock;
  readonly listImportEntries: Mock;
  readonly stageImportEntries: Mock;
  readonly stageCaptureObservation: Mock;
  readonly reviewImportEntry: Mock;
  readonly attachImportCandidates: Mock;
  readonly discardImportEntry: Mock;
  readonly discardImportSession: Mock;
  readonly confirmImport: Mock;
  readonly recoverImportOperation: Mock;
}

/** A UserCards contract whose operations the case scripts and observes. */
export function createUserCardsSpy(): UserCardsSpy {
  const readCopies = vi.fn(async (): Promise<CopyReadResult> => ({
    privateRevision: 'private-revision-1',
    copies: new Map(),
    missing: [],
  }));
  const readTags = vi.fn(async (): Promise<TagReadResult> => ({
    privateRevision: 'private-revision-1',
    tags: new Map(),
    missing: [],
  }));
  const readAssociations = vi.fn(async (): Promise<AssociationReadResult> => ({
    privateRevision: 'private-revision-1',
    associations: new Map(),
    missing: [],
  }));
  const operations = {
    readCopies,
    createCopies: vi.fn(async () => ({ privateRevision: 'r1', copies: [] })),
    correctCopy: vi.fn(async () => ({ privateRevision: 'r1', copies: [] })),
    setCopyLocation: vi.fn(async () => ({ privateRevision: 'r1', copy: null, location: null })),
    listTags: vi.fn(async () => ({ privateRevision: 'r1', tags: [], continuation: null })),
    readTags,
    createTag: vi.fn(async () => ({ privateRevision: 'r1', tag: null })),
    renameTag: vi.fn(async () => ({ privateRevision: 'r1', tag: null })),
    readAssociations,
    createAssociation: vi.fn(async () => ({ privateRevision: 'r1', association: null })),
    changeAssociation: vi.fn(async () => ({ privateRevision: 'r1', association: null })),
    removeAssociation: vi.fn(async () => ({ privateRevision: 'r1', associationId: 'a1' })),
    listImportSessions: vi.fn(async () => ({
      privateRevision: 'r1',
      sessions: [],
      continuation: null,
    })),
    listImportEntries: vi.fn(async () => ({
      privateRevision: 'r1',
      session: null,
      entries: [],
      continuation: null,
    })),
    stageImportEntries: vi.fn(async () => ({
      privateRevision: 'r1',
      session: null,
      entries: [],
      staged: 0,
      replayed: false,
    })),
    stageCaptureObservation: vi.fn(async () => ({
      privateRevision: 'r1',
      outcome: 'admitted',
      replayed: false,
      session: null,
      entry: null,
    })),
    reviewImportEntry: vi.fn(async () => ({ privateRevision: 'r1', session: null, entry: null })),
    attachImportCandidates: vi.fn(async () => ({
      privateRevision: 'r1',
      session: null,
      entry: null,
    })),
    discardImportEntry: vi.fn(async () => ({ privateRevision: 'r1', session: null, entry: null })),
    discardImportSession: vi.fn(async () => ({ privateRevision: 'r1', session: null })),
    confirmImport: vi.fn(async () => ({
      operationId: 'operation-1',
      sessionId: 'session-1',
      sourceKind: 'scan',
      sourceId: 'scan',
      copies: [],
      replayed: false,
      privateRevision: 'r1',
    })),
    recoverImportOperation: vi.fn(async () => ({ outcome: 'absent' })),
  };
  return {
    ...operations,
    contract: operations as unknown as UserCards,
  } as UserCardsSpy;
}

export interface SourceImportsSpy {
  readonly contract: SourceImportOperations;
  readonly stageSourceImport: Mock;
}

/** A source-import contract whose staging the case scripts and observes. */
export function createSourceImportsSpy(): SourceImportsSpy {
  const stageSourceImport = vi.fn(async () => ({
    privateRevision: 'r1',
    session: null,
    rows: [],
    staged: 0,
  }));
  return {
    stageSourceImport,
    contract: { stageSourceImport } as unknown as SourceImportOperations,
  };
}

export interface RecordedStatement {
  readonly statement: string;
  readonly parameters: Readonly<Record<string, UserCardsSqlValue>>;
}

export interface RecordingSql {
  readonly sql: UserCardsSqlTransactor;
  /** Every statement the application executed, in order, with its named parameters. */
  readonly statements: RecordedStatement[];
}

/**
 * The deployment's transaction-capable executor as a substitute: it records every statement with
 * its parameters and answers with the caller-supplied rows, so a case can observe which account a
 * private statement was scoped to and control read or write outcomes.
 */
export function createRecordingSql(
  respond: (
    statement: string,
    parameters: Readonly<Record<string, UserCardsSqlValue>>,
  ) => Promise<readonly UserCardsSqlRow[]> | readonly UserCardsSqlRow[] = () => [],
): RecordingSql {
  const statements: RecordedStatement[] = [];
  const executor = {
    async query(
      statement: string,
      parameters: Readonly<Record<string, UserCardsSqlValue>> = {},
    ): Promise<readonly UserCardsSqlRow[]> {
      statements.push({ statement, parameters });
      return respond(statement, parameters);
    },
  };
  return {
    statements,
    sql: {
      query: executor.query,
      async transaction<T>(work: (statements: typeof executor) => Promise<T>): Promise<T> {
        statements.push({ statement: 'begin', parameters: {} });
        try {
          const outcome = await work(executor);
          statements.push({ statement: 'commit', parameters: {} });
          return outcome;
        } catch (cause) {
          statements.push({ statement: 'rollback', parameters: {} });
          throw cause;
        }
      },
    },
  };
}

export interface TestApplication {
  readonly application: Application;
  readonly sql: RecordingSql;
  readonly diagnostics: Mock;
}

/** One assembled application over the recording executor; every case supplies only what it scripts. */
export function createTestApplication(
  options: {
    readonly configuration?: TestConfiguration;
    readonly sql?: RecordingSql;
    readonly snapshots?: CatalogSnapshotSource;
    readonly diagnostics?: Mock;
    /** Verified identity source; the test environment's claims verifier unless a case scripts one. */
    readonly identity?: IdentityVerifier;
  } = {},
): TestApplication {
  const sql = options.sql ?? createRecordingSql();
  const diagnostics = options.diagnostics ?? vi.fn();
  const application = createPostgresApplication({
    configuration: options.configuration ?? testConfiguration(),
    identity: options.identity ?? testIdentityVerifier(),
    resources: {
      readSql: sql.sql,
      writeSql: sql.sql,
      catalogSynchronization: {
        sql: sql.sql,
        snapshots: options.snapshots ?? createSnapshotSource({}),
      },
      deckSource: null,
    },
    diagnostics: { record: diagnostics } satisfies Diagnostics,
  });
  return { application, sql, diagnostics };
}
