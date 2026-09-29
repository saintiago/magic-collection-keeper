/**
 * Component scope: the packaged Application runtimes
 * (docs/application.md#configuration-and-lifecycle, docs/operations.md#packaging-and-deployment).
 *
 * The deployment entry reads one environment's variables, validates them before constructing
 * anything, binds the RDS Data API and the private snapshot bucket behind their ports and turns
 * HTTP API invocations into transport requests. The AWS services themselves are substituted; the
 * call shapes, the parameter mapping and the failure translation are exercised for real.
 */

import { describe, expect, it, vi } from 'vitest';

import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

import {
  CATALOG_SNAPSHOT_SOURCE_NAME,
  createApiGatewayHandler,
  createConsoleDiagnostics,
  createDataApiTransactor,
  createInteractiveDeployment,
  createRdsDataApiClient,
  createS3SnapshotSource,
  createS3SnapshotClient,
  readCatalogJobEnvironment,
  readInteractiveEnvironment,
  readIndexingJobEnvironment,
  runCatalogJob,
  runIndexingJob,
  type DataApiCommand,
} from '../../../src/application/deployment.js';
import { ConfigurationError } from '../../../src/application/index.js';
import type { TransportRequest } from '../../../src/application/index.js';

const interactiveEnvironment: Record<string, string> = {
  KEEPER_ENVIRONMENT: 'test',
  AWS_REGION: 'us-east-1',
  KEEPER_USER_POOL_ID: 'us-east-1_keeper001',
  KEEPER_USER_POOL_CLIENT_ID: 'keeper-test-client',
  KEEPER_DATABASE_CLUSTER_ARN: 'arn:aws:rds:us-east-1:123456789012:cluster:keeper-test',
  KEEPER_DATABASE_NAME: 'keeper',
  KEEPER_DATABASE_READER_SECRET_ARN:
    'arn:aws:secretsmanager:us-east-1:123456789012:secret:keeper-reader',
  KEEPER_DATABASE_USERCARDS_WRITER_SECRET_ARN:
    'arn:aws:secretsmanager:us-east-1:123456789012:secret:keeper-usercards-writer',
  KEEPER_SNAPSHOT_BUCKET: 'keeper-test-snapshots',
  KEEPER_SNAPSHOT_PREFIX: 'snapshots/',
  KEEPER_RECOGNITION_BASE_URL: 'https://api.test.keeper.example',
  KEEPER_CLOUD_RECOGNITION: 'true',
  KEEPER_SOURCE_IMPORTS: 'true',
  KEEPER_REQUEST_TIMEOUT_MS: '20000',
};

const catalogJobEnvironment: Record<string, string> = {
  KEEPER_ENVIRONMENT: 'test',
  AWS_REGION: 'us-east-1',
  KEEPER_DATABASE_CLUSTER_ARN: 'arn:aws:rds:us-east-1:123456789012:cluster:keeper-test',
  KEEPER_DATABASE_NAME: 'keeper',
  KEEPER_DATABASE_CATALOG_WRITER_SECRET_ARN:
    'arn:aws:secretsmanager:us-east-1:123456789012:secret:keeper-catalog-writer',
  KEEPER_SNAPSHOT_BUCKET: 'keeper-test-snapshots',
  KEEPER_SNAPSHOT_PREFIX: 'snapshots/',
};

/** The variables the background indexing job receives; it holds only the Search indexing secret. */
const indexingJobEnvironment: Record<string, string> = {
  KEEPER_ENVIRONMENT: 'test',
  AWS_REGION: 'us-east-1',
  KEEPER_DATABASE_CLUSTER_ARN: 'arn:aws:rds:us-east-1:123456789012:cluster:keeper-test',
  KEEPER_DATABASE_NAME: 'keeper',
  KEEPER_DATABASE_SEARCH_INDEXING_SECRET_ARN:
    'arn:aws:secretsmanager:us-east-1:123456789012:secret:keeper-search-indexing',
};

