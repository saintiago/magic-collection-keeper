/** Default deployment composition. Only this module selects backend implementations. */
import {
  createCatalog,
  createCatalogPublication,
  createCatalogSynchronizer,
  type CatalogSqlExecutor,
  type CatalogSnapshotSource,
  type CatalogSqlTransactor,
} from '../../catalog/index.js';
import {
  createSearch,
  createSearchIndexer,
  SEARCH_ACCOUNT_SCOPE_SQL,
  type SearchSqlExecutor,
  type SearchSqlTransactor,
} from '../../search/index.js';
import {
  createSourceImports,
  createUserCards,
  createUserCardsPublication,
  type MoxfieldDeckSource,
  type UserCardsSqlTransactor,
} from '../../usercards/index.js';
import {
  createApplication,
  type Application,
  type ApplicationDependencies,
} from './application.js';
import { resolveApplicationConfiguration } from './configuration.js';

export interface ApplicationResources {
  /**
   * Reader role: the published Catalog and UserCards views the interactive operations read.
   */
  readonly readSql: UserCardsSqlTransactor;
  /**
   * Search's own query role: its published projection only, with the transaction-local account
   * scope Search's private queries bind. It reaches no provider relation, so a Search query can
   * never fall back to Catalog or UserCards storage
   * (docs/data-architecture.md#access-and-deployment).
   */
  readonly searchSql: UserCardsSqlTransactor;
  /** Private writer role, supplied only to the owner of private mutations. */
  readonly writeSql: UserCardsSqlTransactor;
  /**
   * Catalog writer credential and snapshot source of a runtime that runs synchronization, or null
   * for a runtime that holds neither (for example the interactive deployment, which never receives
   * the Catalog writer secret).
   */
  readonly catalogSynchronization: {
    readonly sql: CatalogSqlTransactor;
    readonly snapshots: CatalogSnapshotSource;
  } | null;
  /**
   * Search indexing resources of a runtime that runs background indexing, or null for a runtime
   * that holds none of the credentials. `sql` maintains Search's own projection with the indexing
   * role; the other two carry trusted publication access to Catalog and UserCards, never a
   * provider's writer credential (docs/data-architecture.md#access-and-deployment).
   */
  readonly searchIndexing: {
    readonly sql: SearchSqlTransactor;
    readonly catalogPublicationSql: CatalogSqlExecutor;
    readonly userCardsPublicationSql: UserCardsSqlTransactor;
  } | null;
  readonly deckSource?: MoxfieldDeckSource | null;
}

export interface PostgresApplicationDependencies extends Omit<
  ApplicationDependencies,
  'components'
> {
  readonly resources: ApplicationResources;
}

export function createPostgresApplication(
  dependencies: PostgresApplicationDependencies,
): Application {
  const configuration = resolveApplicationConfiguration(dependencies?.configuration);
  const resources = dependencies?.resources;
  const sql = resources?.writeSql;
  const readSql = resources?.readSql;
  const searchSql = resources?.searchSql;
  const synchronization = resources?.catalogSynchronization;
  const searchIndexing = resources?.searchIndexing;
  if (
    typeof readSql?.query !== 'function' ||
    typeof readSql?.transaction !== 'function' ||
    typeof searchSql?.query !== 'function' ||
    typeof searchSql?.transaction !== 'function' ||
    typeof sql?.query !== 'function' ||
    typeof sql?.transaction !== 'function'
  ) {
    throw new TypeError(
      'The PostgreSQL composition requires the reader, Search query and private writer executors.',
    );
  }
  if (
    synchronization !== null &&
    (typeof synchronization?.sql?.transaction !== 'function' ||
      typeof synchronization?.snapshots?.open !== 'function')
  ) {
    throw new TypeError(
      'A supplied catalog synchronization requires its executor and snapshot source.',
    );
  }
  if (
    searchIndexing !== null &&
    (typeof searchIndexing?.sql?.transaction !== 'function' ||
      typeof searchIndexing?.catalogPublicationSql?.query !== 'function' ||
      typeof searchIndexing?.userCardsPublicationSql?.query !== 'function' ||
      typeof searchIndexing?.userCardsPublicationSql?.transaction !== 'function')
  ) {
    throw new TypeError(
      'Supplied Search indexing requires its projection writer and both publication readers.',
    );
  }
  const catalog = createCatalog({ sql: readSql });
  return createApplication({
    ...dependencies,
    configuration,
    components: {
      catalog,
      userCards: createUserCards({ sql, catalog }),
      sourceImports: configuration.capabilities.sourceImports
        ? createSourceImports({
            sql,
            catalog,
            ...(resources.deckSource == null ? {} : { decks: resources.deckSource }),
          })
        : null,
      search: createSearch({
        sql: searchSql,
        withAccountScope: <T>(
          accountId: string,
          work: (scoped: SearchSqlExecutor) => Promise<T>,
        ): Promise<T> =>
          searchSql.transaction(async (statements) => {
            await statements.query(SEARCH_ACCOUNT_SCOPE_SQL, { account_id: accountId });
            return work(statements);
          }),
      }),
      synchronizer:
        synchronization === null
          ? null
          : createCatalogSynchronizer({
              sql: synchronization.sql,
              snapshots: synchronization.snapshots,
            }),
      indexer:
        searchIndexing === null
          ? null
          : createSearchIndexer({
              sql: searchIndexing.sql,
              catalog: createCatalogPublication({ sql: searchIndexing.catalogPublicationSql }),
              userCards: createUserCardsPublication({
                sql: searchIndexing.userCardsPublicationSql,
              }),
            }),
    },
  });
}
