/**
 * Helpers shared by the UserCards component cases: untyped caller input and a storage boundary
 * that fails while publishing the account revision.
 */

import type { UserCardsSqlTransactor } from '../../../src/usercards/index.js';

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