/** A Data API port that records the calls the transactor issues. */
function recordingClient(responses: readonly Readonly<Record<string, unknown>>[] = []) {
  const commands: DataApiCommand[] = [];
  let index = 0;
  return {
    commands,
    async send(command: DataApiCommand): Promise<Readonly<Record<string, unknown>>> {
      commands.push(command);
      const response = responses[index] ?? {};
      index += 1;
      return response;
    },
  };
}

describe('deployment configuration', () => {
  it('reads the interactive runtime from the documented variables', () => {
    const configuration = readInteractiveEnvironment(interactiveEnvironment);

    expect(configuration.environment).toBe('test');
    expect(configuration.region).toBe('us-east-1');
    expect(configuration.authentication).toEqual({
      issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_keeper001',
      appClientId: 'keeper-test-client',
      region: 'us-east-1',
    });
    expect(configuration.resources.catalogDatabase.secretArn).toContain('keeper-reader');
    expect(configuration.resources.userCardsDatabase.secretArn).toContain(
      'keeper-usercards-writer',
    );
    expect(configuration.resources.catalogSnapshots).toEqual({
      bucket: 'keeper-test-snapshots',
      prefix: 'snapshots/',
    });
    expect(configuration.recognition.computeBaseUrl).toBe('https://api.test.keeper.example');
    expect(configuration.capabilities).toEqual({ cloudRecognition: true, sourceImports: true });
    expect(configuration.transport.requestTimeoutMs).toBe(20_000);
  });

  it('names the missing variable instead of reporting an unreadable configuration', () => {
    const environment = { ...interactiveEnvironment };
    delete environment['KEEPER_DATABASE_READER_SECRET_ARN'];

    expect(() => readInteractiveEnvironment(environment)).toThrow(ConfigurationError);
    expect(() => readInteractiveEnvironment(environment)).toThrow(
      /KEEPER_DATABASE_READER_SECRET_ARN/,
    );
  });

  it('rejects a capability that is neither true nor false', () => {
    const environment = { ...interactiveEnvironment, KEEPER_SOURCE_IMPORTS: 'yes' };

    expect(() => readInteractiveEnvironment(environment)).toThrow(/KEEPER_SOURCE_IMPORTS/);
  });

  it('rejects an identity that is not this environment’s user pool', () => {
    const environment = { ...interactiveEnvironment, KEEPER_USER_POOL_ID: 'not-a-pool' };

    expect(() => readInteractiveEnvironment(environment)).toThrow(/KEEPER_USER_POOL_ID/);
  });

  it('reads the catalog job without any identity or browser setting', () => {
    const configuration = readCatalogJobEnvironment(catalogJobEnvironment);

    expect(configuration).toEqual({
      environment: 'test',
      region: 'us-east-1',
      database: {
        clusterArn: 'arn:aws:rds:us-east-1:123456789012:cluster:keeper-test',
        secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:keeper-catalog-writer',
        database: 'keeper',
      },
      snapshots: { bucket: 'keeper-test-snapshots', prefix: 'snapshots/' },
    });
    expect(configuration.database.secretArn).not.toContain('usercards');
  });

  it('requires the catalog writer credential of the finite job', () => {
    const environment = { ...catalogJobEnvironment };
    delete environment['KEEPER_DATABASE_CATALOG_WRITER_SECRET_ARN'];

    expect(() => readCatalogJobEnvironment(environment)).toThrow(
      /KEEPER_DATABASE_CATALOG_WRITER_SECRET_ARN/,
    );
  });

  it('reads the indexing job without any identity, browser or provider credential', () => {
    const configuration = readIndexingJobEnvironment(indexingJobEnvironment);

    expect(configuration).toEqual({
      environment: 'test',
      region: 'us-east-1',
      database: {
        clusterArn: 'arn:aws:rds:us-east-1:123456789012:cluster:keeper-test',
        secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:keeper-search-indexing',
        database: 'keeper',
      },
      accounts: [],
      rebuild: false,
    });
    expect(configuration.database.secretArn).not.toContain('writer');
    expect(configuration.database.secretArn).not.toContain('reader');
  });

  it('reads the accounts and rebuild mode one explicit indexing run names', () => {
    const configuration = readIndexingJobEnvironment({
      ...indexingJobEnvironment,
      KEEPER_INDEXING_ACCOUNTS: 'cognito-alice, cognito-bob',
      KEEPER_INDEXING_REBUILD: 'true',
    });

    expect(configuration.accounts).toEqual(['cognito-alice', 'cognito-bob']);
    expect(configuration.rebuild).toBe(true);
  });

  it('requires the Search indexing credential and rejects an unreadable rebuild mode', () => {
    const missing = { ...indexingJobEnvironment };
    delete missing['KEEPER_DATABASE_SEARCH_INDEXING_SECRET_ARN'];
    expect(() => readIndexingJobEnvironment(missing)).toThrow(
      /KEEPER_DATABASE_SEARCH_INDEXING_SECRET_ARN/,
    );
    expect(() =>
      readIndexingJobEnvironment({ ...indexingJobEnvironment, KEEPER_INDEXING_REBUILD: 'yes' }),
    ).toThrow(/KEEPER_INDEXING_REBUILD/);
  });
});

