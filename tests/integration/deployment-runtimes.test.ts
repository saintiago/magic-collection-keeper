/**
 * Integration scope: the packaged runtimes over real PostgreSQL
 * (docs/application.md#configuration-and-lifecycle, docs/operations.md#packaging-and-deployment).
 *
 * The interactive entry point and the finite catalog job are composed exactly as the artifacts
 * compose them — from one environment's variables, through the RDS Data API port and the snapshot
 * bucket port — and run against real PostgreSQL. The substituted boundary is the AWS service
 * itself; the statements, transaction control, credential separation, account scoping and job
 * outcome are exercised for real. The live service properties stay separate evidence
 * (docs/testing.md#live-boundaries-and-performance).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createApiGatewayHandler,
  createInteractiveDeployment,
  runCatalogJob,
  type SnapshotObjectClient,
} from '../../src/application/deployment.js';
import { catalogSchemaSql } from '../../src/catalog/index.js';
import { usercardsSchemaSql } from '../../src/usercards/index.js';
import { createDataApiTestClient, type DataApiTestClient } from '../support/data-api.js';
import { createTestDatabase, type TestDatabase } from '../support/postgres-database.js';
import { createSnapshotObjects, type SnapshotObjectFixture } from '../support/snapshot-objects.js';

const issuer = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_keeper001';
const appClientId = 'keeper-test-client';
const readerSecret = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:keeper-reader';
const userCardsWriterSecret =
  'arn:aws:secretsmanager:us-east-1:123456789012:secret:keeper-usercards-writer';
const catalogWriterSecret =
  'arn:aws:secretsmanager:us-east-1:123456789012:secret:keeper-catalog-writer';
const clusterArn = 'arn:aws:rds:us-east-1:123456789012:cluster:keeper-test';
const snapshotKey = 'snapshots/default_cards.jsonl';
const sourceVersion = '2026-09-01T00:00:00.000Z';

const bolt = {
  object: 'card',
  id: 'printing-tle-32-en',
  oracle_id: 'oracle-lightning-bolt',
  name: 'Lightning Bolt',
  lang: 'en',
  set: 'tle',
  collector_number: '32',
  finishes: ['nonfoil', 'foil'],
  nonfoil: true,
  foil: true,
  etched: false,
  digital: false,
  oracle_text: 'Lightning Bolt deals 3 damage to any target.',
  type_line: 'Instant',
  colors: ['R'],
  color_identity: ['R'],
  cmc: 1,
  image_uris: {
    small: 'https://images.example.test/tle-32-small.jpg',
    normal: 'https://images.example.test/tle-32-normal.jpg',
    large: 'https://images.example.test/tle-32-large.jpg',
    art_crop: 'https://images.example.test/tle-32-art.jpg',
  },
};

/** The variables a deployed interactive runtime receives (infra/README.md#runtime-environment). */
const interactiveEnvironment: Record<string, string> = {
  KEEPER_ENVIRONMENT: 'test',
  AWS_REGION: 'us-east-1',
  KEEPER_USER_POOL_ID: 'us-east-1_keeper001',
  KEEPER_USER_POOL_CLIENT_ID: appClientId,
  KEEPER_DATABASE_CLUSTER_ARN: clusterArn,
  KEEPER_DATABASE_NAME: 'keeper',
  KEEPER_DATABASE_READER_SECRET_ARN: readerSecret,
  KEEPER_DATABASE_USERCARDS_WRITER_SECRET_ARN: userCardsWriterSecret,
  KEEPER_SNAPSHOT_BUCKET: 'keeper-test-snapshots',
  KEEPER_SNAPSHOT_PREFIX: 'snapshots/',
  KEEPER_RECOGNITION_BASE_URL: 'https://api.test.keeper.example',
  KEEPER_CLOUD_RECOGNITION: 'false',
  KEEPER_SOURCE_IMPORTS: 'true',
  KEEPER_REQUEST_TIMEOUT_MS: '10000',
};

