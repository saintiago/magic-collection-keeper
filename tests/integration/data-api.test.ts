/** Test-transport isolation: real independent sessions, roles and transaction boundaries. */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createDataApiTestClient, type DataApiTestClient } from '../support/data-api.js';
import { startPostgresServer, type PostgresServer } from '../support/postgres-server.js';

let server: PostgresServer;
let client: DataApiTestClient;

beforeEach(async () => {
  server = await startPostgresServer(`
    create role projection_writer;
    create role publication_reader;
    create schema projection;
    create table projection.changes (id integer);
    grant usage on schema projection to projection_writer;
    grant select, insert on projection.changes to projection_writer;
    create schema publication;
    create table publication.records (id integer);
    grant usage on schema publication to publication_reader;
    grant select on publication.records to publication_reader;
  `);
  client = createDataApiTestClient(server, {
    roles: { projection: 'projection_writer', publication: 'publication_reader' },
  });
});
afterEach(async () => {
  await client.close();
  await server.close();
});

async function query(secretArn: string, sql: string, transactionId?: unknown): Promise<unknown> {
  const result = await client.send({
    name: 'ExecuteStatement',
    input: {
      secretArn,
      sql,
      ...(transactionId === undefined ? {} : { transactionId }),
    },
  });
  return JSON.parse(String(result['formattedRecords'])) as unknown;
}
async function begin(secretArn: string): Promise<unknown> {
  return (await client.send({ name: 'BeginTransaction', input: { secretArn } }))['transactionId'];
}

it('enforces standalone credentials, denies protected reads and rejects unmapped secrets', async () => {
  expect(await query('publication', 'select current_user')).toEqual([
    { current_user: 'publication_reader' },
  ]);
  await expect(query('publication', 'select * from projection.changes')).rejects.toThrow(
    /permission denied/,
  );
  expect(await query('projection', 'select current_user')).toEqual([
    { current_user: 'projection_writer' },
  ]);
  await expect(query('projection', 'select * from publication.records')).rejects.toThrow(
    /permission denied/,
  );
  await expect(query('unmapped', 'select current_user')).rejects.toThrow(/No PostgreSQL role/);
});

it('preserves projection role, local settings and rollback across independent publication transactions', async () => {
  const projection = await begin('projection');
  await query('projection', "select set_config('keeper.test', 'outer', true)", projection);
  await query('projection', 'insert into projection.changes values (1)', projection);
  const state =
    "select current_user, pg_current_xact_id()::text as transaction, current_setting('keeper.test') as setting";
  const before = await query('projection', state, projection);
  expect(before).toEqual([
    { current_user: 'projection_writer', transaction: expect.any(String), setting: 'outer' },
  ]);
  const publication = await begin('publication');
  expect(await query('publication', 'select current_user', publication)).toEqual([
    { current_user: 'publication_reader' },
  ]);
  await query('publication', 'select * from publication.records', publication);
  // A standalone statement also gets its own session while both transactions are open.
  expect(await query('projection', 'select * from projection.changes')).toEqual([]);
  await client.send({
    name: 'CommitTransaction',
    input: { secretArn: 'publication', transactionId: publication },
  });
  expect(await query('projection', state, projection)).toEqual(before);
  await expect(query('publication', 'select current_user', projection)).rejects.toThrow(
    /mismatched credential/,
  );
  await client.send({
    name: 'RollbackTransaction',
    input: { secretArn: 'projection', transactionId: projection },
  });
  expect(await query('projection', 'select * from projection.changes')).toEqual([]);
  await expect(query('projection', 'select current_user', projection)).rejects.toThrow(
    /Unknown transaction/,
  );
});
