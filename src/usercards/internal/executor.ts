/**
 * The SQL boundary UserCards needs. Application supplies the implementation: the deployed service
 * uses Amazon RDS Data API named parameters, so statements reference `:name` placeholders and
 * never array parameters. Row values stay scalar; UserCards parses JSON aggregates itself.
 */
export type UserCardsSqlValue = string | number | boolean | null;

export type UserCardsSqlRow = Readonly<Record<string, UserCardsSqlValue>>;

export interface UserCardsSqlExecutor {
  /** Executes one statement and returns its rows. */
  query(
    statement: string,
    parameters?: Readonly<Record<string, UserCardsSqlValue>>,
  ): Promise<readonly UserCardsSqlRow[]>;
}

/**
 * Executor that can run several statements as one transaction. Every private change uses it: the
 * affected copies and the account revision that publishes them commit together, so a failure or
 * interruption leaves no partially stored copy, and readers keep observing the previous revision
 * until the commit. Application supplies the deployed implementation (the RDS Data API begins,
 * commits or rolls back the transaction).
 */
export interface UserCardsSqlTransactor extends UserCardsSqlExecutor {
  /**
   * Runs `work` inside one transaction. Commits when `work` resolves and rolls back when it
   * rejects; the executor handed to `work` executes only inside that transaction.
   */
  transaction<T>(work: (statements: UserCardsSqlExecutor) => Promise<T>): Promise<T>;
}
