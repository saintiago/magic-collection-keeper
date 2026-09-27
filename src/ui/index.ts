/**
 * UserInterface public entry point (docs/user-interface.md#interface,
 * docs/user-interface.md#pages-and-navigation,
 * docs/user-interface.md#state-ownership-and-restoration).
 *
 * The component presents the collection behind one shell. The shell owns the routes of the
 * dedicated pages, history navigation with bounded account-isolated retention of opaque page state,
 * the identity transitions of the presented account and the brief dialogs for auxiliary actions; a
 * page implementation owns one page's content, its retained state and the sources and tools its
 * lists use, and each CardList owns its own capture, restoration and content loading. Application
 * supplies the public configuration, the authenticated transport and the Recognition contract, and
 * the deployment supplies the verified identity and its device capability. Other components import
 * UserInterface through this module only; its internal modules stay private to the component
 * (docs/architecture.md, .dependency-cruiser.mjs).
 */

export {
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
} from './internal/card-list.js';
export type { UiDevice } from './internal/device.js';
export type { UiDialogOptions, UiDialogs } from './internal/dialogs.js';
export type { UiAccount, UiIdentity } from './internal/identity.js';
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
  type UiListRequest,
  type UiListSource,
  type UiOperationOutcome,
  type UiTool,
  type UiToolRequest,
  type UiToolSelection,
} from './internal/list.js';
export type { UiPageContext, UiPageDefinition, UiPageHandle } from './internal/pages.js';
export {
  createViewStateStore,
  type UiViewSnapshot,
  type UiViewStateStore,
} from './internal/restoration.js';
export {
  readUiView,
  uiHref,
  uiPageNames,
  uiViewTitle,
  UI_ROUTE_PREFIX,
  type UiPageName,
  type UiView,
} from './internal/routes.js';
export {
  createUserInterface,
  type UserInterface,
  type UserInterfaceOptions,
} from './internal/shell.js';
