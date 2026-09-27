/** Default deployment composition. Only this module selects backend implementations. */
import {
  createCatalog,
  createCatalogSynchronizer,
  type CatalogSnapshotSource,
  type CatalogSqlTransactor,
} from '../../catalog/index.js';
import { createSearch, type SearchSqlExecutor } from '../../search/index.js';
import {
  USERCARDS_ACCOUNT_SCOPE_SQL,
  createSourceImports,
  createUserCards,
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
  /** Reader role: published views only, with transaction-local account scope. */
  readonly readSql: UserCardsSqlTransactor;
  /** Private writer role, supplied only to the owner of private mutations. */
  readonly writeSql: UserCardsSqlTransactor;
  readonly catalogSynchronization: {
    readonly sql: CatalogSqlTransactor;
    readonly snapshots: CatalogSnapshotSource;
  };
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
  const synchronization = resources?.catalogSynchronization;
  if (
    typeof readSql?.query !== 'function' ||
    typeof readSql?.transaction !== 'function' ||
    typeof sql?.query !== 'function' ||
    typeof sql?.transaction !== 'function' ||
    typeof synchronization?.sql?.transaction !== 'function' ||
    typeof synchronization?.snapshots?.open !== 'function'
  ) {
    throw new TypeError(
      'The PostgreSQL composition requires transaction executors and a snapshot source.',
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
        sql: readSql,
        withAccountScope: <T>(
          accountId: string,
          work: (scoped: SearchSqlExecutor) => Promise<T>,
        ): Promise<T> =>
          readSql.transaction(async (statements) => {
            await statements.query(USERCARDS_ACCOUNT_SCOPE_SQL, { account_id: accountId });
            return work(statements);
          }),
      }),
      synchronizer: createCatalogSynchronizer({
        sql: synchronization.sql,
        snapshots: synchronization.snapshots,
      }),
    },
  });
}
