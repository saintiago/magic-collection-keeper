/**
 * Helpers shared by the UserCards component cases: untyped caller input and a storage boundary
 * that fails while publishing the account revision.
 */

import type {
  UserCardsSqlExecutor,
  UserCardsSqlTransactor,
  UserCardsSqlValue,
} from '../../../src/usercards/index.js';

/** Input as an untyped transport caller could send it, so validation is exercised for real. */
export function callerInput<T>(value: unknown): T {
  return value as T;
}

/** Fails the statement that publishes the account revision, like a lost commit. */
export function failRevisionStatements(sql: UserCardsSqlTransactor): UserCardsSqlTransactor {
  return {
    query: (statement, parameters) => sql.query(statement, parameters),
    transaction: (work) =>
      sql.transaction((statements) =>
        work({
          async query(statement, parameters) {
            if (statement.includes('account_state')) {
              throw new Error('simulated revision failure');
            }
            return statements.query(statement, parameters);
          },
        }),
      ),
  };
}

/**
 * Fails a statement whose rows would exceed the deployed transport's response bound, like the RDS
 * Data API rejecting an oversized result. A private read larger than the bound must therefore be
 * split into pages by the component itself.
 */
export function boundedResponses(
  sql: UserCardsSqlTransactor,
  limitBytes: number,
): UserCardsSqlTransactor {
  async function measured(
    statements: UserCardsSqlExecutor,
    statement: string,
    parameters?: Readonly<Record<string, UserCardsSqlValue>>,
  ) {
    const rows = await statements.query(statement, parameters);
    if (dataApiResponseBytes(rows) > limitBytes) {
      throw new Error('simulated transport response limit');
    }
    return rows;
  }
  return {
    query: (statement, parameters) => measured(sql, statement, parameters),
    transaction: (work) =>
      sql.transaction((statements) =>
        work({
          query: (statement, parameters) => measured(statements, statement, parameters),
        }),
      ),
  };
}

/**
 * Size of the JSON response the deployed transport returns for one statement: every value carries
 * its own type wrapper, as the RDS Data API record set does.
 */
export function dataApiResponseBytes(rows: readonly Readonly<Record<string, unknown>>[]): number {
  const records = rows.map((row) =>
    Object.values(row).map((value) => {
      if (value === null) {
        return { isNull: true };
      }
      return typeof value === 'number' ? { longValue: value } : { stringValue: value };
    }),
  );
  return Buffer.byteLength(JSON.stringify({ records }), 'utf8');
}
