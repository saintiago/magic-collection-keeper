/**
 * Page contract of the Navigation module (docs/ui/navigation.md#interface, docs/ui/pages.md).
 *
 * Navigation owns routes, navigation, the frame and the lifetime of the mounted page; a page
 * implementation owns one dedicated page's content, composes the presentation modules UI
 * composition supplied it and supplies the sources and tools its lists use. Pages are mounted with
 * the supplied capabilities, the verified account, the state the history entry retained and a
 * signal that is aborted when the view closes. A page implements the state the shell keeps for its
 * entry itself: it captures its form state together with the states its children expose and hands
 * the same representation back when the entry returns, so Navigation retains an opaque page-state
 * reference it never inspects (docs/ui/architecture.md#state-ownership-and-restoration).
 *
 * A page whose content arrives asynchronously reports when it has presented the history entry the
 * shell supplied it, so the shell restores that entry's scroll offset and focused element over the
 * presented content and an interrupted restoration keeps the context the entry had
 * (docs/ui/navigation.md#internal-design).
 */

import type { UserInterfaceCapabilities } from '../../../application/index.js';
import type { CaptureBrowserDevice } from '../../../capture/index.js';

import type { UiPresentationModules } from '../../shared/modules.js';
import type { UiDialogs } from './dialogs.js';
import type { UiAccount } from './identity.js';
import type { UiNotices } from './notices.js';
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
   * (docs/ui/architecture.md#state-ownership-and-restoration).
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
  /**
   * Notice capability of the shell: the operation and service failures a page reports stay visible
   * under their identity after the page is left, scoped to the account that presented them, and
   * Navigation owns the presentation
   * (docs/ui/navigation.md#error-notices).
   */
  readonly notices: UiNotices;
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
   * (docs/ui/navigation.md).
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
