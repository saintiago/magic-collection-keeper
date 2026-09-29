/**
 * Integration scope: the packaged runtimes over real PostgreSQL
 * (docs/application.md#configuration-and-lifecycle, docs/operations.md#packaging-and-deployment).
 *
 * The interactive entry point and the two finite background jobs are composed exactly as the
 * artifacts compose them — from one environment's variables, through the RDS Data API port and the
 * snapshot bucket port — and run against real PostgreSQL. The substituted boundary is the AWS
 * service itself; the statements, transaction control, credential separation, account scoping and
 * job outcomes are exercised for real, including the documented path from a committed private write
 * through background indexing to a served query result. The live service properties stay separate
 * evidence (docs/testing.md#live-boundaries-and-performance).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createApiGatewayHandler,
  createInteractiveDeployment,
  runCatalogJob,
  runIndexingJob,
  type SnapshotObjectClient,
} from '../../src/application/deployment.js';
import {
  catalogPublicationGrants,
  catalogReaderGrants,
  catalogSchemaSql,
} from '../../src/catalog/index.js';
import {
  searchIndexingGrants,
  searchReaderGrants,
  searchSchemaSql,
} from '../../src/search/index.js';
import {
  usercardsPublicationGrants,
  usercardsReaderGrants,
  usercardsSchemaSql,
} from '../../src/usercards/index.js';
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
const searchIndexingSecret =
  'arn:aws:secretsmanager:us-east-1:123456789012:secret:keeper-search-indexing';
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

/** The variables the background indexing job receives; it holds no provider credential. */
const indexingJobEnvironment: Record<string, string> = {
  KEEPER_ENVIRONMENT: 'test',
  AWS_REGION: 'us-east-1',
  KEEPER_DATABASE_CLUSTER_ARN: clusterArn,
  KEEPER_DATABASE_NAME: 'keeper',
  KEEPER_DATABASE_SEARCH_INDEXING_SECRET_ARN: searchIndexingSecret,
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
    database = await createTestDatabase(
      `${catalogSchemaSql}\n\n${usercardsSchemaSql}\n\n${searchSchemaSql}`,
    );
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

  /** Runs one bounded indexing pass against the published providers, as the deployed task runs it. */
  function indexJob(
    environment: Record<string, string> = indexingJobEnvironment,
  ): ReturnType<typeof runIndexingJob> {
    return runIndexingJob({
      environment,
      dataApi,
      log: (record) => {
        records.push({ ...record });
      },
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

  it('indexes the committed catalog and copies and serves them to their owner through Search', async () => {
    await runJob({
      metadata: { 'source-version': sourceVersion },
      version: 'snapshot-version-1',
      text: `${JSON.stringify(bolt)}\n`,
    });
    const deployment = interactive();
    const handler = createApiGatewayHandler(deployment.application);
    const ownedCopies = { resultLevel: 'copy', criteria: [{ kind: 'owned' }] };
    const searchAs = (accountId: string) =>
      handler(
        invocation({
          method: 'POST',
          path: '/api/search',
          claims: claimsFor(accountId),
          body: ownedCopies,
        }),
      );

    const created = await handler(
      invocation({
        method: 'POST',
        path: '/api/collection/copies',
        claims: claimsFor('cognito-alice'),
        body: {
          printingId: 'printing-tle-32-en',
          finish: 'nonfoil',
          condition: 'NM',
          quantity: 2,
        },
      }),
    );
    expect(created.statusCode).toBe(200);

    // Saving and indexing stay separate outcomes: the committed copies are not queryable yet.
    const before = await searchAs('cognito-alice');
    expect(before.statusCode).toBe(200);
    expect(JSON.parse(before.body)).toMatchObject({ status: 'updating', entries: [] });

    const outcome = await indexJob({
      ...indexingJobEnvironment,
      KEEPER_INDEXING_ACCOUNTS: 'cognito-alice',
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.result).toMatchObject({
      rebuilt: true,
      published: true,
      caughtUp: true,
      unresolvedReferences: 0,
    });
    expect(outcome.result?.accounts).toEqual([
      { accountId: 'cognito-alice', position: expect.any(String), caughtUp: true },
    ]);
    expect(records.at(-1)).toMatchObject({
      operation: 'search.index',
      environment: 'test',
      outcome: 'ok',
      published: true,
      caughtUp: true,
      indexedAccounts: 1,
    });

    const after = await searchAs('cognito-alice');
    expect(after.statusCode).toBe(200);
    expect(
      (JSON.parse(after.body) as { readonly entries: readonly unknown[] }).entries,
    ).toHaveLength(2);
    // The private projection stays account-scoped: another account's query returns none of them.
    const other = await searchAs('cognito-bob');
    expect((JSON.parse(other.body) as { readonly entries: readonly unknown[] }).entries).toEqual(
      [],
    );

    // The indexing run held only its own credential. It reads the provider publications the role
    // is granted — their publication logs, never the private records behind them — and every write
    // it makes maintains Search's own projection.
    const indexingStatements = dataApi
      .statements()
      .filter((entry) => entry.secretArn === searchIndexingSecret);
    expect(indexingStatements.length).toBeGreaterThan(0);
    expect(indexingStatements.some((entry) => entry.sql.includes('search_private'))).toBe(true);
    const grantedProviderRelations = new Set([
      'catalog_private.publication',
      'usercards_private.publication',
      'usercards_private.account_state',
    ]);
    const providerRelations = indexingStatements.flatMap((entry) =>
      [...entry.sql.matchAll(/\b(catalog_private|usercards_private)\.([a-z_]+)/g)].map(
        (match) => `${match[1]}.${match[2]}`,
      ),
    );
    for (const relation of providerRelations) {
      expect(grantedProviderRelations.has(relation), relation).toBe(true);
    }
    // Both provider publications were read through that one credential.
    expect(providerRelations).toContain('catalog_private.publication');
    expect(providerRelations).toContain('usercards_private.publication');
    expect(
      indexingStatements
        .filter((entry) => /\b(insert|update|delete)\b/i.test(entry.sql))
        .every((entry) => entry.sql.includes('search_private')),
    ).toBe(true);
    deployment.dispose();
  });

  it('runs the indexing pass with exactly the privileges the documented bootstrap grants', async () => {
    // The schema bootstrap of infra/README.md: four roles, the readers' published views, the
    // indexing role's own projection and trusted access to the two provider publications.
    await database.exec('create role keeper_reader');
    await database.exec('create role keeper_usercards_writer');
    await database.exec('create role keeper_catalog_writer');
    await database.exec('create role keeper_search_indexing');
    await database.exec(catalogReaderGrants('keeper_reader'));
    await database.exec(usercardsReaderGrants('keeper_reader'));
    await database.exec(searchReaderGrants('keeper_reader'));
    await database.exec(searchIndexingGrants('keeper_search_indexing'));
    await database.exec(catalogPublicationGrants('keeper_search_indexing'));
    await database.exec(usercardsPublicationGrants('keeper_search_indexing'));

    await runJob({
      metadata: { 'source-version': sourceVersion },
      version: 'snapshot-version-1',
      text: `${JSON.stringify(bolt)}\n`,
    });
    const deployment = interactive();
    const handler = createApiGatewayHandler(deployment.application);
    await handler(
      invocation({
        method: 'POST',
        path: '/api/collection/copies',
        claims: claimsFor('cognito-alice'),
        body: {
          printingId: 'printing-tle-32-en',
          finish: 'nonfoil',
          condition: null,
          quantity: 1,
        },
      }),
    );

    // The packaged indexing runtime runs as the indexing role, not as the bootstrap credential.
    await database.exec('set role keeper_search_indexing');
    try {
      const outcome = await indexJob({
        ...indexingJobEnvironment,
        KEEPER_INDEXING_ACCOUNTS: 'cognito-alice',
      });

      expect(outcome.ok).toBe(true);
      expect(outcome.result).toMatchObject({ published: true, caughtUp: true });
      // Its credential reaches the providers' publications, never their private records.
      await expect(database.query('select copy_id from usercards_private.copy')).rejects.toThrow(
        /permission denied/,
      );
      await expect(database.query('select card_id from catalog_private.card')).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await database.exec('reset role');
    }

    const indexed = await database.query(`select count(*)::int as copies from search_private.copy`);
    expect(indexed).toEqual([{ copies: 1 }]);
    deployment.dispose();
  });

  it('publishes a replacement indexing generation when an explicit run asks to rebuild', async () => {
    await runJob({
      metadata: { 'source-version': sourceVersion },
      version: 'snapshot-version-1',
      text: `${JSON.stringify(bolt)}\n`,
    });
    const deployment = interactive();
    const handler = createApiGatewayHandler(deployment.application);
    await handler(
      invocation({
        method: 'POST',
        path: '/api/collection/copies',
        claims: claimsFor('cognito-alice'),
        body: {
          printingId: 'printing-tle-32-en',
          finish: 'nonfoil',
          condition: null,
          quantity: 1,
        },
      }),
    );
    const first = await indexJob({
      ...indexingJobEnvironment,
      KEEPER_INDEXING_ACCOUNTS: 'cognito-alice',
    });
    expect(first.result).toMatchObject({ rebuilt: true, published: true, caughtUp: true });

    // The explicit rebuild input builds a replacement generation beside the published one and
    // publishes it only once the carried account is caught up.
    const second = await indexJob({
      ...indexingJobEnvironment,
      KEEPER_INDEXING_ACCOUNTS: 'cognito-alice',
      KEEPER_INDEXING_REBUILD: 'true',
    });

    expect(second.ok).toBe(true);
    expect(second.result).toMatchObject({ rebuilt: true, published: true, caughtUp: true });
    expect(second.result?.generation).not.toBe(first.result?.generation);
    const response = await handler(
      invocation({
        method: 'POST',
        path: '/api/search',
        claims: claimsFor('cognito-alice'),
        body: { resultLevel: 'copy', criteria: [{ kind: 'owned' }] },
      }),
    );
    expect(
      (JSON.parse(response.body) as { readonly entries: readonly unknown[] }).entries,
    ).toHaveLength(1);
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