/** The variables the finite catalog job receives; it holds no reader or UserCards credential. */
const catalogJobEnvironment: Record<string, string> = {
  KEEPER_ENVIRONMENT: 'test',
  AWS_REGION: 'us-east-1',
  KEEPER_DATABASE_CLUSTER_ARN: clusterArn,
  KEEPER_DATABASE_NAME: 'keeper',
  KEEPER_DATABASE_CATALOG_WRITER_SECRET_ARN: catalogWriterSecret,
  KEEPER_SNAPSHOT_BUCKET: 'keeper-test-snapshots',
  KEEPER_SNAPSHOT_PREFIX: 'snapshots/',
};

function claimsFor(accountId: string, overrides: Readonly<Record<string, unknown>> = {}) {
  // The claims an HTTP API JWT authorizer delivers: every value, including the expiry, is text.
  return {
    iss: issuer,
    aud: appClientId,
    sub: accountId,
    token_use: 'id',
    exp: String(Math.floor(Date.now() / 1000) + 300),
    ...overrides,
  };
}

function invocation(request: {
  readonly method: string;
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly claims?: Readonly<Record<string, unknown>> | null;
  readonly body?: unknown;
  readonly requestId?: string;
}): Record<string, unknown> {
  return {
    rawPath: request.path,
    ...(request.query === undefined ? {} : { queryStringParameters: request.query }),
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    requestContext: {
      requestId: request.requestId ?? 'integration-request',
      http: { method: request.method, path: request.path },
      ...(request.claims === undefined || request.claims === null
        ? {}
        : { authorizer: { jwt: { claims: request.claims } } }),
    },
  };
}

