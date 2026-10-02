/** Advances authoritative UserCards state in the domain transaction. */
import type { UserCardsSqlExecutor } from './executor.js';
import { readRows, revisionFromRow, revisionStatement } from './sql.js';

export async function advanceRevision(
  statements: UserCardsSqlExecutor,
  accountId: string,
): Promise<string> {
  const advance = revisionStatement(accountId);
  return revisionFromRow(
    (
      await readRows(
        statements,
        advance.statement,
        advance.parameters,
        'The private-data revision could not be advanced.',
      )
    )[0],
  );
}
