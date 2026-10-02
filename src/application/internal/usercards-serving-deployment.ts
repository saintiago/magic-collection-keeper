/** Production composition of the independently deployable UserCards runtime. */

import { RDSDataClient } from '@aws-sdk/client-rds-data';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { Hash } from '@smithy/hash-node';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';

import {
  createSourceImports,
  createUserCards,
  createUserCardsQueries,
} from '../../usercards/serving.js';
import { createCatalogClient, type RequestTransport } from './client.js';
import { createDataApiTransactor, createRdsDataApiClient } from './data-api.js';
import { silentDiagnostics } from './diagnostics.js';
import { ApplicationError, isApplicationFailureCode } from './failures.js';
import { createRequestHandler } from './request-handler.js';
import { createRoutes } from './routes.js';
import {
  readServingIdentity,
  requiredServingVariable,
  servingIdentityVerifier,
  sourceImportsEnabled,
  type ServingDeployment,
  type ServingDeploymentOptions,
} from './serving-deployment-shared.js';

export function createUserCardsServingDeployment(
  options: ServingDeploymentOptions,
): ServingDeployment {
  const identity = readServingIdentity(options.environment);
  const readerSecretArn = requiredServingVariable(
    options.environment,
    'KEEPER_DATABASE_USERCARDS_READER_SECRET_ARN',
  );
  const writerSecretArn = requiredServingVariable(
    options.environment,
    'KEEPER_DATABASE_USERCARDS_WRITER_SECRET_ARN',
  );
  const owned = options.dataApi === undefined;
  const client =
    options.dataApi ?? createRdsDataApiClient(new RDSDataClient({ region: identity.region }));
  const catalogRequest =
    options.catalogRequest ??
    createAwsCatalogRequest({
      baseUrl: requiredServingVariable(options.environment, 'KEEPER_CATALOG_BASE_URL'),
      region: identity.region,
      fetch: options.fetch,
    });
  const catalog = createCatalogClient(catalogRequest);
  const writeSql = createDataApiTransactor({
    client,
    resourceArn: identity.clusterArn,
    secretArn: writerSecretArn,
    database: identity.database,
  });
  const userCards = createUserCards({ sql: writeSql, catalog });
  const userCardsQueries = createUserCardsQueries({
    sql: createDataApiTransactor({
      client,
      resourceArn: identity.clusterArn,
      secretArn: readerSecretArn,
      database: identity.database,
    }),
  });
  const sourceImports = sourceImportsEnabled(options.environment)
    ? createSourceImports({ sql: writeSql, catalog })
    : null;
  const routes = createRoutes({ catalog, userCards, userCardsQueries, sourceImports }).filter(
    (route) => route.operation.startsWith('usercards.'),
  );
  const handle = createRequestHandler({
    routes,
    identity: servingIdentityVerifier(identity),
    requestTimeoutMs: identity.requestTimeoutMs,
    diagnostics: options.diagnostics ?? silentDiagnostics,
  });
  return {
    handle,
    dispose() {
      if (owned) client.destroy?.();
    },
  };
}

/** SigV4-authenticated Catalog adapter used only by the UserCards workload identity. */
export function createAwsCatalogRequest(options: {
  readonly baseUrl: string;
  readonly region: string;
  readonly fetch?: typeof globalThis.fetch;
}): RequestTransport {
  const baseUrl = new URL(options.baseUrl);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('Catalog service access requires fetch.');
  }
  const signer = new SignatureV4({
    credentials: defaultProvider(),
    region: options.region,
    service: 'execute-api',
    sha256: Hash.bind(null, 'sha256'),
  });
  return async (path, init = {}) => {
    const publicUrl = new URL(path, baseUrl);
    const internalPath = `/internal${publicUrl.pathname}`;
    const query = queryParameters(publicUrl.searchParams);
    const request = new HttpRequest({
      protocol: publicUrl.protocol,
      hostname: publicUrl.hostname,
      ...(publicUrl.port === '' ? {} : { port: Number(publicUrl.port) }),
      method: init.method ?? 'GET',
      path: internalPath,
      query,
      headers: {
        host: publicUrl.host,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    const signed = await signer.sign(request);
    const signedUrl = new URL(internalPath, baseUrl);
    signedUrl.search = publicUrl.search;
    let response: Response;
    try {
      response = await fetchImpl(signedUrl, {
        method: signed.method,
        headers: signed.headers,
        ...(signed.body === undefined ? {} : { body: String(signed.body) }),
        signal: init.signal ?? undefined,
      });
    } catch (cause) {
      throw new ApplicationError('unavailable', 'Catalog reference resolution is unavailable.', {
        cause,
      });
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw serviceFailure(payload);
    return payload;
  };
}

function queryParameters(search: URLSearchParams): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const [name, value] of search) {
    const previous = query[name];
    query[name] =
      previous === undefined
        ? value
        : Array.isArray(previous)
          ? [...previous, value]
          : [previous, value];
  }
  return query;
}

function serviceFailure(payload: unknown): ApplicationError {
  const error = asRecord(asRecord(payload)?.error);
  const code = error?.code;
  const message = error?.message;
  return new ApplicationError(
    typeof code === 'string' && isApplicationFailureCode(code) ? code : 'unavailable',
    typeof message === 'string' ? message : 'Catalog reference resolution is unavailable.',
  );
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}
