/**
 * Helpers shared by Search projection cases: an executor whose transactions never commit, so a
 * case can exercise an interrupted run, and a scoped read of the private projection views that
 * binds the account exactly as Application binds it for queries.
 */

import {
  SEARCH_ACCOUNT_SCOPE_SQL,
  type SearchSqlExecutor,
  type SearchSqlRow,
  type SearchSqlTransactor,
  type SearchSqlValue,
} from '../../src/search/index.js';
import type { TestDatabase } from './postgres-database.js';

/** An executor whose transactions always roll back, as a process that died before committing. */
export function createCrashingTransactor(database: TestDatabase): SearchSqlTransactor {
  return {
    query: database.sql.query,
    async transaction<T>(work: (statements: SearchSqlExecutor) => Promise<T>): Promise<T> {
      await database.exec('begin');
      try {
        await work(database.sql);
      } catch (cause) {
        await database.exec('rollback');
        throw cause;
      }
      await database.exec('rollback');
      throw new Error('The process ended before its transaction committed.');
    },
  };
}

/** Reads one statement with the account bound to the private projection views. */
export async function readScopedProjection(
  database: TestDatabase,
  accountId: string,
  statement: string,
  parameters: Readonly<Record<string, SearchSqlValue>> = {},
): Promise<readonly SearchSqlRow[]> {
  return await database.sql.transaction(async (statements) => {
    await statements.query(SEARCH_ACCOUNT_SCOPE_SQL, { account_id: accountId });
    return await statements.query(statement, parameters);
  });
}
