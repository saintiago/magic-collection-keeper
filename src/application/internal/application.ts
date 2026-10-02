/** Request and job boundaries over supplied components (docs/application.md#internal-design). */

import type {
  Catalog,
  CatalogSynchronizer,
  CatalogRevision,
  CatalogSynchronizationRequest,
} from '../../catalog/index.js';
import type {
  Search,
  SearchIndexer,
  SearchIndexingRequest,
  SearchIndexingResult,
} from '../../search/index.js';
import type { UserCards, SourceImportOperations } from '../../usercards/index.js';

import {
  readPublicSettings,
  resolveRuntimeConfiguration,
  type ApplicationRuntimeConfiguration,
  type PublicApplicationSettings,
} from './configuration.js';
import {
  backgroundFailureDiagnostic,
  recordDiagnostic,
  silentDiagnostics,
  type Diagnostics,
} from './diagnostics.js';
import { translateFailure } from './errors.js';
import { ApplicationError } from './failures.js';
import type { IdentityVerifier } from './identity.js';
import { createRoutes } from './routes.js';
import { createRequestHandler } from './request-handler.js';
import type { TransportRequest, TransportResponse } from './transport.js';

/** Supplied provider contracts; the request boundary does not select implementations. */
export interface ApplicationComponents {
  readonly catalog: Catalog;
  readonly userCards: UserCards;
  readonly search: Search;
  readonly sourceImports: SourceImportOperations | null;
  /**
   * Finite catalog synchronization the runtime composes, or null when this runtime serves
   * requests only. The interactive deployment holds no Catalog writer credential, so it never
   * receives the synchronization capability; a runtime without it reports the job entry point as
   * unavailable instead of running it with another component's privileges.
   */
  readonly synchronizer: CatalogSynchronizer | null;
  /**
   * Search indexing the runtime composes, or null when this runtime runs no background indexing.
   * The indexing runtime holds the projection writer credential and trusted read access to both
   * provider publications; the interactive deployment holds neither
   * (docs/application.md#interface, docs/data-architecture.md#access-and-deployment).
   */
  readonly indexer: SearchIndexer | null;
}

export interface ApplicationDependencies {
  /** Raw configuration of this environment; validated before any component is constructed. */
  readonly configuration: unknown;
  readonly identity: IdentityVerifier;
  readonly components: ApplicationComponents;
  readonly diagnostics?: Diagnostics;
}

export interface Application {
  /** Public settings the browser may receive; never resource, credential or storage settings. */
  readonly settings: PublicApplicationSettings;
  /** Interactive backend entry point of one authenticated request. */
  handle(request: TransportRequest): Promise<TransportResponse>;
  /** Finite catalog synchronization job entry point. */
  synchronizeCatalog(request: CatalogSynchronizationRequest): Promise<CatalogRevision>;
  /** Resumable background Search indexing entry point. */
  indexSearch(request?: SearchIndexingRequest): Promise<SearchIndexingResult>;
  /** Stops accepting work; supplied executors stay owned by the runtime that created them. */
  dispose(): void;
}

/**
 * Creates the request and job boundaries over supplied component contracts. Concrete construction
 * belongs to the deployment composition; no storage implementation is selected here.
 */
export function createApplication(dependencies: ApplicationDependencies): Application {
  const configuration: ApplicationRuntimeConfiguration = resolveRuntimeConfiguration(
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

  const components = dependencies?.components;
  if (
    !components ||
    typeof components.catalog?.resolve !== 'function' ||
    typeof components.catalog?.listCardPrintings !== 'function' ||
    typeof components.search?.execute !== 'function' ||
    typeof components.search?.counts !== 'function' ||
    !components.userCards
  ) {
    throw new TypeError('createApplication requires compatible component contracts.');
  }
  if (
    components.synchronizer !== null &&
    typeof components.synchronizer?.synchronize !== 'function'
  ) {
    throw new TypeError('A supplied catalog synchronizer requires its synchronize operation.');
  }
  if (components.indexer !== null && typeof components.indexer?.index !== 'function') {
    throw new TypeError('A supplied Search indexer requires its index operation.');
  }
  for (const operation of [
    'readCopies',
    'createCopies',
    'correctCopy',
    'readTags',
    'listTags',
    'listAssociations',
    'createTag',
    'renameTag',
    'readAssociations',
    'createAssociation',
    'changeAssociation',
    'removeAssociation',
    'setCopyLocation',
    'listImportSessions',
    'listImportEntries',
    'stageImportEntries',
    'stageCaptureObservation',
    'reviewImportEntry',
    'attachImportCandidates',
    'discardImportEntry',
    'discardImportSession',
    'confirmImport',
    'recoverImportOperation',
  ] as const) {
    if (typeof components.userCards[operation] !== 'function') {
      throw new TypeError(`createApplication requires UserCards.${operation}.`);
    }
  }
  if (
    configuration.capabilities.sourceImports &&
    typeof components.sourceImports?.stageSourceImport !== 'function'
  ) {
    throw new TypeError('Enabled source imports require their component contract.');
  }
  const { synchronizer } = components;
  const { indexer } = components;
  const routes = createRoutes({
    ...components,
    sourceImports: configuration.capabilities.sourceImports ? components.sourceImports : null,
  });
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
    if (synchronizer === null) {
      const failure = new ApplicationError(
        'unavailable',
        'This runtime does not run catalog synchronization.',
      );
      recordDiagnostic(diagnostics, {
        operation: 'catalog.synchronize',
        requestId: null,
        outcome: 'failed',
        failureCode: failure.code,
        stage: 'catalog-synchronization',
        durationMs: Date.now() - startedAt,
      });
      throw failure;
    }
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
        ...backgroundFailureDiagnostic('catalog-synchronization', cause),
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
    async indexSearch(request: SearchIndexingRequest = {}): Promise<SearchIndexingResult> {
      assertServing(disposed);
      const startedAt = Date.now();
      if (indexer === null) {
        const failure = new ApplicationError(
          'unavailable',
          'This runtime does not run Search indexing.',
        );
        recordDiagnostic(diagnostics, {
          operation: 'search.index',
          requestId: null,
          outcome: 'failed',
          failureCode: failure.code,
          stage: 'search-indexing',
          durationMs: Date.now() - startedAt,
        });
        throw failure;
      }
      try {
        const result = await indexer.index(request);
        recordDiagnostic(diagnostics, {
          operation: 'search.index',
          requestId: null,
          outcome: 'ok',
          failureCode: null,
          durationMs: Date.now() - startedAt,
        });
        return result;
      } catch (cause) {
        const failure = translateFailure(cause);
        recordDiagnostic(diagnostics, {
          operation: 'search.index',
          requestId: null,
          outcome: 'failed',
          failureCode: failure.code,
          ...backgroundFailureDiagnostic('search-indexing', cause),
          durationMs: Date.now() - startedAt,
        });
        throw failure;
      }
    },
    dispose() {
      disposed = true;
    },
  };
}

function assertServing(disposed: boolean): void {
  if (disposed) {
    throw new ApplicationError('unavailable', 'The application is no longer serving requests.');
  }
}
