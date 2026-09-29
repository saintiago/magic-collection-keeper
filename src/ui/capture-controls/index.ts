/**
 * CaptureControls public entry point (docs/ui/capture-controls.md,
 * docs/ui/architecture.md#modules-and-composition).
 *
 * CaptureControls presents the preview, capture controls, progress and feedback of one Capture
 * session and translates user intent without making admission or matching decisions. It receives
 * a Capture public factory and an existing import identity, owns the session instance created for
 * the mounted view, observes its preview capability, status, provisional readings and feedback
 * events, and forwards start, stop and retry. Pages receive this module through UI composition
 * and depend on this entry point only; its internals stay private to the UI component.
 */

export {
  createCaptureControls,
  type UiCaptureControls,
  type UiCaptureOptions,
} from './internal/controls.js';
