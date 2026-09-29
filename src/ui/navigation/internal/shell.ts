/**
 * Shell of the Navigation module (docs/ui/navigation.md,
 * docs/ui/architecture.md#modules-and-composition).
 *
 * Navigation owns the routes of the dedicated pages, the persistent frame, the mounted page
 * lifetime and the bounded, account-isolated retention of the state pages provide. UI composition
 * registers the page factories it receives; Application supplies the account access and the public
 * capabilities the pages present. Navigation mounts one page at a time, disposes the departed one
 * and fences a factory result that a newer navigation or account change has obsoleted. A retained
 * handle stays opaque: Navigation keeps it for its history entry and hands it back to its owning
 * factory without inspecting its contents.
 *
 * The shell also presents the floating notices of the component: the indexing notice of the
 * account-scoped progress Application connected to Search's browser indexing capability, and the
 * operation and service failures the presented pages report through the notice capability. Closing
 * a page aborts its work and detaches its container so a late result cannot change the new view; a
 * changed account clears the private presentation state and its notices, ends the authenticated
 * session the transport serves and reports the ended account to every page implementation.
 *
 * A page that presents a restored history entry asynchronously reports the presentation, so the
 * entry's scroll offset, focused element and visible anchor are restored over the presented
 * content; an interrupted restoration keeps the context the entry had instead of capturing the
 * partially presented view, and explicit user input takes the interaction over from the
 * restoration.
 */

import type { UserInterfaceCapabilities } from '../../../application/index.js';
import type { CaptureBrowserDevice } from '../../../capture/index.js';
import type { SearchIndexingObservable, SearchIndexingStatus } from '../../../search/browser.js';

import { observeUiInput } from '../../shared/interaction.js';
import type { UiPresentationModules } from '../../shared/modules.js';
import type { UiNotices } from '../../shared/notices.js';
import { createDialogs, type UiDialogs } from './dialogs.js';
import { readAccount, type UiAccount, type UiIdentity } from './identity.js';
import { createNoticeHost, type UiNotice } from './notices.js';
import type { UiPageContext, UiPageDefinition, UiPageHandle } from './pages.js';
import {
  createViewStateStore,
  type UiRetainedRelease,
  type UiViewSnapshot,
} from './restoration.js';
import {
  readUiView,
  uiHref,
  uiPageNames,
  uiViewTitle,
  UI_ROUTE_PREFIX,
  type UiPageName,
  type UiView,
} from './routes.js';

/**
 * One page implementation, or — for a build that loads its pages on demand — the factory that
 * loads it. Loading may be asynchronous; Navigation mounts the result only while the view that
 * requested it still owns the shell (docs/ui/navigation.md#internal-design).
 */
export interface UiPageRegistry {
  /** Implementation of one page, or null when this build presents none. */
  load(page: UiPageName): UiPageDefinition | null | Promise<UiPageDefinition | null>;
}

export interface NavigationOptions {
  /** Element the shell renders the application frame and its pages into. */
  readonly root: Element;
  /** Public configuration, authenticated transport and component access from Application. */
  readonly capabilities: UserInterfaceCapabilities;
  /** Verified identity and its transitions. */
  readonly identity: UiIdentity;
  /** Device capability of this deployment; absent when the UI holds no device resources. */
  readonly device?: CaptureBrowserDevice;
  /**
   * Registry the shell resolves the page of a route from, or the page implementations themselves;
   * UI composition supplies them and a route without a page presents no content.
   */
  readonly pages?: readonly UiPageDefinition[] | UiPageRegistry;
  /**
   * Presentation modules UI composition supplies to the pages it mounts; the shell hands them to
   * every page it presents (docs/ui/architecture.md#modules-and-composition).
   */
  readonly modules: UiPresentationModules;
}

export interface Navigation {
  /** Verified account currently presented, or null while signed out. */
  readonly account: UiAccount | null;
  /** View currently presented, or null while signed out or on an unknown route. */
  readonly view: UiView | null;
  /** Presents one view and keeps the current view's state for the way back. */
  navigate(view: UiView): void;
  /** Presents one view in place of the current one, keeping no way back. */
  replace(view: UiView): void;
  /** Follows navigation history back. */
  back(): void;
  /** Releases listeners, page work, notices and device resources. */
  dispose(): void;
}

/** Notice identity of the account-scoped indexing progress, owned by the shell. */
const indexingNotice = 'navigation:indexing';
/** Notice identities of the shell's own sign-in and sign-out operations. */
const signInNotice = 'navigation:sign-in';
const signOutNotice = 'navigation:sign-out';

/** Dedicated pages the primary navigation reaches; tag and card views are reached from them. */
const primaryLinks: readonly { readonly view: UiView; readonly label: string }[] = [
  { view: { page: 'home' }, label: 'Home' },
  {
    view: { page: 'catalog', query: '', level: 'card', owned: false, finish: null },
    label: 'Catalog',
  },
  { view: { page: 'collection', query: '', level: 'card' }, label: 'Collection' },
  { view: { page: 'tags' }, label: 'Tags' },
  { view: { page: 'import' }, label: 'Import' },
];

