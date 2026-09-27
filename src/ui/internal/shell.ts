/**
 * The UserInterface shell (docs/user-interface.md#interface,
 * docs/user-interface.md#pages-and-navigation).
 *
 * The shell renders the frame, presents the dedicated page of the current URL and owns identity,
 * history navigation and the bounded, account-isolated presentation state. Navigation keeps the
 * state of the view it leaves for the way back, closing a view aborts its work and detaches its
 * container so a late result cannot change the new view, and a changed account clears private
 * presentation state and ends the authenticated session the transport serves.
 */

import type { UserInterfaceCapabilities } from '../../application/index.js';

import { createDialogs, type UiDialogs } from './dialogs.js';
import type { UiDevice } from './device.js';
import { readAccount, type UiAccount, type UiIdentity } from './identity.js';
import type { UiPageContext, UiPageDefinition, UiPageHandle } from './pages.js';
import { createViewStateStore, type UiViewSnapshot } from './restoration.js';
import {
  readUiView,
  uiHref,
  uiPageNames,
  uiViewTitle,
  UI_ROUTE_PREFIX,
  type UiPageName,
  type UiView,
} from './routes.js';

export interface UserInterfaceOptions {
  /** Element the shell renders the application frame and its pages into. */
  readonly root: Element;
  /** Public configuration, authenticated transport and component access from Application. */
  readonly capabilities: UserInterfaceCapabilities;
  /** Verified identity and its transitions. */
  readonly identity: UiIdentity;
  /** Device capability of this deployment; absent when the UI holds no device resources. */
  readonly device?: UiDevice;
  /** Page implementations; a page without one presents the shell frame alone. */
  readonly pages?: readonly UiPageDefinition[];
}

export interface UserInterface {
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
  /** Releases listeners, page work and device resources. */
  dispose(): void;
}

/** Dedicated pages the primary navigation reaches; tag and card views are reached from them. */
const primaryLinks: readonly { readonly view: UiView; readonly label: string }[] = [
  { view: { page: 'home' }, label: 'Home' },
  {
    view: { page: 'catalog', query: '', level: 'card', owned: false, finish: null },
    label: 'Catalog',
  },
  { view: { page: 'collection' }, label: 'Collection' },
  { view: { page: 'tags' }, label: 'Tags' },
  { view: { page: 'import' }, label: 'Import' },
];

