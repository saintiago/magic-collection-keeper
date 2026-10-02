/** Navigation public contract: routes, account lifetime, page restoration and operation/read notices. */

export {
  createNavigation,
  type Navigation,
  type NavigationOptions,
  type UiPageRegistry,
} from './internal/shell.js';
export type { UiPageContext, UiPageDefinition, UiPageHandle } from './internal/pages.js';
export {
  createViewStateStore,
  type UiRetainedRelease,
  type UiViewSnapshot,
  type UiViewStateStore,
} from './internal/restoration.js';
export type { UiAccount, UiIdentity } from './internal/identity.js';
export { createDialogs, type UiDialogHost } from './internal/dialogs.js';
export type { UiDialogOptions, UiDialogs } from './internal/dialogs.js';
export { createNoticeHost, type UiNoticeHost } from './internal/notices.js';
export type { UiNotice, UiNoticeAction, UiNotices, UiNoticeSeverity } from './internal/notices.js';
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
