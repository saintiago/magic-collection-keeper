/**
 * UI composition root of the UserInterface (docs/ui/architecture.md#modules-and-composition).
 *
 * The composition root constructs the replaceable presentation modules once, composes the page
 * implementations of this build and mounts them through the Navigation module, which owns the
 * shell, the routes, the mounted page lifetime, the opaque history retention and the floating
 * notices. Only this module names a concrete module factory: pages compose the CardViews, Editors
 * and CaptureControls they receive, and renderers never select concrete implementations,
 * transports or persistence. A deployment can replace one module or one page implementation
 * through the options without touching the modules around it.
 */

import type { UserInterfaceCapabilities } from '../../application/index.js';
import type { CaptureBrowserDevice } from '../../capture/index.js';

import { createCardViews } from '../card-views/index.js';
import { createCaptureControls } from '../capture-controls/index.js';
import { createEditors } from '../editors/index.js';
import {
  createNavigation,
  type Navigation,
  type UiIdentity,
  type UiPageDefinition,
  type UiPageRegistry,
} from '../navigation/index.js';
import { createPages } from '../pages/index.js';
import type { UiPresentationModules } from '../shared/modules.js';

export type { CaptureControlsFactory, UiPresentationModules } from '../shared/modules.js';

/** What one deployment supplies to construct the presented UserInterface. */
export interface UserInterfaceOptions {
  /** Element the shell renders the application frame and its pages into. */
  readonly root: Element;
  /** Public configuration, authenticated transport and component access from Application. */
  readonly capabilities: UserInterfaceCapabilities;
  /** Verified identity and its transitions. */
  readonly identity: UiIdentity;
  /** Device capability of this deployment; absent when the UI holds no device resources. */
  readonly device?: CaptureBrowserDevice;
  /**
   * Page implementations of this build, or the registry loading them; the defaults compose Home,
   * catalog, collection, tags, card details and import.
   */
  readonly pages?: readonly UiPageDefinition[] | UiPageRegistry;
  /**
   * Presentation modules of this build; the defaults compose the CardViews, Editors and
   * CaptureControls implementations of the browser application.
   */
  readonly modules?: UiPresentationModules;
}

/** The presented UserInterface: Navigation's shell over the pages of this composition. */
export type UserInterface = Navigation;

/** Constructs the default presentation modules of the browser application. */
export function createUiPresentationModules(): UiPresentationModules {
  const cardViews = createCardViews();
  return {
    cardViews,
    editors: createEditors({ cardViews }),
    captureControls: createCaptureControls,
  };
}

/**
 * Composes the UserInterface of one deployment: the presentation modules, the page implementations
 * and the shell that presents them.
 */
export function createUserInterface(options: UserInterfaceOptions): UserInterface {
  const supplied = options ?? ({} as UserInterfaceOptions);
  return createNavigation({
    root: supplied.root,
    capabilities: supplied.capabilities,
    identity: supplied.identity,
    ...(supplied.device === undefined ? {} : { device: supplied.device }),
    pages: supplied.pages ?? createPages(),
    modules: supplied.modules ?? createUiPresentationModules(),
  });
}
