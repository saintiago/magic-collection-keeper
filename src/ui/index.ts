/**
 * UserInterface public entry point (docs/ui/architecture.md).
 *
 * The component presents the collection behind one shell. UI composition constructs the
 * replaceable presentation modules and the page implementations of this build and mounts them
 * through Navigation (docs/ui/navigation.md), which owns the routes, the persistent frame, the
 * mounted page lifetime, the bounded account-isolated retention of opaque page state and the
 * floating notices. Its indexing notice presents the account-scoped progress Application connected
 * to Search's browser indexing capability; the pages report the operation and service failures
 * they present through the notice capability Navigation supplies them
 * (docs/ui/navigation.md#indexing-notice, docs/ui/navigation.md#error-notices).
 *
 * Pages (docs/ui/pages.md) compose one screen around an activity: they compose CardViews, Editors
 * and CaptureControls through the factories composition supplies, pass CardList descriptions to
 * card views and use UserCards for import and tag resource references. Application supplies the
 * public configuration, the authenticated transport and the component access, including the
 * Capture factory; the deployment supplies the verified identity and the device capability the
 * capture sessions open. Other components import UserInterface through this module only; its
 * internal modules stay private to the component (docs/architecture.md, .dependency-cruiser.mjs).
 */

export { createBrowsePages } from './pages/index.js';
export { createCollectionPages } from './pages/index.js';
export { createImportPages } from './pages/index.js';
export { createOrganizationPages } from './pages/index.js';
export { createPages } from './pages/index.js';
export {
  createNavigation,
  createViewStateStore,
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
  type Navigation,
  type NavigationOptions,
  type UiAccount,
  type UiCatalogLevel,
  type UiCollectionLevel,
  type UiDialogOptions,
  type UiDialogs,
  type UiIdentity,
  type UiNotice,
  type UiNoticeAction,
  type UiNotices,
  type UiNoticeSeverity,
  type UiPageContext,
  type UiPageDefinition,
  type UiPageHandle,
  type UiPageName,
  type UiPageRegistry,
  type UiRetainedRelease,
  type UiView,
  type UiViewSnapshot,
  type UiViewStateStore,
} from './navigation/index.js';
export {
  createUserInterface,
  type UserInterface,
  type UserInterfaceOptions,
} from './internal/composition.js';
export type { CaptureControlsFactory, UiPresentationModules } from './shared/modules.js';
export { UI_LIMITS } from './shared/limits.js';
export {
  createCaptureControls,
  type UiCaptureControls,
  type UiCaptureOptions,
} from './capture-controls/index.js';
export {
  cardListBasicContent,
  createCardListView,
  type UiActionIntent,
  type UiCardList,
  type UiCardListOptions,
  type UiCardListPresentation,
  type UiEntryImage,
  type UiEntryOwnership,
  type UiEntryTag,
  type UiListAction,
} from './card-views/index.js';
export {
  createCardViews,
  type CardViewDetail,
  type CardViewDetailOptions,
  type CardViewEntryPresentation,
  type CardViewOpenOptions,
  type CardViewPickerChoice,
  type CardViewPickerOptions,
  type CardViews,
} from './card-views/index.js';
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
} from './editors/index.js';
export {
  addAssociation,
  addToTagTool,
  createTag,
  createTagAccess,
  moveCopyById,
  outcomeText,
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
} from './editors/index.js';
export {
  applyAction,
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
  type UiActionRequest,
  type UiImportAccess,
  type UiImportCandidate,
  type UiImportClient,
  type UiImportLine,
  type UiOperationAction,
  type UiOperationOutcome,
} from './editors/index.js';
export { createEditors, type Editors, type EditorsOptions } from './editors/index.js';
