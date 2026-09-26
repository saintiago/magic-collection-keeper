/**
 * A real PostgreSQL server for the boundary cases that need two connections at once. PGlite serves
 * a single connection, so an interleaving of concurrent writers cannot run there; this harness
 * provisions a local server without credentials or an external service and hands out connections
 * whose executors have the shape Application supplies to UserCards.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import EmbeddedPostgres from 'embedded-postgres';
import type { Client } from 'pg';

import type {
  UserCardsSqlExecutor,
  UserCardsSqlRow,
  UserCardsSqlTransactor,
  UserCardsSqlValue,
} from '../../src/usercards/index.js';
import { bindNamedParameters } from './postgres-database.js';

/** Hooks that let one case interleave two writers of the same database. */
export interface PostgresTransactionHooks {
  /** Runs inside the transaction, after its statements and before its commit. */
  readonly beforeCommit?: () => Promise<void>;
  /** Observes each statement the transaction issues, before it runs. */
  readonly onStatement?: (statement: string) => void;
}

export interface PostgresConnection {
  /** Runs one statement with positional parameters, for setup and post-change assertions. */
  query(
    statement: string,
    values?: readonly unknown[],
  ): Promise<readonly Record<string, unknown>[]>;
  /** Transaction-capable executor in the shape Application supplies to UserCards. */
  transactor(hooks?: PostgresTransactionHooks): UserCardsSqlTransactor;
  close(): Promise<void>;
}

export interface PostgresServer {
  /** A connection to the shared test database; every connection sees the same writes. */
  connect(): Promise<PostgresConnection>;
  close(): Promise<void>;
}

function executorFor(client: Client): UserCardsSqlExecutor {
  return {
    async query(statement, parameters = {}): Promise<readonly UserCardsSqlRow[]> {
      const bound = bindNamedParameters(statement, parameters);
      const result = await client.query<Record<string, UserCardsSqlValue>>(
        bound.text,
        bound.values,
      );
      return result.rows;
    },
  };
}

function connectionFor(client: Client): PostgresConnection {
  const executor = executorFor(client);
  return {
    async query(statement, values = []) {
      const result = await client.query<Record<string, unknown>>(statement, [...values]);
      return result.rows;
    },
    transactor(hooks = {}) {
      return {
        query: executor.query,
        async transaction(work) {
          await client.query('begin');
          try {
            const result = await work({
              query(statement, parameters) {
                hooks.onStatement?.(statement);
                return executor.query(statement, parameters);
              },
            });
            await hooks.beforeCommit?.();
            await client.query('commit');
            return result;
          } catch (cause) {
            await client.query('rollback');
            throw cause;
          }
        },
      };
    },
    async close() {
      await client.end();
    },
  };
}

/** A free TCP port, so parallel test runs do not fight over the server. */
async function freePort(): Promise<number> {
  const probe = createServer();
  try {
    return await new Promise<number>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address();
        if (typeof address === 'object' && address !== null) {
          resolve(address.port);
          return;
        }
        reject(new Error('The operating system reported no free port.'));
      });
    });
  } finally {
    await new Promise<void>((resolve) => {
      probe.close(() => resolve());
    });
  }
}

/**
 * Starts one server with `schemaSql` applied to its default database. The caller closes the
 * connections and, finally, the server.
 */
export async function startPostgresServer(schemaSql: string): Promise<PostgresServer> {
  const directory = await mkdtemp(path.join(tmpdir(), 'keeper-postgres-'));
  let diagnosis = '';
  const server = new EmbeddedPostgres({
    databaseDir: directory,
    user: 'postgres',
    password: 'password',
    port: await freePort(),
    persistent: false,
    onLog: () => {},
    onError: (message) => {
      diagnosis = String(message);
    },
  });
  try {
    await server.initialise();
    await server.start();
    const setup = server.getPgClient();
    await setup.connect();
    try {
      await setup.query(schemaSql);
    } finally {
      await setup.end();
    }
  } catch (cause) {
    await server.stop().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
    throw new Error(`The test PostgreSQL server could not be started. ${diagnosis}`.trim(), {
      cause,
    });
  }
  return {
    async connect() {
      const client = server.getPgClient();
      await client.connect();
      return connectionFor(client);
    },
    async close() {
      await server.stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
