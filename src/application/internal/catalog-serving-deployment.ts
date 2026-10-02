/** Production composition of the independently deployable Catalog runtime. */

import { RDSDataClient } from '@aws-sdk/client-rds-data';

import { createCatalog } from '../../catalog/serving.js';
import type { UserCards, UserCardsQueries } from '../../usercards/index.js';
import { createDataApiTransactor, createRdsDataApiClient } from './data-api.js';
import { silentDiagnostics } from './diagnostics.js';
import { createRequestHandler } from './request-handler.js';
import { createRoutes } from './routes.js';
import {
  readServingIdentity,
  requiredServingVariable,
  servingIdentityVerifier,
  type ServingDeployment,
  type ServingDeploymentOptions,
} from './serving-deployment-shared.js';

export function createCatalogServingDeployment(
  options: ServingDeploymentOptions,
): ServingDeployment {
  const identity = readServingIdentity(options.environment);
  const secretArn = requiredServingVariable(
    options.environment,
    'KEEPER_DATABASE_CATALOG_READER_SECRET_ARN',
  );
  const owned = options.dataApi === undefined;
  const client =
    options.dataApi ?? createRdsDataApiClient(new RDSDataClient({ region: identity.region }));
  const catalog = createCatalog({
    sql: createDataApiTransactor({
      client,
      resourceArn: identity.clusterArn,
      secretArn,
      database: identity.database,
    }),
  });
  const routes = createRoutes({
    catalog,
    userCards: unusedUserCards(),
    userCardsQueries: unusedUserCardsQueries(),
    sourceImports: null,
  }).filter((route) => route.operation.startsWith('catalog.'));
  const handle = createRequestHandler({
    routes,
    identity: servingIdentityVerifier(identity),
    requestTimeoutMs: identity.requestTimeoutMs,
    diagnostics: options.diagnostics ?? silentDiagnostics,
  });
  return { handle, dispose: () => void (owned && client.destroy?.()) };
}

/** Internal IAM routes add one prefix; the provider dispatches the same public contract. */
export function withoutInternalCatalogPrefix(event: unknown): unknown {
  if (typeof event !== 'object' || event === null) return event;
  const record = event as Readonly<Record<string, unknown>>;
  if (typeof record.rawPath !== 'string' || !record.rawPath.startsWith('/internal/api/catalog/')) {
    return event;
  }
  const requestContext = asRecord(record.requestContext);
  const http = asRecord(requestContext?.http);
  const path = record.rawPath.slice('/internal'.length);
  return {
    ...record,
    rawPath: path,
    ...(requestContext === null
      ? {}
      : {
          requestContext: {
            ...requestContext,
            ...(http === null ? {} : { http: { ...http, path } }),
          },
        }),
  };
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function unusedUserCards(): UserCards {
  return new Proxy({} as UserCards, {
    get: () => () => Promise.reject(new Error('The Catalog runtime has no UserCards capability.')),
  });
}

function unusedUserCardsQueries(): UserCardsQueries {
  return new Proxy({} as UserCardsQueries, {
    get: () => () =>
      Promise.reject(new Error('The Catalog runtime has no UserCards query capability.')),
  });
}