describe('RDS Data API transport', () => {
  it('executes statements with named parameters and reads the JSON record format', async () => {
    const client = recordingClient([{ formattedRecords: '[{"id":"copy-1","quantity":2}]' }]);
    const sql = createDataApiTransactor({
      client,
      resourceArn: 'arn:aws:rds:us-east-1:123456789012:cluster:keeper-test',
      secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:keeper-reader',
      database: 'keeper',
    });

    const rows = await sql.query('select :account_id as id', {
      account_id: 'cognito-alice',
      limit: 3,
      enabled: true,
      missing: null,
    });

    expect(rows).toEqual([{ id: 'copy-1', quantity: 2 }]);
    expect(client.commands).toHaveLength(1);
    const command = client.commands[0];
    expect(command?.name).toBe('ExecuteStatement');
    expect(command?.input['sql']).toBe('select :account_id as id');
    expect(command?.input['formatRecordsAs']).toBe('JSON');
    expect(command?.input['transactionId']).toBeUndefined();
    expect(command?.input['parameters']).toEqual([
      { name: 'account_id', value: { stringValue: 'cognito-alice' } },
      { name: 'limit', value: { longValue: 3 } },
      { name: 'enabled', value: { booleanValue: true } },
      { name: 'missing', value: { isNull: true } },
    ]);
  });

  it('reads an empty result when the service returns no record list', async () => {
    const client = recordingClient([{}]);
    const sql = createDataApiTransactor({
      client,
      resourceArn: 'arn:aws:rds:us-east-1:123456789012:cluster:keeper-test',
      secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:keeper-reader',
      database: 'keeper',
    });

    await expect(sql.query('create table example (id text)')).resolves.toEqual([]);
  });

  it('rejects a record the components cannot read instead of reporting an empty result', async () => {
    const client = recordingClient([{ formattedRecords: '[{"payload":{"nested":true}}]' }]);
    const sql = createDataApiTransactor({
      client,
      resourceArn: 'arn:aws:rds:us-east-1:123456789012:cluster:keeper-test',
      secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:keeper-reader',
      database: 'keeper',
    });

    await expect(sql.query('select payload')).rejects.toThrow(/not scalar/);
  });

  it('commits one transaction and rolls back the failed one', async () => {
    const client = recordingClient([
      { transactionId: 'tx-1' },
      { formattedRecords: '[]' },
      {},
      { transactionId: 'tx-2' },
      {},
    ]);
    const sql = createDataApiTransactor({
      client,
      resourceArn: 'arn:aws:rds:us-east-1:123456789012:cluster:keeper-test',
      secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:keeper-usercards-writer',
      database: 'keeper',
    });

    await sql.transaction(async (statements) => {
      await statements.query('insert into example values (:id)', { id: 'copy-1' });
    });
    await expect(
      sql.transaction(async () => {
        throw new Error('The change was refused.');
      }),
    ).rejects.toThrow('The change was refused.');

    expect(client.commands.map((command) => command.name)).toEqual([
      'BeginTransaction',
      'ExecuteStatement',
      'CommitTransaction',
      'BeginTransaction',
      'RollbackTransaction',
    ]);
    const statement = client.commands[1];
    expect(statement?.input['transactionId']).toBe('tx-1');
  });

  it('keeps the operation failure when the rollback itself fails', async () => {
    const commands: DataApiCommand[] = [];
    const sql = createDataApiTransactor({
      client: {
        async send(command) {
          commands.push(command);
          if (command.name === 'BeginTransaction') {
            return { transactionId: 'tx-1' };
          }
          if (command.name === 'RollbackTransaction') {
            throw new Error('The transaction is already gone.');
          }
          return {};
        },
      },
      resourceArn: 'arn:aws:rds:us-east-1:123456789012:cluster:keeper-test',
      secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:keeper-usercards-writer',
      database: 'keeper',
    });

    await expect(
      sql.transaction(async (statements) => {
        await statements.query('insert into example values (:id)', { id: 'copy-1' });
        throw new Error('The change was refused.');
      }),
    ).rejects.toThrow('The change was refused.');
    expect(commands.map((command) => command.name)).toEqual([
      'BeginTransaction',
      'ExecuteStatement',
      'RollbackTransaction',
    ]);
  });
});

