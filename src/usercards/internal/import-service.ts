import { createImportConfirmation } from './import-confirmation.js';
import type { ImportOperations, ImportServiceDependencies } from './import-contract.js';
import { createImportReads } from './import-reads.js';
import { createImportReview } from './import-review.js';
import { createImportStaging } from './import-staging.js';
export type * from './import-contract.js';
export function createImportOperations(dependencies: ImportServiceDependencies): ImportOperations {
  return {
    ...createImportReads(dependencies),
    ...createImportStaging(dependencies),
    ...createImportReview(dependencies),
    ...createImportConfirmation(dependencies),
  };
}
