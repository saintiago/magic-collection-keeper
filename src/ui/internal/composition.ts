/**
 * UI composition of the UserInterface presentation modules
 * (docs/ui/architecture.md#modules-and-composition).
 *
 * The composition root constructs the replaceable presentation modules once and hands them to the
 * pages it registers with Navigation. Pages compose CardViews, Editors and CaptureControls through
 * the interfaces they receive; only this module names a concrete default implementation, so a
 * module can be replaced by changing its construction alone. Pages and renderers never select
 * concrete implementations, transports or persistence.
 */

import { createCardViews, type CardViews } from '../card-views/index.js';
import {
  createCaptureControls,
  type UiCaptureControls,
  type UiCaptureOptions,
} from '../capture-controls/index.js';
import { createEditors, type Editors } from '../editors/index.js';

/** CaptureControls factory the pages receive; one view owns one mounted Capture session. */
export type CaptureControlsFactory = (options: UiCaptureOptions) => UiCaptureControls;

/** The presentation modules the UI composition supplies to its pages. */
export interface UiPresentationModules {
  readonly cardViews: CardViews;
  readonly editors: Editors;
  /** CaptureControls module: the view a page mounts for one import identity. */
  readonly captureControls: CaptureControlsFactory;
}

/** Constructs the default modules of the browser application. */
export function createUiPresentationModules(): UiPresentationModules {
  const cardViews = createCardViews();
  return {
    cardViews,
    editors: createEditors({ cardViews }),
    captureControls: createCaptureControls,
  };
}
