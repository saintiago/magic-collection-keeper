/**
 * The interactive backend entry point and the finite catalog job
 * (docs/application.md#interface, docs/application.md#configuration-and-lifecycle).
 *
 * Construction validates the configuration, receives the environment's implementations through the
 * provider-owned contracts and assembles Catalog, UserCards, Search and the catalog job before the
 * application accepts any work. One invocation carries its own verified identity, trusted context,
 * deadline and diagnostics; nothing about a request is shared with another. Synchronization stays a
 * separate job entry point and recognition inference a separate compute runtime: neither is
 * reachable through the interactive transport.
 */

import {
  createCatalog,
  createCatalogSynchronizer,
  type CatalogRevision,
  type CatalogSnapshotSource,
  type CatalogSynchronizationRequest,
  type CatalogSqlTransactor,
} from '../../catalog/index.js';
import { createSearch, type SearchSqlExecutor } from '../../search/index.js';
import {
  USERCARDS_ACCOUNT_SCOPE_SQL,
  createSourceImports,
  createUserCards,
  type MoxfieldDeckSource,
  type UserCardsSqlTransactor,
} from '../../usercards/index.js';

import {
  readPublicSettings,
  resolveApplicationConfiguration,
  type ApplicationConfiguration,
  type PublicApplicationSettings,
} from './configuration.js';
import { recordDiagnostic, silentDiagnostics, type Diagnostics } from './diagnostics.js';
import { ApplicationError, translateFailure } from './errors.js';
import type { IdentityVerifier } from './identity.js';
import { createRoutes } from './routes.js';
import { createRequestHandler } from './request-handler.js';
import type { TransportRequest, TransportResponse } from './transport.js';

/** Component and resource implementations the running environment selects. */
export interface ApplicationResources {
  /**
   * Transaction-capable executor over the deployment's PostgreSQL database: Catalog reads,
   * UserCards changes and Search evaluation share its published query surfaces.
   */
  readonly sql: UserCardsSqlTransactor;
  /** The finite catalog job: its transaction-capable executor and its configured snapshot source. */
  readonly catalogSynchronization: {
    readonly sql: CatalogSqlTransactor;
    readonly snapshots: CatalogSnapshotSource;
  };
  /** Moxfield deck source; the component's own public-API access is used when it is omitted. */
  readonly deckSource?: MoxfieldDeckSource | null;
}

export interface ApplicationDependencies {
  /** Raw configuration of this environment; validated before any component is constructed. */
  readonly configuration: unknown;
  readonly identity: IdentityVerifier;
  readonly resources: ApplicationResources;
  readonly diagnostics?: Diagnostics;
}

export interface Application {
  /** Public settings the browser may receive; never resource, credential or storage settings. */
  readonly settings: PublicApplicationSettings;
  /** Interactive backend entry point of one authenticated request. */
  handle(request: TransportRequest): Promise<TransportResponse>;
  /** Finite catalog synchronization job entry point. */
  synchronizeCatalog(request: CatalogSynchronizationRequest): Promise<CatalogRevision>;
  /** Stops accepting work; supplied executors stay owned by the runtime that created them. */
  dispose(): void;
}

/**
 * Assembles the interactive application. The environment supplies the executors, the snapshot
 * source and the identity verifier through their provider-owned contracts; Application constructs
 * the components, validates compatibility before serving and owns no storage client of its own.
 */
export function createApplication(dependencies: ApplicationDependencies): Application {
  const configuration: ApplicationConfiguration = resolveApplicationConfiguration(
    dependencies?.configuration,
  );
  const identityVerifier = dependencies?.identity;
  if (typeof identityVerifier?.verify !== 'function') {
    throw new TypeError('createApplication requires an identity verifier with a verify method.');
  }
  const diagnostics = dependencies?.diagnostics ?? silentDiagnostics;
  if (typeof diagnostics?.record !== 'function') {
    throw new TypeError('createApplication requires a diagnostics sink with a record method.');
  }

  const resources = dependencies?.resources;
  const sql = readSqlTransactor(resources);
  const synchronization = resources?.catalogSynchronization;
  if (
    typeof synchronization?.sql?.transaction !== 'function' ||
    typeof synchronization?.snapshots?.open !== 'function'
  ) {
    throw new TypeError(
      'createApplication requires the catalog job’s transaction-capable executor and snapshot source.',
    );
  }

  const catalog = createCatalog({ sql });
  const userCards = createUserCards({ sql, catalog });
  const sourceImports = configuration.capabilities.sourceImports
    ? createSourceImports({
        sql,
        catalog,
        ...(resources?.deckSource == null ? {} : { decks: resources.deckSource }),
      })
    : null;
  const search = createSearch({ sql, withAccountScope: createAccountScopeBinder(sql) });
  const synchronizer = createCatalogSynchronizer({
    sql: synchronization.sql,
    snapshots: synchronization.snapshots,
  });
  const routes = createRoutes({ catalog, search, userCards, sourceImports });
  const settings = readPublicSettings(configuration);
  const handle = createRequestHandler({
    routes,
    identity: identityVerifier,
    requestTimeoutMs: configuration.transport.requestTimeoutMs,
    diagnostics,
  });
  let disposed = false;

  async function synchronizeCatalog(
    request: CatalogSynchronizationRequest,
  ): Promise<CatalogRevision> {
    assertServing(disposed);
    const startedAt = Date.now();
    try {
      const revision = await synchronizer.synchronize(request);
      recordDiagnostic(diagnostics, {
        operation: 'catalog.synchronize',
        requestId: null,
        outcome: 'ok',
        failureCode: null,
        durationMs: Date.now() - startedAt,
      });
      return revision;
    } catch (cause) {
      const failure = translateFailure(cause);
      recordDiagnostic(diagnostics, {
        operation: 'catalog.synchronize',
        requestId: null,
        outcome: 'failed',
        failureCode: failure.code,
        durationMs: Date.now() - startedAt,
      });
      throw failure;
    }
  }

  return {
    settings,
    async handle(request: TransportRequest): Promise<TransportResponse> {
      assertServing(disposed);
      return handle(request);
    },
    synchronizeCatalog,
    dispose() {
      disposed = true;
    },
  };
}

/**
 * The trusted account scope of one private read: the verified account is bound to the published
 * views inside the read transaction, so Search sees one account's rows and one coherent private
 * revision, and a missing scope returns no private rows instead of another account's data.
 */
function createAccountScopeBinder(sql: UserCardsSqlTransactor) {
  return <T>(accountId: string, work: (scoped: SearchSqlExecutor) => Promise<T>): Promise<T> =>
    sql.transaction(async (statements) => {
      await statements.query(USERCARDS_ACCOUNT_SCOPE_SQL, { account_id: accountId });
      return work(statements);
    });
}

function readSqlTransactor(resources: ApplicationResources | undefined): UserCardsSqlTransactor {
  const sql = resources?.sql;
  if (typeof sql?.query !== 'function' || typeof sql.transaction !== 'function') {
    throw new TypeError(
      'createApplication requires the deployment’s transaction-capable SQL executor.',
    );
  }
  return sql;
}

function assertServing(disposed: boolean): void {
  if (disposed) {
    throw new ApplicationError('unavailable', 'The application is no longer serving requests.');
  }
}