describe('snapshot bucket source', () => {
  it('pins the body to the object version its metadata described and streams its text', async () => {
    const reads: { readonly key: string; readonly version: string | undefined }[] = [];
    const source = createS3SnapshotSource({
      client: {
        async head(command) {
          reads.push({ key: `head:${command.input.Key}`, version: command.input.VersionId });
          return {
            metadata: { 'source-version': '2026-09-01T00:00:00.000Z' },
            version: 'object-version-1',
          };
        },
        async get(command) {
          reads.push({ key: `get:${command.input.Key}`, version: command.input.VersionId });
          return {
            metadata: {},
            version: 'object-version-1',
            body: (async function* stream() {
              yield '{"id":"printing-1"}\n';
              yield '{"id":"printing-2"}\n';
            })(),
          };
        },
      },
      bucket: 'keeper-test-snapshots',
      prefix: 'snapshots/',
    });

    const snapshot = await source.open({ dataset: 'default_cards' });

    // Opening the snapshot reads its metadata only; the metadata and the body belong to one version.
    expect(reads).toEqual([{ key: 'head:snapshots/default_cards.jsonl', version: undefined }]);
    expect(snapshot.sourceName).toBe(CATALOG_SNAPSHOT_SOURCE_NAME);
    expect(snapshot.sourceVersion).toBe('2026-09-01T00:00:00.000Z');
    const text: string[] = [];
    for await (const chunk of snapshot.text) {
      text.push(chunk);
    }
    expect(reads).toEqual([
      { key: 'head:snapshots/default_cards.jsonl', version: undefined },
      { key: 'get:snapshots/default_cards.jsonl', version: 'object-version-1' },
    ]);
    expect(text.join('')).toBe('{"id":"printing-1"}\n{"id":"printing-2"}\n');
  });

  it('starts no transfer for a snapshot that is never read', async () => {
    let reads = 0;
    const source = createS3SnapshotSource({
      client: {
        async head() {
          reads += 1;
          return { metadata: { 'source-version': 'v1' }, version: null };
        },
        async get() {
          throw new Error('An unread snapshot opens no transfer.');
        },
      },
      bucket: 'keeper-test-snapshots',
      prefix: 'snapshots/',
    });

    const snapshot = await source.open({ dataset: 'default_cards' });
    const iterator = snapshot.text[Symbol.asyncIterator]();
    await iterator.return?.();

    expect(reads).toBe(1);
  });

  it('releases the body of a transfer the caller stops reading', async () => {
    let releases = 0;
    const body: AsyncIterable<string> & { destroy(): void } = {
      destroy() {
        releases += 1;
      },
      async *[Symbol.asyncIterator]() {
        yield '{"id":"printing-1"}\n';
        yield '{"id":"printing-2"}\n';
      },
    };
    const source = createS3SnapshotSource({
      client: {
        async head() {
          return { metadata: { 'source-version': 'v1' }, version: null };
        },
        async get() {
          return { metadata: {}, version: null, body };
        },
      },
      bucket: 'keeper-test-snapshots',
      prefix: null,
    });

    const snapshot = await source.open({ dataset: 'default_cards' });
    for await (const chunk of snapshot.text) {
      expect(chunk).toContain('printing-1');
      break;
    }

    expect(releases).toBe(1);
  });

  it('refuses a body that does not belong to the version its metadata described', async () => {
    let releases = 0;
    const source = createS3SnapshotSource({
      client: {
        async head() {
          return { metadata: { 'source-version': 'v1' }, version: 'object-version-1' };
        },
        async get() {
          return {
            metadata: {},
            version: 'object-version-2',
            body: {
              destroy() {
                releases += 1;
              },
              async *[Symbol.asyncIterator]() {
                yield '{"id":"printing-of-another-version"}\n';
              },
            },
          };
        },
      },
      bucket: 'keeper-test-snapshots',
      prefix: null,
    });

    const snapshot = await source.open({ dataset: 'default_cards' });

    await expect(collect(snapshot.text)).rejects.toThrow(/changed/);
    expect(releases).toBe(1);
  });

  it('rejects a snapshot that does not record its provider version', async () => {
    const source = createS3SnapshotSource({
      client: {
        async head() {
          return { metadata: {}, version: null };
        },
        async get() {
          throw new Error('A snapshot without a version is never read.');
        },
      },
      bucket: 'keeper-test-snapshots',
      prefix: null,
    });

    await expect(source.open({ dataset: 'default_cards' })).rejects.toThrow(/provider version/);
  });
});

