/**
 * Test substitute for the deployed RDS Data API boundary: it speaks the call shape
 * `src/application/deployment.ts` issues and executes the statements against real PostgreSQL
 * in independent server sessions with the same named parameters, transaction control and JSON
 * record format. What it cannot establish is the deployed service's own behaviour — authorization, response bounds and
 * the real network — which docs/testing.md#live-boundaries-and-performance keeps as live evidence.
 */

import type { DataApiClient, DataApiCommand } from '../../src/application/deployment.js';
import { bindNamedParameters } from './postgres-database.js';
import type { PostgresConnection, PostgresServer } from './postgres-server.js';

/** One typed parameter as the Data API carries it. */
interface DataApiParameter {
  readonly name?: unknown;
  readonly value?: unknown;
}

export interface DataApiTestClient extends DataApiClient {
  /** Closes any transaction sessions left open by a failed test. */
  close(): Promise<void>;
  /** Statements the client executed, oldest first, with the credential that carried them. */
  statements(): readonly { readonly sql: string; readonly secretArn: string | null }[];
  /** Transactions the client opened, committed and rolled back. */
  transactions(): {
    readonly begun: number;
    readonly committed: number;
    readonly rolledBack: number;
  };
}

/**
 * Roles one credential runs as. A case that verifies the deployment's grants maps each secret ARN
 * to the PostgreSQL role its secret names, so the statements a composition issues execute with
 * exactly the privileges that credential has in a deployed cluster. Without a map every statement
 * explicitly runs as the bootstrap user; a supplied map rejects every unmapped credential.
 */
export interface DataApiTestClientOptions {
  readonly roles?: Readonly<Record<string, string>>;
}

export function createDataApiTestClient(
  database: PostgresServer,
  options: DataApiTestClientOptions = {},
): DataApiTestClient {
  const executed: { readonly sql: string; readonly secretArn: string | null }[] = [];
  const counts = { begun: 0, committed: 0, rolledBack: 0 };
  let sequence = 0;
  const sessions = new Map<string, { connection: PostgresConnection; secretArn: unknown }>();
  const roleOf = (input: Readonly<Record<string, unknown>>): string | null => {
    const secretArn = input['secretArn'];
    if (options.roles === undefined) {
      return null;
    }
    const role = typeof secretArn === 'string' ? options.roles[secretArn] : undefined;
    if (role === undefined) {
      throw new Error('No PostgreSQL role is mapped for this credential.');
    }
    return role;
  };
  const sessionOf = (input: Readonly<Record<string, unknown>>) => {
    const session = sessions.get(String(input['transactionId']));
    if (session === undefined || session.secretArn !== input['secretArn']) {
      throw new Error('Unknown transaction or mismatched credential.');
    }
    return session.connection;
  };
  async function begin(input: Readonly<Record<string, unknown>>): Promise<PostgresConnection> {
    const role = roleOf(input);
    const connection = await database.connect();
    try {
      await connection.query('begin');
      if (role !== null) {
        await connection.query(`set local role "${role.replaceAll('"', '""')}"`);
      }
      return connection;
    } catch (cause) {
      await connection.close();
      throw cause;
    }
  }
  return {
    async send(command: DataApiCommand): Promise<Readonly<Record<string, unknown>>> {
      const input = command.input;
      switch (command.name) {
        case 'BeginTransaction': {
          const connection = await begin(input);
          const transactionId = `test-transaction-${++sequence}`;
          sessions.set(transactionId, { connection, secretArn: input['secretArn'] });
          counts.begun += 1;
          return { transactionId };
        }
        case 'CommitTransaction':
        case 'RollbackTransaction': {
          const connection = sessionOf(input);
          try {
            await connection.query(command.name === 'CommitTransaction' ? 'commit' : 'rollback');
            if (command.name === 'CommitTransaction') {
              counts.committed += 1;
            } else {
              counts.rolledBack += 1;
            }
          } finally {
            sessions.delete(String(input['transactionId']));
            await connection.close();
          }
          return {};
        }
        case 'ExecuteStatement': {
          const statement = String(input['sql'] ?? '');
          const secretArn = input['secretArn'];
          executed.push({
            sql: statement,
            secretArn: typeof secretArn === 'string' ? secretArn : null,
          });
          const bound = bindNamedParameters(statement, readParameters(input['parameters']));
          const standalone = input['transactionId'] === undefined;
          const connection = standalone ? await begin(input) : sessionOf(input);
          try {
            const rows = await connection.query(bound.text, bound.values);
            if (standalone) {
              await connection.query('commit');
            }
            return { formattedRecords: JSON.stringify(rows) };
          } finally {
            // Closing also rolls back a failed standalone statement, without touching another
            // credential's transaction or leaving its role on a reused bootstrap connection.
            if (standalone) {
              await connection.close();
            }
          }
        }
      }
    },
    async close() {
      await Promise.all([...sessions.values()].map(({ connection }) => connection.close()));
      sessions.clear();
    },
    statements: () => [...executed],
    transactions: () => ({ ...counts }),
  };
}

/** Reads the Data API parameter list back into the named values the test statement binds. */
function readParameters(
  value: unknown,
): Readonly<Record<string, string | number | boolean | null>> {
  if (!Array.isArray(value)) {
    return {};
  }
  const parameters: Record<string, string | number | boolean | null> = {};
  for (const entry of value as readonly DataApiParameter[]) {
    const name = entry?.name;
    const typed = entry?.value;
    if (typeof name !== 'string' || typeof typed !== 'object' || typed === null) {
      throw new Error('The Data API parameter list is not readable.');
    }
    const fields = typed as Readonly<Record<string, unknown>>;
    parameters[name] =
      fields['stringValue'] !== undefined
        ? String(fields['stringValue'])
        : fields['longValue'] !== undefined
          ? Number(fields['longValue'])
          : fields['doubleValue'] !== undefined
            ? Number(fields['doubleValue'])
            : fields['booleanValue'] !== undefined
              ? Boolean(fields['booleanValue'])
              : null;
  }
  return parameters;
}
