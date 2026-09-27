/** Request and job boundaries over supplied components (docs/application.md#internal-design). */

import type {
  Catalog,
  CatalogSynchronizer,
  CatalogRevision,
  CatalogSynchronizationRequest,
} from '../../catalog/index.js';
import type { Search } from '../../search/index.js';
import type { UserCards, SourceImportOperations } from '../../usercards/index.js';

import {
  readPublicSettings,
  resolveRuntimeConfiguration,
  type ApplicationRuntimeConfiguration,
  type PublicApplicationSettings,
} from './configuration.js';
import { recordDiagnostic, silentDiagnostics, type Diagnostics } from './diagnostics.js';
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
  readonly synchronizer: CatalogSynchronizer;
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
    typeof components.synchronizer?.synchronize !== 'function' ||
    !components.userCards
  ) {
    throw new TypeError('createApplication requires compatible component contracts.');
  }
  for (const operation of [
    'readCopies',
    'createCopies',
    'correctCopy',
    'readTags',
    'listTags',
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

function assertServing(disposed: boolean): void {
  if (disposed) {
    throw new ApplicationError('unavailable', 'The application is no longer serving requests.');
  }
}