/** Reads one snapshot's text to the end, so a failure surfaces to the assertion. */
async function collect(text: AsyncIterable<string>): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of text) {
    chunks.push(chunk);
  }
  return chunks.join('');
}

describe('interactive HTTP API entry point', () => {
  it('maps one invocation to the transport request the boundary validates', async () => {
    const requests: TransportRequest[] = [];
    const handler = createApiGatewayHandler({
      async handle(request) {
        requests.push(request);
        return {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ ok: true }),
        };
      },
    });

    const response = await handler({
      rawPath: '/api/collection/copies',
      queryStringParameters: { pageSize: '10', ignored: 4 },
      headers: { origin: 'https://keeper.test' },
      body: Buffer.from(JSON.stringify({ printingId: 'printing-1' })).toString('base64'),
      isBase64Encoded: true,
      requestContext: {
        requestId: 'request-1',
        http: { method: 'post', path: '/api/collection/copies' },
        authorizer: { jwt: { claims: { sub: 'cognito-alice', token_use: 'id' } } },
      },
    });

    expect(response).toEqual({
      statusCode: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ ok: true }),
    });
    expect(requests).toEqual([
      {
        method: 'post',
        path: '/api/collection/copies',
        query: { pageSize: '10' },
        authentication: { claims: { sub: 'cognito-alice', token_use: 'id' } },
        body: JSON.stringify({ printingId: 'printing-1' }),
        requestId: 'request-1',
      },
    ]);
  });

  it('presents no claims when the invocation carries no verified identity', async () => {
    const requests: TransportRequest[] = [];
    const handler = createApiGatewayHandler({
      async handle(request) {
        requests.push(request);
        return { status: 401, headers: {}, body: '{}' };
      },
    });

    await handler({
      rawPath: '/api/card',
      requestContext: { requestId: 'request-2', http: { method: 'GET', path: '/api/card' } },
    });

    expect(requests[0]?.authentication).toEqual({ claims: null });
  });

  it('normalizes the string expiry an HTTP API authorizer delivers', async () => {
    const requests: TransportRequest[] = [];
    const handler = createApiGatewayHandler({
      async handle(request) {
        requests.push(request);
        return { status: 200, headers: {}, body: '{}' };
      },
    });

    await handler({
      rawPath: '/api/card',
      requestContext: {
        requestId: 'request-3',
        http: { method: 'GET', path: '/api/card' },
        authorizer: {
          jwt: {
            claims: {
              iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_keeper001',
              aud: 'keeper-test-client',
              sub: 'cognito-alice',
              token_use: 'id',
              exp: '1893456000',
            },
          },
        },
      },
    });

    expect(requests[0]?.authentication).toEqual({
      claims: {
        iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_keeper001',
        aud: 'keeper-test-client',
        sub: 'cognito-alice',
        token_use: 'id',
        exp: 1_893_456_000,
      },
    });
  });

  it('passes an expiry the verifier cannot use on unchanged, so it rejects the invocation', async () => {
    const requests: TransportRequest[] = [];
    const handler = createApiGatewayHandler({
      async handle(request) {
        requests.push(request);
        return { status: 200, headers: {}, body: '{}' };
      },
    });

    await handler({
      rawPath: '/api/card',
      requestContext: {
        http: { method: 'GET', path: '/api/card' },
        authorizer: { jwt: { claims: { sub: 'cognito-alice', exp: 'soon' } } },
      },
    });

    expect(requests[0]?.authentication).toEqual({
      claims: { sub: 'cognito-alice', exp: 'soon' },
    });
  });

  it('reports an unreadable invocation as an invalid request', async () => {
    const handler = createApiGatewayHandler({
      async handle() {
        throw new Error('A malformed invocation never reaches the boundary.');
      },
    });

    const response = await handler({ body: 'not-an-event' });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      error: {
        code: 'invalid-request',
        message: 'The invocation is not a readable HTTP request.',
      },
    });
  });

  it('reports an unexpected boundary failure as unavailable without leaking the cause', async () => {
    const handler = createApiGatewayHandler({
      async handle() {
        throw new Error('The cluster rejected the credential of arn:aws:secretsmanager:…');
      },
    });

    const response = await handler({
      rawPath: '/api/card',
      requestContext: { http: { method: 'GET', path: '/api/card' } },
    });

    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('secretsmanager');
    expect(JSON.parse(response.body)).toEqual({
      error: { code: 'unavailable', message: 'The operation could not be completed.' },
    });
  });
});

