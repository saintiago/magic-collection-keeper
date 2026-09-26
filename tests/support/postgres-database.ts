/**
 * Test harness for provider-owned PostgreSQL storage. PGlite is PostgreSQL compiled to WebAssembly,
 * so these tests exercise real PostgreSQL semantics — views, constraints, privileges,
 * transaction-local settings, MVCC snapshots — in-process, without a database service. Production
 * runs the same statements through the RDS Data API executor Application supplies.
 */

import { PGlite } from '@electric-sql/pglite';

export type TestSqlValue = string | number | boolean | null;

export type TestSqlRow = Readonly<Record<string, TestSqlValue>>;

export interface TestSqlExecutor {
  query(
    statement: string,
    parameters?: Readonly<Record<string, TestSqlValue>>,
  ): Promise<readonly TestSqlRow[]>;
}

export interface TestSqlTransactor extends TestSqlExecutor {
  transaction<T>(work: (statements: TestSqlExecutor) => Promise<T>): Promise<T>;
}

export interface TestDatabase {
  /** Executor in the shape Application supplies to a component's create function. */
  readonly sql: TestSqlTransactor;
  exec(statement: string): Promise<void>;
  query(
    statement: string,
    values?: readonly unknown[],
  ): Promise<readonly Record<string, unknown>[]>;
  close(): Promise<void>;
}

/** Creates an in-process PostgreSQL database with `schemaSql` applied. */
export async function createTestDatabase(schemaSql: string): Promise<TestDatabase> {
  const database = new PGlite();
  try {
    await database.exec(schemaSql);
  } catch (error) {
    await database.close();
    throw error;
  }
  const executor: TestSqlExecutor = {
    async query(statement, parameters = {}) {
      const bound = bindNamedParameters(statement, parameters);
      const result = await database.query<Record<string, TestSqlValue>>(bound.text, bound.values);
      return result.rows;
    },
  };
  const sql: TestSqlTransactor = {
    query: executor.query,
    /** PGlite runs on one connection, so an interrupted transaction is rolled back here. */
    async transaction(work) {
      await database.exec('begin');
      try {
        const result = await work(executor);
        await database.exec('commit');
        return result;
      } catch (error) {
        await database.exec('rollback');
        throw error;
      }
    },
  };
  return {
    sql,
    async exec(statement) {
      await database.exec(statement);
    },
    async query(statement, values = []) {
      const result = await database.query<Record<string, unknown>>(statement, [...values]);
      return result.rows;
    },
    close: () => database.close(),
  };
}

/** Replaces `:name` placeholders with positional parameters; `::` casts and quoted text survive. */
export function bindNamedParameters(
  statement: string,
  parameters: Readonly<Record<string, TestSqlValue>>,
): { text: string; values: TestSqlValue[] } {
  const used: string[] = [];
  const values: TestSqlValue[] = [];
  let text = '';
  let index = 0;
  while (index < statement.length) {
    const character = statement[index];
    if (character === undefined) {
      break;
    }
    if (character === "'") {
      const end = statement.indexOf("'", index + 1);
      if (end === -1) {
        throw new Error('Test statement has an unterminated text literal.');
      }
      text += statement.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    if (character === ':' && statement[index + 1] === ':') {
      text += '::';
      index += 2;
      continue;
    }
    if (character === ':' && /[A-Za-z_]/.test(statement[index + 1] ?? '')) {
      let end = index + 2;
      while (end < statement.length && /[A-Za-z0-9_]/.test(statement[end] ?? '')) {
        end += 1;
      }
      const name = statement.slice(index + 1, end);
      const value = parameters[name];
      if (value === undefined) {
        throw new Error(`Test statement references unbound parameter :${name}.`);
      }
      used.push(name);
      values.push(value);
      text += `$${values.length}`;
      index = end;
      continue;
    }
    text += character;
    index += 1;
  }
  const unused = Object.keys(parameters).filter((name) => !used.includes(name));
  if (unused.length > 0) {
    throw new Error(`Test statement ignores bound parameters: ${unused.join(', ')}.`);
  }
  return { text, values };
}