export function createNavigation(options: NavigationOptions): Navigation {
  const root = readRoot(options?.root);
  const capabilities = readCapabilities(options?.capabilities);
  const identity = readIdentity(options?.identity);
  const device = readDevice(options?.device);
  const pages = readPages(options?.pages);
  const modules = readModules(options?.modules);
  const document = root.ownerDocument;
  const candidates = document.defaultView;
  if (candidates === null) {
    throw new TypeError('The UserInterface requires a document with a browsing context.');
  }
  const browser: Window = candidates;
  const history = browser.history;
  const previousScrollRestoration = history.scrollRestoration;
  // The shell owns restoration (docs/ui/navigation.md): the browser's own
  // restoration would move the departing page before a traversal can capture its scroll offset.
  history.scrollRestoration = 'manual';
  const store = createViewStateStore();
  const dialogs = createDialogs(root);

  const nav = document.createElement('nav');
  nav.setAttribute('aria-label', 'Primary');
  const navLinks = new Map<UiPageName, HTMLAnchorElement>();
  for (const link of primaryLinks) {
    const anchor = document.createElement('a');
    anchor.href = uiHref(link.view);
    anchor.textContent = link.label;
    nav.append(anchor);
    navLinks.set(link.view.page, anchor);
  }
  const accountLabel = document.createElement('p');
  const signOutButton = document.createElement('button');
  signOutButton.type = 'button';
  signOutButton.textContent = 'Sign out';
  const header = document.createElement('header');
  header.append(nav, accountLabel, signOutButton);
  const main = document.createElement('main');
  root.replaceChildren(header, main);
  // The floating notices of the shell: the pages report their failures through the capability
  // below, and the presentation outlives the page that reported one
  // (docs/ui/navigation.md#error-notices).
  const notices = createNoticeHost(root);
  /** Notice identities a page reported a recovery action for; leaving the page retires them. */
  const pageActionNotices = new Set<string>();

  let account: UiAccount | null = null;
  let view: UiView | null = null;
  let pageController: AbortController | null = null;
  let pageHandle: UiPageHandle | null = null;
  /** Factory that owns the mounted page's retained handles; the shell delegates release to it. */
  let pageDefinition: UiPageDefinition | null = null;
  let generation = 0;
  let teardownGeneration: number | null = null;
  let disposed = false;
  let signOutPending = false;
  /**
   * Lifetime of the identity operation the shell presents. A change of the presented account and
   * the disposal of the shell end it, so a completion of an operation the departed account started
   * changes neither the notices nor the controls of the account that replaced it
   * (docs/ui/architecture.md#asynchronous-presentation).
   */
  let identityOperation = 0;
  let lastHref = '';
  let lastToken: string | null = null;
  /** Account-scoped indexing progress Application supplied for the presented account. */
  let indexing: SearchIndexingObservable | null = null;
  /** Withdrawal of the subscription to that progress. */
  let unsubscribeIndexing: (() => void) | null = null;
  /**
   * Whether the presented entry still keeps the interaction context it is restoring: the scroll
   * offset, focused element and visible anchor it had when the user left it. It holds from the
   * moment the shell presents the entry's snapshot until the page reports that it presented the
   * content of that snapshot and the user takes the applied interaction over with explicit input,
   * or until the page presents the entry synchronously, its presentation fails or the entry closes.
   */
  let restoringEntry = false;
  /** The snapshot whose interaction context the presented entry keeps while it keeps one. */
  let restoringSnapshot: UiViewSnapshot | null = null;

  signOutButton.addEventListener('click', () => {
    requestSignOut();
  });
  root.addEventListener('click', onClick);
  browser.addEventListener('popstate', onBrowserNavigation);
  browser.addEventListener('hashchange', onBrowserNavigation);
  const unsubscribe = identity.subscribe((reported) => {
    applyAccount(readAccount(reported));
  });

  applyAccount(readAccount(identity.current()));

  return {
    get account() {
      return account;
    },
    get view() {
      return view;
    },
    navigate,
    replace,
    back,
    dispose,
  };

  function navigate(target: UiView): void {
    if (disposed) {
      return;
    }
    rememberCurrent();
    history.pushState({ ...readState(history), uiView: store.open() }, '', uiHref(target));
    render();
  }

  function replace(target: UiView): void {
    if (disposed) {
      return;
    }
    // The entry the presented view occupies cannot be returned to: the page's own state is not
    // retained for it, and the store discards what it kept once that view is disposed below, so
    // the factory that owns the handle reclaims it (docs/ui/navigation.md#interface).
    const superseded = lastToken;
    history.replaceState({ ...readState(history), uiView: store.open() }, '', uiHref(target));
    render();
    if (superseded !== null) {
      store.discard(superseded);
    }
  }

  function back(): void {
    if (disposed) {
      return;
    }
    rememberCurrent();
    history.back();
  }

  function dispose(): void {
    if (disposed) {
      return;
    }
    disposed = true;
    identityOperation += 1;
    closePage();
    browser.removeEventListener('popstate', onBrowserNavigation);
    browser.removeEventListener('hashchange', onBrowserNavigation);
    root.removeEventListener('click', onClick);
    unsubscribe();
    const current = account;
    if (current !== null) {
      // Disposal ends the presented account's private state with the UI that presented it.
      endAccount(current.accountId);
    }
    bindIndexing(null);
    notices.dispose();
    store.clear();
    releaseDevice();
    notices.dispose();
    history.scrollRestoration = previousScrollRestoration;
    root.replaceChildren();
  }

  /**
   * Reports one account change. The same account keeps the presented view; another account or a
   * sign-out clears the private presentation state, ends the authenticated session so outstanding
   * responses are rejected, releases device resources and presents the current URL anew.
   */
  function applyAccount(next: UiAccount | null): void {
    if (disposed) {
      return;
    }
    const previous = account;
    const same = previous !== null && previous.accountId === next?.accountId;
    account = next;
    if (same) {
      renderAccountLabel();
      return;
    }
    // The account that replaced the previous one owns fresh controls: the operation the departed
    // account started no longer presents its pending state here, and its later completion is
    // fenced out of the notices and controls of this account.
    identityOperation += 1;
    signOutPending = false;
    signOutButton.disabled = false;
    closePage();
    store.clear();
    // The notices of the presented view end with the account that presented them, and the progress
    // of the account the shell leaves is fenced before the next account is bound
    // (docs/ui/navigation.md#error-notices, docs/ui/navigation.md#indexing-notice).
    bindIndexing(null);
    notices.clear();
    if (previous !== null) {
      endAccount(previous.accountId);
      capabilities.request.endSession();
      releaseDevice();
    }
    bindIndexing(next);
    render();
  }

  /**
   * Reports one account the shell leaves to every page implementation, whichever page is presented
   * at that moment, so private state a page keeps outside the entries of the shell's own store ends
   * with the account that presented it (docs/ui/architecture.md#state-ownership-and-restoration).
   */
  function endAccount(accountId: string): void {
    for (const definition of pages.loaded.values()) {
      definition.accountEnded?.(accountId);
    }
  }

  /**
   * Withdraws the private presentation and asks the deployment to sign out. The presented page
   * stays live underneath: it returns unchanged when identity keeps the verified account, and its
   * work is aborted and its state cleared only when identity reports the change.
   */
  function requestSignOut(): void {
    if (disposed || signOutPending) {
      return;
    }
    const operation = identityOperation;
    signOutPending = true;
    signOutButton.disabled = true;
    main.hidden = true;
    notices.show({ id: signOutNotice, severity: 'progress', message: 'Signing out…' });
    void finishSignOut(operation);
  }

  async function finishSignOut(operation: number): Promise<void> {
    let message: string | null = null;
    try {
      await identity.signOut();
    } catch (cause) {
      message = readMessage(cause, 'Sign-out failed. Please retry.');
    }
    if (disposed || operation !== identityOperation) {
      // The account this sign-out belonged to left meanwhile: its failure belongs to a session that
      // no longer exists and never reaches the replacement account's notices or controls.
      return;
    }
    signOutPending = false;
    signOutButton.disabled = false;
    const reported = readAccount(identity.current());
    if (reported === null || reported.accountId !== account?.accountId) {
      applyAccount(reported);
      return;
    }
    // Identity still reports the signed-in account, so the page was never closed and is live.
    main.hidden = false;
    if (message === null) {
      notices.dismiss(signOutNotice);
      return;
    }
    // Signing out is a service failure with no field to hold it: the floating error notice reports
    // it, the live page keeps its work, and the notice and the enabled control offer the retry
    // (docs/ui/navigation.md#error-notices).
    notices.show({
      id: signOutNotice,
      severity: 'error',
      message,
      action: { label: 'Retry sign-out', run: requestSignOut },
    });
  }

  function requestSignIn(): void {
    if (disposed) {
      return;
    }
    void runIdentity(() => identity.signIn(), 'Sign-in failed. Please retry.');
  }

  async function runIdentity(start: () => void | Promise<void>, fallback: string): Promise<void> {
    const operation = identityOperation;
    notices.dismiss(signInNotice);
    try {
      await start();
    } catch (cause) {
      if (disposed || operation !== identityOperation) {
        // The attempt belongs to a session the shell already left; its failure is not presented to
        // the account that replaced it (docs/ui/architecture.md#asynchronous-presentation).
        return;
      }
      notices.show({
        id: signInNotice,
        severity: 'error',
        message: readMessage(cause, fallback),
        action: { label: 'Sign in again', run: requestSignIn },
      });
      return;
    }
    if (!disposed && operation === identityOperation) {
      applyAccount(readAccount(identity.current()));
    }
  }

  /** Presents the signed-in view of the current URL, the sign-in prompt or the unknown route. */
  function render(): void {
    closePage();
    const current = account;
    header.hidden = current === null;
    main.hidden = false;
    const target = current === null ? null : readUiView(browser.location.href);
    view = target;
    const token = current === null ? null : entryToken();
    lastHref = browser.location.href;
    lastToken = token;
    renderAccountLabel();
    updateNavigation(target?.page ?? null);
    if (current === null) {
      renderPanel(signedOutHeading(), signedOutContent());
    } else if (target === null) {
      renderPanel(plainHeading('Page not found'), unknownRouteContent());
    } else {
      renderPage(current, target, token);
    }
  }

  /**
   * Token of the presented history entry, opened when the entry carries none or one that a previous
   * page load opened. Every presented entry then owns a token of this store, so leaving it — by a
   * link or by the browser's own Back and Forward — captures the state of the entry it holds.
   */
  function entryToken(): string {
    const carried = readToken(history.state);
    if (carried !== null && store.owns(carried)) {
      return carried;
    }
    const token = store.open();
    history.replaceState({ ...readState(history), uiView: token }, '');
    return token;
  }

  /** Presents one page: its heading, its container and the lifecycle of its implementation. */
  function renderPage(current: UiAccount, target: UiView, token: string | null): void {
    const heading = plainHeading(uiViewTitle(target));
    const container = document.createElement('div');
    container.dataset.uiPage = target.page;
    main.replaceChildren(heading, container);
    const currentGeneration = generation;
    const restored = token === null ? null : store.read(current.accountId, token);
    // An entry that restores a snapshot keeps it until its page reports how it presents that
    // snapshot: even a page that navigates away while mounting leaves that context in place.
    restoringEntry = restored !== null;
    restoringSnapshot = restored;
    const controller = new AbortController();
    pageController = controller;
    const context: UiPageContext = {
      view: target,
      modules,
      account: current,
      capabilities,
      device: pageDevice(currentGeneration),
      signal: controller.signal,
      restored,
      navigate: (next) => {
        if (generation === currentGeneration) {
          navigate(next);
        }
      },
      replace: (next) => {
        if (generation === currentGeneration) {
          replace(next);
        }
      },
      back: () => {
        if (generation === currentGeneration) {
          back();
        }
      },
      dialogs: pageDialogs(currentGeneration),
      notices: pageNotices(currentGeneration, current.accountId),
    };
    resolvePage(target, container, context, heading, restored, currentGeneration, controller);
  }

  /**
   * Resolves the page implementation of one route and mounts it. A registry may load the factory
   * asynchronously: the resolved definition mounts only while the view that requested it still owns
   * the shell, so a load a newer navigation or account change obsoleted neither renders into the
   * page region of the replacement view nor keeps a handle of its own
   * (docs/ui/navigation.md#internal-design).
   */
  function resolvePage(
    target: UiView,
    container: HTMLDivElement,
    context: UiPageContext,
    heading: HTMLHeadingElement,
    restored: UiViewSnapshot | null,
    currentGeneration: number,
    controller: AbortController,
  ): void {
    let loading: UiPageDefinition | null | Promise<UiPageDefinition | null>;
    try {
      loading = pages.load(target.page);
    } catch (cause) {
      presentUnavailable(container, cause, currentGeneration);
      return;
    }
    if (isThenable(loading)) {
      // The route presents its loading state while the factory loads; the definition replaces it.
      const pending = document.createElement('p');
      pending.dataset.uiPageLoading = '';
      pending.textContent = 'Loading…';
      container.replaceChildren(pending);
      void Promise.resolve(loading).then(
        (definition) => {
          mountPage(
            definition,
            container,
            context,
            heading,
            restored,
            currentGeneration,
            controller,
          );
        },
        (cause: unknown) => {
          presentUnavailable(container, cause, currentGeneration);
        },
      );
      return;
    }
    mountPage(loading, container, context, heading, restored, currentGeneration, controller);
  }

  /** Mounts one resolved page implementation, unless a newer view already owns the shell. */
  function mountPage(
    definition: UiPageDefinition | null,
    container: HTMLDivElement,
    context: UiPageContext,
    heading: HTMLHeadingElement,
    restored: UiViewSnapshot | null,
    currentGeneration: number,
    controller: AbortController,
  ): void {
    if (disposed || generation !== currentGeneration) {
      // A factory that resolved after the shell left its view mounts nothing.
      return;
    }
    if (definition === null) {
      container.replaceChildren();
      return;
    }
    if (definition.page !== context.view.page) {
      presentUnavailable(
        container,
        new TypeError('A page factory loaded another page than the route it belongs to.'),
        currentGeneration,
      );
      return;
    }
    pages.loaded.set(definition.page, definition);
    container.replaceChildren();
    const handle = definition.mount(container, context) ?? null;
    if (generation !== currentGeneration) {
      // The page presented another view while mounting; that view owns the shell's handle now.
      handle?.dispose?.();
      return;
    }
    pageHandle = handle;
    pageDefinition = definition;
    restoreInteraction(heading, restored);
    restorePresentedInteraction(handle, heading, restored, currentGeneration, controller.signal);
  }

  /** A route whose factory could not be loaded presents recoverable feedback instead of nothing. */
  function presentUnavailable(
    container: HTMLDivElement,
    cause: unknown,
    currentGeneration: number,
  ): void {
    if (disposed || generation !== currentGeneration) {
      return;
    }
    container.replaceChildren();
    const message = document.createElement('p');
    message.dataset.uiPageUnavailable = '';
    message.textContent = readMessage(cause, 'This page could not be loaded.');
    container.append(message);
  }

  function renderPanel(heading: HTMLHeadingElement, content: readonly Node[]): void {
    main.replaceChildren(heading, ...content);
    restoreInteraction(heading, null);
  }

  /** Restores the focused element and scroll offset of a history entry, or starts at the top. */
  function restoreInteraction(heading: HTMLHeadingElement, restored: UiViewSnapshot | null): void {
    if (restored === null) {
      browser.scrollTo(0, 0);
      heading.focus({ preventScroll: true });
      return;
    }
    const focus = restored.focusId === null ? null : document.getElementById(restored.focusId);
    // A page or list may have restored a control without an element id. Use the heading only
    // when neither the shell's saved target nor focus within the presented page is available.
    if (focus !== null) {
      focus.focus({ preventScroll: true });
    } else if (!main.contains(document.activeElement)) {
      heading.focus({ preventScroll: true });
    }
    browser.scrollTo(0, restored.scrollY);
  }

  /**
   * Restores the interaction of one history entry again once the page reports that it presented the
   * content of that entry. A page whose sources supply entries only after the shell has mounted it
   * presents them asynchronously, so the entry's scroll offset, focused element and visible anchor
   * are restored over the presented content instead of over the empty page
   * (docs/ui/architecture.md#state-ownership-and-restoration).
   *
   * Until the page presents that snapshot the entry keeps the interaction context it is restoring:
   * Back, Forward or a link leaves that context in place instead of capturing the partially
   * presented view and the heading the shell focused while the page was still empty. The page's own
   * retained state is read live, so edits the user made beside the arriving content are kept.
   *
   * Explicit user input takes the interaction over: input while the content is still unavailable
   * cancels the automatic restoration of scroll and focus but does not release the entry's context,
   * and input once the presentation settled — applied or failed — releases it so the view captures
   * the interaction the user chose from then on. Late layout of the presented content — further
   * fragments and decoded images — keeps the visible anchor at its saved viewport offset while the
   * entry still keeps its context.
   */
  function restorePresentedInteraction(
    handle: UiPageHandle | null,
    heading: HTMLHeadingElement,
    restored: UiViewSnapshot | null,
    currentGeneration: number,
    signal: AbortSignal,
  ): void {
    if (restored === null || handle?.presented === undefined) {
      // The page presents its entry synchronously: leaving it captures the presented view again.
      releaseRestoration();
      return;
    }
    // The entry restored one snapshot; the presentation applies that snapshot once it can be read.
    const snapshot: UiViewSnapshot = restored;
    const lifetime = new AbortController();
    let observer: ResizeObserver | null = null;
    let presentationSettled = false;
    let interactionTaken = false;
    const disposeRestoration = (): void => {
      observer?.disconnect();
      observer = null;
      lifetime.abort();
    };
    /**
     * Explicit user input: the shell no longer moves the scroll offset and focus of the entry, and
     * once the presentation settled the entry captures the interaction the user chooses from here
     * on. Input while the content is still unavailable cancels automatic restoration but keeps
     * listening for that later input.
     */
    const takeOver = (): void => {
      interactionTaken = true;
      if (presentationSettled) {
        disposeRestoration();
        releaseRestoration();
      }
    };
    signal.addEventListener('abort', disposeRestoration, { once: true, signal: lifetime.signal });
    observeUiInput(browser, takeOver, lifetime.signal);
    let presented: void | Promise<void>;
    try {
      presented = handle.presented();
    } catch {
      // A page that cannot report its presentation stops the automatic restoration, but the entry
      // keeps the context it was restoring instead of capturing the partially presented view;
      // explicit input releases it from here on.
      presentationSettled = true;
      return;
    }
    if (!ownsPage(handle, currentGeneration)) {
      // The page presented another view while starting its presentation: that view owns the shared
      // restoration now, so the departed page may neither keep nor release it, and no listener of
      // it may outlive the view.
      disposeRestoration();
      // Still observe the returned promise: a hook can redirect synchronously and then reject.
      // The settlement handlers below guard ownership before touching the current view.
    }
    void Promise.resolve(presented).then(
      () => {
        if (!ownsPage(handle, currentGeneration)) {
          // The presented page reported after it handed the entry to another view: the departed
          // page keeps neither the shared restoration nor its listeners.
          return;
        }
        presentationSettled = true;
        if (interactionTaken) {
          // The user took the interaction over while the content was still unavailable: the entry
          // keeps its context until later input releases it, without moving focus or scroll now.
          return;
        }
        restoreInteraction(heading, snapshot);
        keepVisibleAnchor();
      },
      () => {
        // A page that could not present its content stops the automatic restoration, but the entry
        // keeps the interaction context it was restoring — the saved scroll offset, focused element
        // and visible anchor — instead of capturing the partially presented view; explicit input
        // releases it from here on.
        presentationSettled = true;
        if (!ownsPage(handle, currentGeneration)) {
          disposeRestoration();
        }
      },
    );

    /**
     * Keeps the element the entry's window showed at the viewport offset it showed it at. Entries
     * of an asynchronous source exist only once presented, so fragments and decoded images can
     * still change the layout after that presentation; the offset holds until user input or the
     * page's own teardown takes the interaction over.
     */
    function keepVisibleAnchor(): void {
      const anchorId = snapshot.anchorId;
      const anchor = anchorId == null ? null : document.getElementById(anchorId);
      if (anchor === null || !main.contains(anchor)) {
        // Nothing of the presented content carries the entry's position: the restored offset
        // stands, and explicit input that follows releases the restored context.
        return;
      }
      const align = (): void => {
        if (lifetime.signal.aborted || !anchor.isConnected) {
          return;
        }
        browser.scrollBy(0, anchor.getBoundingClientRect().top - (snapshot.anchorTop ?? 0));
      };
      observer = new ResizeObserver(align);
      observer.observe(main);
      align();
    }
  }

  /**
   * The presented entry stops keeping the interaction context it was restoring: from here on,
   * leaving it captures the interaction the presented view holds
   * (docs/ui/architecture.md#state-ownership-and-restoration).
   */
  function releaseRestoration(): void {
    restoringEntry = false;
    restoringSnapshot = null;
  }

  /**
   * Whether one page still owns the shell's shared presentation state. A page that navigated or
   * was closed while running its own code owns neither that state nor its listeners; the view it
   * presented owns them instead.
   */
  function ownsPage(handle: UiPageHandle | null, currentGeneration: number): boolean {
    return !disposed && generation === currentGeneration && pageHandle === handle;
  }

  /** Dialogs of one presented page; a page the shell has left can no longer open one. */
  function pageDialogs(currentGeneration: number): UiDialogs {
    return {
      confirm(options) {
        if (disposed || generation !== currentGeneration) {
          return Promise.resolve(false);
        }
        return dialogs.confirm(options);
      },
    };
  }

  /**
   * Notice capability of one presented page: it reports the operation and service failures it
   * presents under the account's identities, and a page the shell has left can no longer report
   * one to the view that replaced it (docs/ui/navigation.md#error-notices).
   */
  function pageNotices(currentGeneration: number, accountId: string): UiNotices {
    const prefix = `navigation:page:${accountId}:`;
    const live = (): boolean =>
      !disposed && generation === currentGeneration && account?.accountId === accountId;
    return {
      show(report: UiNotice) {
        if (!live()) {
          return;
        }
        const id = `${prefix}${report.id}`;
        if (report.action == null) {
          pageActionNotices.delete(id);
        } else {
          pageActionNotices.add(id);
        }
        notices.show({ ...report, id });
      },
      dismiss(id) {
        if (!live()) {
          return;
        }
        const owned = `${prefix}${id}`;
        pageActionNotices.delete(owned);
        notices.dismiss(owned);
      },
    };
  }

  /**
   * Binds the account-scoped indexing status Application supplies. Application replaces the
   * tracker with the account, so the shell subscribes when the account changes, presents every
   * published status and drops the binding of the account it left; the shell neither compares
   * positions nor checks progress itself (docs/ui/navigation.md#indexing-notice).
   */
  function bindIndexing(current: UiAccount | null): void {
    unsubscribeIndexing?.();
    unsubscribeIndexing = null;
    indexing = null;
    notices.dismiss(indexingNotice);
    if (current === null) {
      return;
    }
    let progress: SearchIndexingObservable;
    try {
      progress = capabilities.indexing(current.accountId);
    } catch {
      // A composition without tracked progress of this account presents no indexing notice.
      return;
    }
    if (progress.status().accountId !== current.accountId) {
      // Progress of another account is never presented as this account's saving state.
      return;
    }
    indexing = progress;
    unsubscribeIndexing = progress.subscribe((status) => {
      applyIndexingStatus(current.accountId, status);
    });
    applyIndexingStatus(current.accountId, progress.status());
  }

  /**
   * Presents one published indexing status. The notice means the save succeeded and search results
   * are catching up: it disappears once the known changes are incorporated, reports delayed or
   * failed progress explicitly with a status check that repeats no write, and never invents a
   * percentage (docs/ui/navigation.md#indexing-notice).
   */
  function applyIndexingStatus(accountId: string, status: SearchIndexingStatus): void {
    if (disposed || status.accountId !== accountId || account?.accountId !== accountId) {
      // A late status of the account the shell left never reaches another account's notice.
      return;
    }
    switch (status.state) {
      case 'idle':
      case 'incorporated':
        // Nothing known awaits indexing: no notice is presented.
        notices.dismiss(indexingNotice);
        return;
      case 'indexing':
        notices.show({
          id: indexingNotice,
          severity: 'progress',
          message: 'Indexing your cards…',
        });
        return;
      case 'delayed':
        notices.show({
          id: indexingNotice,
          severity: 'status',
          message: 'Indexing is delayed',
          action: checkIndexing(),
        });
        return;
      case 'unavailable':
        notices.show({
          id: indexingNotice,
          severity: 'status',
          message: 'The indexing status is unavailable',
          action: checkIndexing(),
        });
        return;
      case 'failed':
        notices.show({
          id: indexingNotice,
          severity: 'error',
          message: 'Indexing failed',
          action: checkIndexing(),
        });
        return;
    }
  }

  /** Status retry of the indexing notice; it checks progress and repeats no original write. */
  function checkIndexing(): UiNotice['action'] {
    return {
      label: 'Check indexing status',
      run: () => {
        indexing?.recheck();
      },
    };
  }

  /** Device access lasts through synchronous teardown, but never into a replacement page. */
  function pageDevice(currentGeneration: number): CaptureBrowserDevice {
    const available = (): boolean =>
      (!disposed && generation === currentGeneration) ||
      (teardownGeneration === currentGeneration && generation === currentGeneration + 1);
    const page: CaptureBrowserDevice = {
      release() {
        if (available()) {
          return device.release();
        }
      },
    };
    const open = device.openCamera;
    if (typeof open === 'function') {
      page.openCamera = () => {
        if (!available()) {
          // A closed page cannot open the device of the view that replaced it.
          return Promise.reject(new Error('This page no longer holds the device.'));
        }
        return open.call(device);
      };
    }
    return page;
  }

  function signedOutHeading(): HTMLHeadingElement {
    return plainHeading('Sign in');
  }

  function signedOutContent(): readonly Node[] {
    const hint = document.createElement('p');
    hint.textContent = 'Sign in to use the collection.';
    const signIn = document.createElement('button');
    signIn.type = 'button';
    signIn.textContent = 'Sign in';
    signIn.addEventListener('click', () => {
      requestSignIn();
    });
    return [hint, signIn];
  }

  function unknownRouteContent(): readonly Node[] {
    const hint = document.createElement('p');
    hint.textContent = 'This address does not name a page of the collection.';
    const home = document.createElement('a');
    home.href = uiHref({ page: 'home' });
    home.textContent = 'Go to Home';
    return [hint, home];
  }

  function plainHeading(text: string): HTMLHeadingElement {
    const heading = document.createElement('h1');
    heading.tabIndex = -1;
    heading.textContent = text;
    return heading;
  }

  function renderAccountLabel(): void {
    accountLabel.textContent = account === null ? '' : (account.displayName ?? 'Signed in');
  }

  function updateNavigation(page: UiPageName | null): void {
    const current = page === 'tag' ? 'tags' : page;
    for (const [name, anchor] of navLinks) {
      if (name === current) {
        anchor.setAttribute('aria-current', 'page');
      } else {
        anchor.removeAttribute('aria-current');
      }
    }
  }

  /**
   * Keeps the state of the presented view in the history entry the user is leaving, under the token
   * that entry carries — with the page's own state when it keeps one and the shell-owned scroll and
   * focus otherwise. A browser-driven traversal reaches the shell only after the destination entry
   * is current, so the departing entry's token, never the destination's, receives the snapshot.
   * An entry that still keeps the context it is restoring saves that context again beside the
   * page's own state, which the page reads live, instead of capturing the partial view and the
   * heading the shell focused while it was empty.
   */
  function rememberCurrent(): void {
    const current = account;
    if (current === null || view === null || lastToken === null) {
      return;
    }
    const release = releaseRetained(pageDefinition);
    const keeping = restoringEntry ? restoringSnapshot : null;
    if (keeping !== null) {
      store.save(
        current.accountId,
        lastToken,
        {
          state: capturePageState(keeping.state),
          scrollY: keeping.scrollY,
          ...(keeping.anchorId == null
            ? {}
            : { anchorId: keeping.anchorId, anchorTop: keeping.anchorTop }),
          focusId: keeping.focusId,
        },
        release,
      );
      return;
    }
    store.save(
      current.accountId,
      lastToken,
      {
        state: capturePageState(null),
        scrollY: browser.scrollY,
        ...captureAnchor(),
        focusId: document.activeElement?.id ?? null,
      },
      release,
    );
  }

  /**
   * Release callback of the factory that owns the retained handles of the page presented now. The
   * store invokes it when an entry is replaced, evicted or discarded, so the factory reclaims what
   * it retained for a history entry whose page instance is gone
   * (docs/ui/navigation.md#interface, docs/ui/architecture.md#state-ownership-and-restoration).
   */
  function releaseRetained(definition: UiPageDefinition | null): UiRetainedRelease {
    return (retained) => {
      definition?.release?.(retained);
    };
  }

  /**
   * State the presented page retains now. The page owns the value its `capture` hook returns: an
   * explicit null keeps no page state, so only a page without the hook falls back to the retained
   * context the entry is still restoring.
   */
  function capturePageState(fallback: unknown): unknown {
    const handle = pageHandle;
    if (handle === null || handle.capture === undefined) {
      return fallback;
    }
    return handle.capture();
  }

  /** One visible stable element; no result data or unbounded DOM snapshot is retained. */
  function captureAnchor(): Pick<UiViewSnapshot, 'anchorId' | 'anchorTop'> {
    let closest: HTMLElement | null = null;
    let top = Number.POSITIVE_INFINITY;
    for (const element of main.querySelectorAll<HTMLElement>('[id]')) {
      const rect = element.getBoundingClientRect();
      if (
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.top < browser.innerHeight &&
        Math.abs(rect.top) < Math.abs(top)
      ) {
        closest = element;
        top = rect.top;
      }
    }
    return closest === null ? {} : { anchorId: closest.id, anchorTop: top };
  }

  /** Closes the presented page: its work is cancelled and its container is left behind. */
  function closePage(): void {
    teardownGeneration = generation;
    generation += 1;
    // Failures remain visible, but recovery belongs to the mounted view that supplied it.
    notices.retireActions(pageActionNotices);
    pageActionNotices.clear();
    releaseRestoration();
    const controller = pageController;
    const handle = pageHandle;
    pageController = null;
    pageHandle = null;
    // The saved release callbacks keep their owning factory; only the mounted lifetime ends here.
    pageDefinition = null;
    try {
      // Navigation and dialogs are already invalidated, but device cleanup is still permitted.
      // A nested transition advances generation again, ending this page's device ownership too.
      controller?.abort();
      handle?.dispose?.();
    } finally {
      teardownGeneration = null;
      dialogs.closeAll();
    }
  }

  function releaseDevice(): void {
    try {
      void Promise.resolve(device.release()).catch(() => {
        // Shell-owned cleanup is best effort, including asynchronous provider failures.
      });
    } catch {
      // Releasing device resources is best effort; it never blocks sign-out or disposal.
    }
  }

  function onBrowserNavigation(): void {
    if (disposed) {
      return;
    }
    if (browser.location.href === lastHref && readToken(history.state) === lastToken) {
      return;
    }
    rememberCurrent();
    render();
  }

  function onClick(event: Event): void {
    const click = event as MouseEvent;
    if (disposed || click.defaultPrevented || click.button !== 0) {
      return;
    }
    if (click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) {
      return;
    }
    const anchor = (click.target as Element | null)?.closest?.('a[href]') ?? null;
    if (anchor === null || anchor.hasAttribute('download') || anchor.hasAttribute('target')) {
      return;
    }
    const href = anchor.getAttribute('href');
    if (href === null || !href.startsWith(UI_ROUTE_PREFIX)) {
      return;
    }
    const target = readUiView(href);
    if (target === null) {
      return;
    }
    click.preventDefault();
    navigate(target);
  }
}

