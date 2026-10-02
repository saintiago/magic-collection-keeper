/** Default deployment composition. Only this module selects backend implementations. */
import {
  createCatalog,
  createCatalogSynchronizer,
  type CatalogSnapshotSource,
  type CatalogSqlTransactor,
} from '../../catalog/index.js';
import {
  createSourceImports,
  createUserCards,
  createUserCardsQueries,
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
  /** Read-only Catalog role. */
  readonly catalogReadSql: CatalogSqlTransactor;
  /** Read-only, account-scoped UserCards query role. */
  readonly userCardsReadSql: UserCardsSqlTransactor;
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
  const catalogReadSql = resources?.catalogReadSql;
  const userCardsReadSql = resources?.userCardsReadSql;
  const synchronization = resources?.catalogSynchronization;
  if (
    typeof catalogReadSql?.query !== 'function' ||
    typeof userCardsReadSql?.query !== 'function' ||
    typeof userCardsReadSql?.transaction !== 'function' ||
    typeof sql?.query !== 'function' ||
    typeof sql?.transaction !== 'function'
  ) {
    throw new TypeError(
      'The PostgreSQL composition requires Catalog and UserCards readers and the private writer.',
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
  const catalog = createCatalog({ sql: catalogReadSql });
  return createApplication({
    ...dependencies,
    configuration,
    components: {
      catalog,
      userCards: createUserCards({ sql, catalog }),
      userCardsQueries: createUserCardsQueries({ sql: userCardsReadSql }),
      sourceImports: configuration.capabilities.sourceImports
        ? createSourceImports({
            sql,
            catalog,
            ...(resources.deckSource == null ? {} : { decks: resources.deckSource }),
          })
        : null,
      synchronizer:
        synchronization === null
          ? null
          : createCatalogSynchronizer({
              sql: synchronization.sql,
              snapshots: synchronization.snapshots,
            }),
    },
  });
}
