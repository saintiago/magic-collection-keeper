/** Local design workspace entry point (docs/ui/storybook.md). */

import type { AuthenticatedRequest, UserInterfaceCapabilities } from '../src/application/index.js';
import type { Capture, CaptureBrowser, CaptureSnapshot } from '../src/capture/index.js';
import { createCardListBrowser } from '../src/card-list/index.js';
import {
  createUserInterface,
  type UiAccount,
  type UiIdentity,
  type UserInterface,
} from '../src/ui/index.js';
import { mountDesignLanguage } from './design-language.js';
import { createLocalProviders } from './fixtures.js';
import { ManualProgression, type StorybookStage } from './progression.js';

export interface StorybookControl {
  readonly stage: StorybookStage | null;
  readonly view: 'app' | 'design';
  advance(): boolean;
  showApp(): void;
  showDesign(): void;
  failNext(value: boolean): void;
}

declare global {
  var keeperStorybook: StorybookControl | undefined;
}

const root = document.getElementById('storybook-root');
if (!(root instanceof HTMLElement)) throw new Error('The storybook root is missing.');

const progression = new ManualProgression();
const providers = createLocalProviders(progression);
const cardList = createCardListBrowser(providers);
const identity = fixedIdentity();
const request = localRequest();
const capture: CaptureBrowser = {
  createImportId: () => 'local-capture-import',
  create: ({ accountId, importId }) => unavailableCapture(accountId, importId),
  endAccount: () => undefined,
};
const capabilities: UserInterfaceCapabilities = {
  settings: {
    environment: 'development',
    apiBaseUrl: 'http://127.0.0.1.invalid',
    authentication: { region: 'local', appClientId: 'local-storybook' },
    recognition: { cloudEnabled: false, computeBaseUrl: null },
    capabilities: { sourceImports: false },
  },
  identity,
  request,
  catalog: providers.catalog,
  userCards: providers.userCards,
  cardList,
  capture,
};

const header = document.createElement('header');
const title = document.createElement('h1');
title.textContent = 'Local design storybook';
const appButton = tabButton('Mocked app');
const designButton = tabButton('Design language');
const failure = document.createElement('label');
const failureToggle = document.createElement('input');
failureToggle.type = 'checkbox';
failureToggle.id = 'fail-next-stage';
failure.append(failureToggle, ' Fail next completion');
const advance = document.createElement('button');
advance.type = 'button';
advance.id = 'advance-stage';
advance.textContent = 'Advance one stage (Space)';
const stageStatus = document.createElement('p');
stageStatus.id = 'stage-status';
stageStatus.setAttribute('role', 'status');
stageStatus.setAttribute('aria-live', 'polite');
header.append(title, appButton, designButton, failure, advance, stageStatus);
const workspace = document.createElement('div');
workspace.id = 'workspace';
root.replaceChildren(header, workspace);

let view: 'app' | 'design' = 'app';
let application: UserInterface | null = null;
let initialLoaded = false;

appButton.addEventListener('click', showApp);
designButton.addEventListener('click', showDesign);
failureToggle.addEventListener('change', () => {
  progression.failNext = failureToggle.checked;
});
advance.addEventListener('click', () => progression.advance());
progression.subscribe((stage) => {
  failureToggle.checked = progression.failNext;
  advance.disabled = stage === null;
  stageStatus.textContent =
    stage === null ? 'No stage is waiting.' : `Waiting: ${stage.label}. Press Space to continue.`;
});
progression.installKeyboard(window);
workspace.addEventListener(
  'click',
  (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest('.mocked-app a') !== null) {
      progression.cancelAll();
    }
  },
  { capture: true },
);

globalThis.keeperStorybook = {
  get stage() {
    return progression.current;
  },
  get view() {
    return view;
  },
  advance: () => progression.advance(),
  showApp,
  showDesign,
  failNext: (value) => {
    progression.failNext = value;
  },
};

updateTabs();
workspace.replaceChildren(loadingMessage());
void progression.wait('Loading mocked app', () => {
  initialLoaded = true;
  if (view === 'app') mountApp();
});

function showApp(): void {
  view = 'app';
  updateTabs();
  if (initialLoaded) mountApp();
  else workspace.replaceChildren(loadingMessage());
}

function showDesign(): void {
  view = 'design';
  updateTabs();
  progression.cancelAll();
  disposeApp();
  mountDesignLanguage(workspace);
}

function mountApp(): void {
  disposeApp();
  const appRoot = document.createElement('div');
  appRoot.className = 'mocked-app';
  workspace.replaceChildren(appRoot);
  application = createUserInterface({ root: appRoot, capabilities, identity });
}

function disposeApp(): void {
  application?.dispose();
  application = null;
}

function updateTabs(): void {
  appButton.setAttribute('aria-pressed', String(view === 'app'));
  designButton.setAttribute('aria-pressed', String(view === 'design'));
}

function tabButton(label: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  return button;
}

function loadingMessage(): HTMLParagraphElement {
  const message = document.createElement('p');
  message.id = 'initial-loading';
  message.setAttribute('role', 'status');
  message.setAttribute('aria-busy', 'true');
  message.textContent = 'Loading mocked app';
  return message;
}

/** A stable device-free session lets the current Import page present its unavailable state. */
function unavailableCapture(accountId: string, importId: string): Capture {
  const snapshot: CaptureSnapshot = {
    status: { kind: 'unavailable', failure: null },
    preview: null,
    attempt: null,
    events: [],
    recoverable: false,
    busy: false,
    running: false,
  };
  return {
    accountId,
    importId,
    prepare: async () => undefined,
    start: async () => undefined,
    stop: () => undefined,
    retry: async () => undefined,
    observe(listener) {
      listener(snapshot);
      return () => undefined;
    },
    dispose: () => undefined,
  };
}

function fixedIdentity(): UiIdentity {
  const account: UiAccount = { accountId: 'local-owner', displayName: 'Local Owner' };
  return {
    current: () => account,
    signIn: () => undefined,
    signOut: () => undefined,
    subscribe: () => () => undefined,
  };
}

function localRequest(): AuthenticatedRequest {
  return Object.assign(
    async () => {
      throw new Error('The local storybook has no remote transport.');
    },
    { endSession: () => undefined },
  );
}
