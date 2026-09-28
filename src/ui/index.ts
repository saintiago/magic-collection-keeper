/**
 * UserInterface public entry point (docs/user-interface.md#interface,
 * docs/user-interface.md#pages-and-navigation,
 * docs/user-interface.md#state-ownership-and-restoration).
 *
 * The component presents the collection behind one shell. The shell owns the routes of the
 * dedicated pages, history navigation with bounded account-isolated retention of opaque page state,
 * the identity transitions of the presented account and the brief dialogs for auxiliary actions; a
 * page implementation owns one page's content, its retained state and the sources and tools its
 * lists use, and each CardList owns its own capture, restoration and content loading. The browsing
 * pages present Home's bounded, account-isolated recent card activity and the catalog/search query
 * a URL names, both over the supplied Search and Catalog contracts, and the collection pages
 * present the account's owned records with their copy corrections over the supplied UserCards
 * contract. The Import page stages manually entered cards as pending entries and presents the
 * account's pending imports for review and confirmation through the same private contract, so a
 * staged line is never presented as owned before its confirmation reports the copies it created.
 * The same page captures cards hands-free through the supplied device and the Recognition
 * contract: a settled frame the runtime reports as one card stages its candidate in review, a
 * frame whose geometry is not established is never admitted, a repeated observation stays one
 * entry, unresolved readings receive no success cue, late alternatives are attached to the entry
 * they belong to without rewriting its reviewed values, and a capture whose staging response was
 * lost is recovered by replaying its own observation.
 * Application supplies the public configuration, the authenticated transport and the component
 * access, and the deployment supplies the verified identity and its device capability, including
 * the camera the capture view opens. Other
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
  cardListBasicContent,
  createCardList,
  groupCardListEntries,
  type UiCardList,
  type UiCardListFragments,
  type UiCardListGroup,
  type UiCardListOptions,
  type UiCardListPresentation,
  type UiCardListRestoration,
  type UiCardListState,
  type UiCardListTool,
  type UiEntryImage,
  type UiEntryOwnership,
  type UiEntryTag,
  type UiListFocus,
  type UiListPosition,
  type UiListSelectedTarget,
} from './internal/card-list.js';
export type { UiCamera, UiDevice } from './internal/device.js';
export type { UiDialogOptions, UiDialogs } from './internal/dialogs.js';
export type { UiAccount, UiIdentity } from './internal/identity.js';
export {
  attachImportCandidates,
  beginSourceImport,
  confirmImport,
  createImportAccess,
  discardImportEntry,
  discardImportSession,
  recoverConfirmation,
  reopenSourceImport,
  retryRetainedAttempt,
  reviewImportEntry,
  stageCaptureObservation,
  stageImportLines,
  uiCaptureIdentity,
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
export {
  uiFragmentKinds,
  type UiEntryBasic,
  type UiEntryCard,
  type UiEntryPrinting,
  type UiEntryQuantity,
  type UiEntryTarget,
  type UiFragmentKind,
  type UiFragmentReader,
  type UiFragmentRequest,
  type UiFragmentResult,
  type UiListEntry,
  type UiListPage,
  type UiListRead,
  type UiListRequest,
  type UiListSource,
  type UiOperationOutcome,
  type UiTool,
  type UiToolRequest,
  type UiToolSelection,
} from './internal/list.js';
export type { UiPageContext, UiPageDefinition, UiPageHandle } from './internal/pages.js';
export { createOrganizationPages } from './internal/organization.js';
export { createRecentCards, type UiRecentCards } from './internal/recent.js';
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
  catalogSearchRequest,
  collectionSearchRequest,
  createCatalogSearchAccess,
  createCollectionSearchAccess,
  createEntryOwnershipReader,
  createSearchCounts,
  searchListEntry,
  uiEntryKey,
  uiEntryTargetOfKey,
  type UiCatalogQuery,
  type UiCatalogSearchAccess,
  type UiCollectionQuery,
  type UiCollectionSearchAccess,
  type UiCountsAccess,
  type UiEntryCounts,
} from './internal/search-source.js';
export {
  createUserInterface,
  type UserInterface,
  type UserInterfaceOptions,
} from './internal/shell.js';
