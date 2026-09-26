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
