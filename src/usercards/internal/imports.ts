/** Composes the private import store; each operation retains its transaction boundary. */
import type { UserCardsSqlTransactor } from './executor.js';
import { createImportConfirmation } from './imports/confirmation.js';
import { createImportReads } from './imports/reads.js';
import { createImportReview } from './imports/review.js';
import { createImportStaging } from './imports/staging.js';
import type { ImportStore } from './store.js';
export function createPostgresImportStore(sql: UserCardsSqlTransactor): ImportStore {
  return {
    ...createImportReads(sql),
    ...createImportStaging(sql),
    ...createImportReview(sql),
    ...createImportConfirmation(sql),
  };
}
