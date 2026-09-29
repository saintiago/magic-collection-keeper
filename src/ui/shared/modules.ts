/**
 * Presentation modules UI composition supplies to the pages of the UserInterface
 * (docs/ui/architecture.md#modules-and-composition).
 *
 * Pages compose the CardViews, Editors and CaptureControls implementations they receive; only the
 * UI composition root names a concrete module, so a module can be replaced by changing its
 * construction alone. This contract belongs to the composition of the component rather than to
 * one module: Navigation hands the same references to every page it mounts, and a page uses the
 * part it composes.
 */

import type { CardViews } from '../card-views/index.js';
import type { UiCaptureControls, UiCaptureOptions } from '../capture-controls/index.js';
import type { Editors } from '../editors/index.js';

/** CaptureControls factory the pages receive; one view owns one mounted Capture session. */
export type CaptureControlsFactory = (options: UiCaptureOptions) => UiCaptureControls;

/** The presentation modules the UI composition supplies to its pages. */
export interface UiPresentationModules {
  readonly cardViews: CardViews;
  readonly editors: Editors;
  /** CaptureControls module: the view a page mounts for one import identity. */
  readonly captureControls: CaptureControlsFactory;
}