describe('snapshot SDK adapter', () => {
  it('reads the object version of the metadata and pins the body request to it', async () => {
    const sent: unknown[] = [];
    const client = createS3SnapshotClient({
      async send(command: unknown) {
        sent.push(command);
        return {
          Metadata: { 'source-version': '2026-09-01T00:00:00.000Z' },
          VersionId: 'object-version-1',
          Body: undefined,
        };
      },
    } as never);

    const head = await client.head({
      name: 'HeadObject',
      input: { Bucket: 'keeper-test-snapshots', Key: 'snapshots/default_cards.jsonl' },
    });
    const object = await client.get({
      name: 'GetObject',
      input: {
        Bucket: 'keeper-test-snapshots',
        Key: 'snapshots/default_cards.jsonl',
        ...(head.version === null ? {} : { VersionId: head.version }),
      },
    });

    expect(head).toEqual({
      metadata: { 'source-version': '2026-09-01T00:00:00.000Z' },
      version: 'object-version-1',
    });
    expect(sent[0]).toBeInstanceOf(HeadObjectCommand);
    expect(sent[1]).toBeInstanceOf(GetObjectCommand);
    expect((sent[1] as GetObjectCommand).input).toMatchObject({
      Bucket: 'keeper-test-snapshots',
      Key: 'snapshots/default_cards.jsonl',
      VersionId: 'object-version-1',
    });
    expect(object.version).toBe('object-version-1');
  });
});

