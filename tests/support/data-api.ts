/**
 * Test substitute for the deployed RDS Data API boundary: it speaks the call shape
 * `src/application/deployment.ts` issues and executes the statements against real PostgreSQL
 * (PGlite) with the same named parameters, transaction control and JSON record format. What it
 * cannot establish is the deployed service's own behaviour — authorization, response bounds and
 * the real network — which docs/testing.md#live-boundaries-and-performance keeps as live evidence.
 */

import type { DataApiClient, DataApiCommand } from '../../src/application/deployment.js';
import { bindNamedParameters, type TestDatabase } from './postgres-database.js';

/** One typed parameter as the Data API carries it. */
interface DataApiParameter {
  readonly name?: unknown;
  readonly value?: unknown;
}

export interface DataApiTestClient extends DataApiClient {
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
 * runs as the connection's own user.
 */
export interface DataApiTestClientOptions {
  readonly roles?: Readonly<Record<string, string>>;
}

export function createDataApiTestClient(
  database: TestDatabase,
  options: DataApiTestClientOptions = {},
): DataApiTestClient {
  const executed: { readonly sql: string; readonly secretArn: string | null }[] = [];
  const counts = { begun: 0, committed: 0, rolledBack: 0 };
  let sequence = 0;
  const roles = options.roles ?? {};
  const roleOf = (input: Readonly<Record<string, unknown>>): string | null => {
    const secretArn = input['secretArn'];
    return typeof secretArn === 'string' ? (roles[secretArn] ?? null) : null;
  };
  return {
    async send(command: DataApiCommand): Promise<Readonly<Record<string, unknown>>> {
      switch (command.name) {
        case 'BeginTransaction': {
          await database.exec('begin');
          const role = roleOf(command.input);
          if (role !== null) {
            await database.exec(`set local role ${role}`);
          }
          counts.begun += 1;
          sequence += 1;
          return { transactionId: `test-transaction-${sequence}` };
        }
        case 'CommitTransaction':
          await database.exec('commit');
          counts.committed += 1;
          return {};
        case 'RollbackTransaction':
          await database.exec('rollback');
          counts.rolledBack += 1;
          return {};
        case 'ExecuteStatement': {
          const input = command.input;
          const statement = String(input['sql'] ?? '');
          const secretArn = input['secretArn'];
          executed.push({
            sql: statement,
            secretArn: typeof secretArn === 'string' ? secretArn : null,
          });
          const bound = bindNamedParameters(statement, readParameters(input['parameters']));
          const role = input['transactionId'] === undefined ? roleOf(input) : null;
          if (role === null) {
            const rows = await database.query(bound.text, bound.values);
            return { formattedRecords: JSON.stringify(rows) };
          }
          // A statement outside a transaction runs in its own implicit transaction, so the
          // credential's role is set for that statement only.
          await database.exec(`set local role ${role}`);
          try {
            const rows = await database.query(bound.text, bound.values);
            return { formattedRecords: JSON.stringify(rows) };
          } finally {
            await database.exec('reset role');
          }
        }
      }
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