describe('packaged runtimes', () => {
  let database: TestDatabase;
  let dataApi: DataApiTestClient;
  let records: Record<string, unknown>[];

  beforeEach(async () => {
    database = await createTestDatabase(`${catalogSchemaSql}\n\n${usercardsSchemaSql}`);
    dataApi = createDataApiTestClient(database);
    records = [];
  });

  afterEach(async () => {
    await database.close();
  });

  /** Runs the finite job against one snapshot object, as the deployed task runs it. */
  function runJob(
    fixture: SnapshotObjectFixture,
    environment: Record<string, string> = catalogJobEnvironment,
  ): ReturnType<typeof runCatalogJob> {
    return runCatalogJob({
      environment,
      dataApi,
      snapshots: createSnapshotObjects({ [snapshotKey]: fixture }),
      log: (record) => {
        records.push({ ...record });
      },
    });
  }

  function interactive() {
    return createInteractiveDeployment({
      environment: interactiveEnvironment,
      dataApi,
    });
  }

  it('publishes through the finite job and serves the published catalog to a verified caller', async () => {
    const outcome = await runJob({
      metadata: { 'source-version': sourceVersion },
      version: 'snapshot-version-1',
      text: `${JSON.stringify(bolt)}\n`,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.revision?.sourceVersion).toBe(sourceVersion);
    const jobRecord = records.at(-1);
    expect(jobRecord).toMatchObject({
      operation: 'catalog.synchronize',
      outcome: 'ok',
      sourceName: 'scryfall',
      sourceVersion,
    });
    // The finite job ran only with the Catalog writer credential, and only over the catalog schema.
    const jobStatements = dataApi.statements();
    expect(jobStatements.length).toBeGreaterThan(0);
    expect(jobStatements.every((entry) => entry.secretArn === catalogWriterSecret)).toBe(true);
    expect(jobStatements.some((entry) => entry.sql.includes('usercards'))).toBe(false);

    const deployment = interactive();
    const handler = createApiGatewayHandler(deployment.application);
    const response = await handler(
      invocation({
        method: 'GET',
        path: '/api/card',
        query: { printing: 'printing-tle-32-en', oracle: 'oracle-lightning-bolt' },
        claims: claimsFor('cognito-alice'),
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(
      (JSON.parse(response.body) as { readonly cards: readonly unknown[] }).cards,
    ).toHaveLength(1);
    // The interactive runtime reaches the database with the reader credential only.
    const interactiveStatements = dataApi
      .statements()
      .slice(jobStatements.length)
      .map((entry) => entry.secretArn);
    expect(interactiveStatements).toEqual([readerSecret]);
    deployment.dispose();
  });

  it('stores a private copy for the verified account and keeps another account out', async () => {
    await runJob({
      metadata: { 'source-version': sourceVersion },
      version: 'snapshot-version-1',
      text: `${JSON.stringify(bolt)}\n`,
    });
    const deployment = interactive();
    const handler = createApiGatewayHandler(deployment.application);

    const created = await handler(
      invocation({
        method: 'POST',
        path: '/api/collection/copies',
        claims: claimsFor('cognito-alice'),
        // A caller-supplied owner never decides the account.
        body: {
          printingId: 'printing-tle-32-en',
          finish: 'nonfoil',
          condition: 'NM',
          quantity: 2,
          ownerId: 'cognito-bob',
        },
      }),
    );
    expect(created.statusCode).toBe(200);
    const copyIds = (
      JSON.parse(created.body) as { readonly copies: readonly { readonly copyId: string }[] }
    ).copies.map((copy) => copy.copyId);
    expect(copyIds).toHaveLength(2);
    // The private write went through the UserCards writer credential, never the reader's.
    expect(
      dataApi
        .statements()
        .filter((entry) => entry.sql.includes('usercards'))
        .every((entry) => entry.secretArn === userCardsWriterSecret),
    ).toBe(true);

    const alice = await handler(
      invocation({
        method: 'POST',
        path: '/api/collection/copies/read',
        claims: claimsFor('cognito-alice'),
        body: { copyIds },
      }),
    );
    expect((JSON.parse(alice.body) as { readonly copies: readonly unknown[] }).copies).toHaveLength(
      2,
    );

    const bob = await handler(
      invocation({
        method: 'POST',
        path: '/api/collection/copies/read',
        claims: claimsFor('cognito-bob'),
        body: { copyIds },
      }),
    );
    expect((JSON.parse(bob.body) as { readonly copies: readonly unknown[] }).copies).toEqual([]);
    deployment.dispose();
  });

  it('rejects an invocation of another environment’s identity before it writes anything', async () => {
    await runJob({
      metadata: { 'source-version': sourceVersion },
      version: 'snapshot-version-1',
      text: `${JSON.stringify(bolt)}\n`,
    });
    const deployment = interactive();
    const handler = createApiGatewayHandler(deployment.application);

    const response = await handler(
      invocation({
        method: 'POST',
        path: '/api/collection/copies',
        claims: claimsFor('cognito-alice', {
          iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_production1',
        }),
        body: {
          printingId: 'printing-tle-32-en',
          finish: 'nonfoil',
          condition: null,
          quantity: 1,
        },
      }),
    );

    expect(response.statusCode).toBe(401);
    expect(dataApi.transactions().begun).toBe(dataApi.transactions().committed);
    deployment.dispose();
  });

  it('rejects an expired or unreadable authorizer expiry before it writes anything', async () => {
    const deployment = interactive();
    const handler = createApiGatewayHandler(deployment.application);
    const expired = String(Math.floor(Date.now() / 1000) - 1);

    for (const exp of [expired, 'not-a-time']) {
      const response = await handler(
        invocation({
          method: 'POST',
          path: '/api/collection/copies',
          claims: claimsFor('cognito-alice', { exp }),
          body: {
            printingId: 'printing-tle-32-en',
            finish: 'nonfoil',
            condition: null,
            quantity: 1,
          },
        }),
      );
      expect(response.statusCode).toBe(401);
    }

    expect(dataApi.transactions().begun).toBe(0);
    deployment.dispose();
  });

  it('serves no health or readiness endpoint', async () => {
    const deployment = interactive();
    const handler = createApiGatewayHandler(deployment.application);

    for (const path of ['/health', '/api/health', '/ready']) {
      const response = await handler(invocation({ method: 'GET', path }));
      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.body)).toMatchObject({ error: { code: 'route-not-found' } });
    }
    deployment.dispose();
  });

  it('reports an already published snapshot without ingesting it again', async () => {
    const fixture = {
      metadata: { 'source-version': sourceVersion },
      version: 'snapshot-version-1',
      text: `${JSON.stringify(bolt)}\n`,
    };
    const first = await runJob(fixture);
    const statementsAfterFirst = dataApi.statements().length;
    const second = await runJob(fixture);

    expect(second.ok).toBe(true);
    expect(second.revision?.revisionId).toBe(first.revision?.revisionId);
    expect(second.revision?.sourceVersion).toBe(sourceVersion);
    // The second run reads what is published and writes nothing.
    const repeated = dataApi.statements().slice(statementsAfterFirst);
    expect(repeated.length).toBeGreaterThan(0);
    expect(repeated.some((entry) => /\b(insert|update|delete)\b/i.test(entry.sql))).toBe(false);
    expect(records.at(-1)).toMatchObject({ outcome: 'ok', sourceVersion });
  });

  it('opens no snapshot body when the published version is unchanged', async () => {
    const fixture = {
      metadata: { 'source-version': sourceVersion },
      version: 'snapshot-version-1',
      text: `${JSON.stringify(bolt)}\n`,
    };
    const source = createSnapshotObjects({ [snapshotKey]: fixture });
    let bodies = 0;
    const snapshots: SnapshotObjectClient = {
      head: (command) => source.head(command),
      get: (command) => {
        bodies += 1;
        return source.get(command);
      },
    };

    const first = await runCatalogJob({
      environment: catalogJobEnvironment,
      dataApi,
      snapshots,
      log: (record) => records.push({ ...record }),
    });
    expect(first.ok).toBe(true);
    expect(bodies).toBe(1);
    const published = bodies;

    const second = await runCatalogJob({
      environment: catalogJobEnvironment,
      dataApi,
      snapshots,
      log: (record) => records.push({ ...record }),
    });

    expect(second.ok).toBe(true);
    expect(second.revision?.revisionId).toBe(first.revision?.revisionId);
    // The unchanged run reads the metadata and never opens the transfer it does not ingest.
    expect(bodies).toBe(published);
  });

  it('reports an unusable snapshot as a failed run and publishes nothing', async () => {
    const outcome = await runCatalogJob({
      environment: catalogJobEnvironment,
      dataApi,
      snapshots: createSnapshotObjects({}),
      log: (record) => {
        records.push({ ...record });
      },
    });

    expect(outcome).toEqual({ ok: false, failureCode: 'unavailable', revision: null });
    expect(records.at(-1)).toMatchObject({
      operation: 'catalog.synchronize',
      outcome: 'failed',
      failureCode: 'unavailable',
    });
  });

  it('reports a missing configuration variable without publishing or leaking a value', async () => {
    const environment = { ...catalogJobEnvironment };
    delete environment['KEEPER_SNAPSHOT_BUCKET'];
    const outcome = await runJob({ metadata: {}, text: '' }, environment);

    expect(outcome.ok).toBe(false);
    expect(records.at(-1)).toMatchObject({
      operation: 'catalog.synchronize',
      outcome: 'failed',
    });
    expect(String(records.at(-1)?.['problem'])).toContain('KEEPER_SNAPSHOT_BUCKET');
    expect(JSON.stringify(records)).not.toContain(clusterArn);
    expect(JSON.stringify(records)).not.toContain(catalogWriterSecret);
  });
});