describe('catalog job snapshot lifecycle', () => {
  it('opens no snapshot transfer when another publication holds the lock', async () => {
    const client = recordingClient([
      { formattedRecords: '[]' },
      { transactionId: 'tx-1' },
      { formattedRecords: '[{"locked":"false"}]' },
      {},
    ]);
    let reads = 0;

    const outcome = await runCatalogJob({
      environment: catalogJobEnvironment,
      dataApi: client,
      snapshots: {
        async head() {
          return { metadata: { 'source-version': 'v1' }, version: null };
        },
        async get() {
          reads += 1;
          return {
            metadata: {},
            version: null,
            body: (async function* stream() {
              yield '{"id":"printing-1"}\n';
            })(),
          };
        },
      },
      log: () => undefined,
    });

    // The busy run reports its outcome without opening the transfer it never consumes.
    expect(outcome).toEqual({ ok: false, failureCode: 'busy', revision: null });
    expect(reads).toBe(0);
  });
});

describe('background indexing job outcome', () => {
  it('reports a missing configuration variable as a failed pass without leaking a value', async () => {
    const environment = { ...indexingJobEnvironment };
    delete environment['KEEPER_DATABASE_SEARCH_INDEXING_SECRET_ARN'];
    const records: Record<string, unknown>[] = [];

    const outcome = await runIndexingJob({
      environment,
      dataApi: recordingClient(),
      log: (record) => records.push({ ...record }),
    });

    expect(outcome).toEqual({ ok: false, failureCode: 'unavailable', result: null });
    expect(records.at(-1)).toMatchObject({
      operation: 'search.index',
      outcome: 'failed',
      failureCode: 'unavailable',
    });
    expect(String(records.at(-1)?.['problem'])).toContain(
      'KEEPER_DATABASE_SEARCH_INDEXING_SECRET_ARN',
    );
    expect(JSON.stringify(records)).not.toContain('keeper-test');
  });
});

describe('deployment-owned SDK clients', () => {
  it('releases the SDK client each adapter wraps', () => {
    const dataApiSdk = { send: async () => ({}), destroy: vi.fn() };
    const snapshotsSdk = { send: async () => ({}), destroy: vi.fn() };

    createRdsDataApiClient(dataApiSdk as never).destroy?.();
    createS3SnapshotClient(snapshotsSdk as never).destroy?.();

    expect(dataApiSdk.destroy).toHaveBeenCalledTimes(1);
    expect(snapshotsSdk.destroy).toHaveBeenCalledTimes(1);
  });

  it('keeps a caller-supplied client open when the runtime is disposed', () => {
    const destroy = vi.fn();
    const deployment = createInteractiveDeployment({
      environment: interactiveEnvironment,
      dataApi: {
        async send() {
          return {};
        },
        destroy,
      },
    });

    deployment.dispose();

    // A port the caller supplied stays the caller's; only the runtime's own client is released.
    expect(destroy).not.toHaveBeenCalled();
  });
});

describe('runtime diagnostics', () => {
  it('records the operation, outcome and duration without private content', () => {
    const lines: string[] = [];
    const diagnostics = createConsoleDiagnostics((line) => lines.push(line));

    diagnostics.record({
      operation: 'search.execute',
      requestId: 'request-1',
      outcome: 'failed',
      failureCode: 'timeout',
      durationMs: 20_000,
    });

    expect(JSON.parse(lines[0] ?? '')).toEqual({
      event: 'keeper-operation',
      operation: 'search.execute',
      requestId: 'request-1',
      outcome: 'failed',
      failureCode: 'timeout',
      durationMs: 20_000,
    });
  });
});
