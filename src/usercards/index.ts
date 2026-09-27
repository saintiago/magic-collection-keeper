/**
 * UserCards public entry point (docs/user-cards.md#interface).
 *
 * Application wires the private operations with a transaction-capable SQL executor and the
 * Catalog contract: a copy is stored with one printing reference and its physical attributes,
 * corrections keep the copy identity and quote the revision they started from, and tags,
 * associations and a copy's single physical location follow the same revision-checked,
 * account-scoped rules. Pending imports, review and confirmation follow the same rules: an
 * observation or parsed line is staged once, review quotes the entry revision, and a confirmation
 * under an operation identity creates the copies with their provenance or returns the recorded
 * outcome. Consumers read private copies, tags and associations through the declared query surface
 * (USERCARDS_QUERY_SURFACE), which Application binds to that account inside one read transaction;
 * pending imports have no published relation and are read through the component's own pending
 * reads. Source imports parse a pasted list, a public Moxfield deck or a reviewed Wizards
 * preconstructed list inside this boundary into the same pending entries, preserving what the
 * source published and reconciling a repeated import of the list the caller identified with what
 * that import already acquired, while another import owns its own acquisitions. Other components
 * import UserCards through this module only; its internal modules stay private to the component
 * (docs/architecture.md, .dependency-cruiser.mjs).
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
  importEntryStates,
  importSessionStates,
  tagKinds,
  userTagKinds,
  USERCARDS_LIMITS,
  type Association,
  type AssociationId,
  type AssociationTargetLevel,
  type CopyCondition,
  type CopyId,
  type ImportCandidate,
  type ImportEntry,
  type ImportEntryId,
  type ImportEntryState,
  type ImportOperationId,
  type ImportSession,
  type ImportSessionId,
  type ImportSessionState,
  type ImportSourceLine,
  type PhysicalCopy,
  type Tag,
  type TagId,
  type TagKind,
  type TrustedUserContext,
  type UserTagKind,
} from './internal/model.js';
export {
  type AttachImportCandidatesInput,
  type CaptureStageResult,
  type ConfirmImportEntryInput,
  type ConfirmImportInput,
  type DiscardImportEntryInput,
  type DiscardImportSessionInput,
  type ImportConfirmationResult,
  type ImportEntryChangeResult,
  type ImportEntryListResult,
  type ImportOperationRecoveryResult,
  type ImportOperations,
  type ImportReceipt,
  type ImportSessionChange,
  type ImportSessionListResult,
  type ImportSourceInput,
  type ImportStageResult,
  type ListImportEntriesOptions,
  type ListImportSessionsOptions,
  type ReviewImportEntryInput,
  type StageCaptureInput,
  type StageImportEntriesInput,
  type StageImportEntryInput,
} from './internal/import-service.js';
export {
  createMoxfieldDeckSource,
  type MoxfieldDeckSource,
  type MoxfieldSourceOptions,
} from './internal/moxfield.js';
export {
  createSourceImports,
  type MoxfieldDeckImport,
  type PastedCardListImport,
  type ReviewedWizardsLine,
  type SourceImportDependencies,
  type SourceImportOperations,
  type SourceImportOutcome,
  type SourceImportResult,
  type SourceImportRow,
  type StageSourceImportInput,
  type WizardsPreconImport,
} from './internal/source-imports.js';
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
  type AssociationListResult,
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
  type ListAssociationsOptions,
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