function readRoot(value: unknown): Element {
  const root = value as Element | null | undefined;
  if (
    typeof root !== 'object' ||
    root === null ||
    typeof root.ownerDocument !== 'object' ||
    root.ownerDocument === null
  ) {
    throw new TypeError('The UserInterface renders into one supplied element.');
  }
  return root;
}

function readCapabilities(value: unknown): UserInterfaceCapabilities {
  const record = readObject(value);
  const request = record?.request;
  const userCards = readObject(record?.userCards);
  const capture = readObject(record?.capture);
  if (
    record === null ||
    typeof capture?.create !== 'function' ||
    readObject(record.settings) === null ||
    typeof readObject(record.catalog)?.resolve !== 'function' ||
    typeof readObject(record.search)?.execute !== 'function' ||
    typeof userCards?.account !== 'function' ||
    typeof record.indexing !== 'function' ||
    typeof request !== 'function' ||
    typeof (request as { endSession?: unknown }).endSession !== 'function'
  ) {
    throw new TypeError('The UserInterface requires the capabilities Application supplies.');
  }
  return value as UserInterfaceCapabilities;
}

function readIdentity(value: unknown): UiIdentity {
  const record = readObject(value);
  if (
    record === null ||
    typeof record.current !== 'function' ||
    typeof record.signIn !== 'function' ||
    typeof record.signOut !== 'function' ||
    typeof record.subscribe !== 'function'
  ) {
    throw new TypeError('The UserInterface requires the identity capability.');
  }
  return value as UiIdentity;
}

