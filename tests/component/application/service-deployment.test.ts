/** Component scope: production Catalog/UserCards runtime separation and internal route adaptation. */

import { describe, expect, it, vi } from 'vitest';

import {
  createAwsCatalogRequest,
  createCatalogServingDeployment,
  createUserCardsServingDeployment,
  withoutInternalCatalogPrefix,
  type DataApiClient,
} from '../../../src/application/deployment.js';

const identity = {
  KEEPER_ENVIRONMENT: 'test',
  AWS_REGION: 'us-east-1',
  KEEPER_DATABASE_CLUSTER_ARN: 'arn:aws:rds:us-east-1:123456789012:cluster:keeper-test',
  KEEPER_DATABASE_NAME: 'keeper',
  KEEPER_USER_POOL_ID: 'us-east-1_keeper001',
  KEEPER_USER_POOL_CLIENT_ID: 'keeper-test-client',
  KEEPER_REQUEST_TIMEOUT_MS: '20000',
} as const;

function unusedDataApi(): DataApiClient {
  return { send: vi.fn(async () => Promise.reject(new Error('Unexpected database access.'))) };
}

describe('independent serving deployments', () => {
  it('constructs Catalog serving with no UserCards credential', async () => {
    const deployment = createCatalogServingDeployment({
      environment: {
        ...identity,
        KEEPER_DATABASE_CATALOG_READER_SECRET_ARN:
          'arn:aws:secretsmanager:us-east-1:123456789012:secret:catalog-reader',
      },
      dataApi: unusedDataApi(),
    });

    const response = await deployment.handle({
      method: 'POST',
      path: '/api/collection/query',
      body: '{}',
    });
    expect(response.status).toBe(404);
    deployment.dispose();
  });

  it('constructs UserCards with no Catalog database credential', async () => {
    const catalogRequest = vi.fn(async () => ({
      revision: 'catalog-revision',
      cards: [],
      printings: [],
      missing: [],
    }));
    const deployment = createUserCardsServingDeployment({
      environment: {
        ...identity,
        KEEPER_DATABASE_USERCARDS_READER_SECRET_ARN:
          'arn:aws:secretsmanager:us-east-1:123456789012:secret:usercards-reader',
        KEEPER_DATABASE_USERCARDS_WRITER_SECRET_ARN:
          'arn:aws:secretsmanager:us-east-1:123456789012:secret:usercards-writer',
        KEEPER_CATALOG_BASE_URL: 'https://keeper.execute-api.us-east-1.amazonaws.com',
        KEEPER_SOURCE_IMPORTS: 'true',
      },
      dataApi: unusedDataApi(),
      catalogRequest,
    });

    const response = await deployment.handle({ method: 'GET', path: '/api/card' });
    expect(response.status).toBe(404);
    expect(catalogRequest).not.toHaveBeenCalled();
    deployment.dispose();
  });

  it('maps IAM service paths onto the same Catalog public contract', () => {
    expect(
      withoutInternalCatalogPrefix({
        rawPath: '/internal/api/catalog/resolve',
        requestContext: {
          http: { method: 'POST', path: '/internal/api/catalog/resolve' },
        },
      }),
    ).toMatchObject({
      rawPath: '/api/catalog/resolve',
      requestContext: { http: { path: '/api/catalog/resolve' } },
    });
  });

  it('signs Catalog service requests with the UserCards workload identity', async () => {
    const previous = {
      accessKey: process.env.AWS_ACCESS_KEY_ID,
      secretKey: process.env.AWS_SECRET_ACCESS_KEY,
      token: process.env.AWS_SESSION_TOKEN,
    };
    process.env.AWS_ACCESS_KEY_ID = 'AKIDEXAMPLE';
    process.env.AWS_SECRET_ACCESS_KEY = 'secret-example';
    process.env.AWS_SESSION_TOKEN = 'session-example';
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      void input;
      void init;
      return new Response(
        JSON.stringify({ revision: 'catalog-revision', cards: [], printings: [], missing: [] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    try {
      const request = createAwsCatalogRequest({
        baseUrl: 'https://keeper.execute-api.us-east-1.amazonaws.com',
        region: 'us-east-1',
        fetch,
      });
      await request('/api/catalog/resolve', { method: 'POST', body: '{"references":[]}' });
      const [url, init] = fetch.mock.calls[0] ?? [];
      expect(String(url)).toBe(
        'https://keeper.execute-api.us-east-1.amazonaws.com/internal/api/catalog/resolve',
      );
      const headers = (init?.headers ?? {}) as Readonly<Record<string, string>>;
      expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
      expect(headers['x-amz-security-token']).toBe('session-example');
    } finally {
      restoreEnvironment('AWS_ACCESS_KEY_ID', previous.accessKey);
      restoreEnvironment('AWS_SECRET_ACCESS_KEY', previous.secretKey);
      restoreEnvironment('AWS_SESSION_TOKEN', previous.token);
    }
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
