/**
 * UserCards public entry point (docs/user-cards.md#interface).
 *
 * Application wires the copy operations with a transaction-capable SQL executor and the Catalog
 * contract: a copy is stored with one printing reference and its physical attributes, corrections
 * keep the copy identity and quote the revision they started from, and every operation is scoped
 * to the trusted account it receives. Consumers read private copies and the private-data revision
 * through the declared query surface (USERCARDS_QUERY_SURFACE), which Application binds to that
 * account inside one read transaction. Other components import UserCards through this module only;
 * its internal modules stay private to the component (docs/architecture.md, .dependency-cruiser.mjs).
 */

export { UserCardsError, type UserCardsFailureCode } from './internal/errors.js';
export type {
  UserCardsSqlExecutor,
  UserCardsSqlRow,
  UserCardsSqlTransactor,
  UserCardsSqlValue,
} from './internal/executor.js';
export {
  copyConditions,
  USERCARDS_LIMITS,
  type CopyCondition,
  type CopyId,
  type PhysicalCopy,
  type TrustedUserContext,
} from './internal/model.js';
export {
  USERCARDS_ACCOUNT_SCOPE_SQL,
  USERCARDS_ACCOUNT_SETTING,
  USERCARDS_QUERY_SURFACE,
  usercardsReaderGrants,
  usercardsSchemaSql,
  type UserCardsColumnType,
  type UserCardsQueryRelation,
  type UserCardsQuerySurface,
  type UserCardsRelationColumn,
} from './internal/schema.js';
export {
  createUserCards,
  type CopyChangeResult,
  type CopyReadResult,
  type CorrectCopyInput,
  type CreateCopiesInput,
  type UserCards,
  type UserCardsDependencies,
} from './internal/service.js';