function readDevice(value: unknown): CaptureBrowserDevice {
  if (value === undefined) {
    return { release() {} };
  }
  const record = readObject(value);
  if (record === null || typeof record.release !== 'function') {
    throw new TypeError('The device capability releases the resources the UI holds.');
  }
  if (record.openCamera !== undefined && typeof record.openCamera !== 'function') {
    throw new TypeError('The device capability opens the camera the capture view reads.');
  }
  return value as CaptureBrowserDevice;
}

/** Page implementations of one shell and the definitions the shell has resolved so far. */
interface UiPages extends UiPageRegistry {
  /**
   * Resolved implementations by page. A list registers every implementation it carries; a lazy
   * registry only the ones a presented route resolved, which are the ones that can hold state.
   */
  readonly loaded: Map<UiPageName, UiPageDefinition>;
}

function readPages(value: unknown): UiPages {
  if (value === undefined) {
    return { load: () => null, loaded: new Map() };
  }
  if (Array.isArray(value)) {
    // A list of implementations is the eager registry UI composition usually supplies.
    const loaded = new Map<UiPageName, UiPageDefinition>();
    for (const entry of value) {
      const definition = readDefinition(entry);
      loaded.set(definition.page, definition);
    }
    return { load: (page) => loaded.get(page) ?? null, loaded };
  }
  const registry = readObject(value);
  if (registry === null || typeof registry.load !== 'function') {
    throw new TypeError('Page implementations are supplied as a list or a page registry.');
  }
  const load = registry.load as UiPageRegistry['load'];
  return {
    load: (page) => {
      const result = load.call(registry, page);
      return isThenable(result)
        ? Promise.resolve(result).then((definition) =>
            definition === null || definition === undefined ? null : readDefinition(definition),
          )
        : result === null || result === undefined
          ? null
          : readDefinition(result);
    },
    loaded: new Map(),
  };
}

