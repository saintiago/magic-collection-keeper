/**
 * Page contract of the UserInterface (docs/user-interface.md#pages-and-navigation,
 * docs/user-interface.md#state-ownership-and-restoration).
 *
 * The shell owns routes, navigation and the frame; a page implementation owns one dedicated page's
 * content and supplies the sources and tools its lists use. Pages are mounted with the supplied
 * capabilities, the verified account, the state the history entry retained and a signal that is
 * aborted when the view closes. A page implements the state the shell keeps for its entry itself:
 * it captures its form state together with the states its CardLists expose and hands the same
 * representation back when the entry returns, so navigation retains an opaque page-state reference
 * it never inspects (docs/user-interface.md#state-ownership-and-restoration).
 *
 * A page whose content arrives asynchronously reports when it has presented the history entry the
 * shell supplied it, so the shell restores that entry's scroll offset and focused element over the
 * presented content and an interrupted restoration keeps the context the entry had
 * (docs/user-interface.md#pages-and-navigation).
 */

import type { UserInterfaceCapabilities } from '../../application/index.js';
import type { CaptureBrowserDevice } from '../../capture/index.js';

import type { UiPresentationModules } from './composition.js';
import type { UiDialogs } from './dialogs.js';
import type { UiAccount } from './identity.js';
import type { UiViewSnapshot } from './restoration.js';
import type { UiPageName, UiView } from './routes.js';

/** What one page receives when the shell presents its view. */
export interface UiPageContext {
  readonly view: UiView;
  /**
   * Presentation modules UI composition supplies: the page composes CardViews, Editors and
   * CaptureControls through the interfaces it receives and never selects a concrete
   * implementation (docs/ui/architecture.md#modules-and-composition).
   */
  readonly modules: UiPresentationModules;
  /** Verified account the view presents; pages render nothing private without one. */
  readonly account: UiAccount;
  /** Public configuration, authenticated transport and component access from Application. */
  readonly capabilities: UserInterfaceCapabilities;
  /** Device capability of this deployment, as Capture consumes it. */
  readonly device: CaptureBrowserDevice;
  /** Aborted when the view closes; late results must not change the new view. */
  readonly signal: AbortSignal;
  /**
   * State this page retained for the history entry, or null when the entry kept none. The same
   * page interprets it; navigation neither reads nor restricts its shape
   * (docs/user-interface.md#state-ownership-and-restoration).
   */
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
  /**
   * State this page and its lists retain for the history entry, or null to keep none. It is the
   * page's own representation: the shell keeps the reference for the entry's lifetime and hands it
   * back through `restored`, without interpreting or bounding it.
   */
  capture?(): unknown | null;
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
  /**
   * The shell leaves one presented account: it presents another account, the visitor signs out or
   * the shell is disposed. A page that keeps private presentation state outside the state of a
   * history entry releases that account's state here; the state of a closed view is released the
   * same way whether or not its page was the one presented.
   */
  accountEnded?(accountId: string): void;
}
