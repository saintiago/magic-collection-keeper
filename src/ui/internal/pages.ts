/**
 * Page contract of the UserInterface (docs/user-interface.md#pages-and-navigation).
 *
 * The shell owns routes, navigation and the frame; a page implementation owns one dedicated page's
 * content and supplies the sources and tools its lists use. Pages are mounted with the supplied
 * capabilities, the verified account and a signal that is aborted when the view closes, and they
 * return the bounded interaction state the shell keeps for restoration. A page whose sources
 * supply entries only after the shell has presented the page reports when it presented the content
 * of its history entry, and the shell reports the account it leaves so a page that keeps private
 * presentation state ends that account's state with it.
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
   * Resolves once the page has presented the content this history entry restores, so the shell
   * restores the entry's scroll offset and focus again over the presented content. Entries of an
   * asynchronous source exist only after the shell has presented the page.
   */
  presented?(): void | Promise<void>;
  /** Releases the page; the shell has already aborted the context signal. */
  dispose?(): void;
}

/** One dedicated page implementation. */
export interface UiPageDefinition {
  readonly page: UiPageName;
  mount(container: HTMLElement, context: UiPageContext): UiPageHandle | void;
  /**
   * The shell leaves one presented account: it presents another account, the visitor signs out or
   * the shell is disposed. A page that keeps private presentation state outside the shell's own
   * bounded state releases that account's state here.
   */
  accountEnded?(accountId: string): void;
}
