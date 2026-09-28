/**
 * Component scope: the packaged Application runtimes
 * (docs/application.md#configuration-and-lifecycle, docs/operations.md#packaging-and-deployment).
 *
 * The deployment entry reads one environment's variables, validates them before constructing
 * anything, binds the RDS Data API and the private snapshot bucket behind their ports and turns
 * HTTP API invocations into transport requests. The AWS services themselves are substituted; the
 * call shapes, the parameter mapping and the failure translation are exercised for real.
 */

import { describe, expect, it } from 'vitest';

import {
  CATALOG_SNAPSHOT_SOURCE_NAME,
  createApiGatewayHandler,
  createConsoleDiagnostics,
  createDataApiTransactor,
  createS3SnapshotSource,
  readCatalogJobEnvironment,
  readInteractiveEnvironment,
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
  it('opens the dataset object under the configured prefix and streams its text', async () => {
    const reads: string[] = [];
    const source = createS3SnapshotSource({
      client: {
        async head(command) {
          reads.push(`head:${command.input.Key}`);
          return { metadata: { 'source-version': '2026-09-01T00:00:00.000Z' } };
        },
        async get(command) {
          reads.push(`get:${command.input.Key}`);
          return {
            metadata: {},
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

    expect(reads).toEqual([
      'head:snapshots/default_cards.jsonl',
      'get:snapshots/default_cards.jsonl',
    ]);
    expect(snapshot.sourceName).toBe(CATALOG_SNAPSHOT_SOURCE_NAME);
    expect(snapshot.sourceVersion).toBe('2026-09-01T00:00:00.000Z');
    const text: string[] = [];
    for await (const chunk of snapshot.text) {
      text.push(chunk);
    }
    expect(text.join('')).toBe('{"id":"printing-1"}\n{"id":"printing-2"}\n');
  });

  it('rejects a snapshot that does not record its provider version', async () => {
    const source = createS3SnapshotSource({
      client: {
        async head() {
          return { metadata: {} };
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
