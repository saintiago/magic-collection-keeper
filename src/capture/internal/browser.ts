/**
 * Browser composition of the Capture component (docs/application.md#interface,
 * docs/capture.md#interface).
 *
 * Application selects this composition and hands the UserInterface its capability: the factory
 * that creates one session over a deployment-supplied device, bound to one account and one pending
 * import. The factory supplies Recognition and UserCards' account-scoped staging, so pages present
 * capture without naming the component's wiring or constructing its providers.
 */

import type { Recognition, RecognitionEngineName } from '../../recognition/index.js';
import type { UserCardsOperations } from '../../usercards/browser.js';

import type {
  Capture,
  CaptureBrowserDevice,
  CaptureReviewChange,
  CaptureTimers,
} from './contract.js';
import { createCaptureIdentity } from './identity.js';
import { createCapture } from './session.js';
import { captureStaging } from './staging.js';

/** One session request: the binding Capture owns for its lifetime and the deployment's device. */
export interface CaptureSessionRequest {
  /** Verified account the session stages for. */
  readonly accountId: string;
  /** Pending import every new observation of the session stages under. */
  readonly importId: string;
  /** Device capability of this deployment. */
  readonly device: CaptureBrowserDevice;
  /** Reports that the pending review changed, so the page presents what the provider holds. */
  readonly reviewed?: (change: CaptureReviewChange) => void;
}

/**
 * The Capture capability Application supplies the UserInterface: one composed import identity and
 * the factory of the sessions that bind it.
 */
export interface CaptureBrowser {
  /** Composes one pending-import identity a session can bind and the review can present. */
  createImportId(): string;
  /** Creates one session bound to one account and import identity over the supplied device. */
  create(request: CaptureSessionRequest): Capture;
}

export interface CaptureBrowserOptions {
  /** UserCards' browser operation facade the sessions stage through. */
  readonly userCards: UserCardsOperations;
  /** Builds the Recognition contract over the deployment's preserved engines. */
  readonly createRecognition: () => Recognition<HTMLCanvasElement>;
  /** Engine names the deployment's pipeline prepares, from `recognitionEngineNames`. */
  readonly engines: readonly RecognitionEngineName[];
  /** Identity source of new imports and captures; tests control it. */
  readonly identity?: (family: string) => string;
  /** Clock of the sampling loop; tests control the pacing without the system clock. */
  readonly timers?: CaptureTimers;
}

/** Composes the Capture capability of one browser deployment over its provider contracts. */
export function createCaptureBrowser(options: CaptureBrowserOptions): CaptureBrowser {
  if (typeof options?.userCards?.account !== 'function') {
    throw new TypeError('createCaptureBrowser requires the UserCards browser operations.');
  }
  const identity = options.identity ?? createCaptureIdentity;
  return {
    createImportId: () => identity('capture-import'),
    create(request) {
      return createCapture({
        accountId: request.accountId,
        importId: request.importId,
        device: request.device,
        createRecognition: options.createRecognition,
        engines: options.engines,
        // One session stages through the account-scoped facade, so its reads and retained attempts
        // never cross into another presented account (docs/architecture.md#runtime-boundaries).
        staging: captureStaging(options.userCards.account(request.accountId)),
        identity: () => identity('capture'),
        ...(options.timers === undefined ? {} : { timers: options.timers }),
        ...(request.reviewed === undefined ? {} : { reviewed: request.reviewed }),
      });
    },
  };
}
