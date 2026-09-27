/**
 * Search contract fixtures over the shared in-process PostgreSQL harness
 * (tests/support/postgres-database.ts): the real Catalog and UserCards schemas, the account-scope
 * binder Application supplies, and a Search instance that evaluates against them. Private rows are
 * written through UserCards' own contract, so the cases exercise the published query surfaces
 * rather than hand-written substitutes.
 */

import { catalogSchemaSql, createCatalog } from '../../src/catalog/index.js';
import { createSearch, type Search } from '../../src/search/index.js';
import {
  USERCARDS_ACCOUNT_SCOPE_SQL,
  createUserCards,
  usercardsSchemaSql,
  type UserCards,
  type UserCardsSqlTransactor,
} from '../../src/usercards/index.js';
import { createTestDatabase, type TestDatabase } from './postgres-database.js';

export interface SearchTestDatabase extends TestDatabase {
  /** Executor in the shape Application supplies to the provider components. */
  readonly sql: UserCardsSqlTransactor;
  /** Search wired the way Application wires it: one read executor plus the account-scope binder. */
  readonly search: Search;
  /** UserCards writing the private fixtures through its own contract. */
  readonly userCards: UserCards;
}

export async function createSearchTestDatabase(): Promise<SearchTestDatabase> {
  const database = await createTestDatabase(`${catalogSchemaSql}\n\n${usercardsSchemaSql}`);
  const search = createSearch({
    sql: database.sql,
    withAccountScope: (accountId, work) =>
      database.sql.transaction(async (statements) => {
        await statements.query(USERCARDS_ACCOUNT_SCOPE_SQL, { account_id: accountId });
        return work(statements);
      }),
  });
  const userCards = createUserCards({
    sql: database.sql,
    catalog: createCatalog({ sql: database.sql }),
  });
  return { ...database, search, userCards };
}
