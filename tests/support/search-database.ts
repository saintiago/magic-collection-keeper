/**
 * Search contract fixtures over a local PostgreSQL server with separate projection and publication
 * sessions (tests/support/postgres-server.ts): the real Catalog, UserCards and Search schemas, the
 * binder Application supplies for Search's account-scoped projection views, and a Search instance
 * that evaluates against its own projection. Catalog and private rows are written through the
 * providers' own contracts and become query-visible only through a Search indexing pass, so the
 * cases exercise the real publication-to-indexing cooperation.
 */

import {
  catalogSchemaSql,
  createCatalog,
  createCatalogPublication,
  type CatalogPublication,
} from '../../src/catalog/index.js';
import {
  createSearch,
  createSearchIndexer,
  SEARCH_ACCOUNT_SCOPE_SQL,
  searchSchemaSql,
  type Search,
  type SearchIndexer,
  type SearchIndexingRequest,
} from '../../src/search/index.js';
import {
  createUserCards,
  createUserCardsPublication,
  usercardsSchemaSql,
  type UserCards,
  type UserCardsPublication,
  type UserCardsSqlTransactor,
} from '../../src/usercards/index.js';
import type { TestDatabase } from './postgres-database.js';
import { startPostgresServer } from './postgres-server.js';

export interface SearchTestDatabase extends TestDatabase {
  /** Executor in the shape Application supplies to the provider components. */
  readonly sql: UserCardsSqlTransactor;
  /** Search wired the way Application wires it: one read executor plus the account-scope binder. */
  readonly search: Search;
  /** UserCards writing the private fixtures through its own contract. */
  readonly userCards: UserCards;
  /** Catalog's durable snapshot/change publication over the published catalog. */
  readonly catalogPublication: CatalogPublication;
  /** UserCards' account-scoped snapshot/change publication. */
  readonly userCardsPublication: UserCardsPublication;
  /** Search's background indexing job over both publications and its own projection storage. */
  readonly indexer: SearchIndexer;
  /** Applies one indexing pass and fails the case when it did not catch up. */
  index(request?: SearchIndexingRequest): Promise<void>;
}

export async function createSearchTestDatabase(): Promise<SearchTestDatabase> {
  const server = await startPostgresServer(
    `${catalogSchemaSql}\n\n${usercardsSchemaSql}\n\n${searchSchemaSql}`,
  );
  const connection = await server.connect();
  const catalogConnection = await server.connect();
  const userCardsConnection = await server.connect();
  // Provider snapshots open their own transactions while a projection write is in progress.
  // Sharing one connection would let a provider commit the projection before its checkpoint.
  const database: TestDatabase = {
    sql: connection.transactor(),
    query: (statement, values) => connection.query(statement, values),
    async exec(statement) {
      await connection.query(statement);
    },
    async close() {
      await Promise.all([
        connection.close(),
        catalogConnection.close(),
        userCardsConnection.close(),
      ]);
      await server.close();
    },
  };
  const search = createSearch({
    sql: database.sql,
    withAccountScope: (accountId, work) =>
      database.sql.transaction(async (statements) => {
        await statements.query(SEARCH_ACCOUNT_SCOPE_SQL, { account_id: accountId });
        return work(statements);
      }),
  });
  const userCards = createUserCards({
    sql: database.sql,
    catalog: createCatalog({ sql: database.sql }),
  });
  const catalogPublication = createCatalogPublication({ sql: catalogConnection.transactor() });
  const userCardsPublication = createUserCardsPublication({
    sql: userCardsConnection.transactor(),
  });
  const indexer = createSearchIndexer({
    sql: database.sql,
    catalog: catalogPublication,
    userCards: userCardsPublication,
  });
  return {
    ...database,
    search,
    userCards,
    catalogPublication,
    userCardsPublication,
    indexer,
    async index(request = {}) {
      const result = await indexer.index(request);
      if (!result.published || !result.caughtUp) {
        throw new Error(
          `The test indexing pass did not catch up: ${JSON.stringify({
            published: result.published,
            caughtUp: result.caughtUp,
            unresolvedReferences: result.unresolvedReferences,
          })}`,
        );
      }
    },
  };
}
