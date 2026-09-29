/**
 * Navigation public entry point (docs/ui/navigation.md,
 * docs/ui/architecture.md#modules-and-composition).
 *
 * Navigation owns the routes of the dedicated pages, the persistent shell, the mounted page
 * lifetime, the bounded account-isolated retention of opaque page state and the floating notices
 * of the component. UI composition registers the page factories it presents and hands Navigation
 * the presentation modules the pages compose; Application supplies the account access, the public
 * capabilities and the account-scoped observable indexing status the shell presents as its
 * indexing notice. Pages implement the page contract this module owns and reach routes, dialogs
 * and notices through the context Navigation passes them.
 *
 * This module publishes the shell, the route vocabulary and the contracts its consumers need;
 * its internals stay private to the UI component (docs/architecture.md).
 */

export {
  createNavigation,
  type Navigation,
  type NavigationOptions,
  type UiPageRegistry,
} from './internal/shell.js';
export type { UiPageContext, UiPageDefinition, UiPageHandle } from './internal/pages.js';
export { createViewStateStore, type UiViewSnapshot } from './internal/restoration.js';
export type { UiAccount, UiIdentity } from './internal/identity.js';
export type { UiDialogOptions, UiDialogs } from './internal/dialogs.js';
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
