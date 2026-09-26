/**
 * Test harness for UserCards storage and its published query surface. The database also carries
 * the catalog schema, so these tests resolve printings through the real Catalog contract instead
 * of a hand-written substitute (docs/testing.md#contracts-and-cooperation).
 */

import { catalogSchemaSql } from '../../src/catalog/index.js';
import {
  UserCardsError,
  usercardsSchemaSql,
  type UserCardsSqlTransactor,
} from '../../src/usercards/index.js';
import { createTestDatabase, type TestDatabase } from './postgres-database.js';

/** Returns the UserCardsError a call rejects with; fails the test for any other outcome. */
export async function captureUserCardsError(promise: Promise<unknown>): Promise<UserCardsError> {
  const outcome = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  if (!(outcome instanceof UserCardsError)) {
    throw new Error(`Expected a UserCardsError, received ${String(outcome)}.`);
  }
  return outcome;
}

export interface UserCardsTestDatabase extends TestDatabase {
  /** Executor in the shape Application supplies to createUserCards. */
  readonly sql: UserCardsSqlTransactor;
}

export async function createUserCardsTestDatabase(): Promise<UserCardsTestDatabase> {
  return createTestDatabase(`${catalogSchemaSql}\n\n${usercardsSchemaSql}`);
}
