/**
 * Page contract of the UserInterface (docs/user-interface.md#pages-and-navigation).
 *
 * The shell owns routes, navigation and the frame; a page implementation owns one dedicated page's
 * content and supplies the sources and tools its lists use. Pages are mounted with the supplied
 * capabilities, the verified account and a signal that is aborted when the view closes, and they
 * return the bounded interaction state the shell keeps for restoration. A page whose sources supply
 * entries only after the shell has presented it reports when it presented the content of its history
 * entry, so the shell restores that entry's scroll offset and focused element over the presented
 * content; an interrupted restoration keeps the context the entry had, while the page's own
 * captured state stays live. The shell also reports the account it leaves, so a page that keeps
 * private presentation state ends that account's state with it
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
   * presented content, and it keeps the entry's saved scroll offset, focused element and visible
   * position instead of capturing the partially presented view until the page reports the
   * presentation — and, afterwards, until explicit user input takes the interaction over, even if
   * earlier input cancelled automatic scroll and focus restoration during loading.
   * The page's captured state is read live while the shell keeps that context, so a page that
   * restores content asynchronously reports the content it presents, the window it is restoring
   * included, even before its entries arrive. A page whose own presentation supersedes the restored
   * context — explicit input taking over, or a failed restore — reports that through this same
   * result. A page that presents another view from this hook hands the entry over to that view,
   * which captures and restores its own interaction context
   * (docs/user-interface.md#pages-and-navigation). Entries of an asynchronous source exist only
   * after the shell has presented the page, so its entries are presented through this result.
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
