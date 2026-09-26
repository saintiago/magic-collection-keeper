/**
 * UserCards public entry point (docs/user-cards.md#interface).
 *
 * Application wires the private operations with a transaction-capable SQL executor and the
 * Catalog contract: a copy is stored with one printing reference and its physical attributes,
 * corrections keep the copy identity and quote the revision they started from, and tags,
 * associations and a copy's single physical location follow the same revision-checked,
 * account-scoped rules. Consumers read private copies, tags and associations through the declared
 * query surface (USERCARDS_QUERY_SURFACE), which Application binds to that account inside one read
 * transaction. Other components import UserCards through this module only; its internal modules
 * stay private to the component (docs/architecture.md, .dependency-cruiser.mjs).
 */

export { UserCardsError, type UserCardsFailureCode } from './internal/errors.js';
export type {
  UserCardsSqlExecutor,
  UserCardsSqlRow,
  UserCardsSqlTransactor,
  UserCardsSqlValue,
} from './internal/executor.js';
export {
  associationLevelsByTagKind,
  associationTargetLevels,
  copyConditions,
  tagKinds,
  userTagKinds,
  USERCARDS_LIMITS,
  type Association,
  type AssociationId,
  type AssociationTargetLevel,
  type CopyCondition,
  type CopyId,
  type PhysicalCopy,
  type Tag,
  type TagId,
  type TagKind,
  type TrustedUserContext,
  type UserTagKind,
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
  type AssociationChangeResult,
  type AssociationReadResult,
  type AssociationRemovalResult,
  type ChangeAssociationInput,
  type CopyChangeResult,
  type CopyLocationResult,
  type CopyReadResult,
  type CorrectCopyInput,
  type CreateAssociationInput,
  type CreateCopiesInput,
  type CreateTagInput,
  type RemoveAssociationInput,
  type RenameTagInput,
  type SetCopyLocationInput,
  type TagChangeResult,
  type TagListOptions,
  type TagListResult,
  type TagReadResult,
  type UserCards,
  type UserCardsDependencies,
} from './internal/service.js';
