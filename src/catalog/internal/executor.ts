/**
 * The SQL boundary Catalog needs. Application supplies the implementation: the deployed service
 * uses Amazon RDS Data API named parameters, so statements reference `:name` placeholders and
 * never array parameters. Row values stay scalar; the catalog parses JSON aggregates itself.
 */
export type CatalogSqlValue = string | number | boolean | null;

export type CatalogSqlRow = Readonly<Record<string, CatalogSqlValue>>;

export interface CatalogSqlExecutor {
  /** Executes one statement and returns its rows. */
  query(
    statement: string,
    parameters?: Readonly<Record<string, CatalogSqlValue>>,
  ): Promise<readonly CatalogSqlRow[]>;
}

/**
 * Executor that can run several statements as one transaction. Synchronization publishes one
 * candidate revision through it: readers keep observing the previous revision until every write
 * commits, and a failure or interruption leaves that revision exactly as it was. Application
 * supplies the deployed implementation (the RDS Data API begins, commits or rolls back the
 * transaction); reads never require this capability.
 */
export interface CatalogSqlTransactor extends CatalogSqlExecutor {
  /**
   * Runs `work` inside one transaction. Commits when `work` resolves and rolls back when it
   * rejects; the executor handed to `work` executes only inside that transaction.
   */
  transaction<T>(work: (statements: CatalogSqlExecutor) => Promise<T>): Promise<T>;
}
