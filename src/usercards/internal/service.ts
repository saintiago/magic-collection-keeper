import { createImportOperations } from './import-service.js';
import { createPostgresImportStore } from './imports.js';
import { createPostgresOrganizationStore } from './organization.js';
import { createPostgresCopyStore } from './postgres.js';
import type { UserCards, UserCardsDependencies } from './records-contract.js';
import { createCopyOperations } from './copy-service.js';
import { createOrganizationOperations } from './organization-service.js';
export type * from './records-contract.js';
export function createUserCards(dependencies: UserCardsDependencies): UserCards {
  const sql = dependencies?.sql;
  const catalog = dependencies?.catalog;
  if (typeof sql?.query !== 'function' || typeof sql?.transaction !== 'function')
    throw new TypeError('createUserCards requires a transaction-capable SQL executor.');
  if (typeof catalog?.resolve !== 'function')
    throw new TypeError(
      'createUserCards requires the CatalogResolver contract to resolve printings.',
    );
  const records = {
    store: createPostgresCopyStore(sql),
    organization: createPostgresOrganizationStore(sql),
    catalog,
  };
  return {
    ...createCopyOperations(records),
    ...createOrganizationOperations(records),
    ...createImportOperations({ store: createPostgresImportStore(sql), catalog }),
  };
}
