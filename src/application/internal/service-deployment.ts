/** Production composition of the independently deployable Catalog and UserCards runtimes. */

import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { Hash } from '@smithy/hash-node';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import { RDSDataClient } from '@aws-sdk/client-rds-data';
import { z } from 'zod';

import { createCatalog } from '../../catalog/index.js';
import {
  createSourceImports,
  createUserCards,
  createUserCardsQueries,
  type UserCards,
  type UserCardsQueries,
} from '../../usercards/index.js';
import { createCatalogClient, type RequestTransport } from './client.js';
import { ConfigurationError } from './configuration.js';
import { silentDiagnostics, type Diagnostics } from './diagnostics.js';
import { ApplicationError, isApplicationFailureCode } from './failures.js';
import { createClaimsIdentityVerifier } from './identity.js';
import { createRequestHandler } from './request-handler.js';
import { createRoutes } from './routes.js';
import type { TransportRequest, TransportResponse } from './transport.js';
import {
  createDataApiTransactor,
  createRdsDataApiClient,
  type DataApiClient,
} from './deployment.js';

const environmentSchema = z.enum(['development', 'test', 'production']);
const regionSchema = z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/);
const poolSchema = z.string().regex(/^[a-z]{2}-[a-z]+-\d_[A-Za-z0-9]{9}$/);

interface ServiceIdentity {
  readonly environment: z.infer<typeof environmentSchema>;
  readonly region: string;
  readonly clusterArn: string;
  readonly database: string;
  readonly poolId: string;
  readonly appClientId: string;
  readonly requestTimeoutMs: number;
}

export interface ServingDeployment {
  handle(request: TransportRequest): Promise<TransportResponse>;
  dispose(): void;
}

interface ServingDeploymentOptions {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly dataApi?: DataApiClient;
  readonly diagnostics?: Diagnostics;
  readonly fetch?: typeof globalThis.fetch;
  readonly catalogRequest?: RequestTransport;
}

export function createCatalogServingDeployment(
  options: ServingDeploymentOptions,
): ServingDeployment {
  const identity = readIdentity(options.environment);
  const secretArn = required(options.environment, 'KEEPER_DATABASE_CATALOG_READER_SECRET_ARN');
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
    identity: verifier(identity),
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

export function createUserCardsServingDeployment(
  options: ServingDeploymentOptions,
): ServingDeployment {
  const identity = readIdentity(options.environment);
  const readerSecretArn = required(
    options.environment,
    'KEEPER_DATABASE_USERCARDS_READER_SECRET_ARN',
  );
  const writerSecretArn = required(
    options.environment,
    'KEEPER_DATABASE_USERCARDS_WRITER_SECRET_ARN',
  );
  const owned = options.dataApi === undefined;
  const client =
    options.dataApi ?? createRdsDataApiClient(new RDSDataClient({ region: identity.region }));
  const catalogRequest =
    options.catalogRequest ??
    createAwsCatalogRequest({
      baseUrl: required(options.environment, 'KEEPER_CATALOG_BASE_URL'),
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
    identity: verifier(identity),
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
  if (typeof fetchImpl !== 'function')
    throw new TypeError('Catalog service access requires fetch.');
  const signer = new SignatureV4({
    credentials: defaultProvider(),
    region: options.region,
    service: 'execute-api',
    sha256: Hash.bind(null, 'sha256'),
  });
  return async (path, init = {}) => {
    const publicUrl = new URL(path, baseUrl);
    const internalPath = `/internal${publicUrl.pathname}${publicUrl.search}`;
    const request = new HttpRequest({
      protocol: publicUrl.protocol,
      hostname: publicUrl.hostname,
      ...(publicUrl.port === '' ? {} : { port: Number(publicUrl.port) }),
      method: init.method ?? 'GET',
      path: internalPath,
      headers: {
        host: publicUrl.host,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    const signed = await signer.sign(request);
    let response: Response;
    try {
      response = await fetchImpl(new URL(internalPath, baseUrl), {
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

/** Internal IAM routes add one prefix; the provider handler dispatches the same public contract. */
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

function readIdentity(environment: Readonly<Record<string, string | undefined>>): ServiceIdentity {
  const parsedEnvironment = environmentSchema.safeParse(
    required(environment, 'KEEPER_ENVIRONMENT'),
  );
  const region = regionSchema.safeParse(required(environment, 'AWS_REGION'));
  const pool = poolSchema.safeParse(required(environment, 'KEEPER_USER_POOL_ID'));
  const timeout = Number(required(environment, 'KEEPER_REQUEST_TIMEOUT_MS'));
  const problems: string[] = [];
  if (!parsedEnvironment.success)
    problems.push('KEEPER_ENVIRONMENT: use development, test or production.');
  if (!region.success) problems.push('AWS_REGION: use an AWS region such as us-east-1.');
  if (!pool.success) problems.push('KEEPER_USER_POOL_ID: use a Cognito user pool identifier.');
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 15 * 60 * 1000) {
    problems.push('KEEPER_REQUEST_TIMEOUT_MS: use a bounded whole number of milliseconds.');
  }
  if (problems.length > 0 || !parsedEnvironment.success || !region.success || !pool.success) {
    throw new ConfigurationError(problems);
  }
  return {
    environment: parsedEnvironment.data,
    region: region.data,
    clusterArn: required(environment, 'KEEPER_DATABASE_CLUSTER_ARN'),
    database: required(environment, 'KEEPER_DATABASE_NAME'),
    poolId: pool.data,
    appClientId: required(environment, 'KEEPER_USER_POOL_CLIENT_ID'),
    requestTimeoutMs: timeout,
  };
}

function verifier(identity: ServiceIdentity) {
  return createClaimsIdentityVerifier({
    issuer: `https://cognito-idp.${identity.region}.amazonaws.com/${identity.poolId}`,
    appClientId: identity.appClientId,
  });
}

function required(environment: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = environment[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConfigurationError([`${name}: this runtime requires the variable.`]);
  }
  return value;
}

function sourceImportsEnabled(environment: Readonly<Record<string, string | undefined>>): boolean {
  const value = required(environment, 'KEEPER_SOURCE_IMPORTS');
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ConfigurationError(['KEEPER_SOURCE_IMPORTS: use true or false.']);
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
