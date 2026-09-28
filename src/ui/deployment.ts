/**
 * UserInterface browser deployment entry point
 * (docs/application.md#configuration-and-lifecycle, docs/operations.md#packaging-and-deployment).
 *
 * The packaged browser artifact loads the public settings of its environment and calls
 * {@link createBrowserDeployment}: Application validates the settings, composes the authenticated
 * transport, the Catalog/Search/UserCards clients and the preserved browser recognition engines,
 * and hands the shell the capabilities it needs. The deployment supplies what only it can — the
 * sign-in page it presents, the camera of this device and the page implementations of this build —
 * and receives back one shell that a replacement page implementation or recognition factory could
 * replace without touching transport code.
 *
 * Only public settings cross into the browser; the tokens stay in the browsing session of the
 * Application-owned sign-in, the prompt is this component's presentation, and the backend
 * re-verifies every invocation. This module is the browser composition root: it must never reach a
 * backend entry point or a deployment module (docs/application.md#interface).
 */

import {
  createBrowserApplication,
  resolvePublicSettings,
  type BrowserApplication,
  type BrowserCredentialPrompt,
  type BrowserSessionStore,
  type PublicApplicationSettings,
} from '../application/index.js';
import { createBrowsePages } from './internal/browse.js';
import { createBrowserDevice, type BrowserDeviceOptions } from './internal/browser-device.js';
import { createCollectionPages } from './internal/collection.js';
import type { UiDevice } from './internal/device.js';
import type { UiIdentity } from './internal/identity.js';
import { createImportPages } from './internal/imports.js';
import { createOrganizationPages } from './internal/organization.js';
import { createCredentialPrompt } from './internal/sign-in-page.js';
import { createUserInterface, type UserInterface } from './internal/shell.js';

export interface BrowserDeploymentOptions {
  /** Element the shell renders into; the packaged page supplies `#keeper-root`. */
  readonly root: Element | null;
  /** Public settings as the deployment published them; any private setting is rejected. */
  readonly settings: unknown;
  readonly fetch?: typeof globalThis.fetch;
  /** Session store of the sign-in; defaults to this browsing session. */
  readonly storage?: BrowserSessionStore;
  /** Sign-in interaction; defaults to the sign-in page this deployment renders. */
  readonly prompt?: BrowserCredentialPrompt;
  /** Device capability; defaults to the camera the browsing context grants. */
  readonly device?: UiDevice;
  readonly deviceOptions?: BrowserDeviceOptions;
}

export interface BrowserDeployment {
  readonly settings: PublicApplicationSettings;
  readonly application: BrowserApplication;
  /** Verified-account capability of this deployment, as the shell presents it. */
  readonly identity: UiIdentity;
  readonly userInterface: UserInterface;
  /** Ends the session and releases the page's listeners and device resources. */
  dispose(): void;
}

/**
 * Composes the browser runtime of one deployment: validated public settings, the environment's
 * sign-in, the device the capture view opens and the pages of this build behind one shell.
 */
export function createBrowserDeployment(options: BrowserDeploymentOptions): BrowserDeployment {
  const settings = resolvePublicSettings(options?.settings);
  const root = readRoot(options?.root);
  const device = options?.device ?? createBrowserDevice(options?.deviceOptions ?? {});
  const pages = [
    ...createBrowsePages(),
    ...createCollectionPages(),
    ...createOrganizationPages(),
    ...createImportPages(),
  ];
  let userInterface: UserInterface | null = null;
  const application = createBrowserApplication({
    settings,
    prompt: options?.prompt ?? createCredentialPrompt(root),
    ...(options?.storage === undefined ? {} : { storage: options.storage }),
    ...(options?.fetch === undefined ? {} : { fetch: options.fetch }),
    createUserInterface: (capabilities) => {
      userInterface = createUserInterface({
        root,
        capabilities,
        identity: capabilities.identity,
        device,
        pages,
      });
      return userInterface;
    },
  });
  if (userInterface === null) {
    throw new TypeError('The browser deployment did not present its UserInterface.');
  }
  return {
    settings,
    application,
    identity: application.identity,
    userInterface,
    dispose() {
      userInterface?.dispose();
      device.release();
      application.endSession();
    },
  };
}

function readRoot(root: Element | null | undefined): Element {
  if (root === null || root === undefined || root.ownerDocument === undefined) {
    throw new TypeError('The browser deployment requires the element the shell renders into.');
  }
  return root;
}

export {
  createBrowserDevice,
  createCredentialPrompt,
  type BrowserCredentialPrompt,
  type BrowserDeviceOptions,
  type BrowserSessionStore,
};

export type { BrowserMediaDevices } from './internal/browser-device.js';
