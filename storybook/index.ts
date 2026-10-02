/** Local design workspace entry point (docs/ui/storybook.md). */

import type { AuthenticatedRequest, UserInterfaceCapabilities } from '../src/application/index.js';
import type {
  Capture,
  CaptureBrowser,
  CaptureBrowserDevice,
  CaptureSnapshot,
} from '../src/capture/index.js';
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
const cardList = providers.cardList;
const identity = fixedIdentity();
const request = localRequest();
const capture: CaptureBrowser = {
  createImportId: () => 'local-capture-import',
  create: ({ accountId, importId, reviewed }) => inspectableCapture(accountId, importId, reviewed),
  endAccount: () => undefined,
};
const device: CaptureBrowserDevice = {
  openCamera: async () => {
    throw new Error('The local capture session supplies its own inspectable states.');
  },
  release: () => undefined,
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
let initialController: AbortController | null = null;

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
startInitialLoad();

function showApp(): void {
  view = 'app';
  updateTabs();
  if (initialLoaded) mountApp();
  else {
    workspace.replaceChildren(loadingMessage());
    startInitialLoad();
  }
}

function showDesign(): void {
  view = 'design';
  updateTabs();
  initialController?.abort();
  initialController = null;
  progression.cancelAll();
  disposeApp();
  mountDesignLanguage(workspace);
}

function mountApp(): void {
  disposeApp();
  const appRoot = document.createElement('div');
  appRoot.className = 'mocked-app';
  workspace.replaceChildren(appRoot);
  application = createUserInterface({ root: appRoot, capabilities, identity, device });
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

function startInitialLoad(): void {
  if (initialLoaded || initialController !== null || view !== 'app') return;
  const controller = new AbortController();
  initialController = controller;
  void progression
    .wait('Loading mocked app', () => undefined, controller.signal)
    .then(
      () => {
        if (initialController !== controller) return;
        initialController = null;
        initialLoaded = true;
        if (view === 'app') mountApp();
      },
      (cause: unknown) => {
        if (initialController !== controller) return;
        initialController = null;
        if (view !== 'app' || isAbort(cause)) return;
        const message = loadingMessage();
        message.textContent = 'Mocked app loading failed. Press Space to retry.';
        workspace.replaceChildren(message);
        startInitialLoad();
      },
    );
}

/** A device-free session exposes the capture control's idle, starting, running and failed views. */
function inspectableCapture(
  accountId: string,
  importId: string,
  reviewed: Parameters<CaptureBrowser['create']>[0]['reviewed'],
): Capture {
  let snapshot: CaptureSnapshot = {
    status: { kind: 'idle', failure: null },
    preview: null,
    attempt: null,
    events: [],
    recoverable: false,
    busy: false,
    running: false,
  };
  const listeners = new Set<(value: CaptureSnapshot) => void>();
  let disposed = false;
  let startController: AbortController | null = null;
  let eventSequence = 0;
  const report = (): void => {
    for (const listener of listeners) listener(snapshot);
  };
  const start = async (): Promise<void> => {
    if (disposed || snapshot.running || snapshot.status.kind === 'starting') return;
    const controller = new AbortController();
    startController = controller;
    snapshot = { ...snapshot, status: { kind: 'starting', failure: null }, busy: true };
    report();
    try {
      await progression.wait('Starting local camera', () => undefined, controller.signal);
      if (disposed || startController !== controller) return;
      snapshot = {
        ...snapshot,
        status: { kind: 'running', failure: null },
        attempt: {
          captureId: 'local-capture-1',
          attempt: 1,
          reading: {
            captureId: 'local-capture-1',
            attempt: 1,
            revision: 1,
            status: 'possible',
            candidates: [
              {
                cardId: 'lightning-bolt',
                printingId: 'm11-149',
                name: 'Lightning Bolt',
                evidence: 'title-evidence',
              },
            ],
            suggestedPrintingId: 'm11-149',
            presence: 'single',
            provisional: true,
            uncertain: false,
          },
        },
        busy: true,
        running: true,
      };
      report();
      const operation = providers.userCards.account(accountId).stageCaptureObservation(
        {
          sessionId: importId,
          captureId: 'local-capture-1',
          printingId: 'm11-149',
          finish: 'nonfoil',
        },
        controller.signal,
      );
      const outcome = await operation.observe();
      if (disposed || startController !== controller) return;
      startController = null;
      if (outcome.state === 'committed') {
        const entryId = outcome.record.entry?.entryId ?? null;
        const reading = snapshot.attempt?.reading ?? null;
        snapshot = {
          ...snapshot,
          attempt: null,
          busy: false,
          events: [
            ...snapshot.events,
            {
              kind: 'accepted',
              sequence: ++eventSequence,
              captureId: 'local-capture-1',
              attempt: 1,
              cue: 'accepted',
              entryId: entryId ?? 'local-capture-1',
              replayed: outcome.record.replayed,
              reading: reading === null ? null : { ...reading, provisional: false },
            },
          ],
        };
        report();
        reviewed?.({ kind: 'staged', session: outcome.record.session, entryId });
        return;
      }
      snapshot = {
        ...snapshot,
        attempt: null,
        busy: false,
        running: false,
        recoverable: outcome.state === 'unknown',
        events: [
          ...snapshot.events,
          {
            kind: 'unavailable',
            sequence: ++eventSequence,
            captureId: 'local-capture-1',
            attempt: 1,
            cue: 'error',
            reason: 'staging',
            failure: outcome.state === 'rejected' ? outcome.failure.message : null,
            recoverable: outcome.state === 'unknown',
          },
        ],
      };
      report();
    } catch (cause) {
      if (startController === controller) startController = null;
      if (disposed || isAbort(cause)) return;
      snapshot = {
        ...snapshot,
        status: { kind: 'failed', failure: cause instanceof Error ? cause.message : String(cause) },
        busy: false,
        running: false,
      };
      report();
    }
  };
  return {
    accountId,
    importId,
    prepare: async () => undefined,
    start,
    stop: () => {
      startController?.abort();
      startController = null;
      snapshot = {
        ...snapshot,
        status: { kind: 'stopped', failure: null },
        busy: false,
        running: false,
      };
      report();
    },
    retry: async () => {
      if (snapshot.recoverable) {
        snapshot = { ...snapshot, recoverable: false, running: false };
      }
      await start();
    },
    observe(listener) {
      listener(snapshot);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: () => {
      disposed = true;
      startController?.abort();
      startController = null;
      listeners.clear();
    },
  };
}

function isAbort(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === 'AbortError';
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
