/**
 * Page contract of the UserInterface (docs/user-interface.md#pages-and-navigation).
 *
 * The shell owns routes, navigation and the frame; a page implementation owns one dedicated page's
 * content and supplies the sources and tools its lists use. Pages are mounted with the supplied
 * capabilities, the verified account and a signal that is aborted when the view closes, and they
 * return the bounded interaction state the shell keeps for restoration.
 *
 * A page whose content arrives asynchronously reports when it has presented the history entry the
 * shell supplied it, so the shell restores that entry's scroll offset and focused element over the
 * presented content and an interrupted restoration keeps the context the entry had
 * (docs/user-interface.md#pages-and-navigation).
 */

import type { UserInterfaceCapabilities } from '../../application/index.js';

import type { UiDevice } from './device.js';
import type { UiDialogs } from './dialogs.js';
import type { UiAccount } from './identity.js';
import type { UiRestorationState, UiViewSnapshot } from './restoration.js';
import type { UiPageName, UiView } from './routes.js';

/** What one page receives when the shell presents its view. */
export interface UiPageContext {
  readonly view: UiView;
  /** Verified account the view presents; pages render nothing private without one. */
  readonly account: UiAccount;
  /** Public configuration, authenticated transport and component access from Application. */
  readonly capabilities: UserInterfaceCapabilities;
  /** Device capability of this deployment. */
  readonly device: UiDevice;
  /** Aborted when the view closes; late results must not change the new view. */
  readonly signal: AbortSignal;
  /** State restored for this history entry, or null when the entry kept none. */
  readonly restored: UiViewSnapshot | null;
  /** Navigates to another view and keeps this one's state for the way back. */
  navigate(view: UiView): void;
  /** Presents another view in place of this one. */
  replace(view: UiView): void;
  /** Follows navigation history back. */
  back(): void;
  /** Brief dialogs for small auxiliary actions. */
  readonly dialogs: UiDialogs;
}

/** What a page returns to the shell when the shell presents it. */
export interface UiPageHandle {
  /** Bounded query and selection state to keep for this history entry, or null to keep none. */
  capture?(): UiRestorationState | null;
  /**
   * Resolves once the page has presented the content of the history entry the shell supplied in
   * `restored`. The shell restores that entry's scroll offset and focused element again over the
   * presented content, and it keeps the entry's saved context instead of capturing the partially
   * presented view until the page reports the presentation. A page whose own presentation
   * supersedes the restored context — explicit input taking over, or a failed restore — reports
   * that through this same result. A page that presents another view from this hook hands the entry
   * over to that view, which captures and restores its own interaction context
   * (docs/user-interface.md#pages-and-navigation).
   */
  presented?(): void | Promise<void>;
  /** Releases the page; the shell has already aborted the context signal. */
  dispose?(): void;
}

/** One dedicated page implementation. */
export interface UiPageDefinition {
  readonly page: UiPageName;
  mount(container: HTMLElement, context: UiPageContext): UiPageHandle | void;
}
