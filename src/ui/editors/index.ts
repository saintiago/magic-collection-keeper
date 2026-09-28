/**
 * Editors public entry point (docs/ui/editors.md,
 * docs/ui/architecture.md#modules-and-composition).
 *
 * Editors owns unsaved input and the presentation of a user-requested action: draft values stay
 * distinct from last committed values, provider validation, conflicts and uncertain outcomes are
 * explained, and every change runs through a provider-owned operation handle. Editors receive
 * focused UserCards read/command capabilities and recoverable operation handles, use Catalog for
 * printing attributes, and request a supplied CardViews picker for card choices. Pages compose
 * independently mountable editors for query/filter input, copy attributes, tags,
 * associations/location, import source input, pending review and confirmation.
 *
 * The module publishes its operation presentation through this entry point; its internals stay
 * private to the UI component (docs/architecture.md).
 */

export {
  copyChangeTool,
  correctCopy,
  createCopyAccess,
  uiCopyConditions,
  type UiCopyAccess,
  type UiCopyChange,
  type UiCopyClient,
  type UiCopyCorrection,
  type UiCopyCorrectionOutcome,
  type UiCopyRead,
} from './internal/copy-edits.js';
export {
  addAssociation,
  addToTagTool,
  createTag,
  createTagAccess,
  moveCopyById,
  removeAssociation,
  renameTag,
  saveAssociation,
  uiAssociationLevelLabel,
  uiAssociationLevelsByTagKind,
  uiTagKindLabel,
  uiTagKinds,
  type AssociationCorrection,
  type AssociationRemoval,
  type UiAddOutcome,
  type UiAddToTagTool,
  type UiChangeOutcome,
  type UiTagAccess,
  type UiTagClient,
  type UiTagKind,
} from './internal/tag-edits.js';
export {
  beginSourceImport,
  confirmImport,
  createImportAccess,
  discardImportEntry,
  discardImportSession,
  recoverConfirmation,
  reopenSourceImport,
  retryRetainedAttempt,
  reviewImportEntry,
  stageImportLines,
  uiImportCandidates,
  uiImportIdentity,
  uiImportSourceLabel,
  uiUnfinishedSourceMessage,
  type UiImportAccess,
  type UiImportCandidate,
  type UiImportClient,
  type UiImportLine,
} from './internal/import-edits.js';
export {
  commitUiOperation,
  isUiInvalidatedContinuation,
  readUiFailureCode,
  readUiFailureMessage,
  type UiChangeCommit,
  type UiOperation,
} from './internal/failure.js';
export { createEditors, type Editors, type EditorsOptions } from './internal/editors.js';
export {
  createCatalogQueryEditor,
  createCollectionQueryEditor,
  createSearchEntryEditor,
  type UiCatalogQueryEditorOptions,
  type UiCatalogQueryDraft,
  type UiCollectionQueryEditorOptions,
  type UiCollectionQueryDraft,
  type UiQueryEditor,
  type UiSearchEntryEditor,
  type UiSearchEntryDraft,
  type UiSearchEntryEditorOptions,
} from './internal/query.js';
export {
  createCopyBulkEditor,
  createCopyEditor,
  type UiCopyBulkDraft,
  type UiCopyBulkEditor,
  type UiCopyBulkEditorOptions,
  type UiCopyDraft,
  type UiCopyEditor,
  type UiCopyEditorOptions,
} from './internal/copy.js';
export {
  createImportReviewEditor,
  createManualImportEditor,
  createSourceImportEditor,
  type UiImportEditorContext,
  type UiImportReviewDraft,
  type UiImportReviewEditor,
  type UiImportReviewEditorOptions,
  type UiManualImportDraft,
  type UiManualImportEditor,
  type UiManualImportEditorOptions,
  type UiSourceImportEditor,
  type UiSourceImportEditorOptions,
} from './internal/imports.js';