export function createUserInterface(options: UserInterfaceOptions): UserInterface {
  const root = readRoot(options?.root);
  const capabilities = readCapabilities(options?.capabilities);
  const identity = readIdentity(options?.identity);
  const device = readDevice(options?.device);
  const pages = readPages(options?.pages);
  const document = root.ownerDocument;
  const candidates = document.defaultView;
  if (candidates === null) {
    throw new TypeError('The UserInterface requires a document with a browsing context.');
  }
  const browser: Window = candidates;
  const history = browser.history;
  const previousScrollRestoration = history.scrollRestoration;
  // The shell owns restoration (docs/user-interface.md#pages-and-navigation): the browser's own
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
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  root.replaceChildren(header, main, status);

  let account: UiAccount | null = null;
  let view: UiView | null = null;
  let pageController: AbortController | null = null;
  let pageHandle: UiPageHandle | null = null;
  let generation = 0;
  let teardownGeneration: number | null = null;
  let disposed = false;
  let signOutPending = false;
  let lastHref = '';
  let lastToken: string | null = null;

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
    rememberCurrent();
    history.replaceState({ ...readState(history), uiView: store.open() }, '', uiHref(target));
    render();
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
    closePage();
    browser.removeEventListener('popstate', onBrowserNavigation);
    browser.removeEventListener('hashchange', onBrowserNavigation);
    root.removeEventListener('click', onClick);
    unsubscribe();
    store.clear();
    releaseDevice();
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
    closePage();
    store.clear();
    if (previous !== null) {
      capabilities.request.endSession();
      releaseDevice();
    }
    render();
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
    signOutPending = true;
    signOutButton.disabled = true;
    main.hidden = true;
    status.textContent = 'Signing out…';
    void finishSignOut();
  }

  async function finishSignOut(): Promise<void> {
    let message: string | null = null;
    try {
      await identity.signOut();
    } catch (cause) {
      message = readMessage(cause, 'Sign-out failed. Please retry.');
    }
    if (disposed) {
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
    status.textContent = message ?? '';
  }

  function requestSignIn(): void {
    if (disposed) {
      return;
    }
    void runIdentity(() => identity.signIn(), 'Sign-in failed. Please retry.');
  }

  async function runIdentity(start: () => void | Promise<void>, fallback: string): Promise<void> {
    status.textContent = '';
    try {
      await start();
    } catch (cause) {
      status.textContent = readMessage(cause, fallback);
      return;
    }
    if (!disposed) {
      applyAccount(readAccount(identity.current()));
    }
  }

  /** Presents the signed-in view of the current URL, the sign-in prompt or the unknown route. */
  function render(): void {
    closePage();
    const current = account;
    status.textContent = '';
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
    const controller = new AbortController();
    pageController = controller;
    const context: UiPageContext = {
      view: target,
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
    };
    const handle = pages.get(target.page)?.mount(container, context) ?? null;
    if (generation !== currentGeneration) {
      // The page presented another view while mounting; that view owns the shell's handle now.
      handle?.dispose?.();
      return;
    }
    pageHandle = handle;
    restoreInteraction(heading, restored);
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
    (focus ?? heading).focus({ preventScroll: true });
    browser.scrollTo(0, restored.scrollY);
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

  /** Device access lasts through synchronous teardown, but never into a replacement page. */
  function pageDevice(currentGeneration: number): UiDevice {
    return {
      release() {
        const active = !disposed && generation === currentGeneration;
        const tearingDown =
          teardownGeneration === currentGeneration && generation === currentGeneration + 1;
        if (active || tearingDown) {
          return device.release();
        }
      },
    };
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
   */
  function rememberCurrent(): void {
    const current = account;
    if (current === null || view === null || lastToken === null) {
      return;
    }
    store.save(current.accountId, lastToken, {
      state: pageHandle?.capture?.() ?? null,
      scrollY: browser.scrollY,
      focusId: document.activeElement?.id ?? null,
    });
  }

  /** Closes the presented page: its work is cancelled and its container is left behind. */
  function closePage(): void {
    teardownGeneration = generation;
    generation += 1;
    const controller = pageController;
    const handle = pageHandle;
    pageController = null;
    pageHandle = null;
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
  if (
    record === null ||
    typeof record.createRecognition !== 'function' ||
    readObject(record.settings) === null ||
    typeof readObject(record.catalog)?.resolve !== 'function' ||
    typeof readObject(record.search)?.execute !== 'function' ||
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

function readDevice(value: unknown): UiDevice {
  if (value === undefined) {
    return { release() {} };
  }
  const record = readObject(value);
  if (record === null || typeof record.release !== 'function') {
    throw new TypeError('The device capability releases the resources the UI holds.');
  }
  return value as UiDevice;
}

function readPages(value: unknown): ReadonlyMap<UiPageName, UiPageDefinition> {
  const pages = new Map<UiPageName, UiPageDefinition>();
  if (value === undefined) {
    return pages;
  }
  if (!Array.isArray(value)) {
    throw new TypeError('Page implementations are supplied as a list.');
  }
  for (const entry of value) {
    const definition = readObject(entry);
    const name = definition?.page;
    if (
      definition === null ||
      typeof definition.mount !== 'function' ||
      !uiPageNames.includes(name as UiPageName)
    ) {
      throw new TypeError('A page implementation names one dedicated page and mounts it.');
    }
    pages.set(name as UiPageName, entry as UiPageDefinition);
  }
  return pages;
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
