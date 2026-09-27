/**
 * The SQL boundary Search needs (docs/search.md#required-query-contracts). Application supplies the
 * implementation: the deployed service uses Amazon RDS Data API named parameters, so statements
 * reference `:name` placeholders and never array parameters. Search reads only the published
 * Catalog and UserCards relations of one database; it never reaches a provider's private tables.
 */
export type SearchSqlValue = string | number | boolean | null;

export type SearchSqlRow = Readonly<Record<string, SearchSqlValue>>;

export interface SearchSqlExecutor {
  /** Executes one read-only statement over the published query surfaces. */
  query(
    statement: string,
    parameters?: Readonly<Record<string, SearchSqlValue>>,
  ): Promise<readonly SearchSqlRow[]>;
}