/** One registered page implementation; a value outside the contract is rejected. */
function readDefinition(value: unknown): UiPageDefinition {
  const definition = readObject(value);
  const name = definition?.page;
  if (
    definition === null ||
    typeof definition.mount !== 'function' ||
    !uiPageNames.includes(name as UiPageName)
  ) {
    throw new TypeError('A page implementation names one dedicated page and mounts it.');
  }
  return value as UiPageDefinition;
}

/** Whether one page-registry result is a factory still loading. */
function isThenable(value: unknown): value is Promise<UiPageDefinition | null> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function readModules(value: unknown): UiPresentationModules {
  const record = readObject(value);
  if (
    record === null ||
    readObject(record.cardViews) === null ||
    readObject(record.editors) === null ||
    typeof record.captureControls !== 'function'
  ) {
    throw new TypeError(
      'The UI composition supplies the CardViews, Editors and CaptureControls modules of its pages.',
    );
  }
  return value as UiPresentationModules;
}

function readObject(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Readonly<Record<string, unknown>>;
}

function readState(history: History): Record<string, unknown> {
  const value = history.state;
  return readObject(value) === null ? {} : { ...(value as Record<string, unknown>) };
}

function readToken(value: unknown): string | null {
  const record = readObject(value);
  const token = record?.uiView;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

function readMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}
