/**
 * Capture public entry point (docs/capture.md, docs/architecture.md#components).
 *
 * The component owns one live camera session: device acquisition, frame scheduling, admission of
 * affirmative single-card evidence, coordination of staging through UserCards and the identified
 * feedback of every attempt. A consumer constructs one session bound to an account and a pending
 * import, observes immutable snapshots and forwards start, stop and retry; the component runs in
 * the browser without a rendering dependency, and a supplied device and frames run it without a
 * camera.
 *
 * Bindings live in this component: the browser device presents the granted stream and reads
 * bounded frames, the Recognition contract supplies preparation and readings, and the UserCards
 * binding translates the account's private staging handles. Providers never import these types.
 * UserInterface consumes the component through this module only; its internal modules stay private
 * to the component (docs/architecture.md, .dependency-cruiser.mjs).
 */

export { CAPTURE_LIMITS } from './internal/limits.js';
export {
  captureAttemptOutcomes,
  createCaptureAdmission,
  frameDifference,
  type CaptureAdmission,
  type CaptureAttemptOutcome,
} from './internal/scheduler.js';
export { captureCandidates, captureObservation, captureReading } from './internal/reading.js';
export { captureStaging } from './internal/staging.js';
export { createCapture } from './internal/session.js';
export {
  createBrowserCaptureDevice,
  type BrowserCaptureDeviceOptions,
  type BrowserMediaDevices,
  type CaptureVideoSurface,
} from './internal/browser-device.js';
export {
  createCaptureBrowser,
  type CaptureBrowser,
  type CaptureBrowserOptions,
  type CaptureSessionRequest,
} from './internal/browser.js';
export {
  captureCues,
  captureEventKinds,
  captureStatuses,
  type Capture,
  type CaptureAcceptedEvent,
  type CaptureAttempt,
  type CaptureBrowserDevice,
  type CaptureCamera,
  type CaptureCandidate,
  type CaptureComparisonEvent,
  type CaptureCue,
  type CaptureDevice,
  type CaptureEvent,
  type CaptureEventKind,
  type CaptureGuidanceEvent,
  type CaptureOperationOutcome,
  type CaptureOptions,
  type CapturePreview,
  type CaptureReading,
  type CaptureRepeatEvent,
  type CaptureRetainedObservation,
  type CaptureRetainedOperation,
  type CaptureReviewChange,
  type CaptureSnapshot,
  type CaptureStaging,
  type CaptureStagingOperation,
  type CaptureStatus,
  type CaptureStatusKind,
  type CaptureTimers,
  type CaptureUnavailableEvent,
  type CaptureUnresolvedEvent,
} from './internal/contract.js';
