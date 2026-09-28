/**
 * UserInterface public entry point (docs/user-interface.md#interface,
 * docs/user-interface.md#pages-and-navigation,
 * docs/user-interface.md#state-ownership-and-restoration).
 *
 * The component presents the collection behind one shell. The shell owns the routes of the
 * dedicated pages, history navigation with bounded account-isolated retention of opaque page state,
 * the identity transitions of the presented account and the brief dialogs for auxiliary actions; a
 * page implementation owns one page's content, its retained state and the tools its lists present;
 * it describes its lists to the CardList component, which owns their loading, enrichment,
 * selection, retention, restoration and recent activity (docs/card-list.md#interface). The
 * browsing pages present Home's bounded, account-isolated recent card activity and the
 * catalog/search query a URL names, both through CardList's bindings over the supplied Search and
 * Catalog contracts, and the collection pages present the account's owned records with their copy
 * corrections over the supplied UserCards contract. The Import page stages manually entered cards as pending entries and presents the
 * account's pending imports for review and confirmation through the same private contract, so a
 * staged line is never presented as owned before its confirmation reports the copies it created.
 * The same page presents one Capture session hands-free: it binds the session to the account and a
 * pending import, presents its preview, status, provisional evidence and identified feedback, and
 * forwards start, stop and retry (docs/capture.md#interface, docs/ui/capture-controls.md).
 * Application supplies the public configuration, the authenticated transport and the component
 * access, including the Capture factory; the deployment supplies the verified identity and the
 * device capability the session opens. Other
 * components import UserInterface through this module only; its internal modules stay private to
 * the component (docs/architecture.md, .dependency-cruiser.mjs).
 */

export { createBrowsePages } from './internal/browse.js';
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
export { createCollectionPages } from './internal/collection.js';
export {
  createCaptureControls,
  type UiCaptureControls,
  type UiCaptureOptions,
} from './internal/capture.js';
export {
  cardListBasicContent,
  createCardListView,
  type UiCardList,
  type UiCardListOptions,
  type UiCardListPresentation,
  type UiEntryImage,
  type UiEntryOwnership,
  type UiEntryTag,
} from './internal/card-list.js';
export type { UiDialogOptions, UiDialogs } from './internal/dialogs.js';
export type { UiAccount, UiIdentity } from './internal/identity.js';
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
  type UiImportAccess,
  type UiImportCandidate,
  type UiImportClient,
  type UiImportLine,
} from './internal/import-edits.js';
export { createImportPages } from './internal/imports.js';
export { UI_LIMITS } from './internal/limits.js';
export type { UiPageContext, UiPageDefinition, UiPageHandle } from './internal/pages.js';
export { createOrganizationPages } from './internal/organization.js';
export {
  createViewStateStore,
  type UiViewSnapshot,
  type UiViewStateStore,
} from './internal/restoration.js';
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
  type UiChangeOutcome,
  type UiTagAccess,
  type UiTagClient,
  type UiTagKind,
} from './internal/tag-edits.js';
export {
  readUiCatalogFinish,
  readUiCatalogLevel,
  readUiCollectionLevel,
  readUiView,
  uiCatalogFinishes,
  uiCatalogLevels,
  uiCollectionLevels,
  uiFinishLabel,
  uiHref,
  uiPageNames,
  uiViewTitle,
  UI_ROUTE_PREFIX,
  type UiCatalogLevel,
  type UiCollectionLevel,
  type UiPageName,
  type UiView,
} from './internal/routes.js';
export {
  createUserInterface,
  type UserInterface,
  type UserInterfaceOptions,
} from './internal/shell.js';
