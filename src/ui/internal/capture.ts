/**
 * Camera capture of the Import page (docs/user-interface.md#capture-and-review,
 * docs/recognition.md#interface, docs/user-cards.md#import-and-capture-state).
 *
 * The view owns camera permission, frame acquisition, capture controls and feedback. It opens the
 * camera the deployment grants, presents its live stream and samples frames continuously: a frame
 * that has held still starts one Recognition attempt, and only a reading the runtime reports as
 * holding one card with a usable identity is staged as a pending entry. Ordinary capture stays
 * hands-free after the initial activation — the next card is read from the next settled frame
 * without another control — and the provider's accepted-identity sequence suppresses a repeated
 * observation, so one card never becomes two entries. A success cue means a candidate was accepted
 * into review, never that the card is owned; an unresolved capture receives no success cue, and an
 * attempt never repeats its error cue. Late readings of the same capture are attached as
 * alternatives, leaving the owner's reviewed values untouched. The session releases the camera and
 * the Recognition session when it stops, and the page disposes it when the view closes, so
 * sign-out leaves no private capture state or outstanding work behind.
 */

import {
  RECOGNITION_LIMITS,
  type Recognition,
  type RecognitionEngineName,
  type RecognitionReading,
} from '../../recognition/index.js';
import type {
  CaptureStageResult,
  ImportCandidate,
  ImportSession,
  StageCaptureInput,
} from '../../usercards/index.js';

import {
  createCaptureAdmission,
  UI_CAPTURE,
  type UiCaptureCue,
  type UiCaptureOutcome,
} from './capture-admission.js';
import type { UiCamera, UiDevice } from './device.js';
import { readUiFailureMessage } from './failure.js';
import {
  attachImportCandidates,
  stageCaptureObservation,
  uiCaptureIdentity,
  type UiImportAccess,
} from './import-edits.js';

/** Longest candidate name the capture status presents, so one engine reading stays bounded. */
const uiCaptureNameLength = 120;

/** Evidence labels of one stored alternative; the review presents them beside the printing. */
const captureEvidenceLabels = {
  /** Whole-title corroboration supported this printing. */
  title: 'title-evidence',
  /** The engine ranked this printing without corroborating the observed edition. */
  ranking: 'engine-ranking',
} as const;

export interface UiCaptureOptions {
  readonly document: Document;
  /** Private import operations the capture stages its observations through. */
  readonly access: UiImportAccess;
  /** Device capability of this deployment; one without a camera only reports that. */
  readonly device: UiDevice;
  /** Builds the Recognition contract over the deployment's preserved engines. */
  readonly createRecognition: () => Recognition<HTMLCanvasElement>;
  /** Engine names the deployment's pipeline prepares, from `recognitionEngineNames`. */
  readonly engines: readonly RecognitionEngineName[];
  /** Aborted when the view closes; its work must not change a replacement view. */
  readonly signal: AbortSignal;
  /** Reports that the pending review changed, so the page presents what the provider now holds. */
  readonly reviewChanged: (change: UiCaptureReviewChange) => void;
}

/**
 * One capture change the page takes into its review: an observation staged into an import, late
 * alternatives attached to one of its entries, or an unknown outcome that must be re-read instead
 * of being inferred (docs/application.md#construction-and-request-boundary).
 */
export type UiCaptureReviewChange =
  | {
      readonly kind: 'staged';
      readonly session: ImportSession;
      /** Entry the observation was admitted as, or null when it was suppressed or unresolved. */
      readonly entryId: string | null;
    }
  | { readonly kind: 'attached'; readonly session: ImportSession; readonly entryId: string }
  | { readonly kind: 'unknown' };

export interface UiCaptureControls {
  /** The capture section this view presents. */
  readonly element: HTMLElement;
  /** Ends the capture session, keeping the imported review. */
  stop(): void;
  /** Ends the capture session and releases the device. */
  dispose(): void;
}

/** One capture attempt of the running session. */
interface UiCaptureAttempt {
  readonly sessionId: string;
  readonly captureId: string;
  readonly id: number;
  /** Whether one of the attempt's readings staged an observation. */
  staged: boolean;
  /** Entry the observation was admitted as, or null while none is reviewable. */
  entryId: string | null;
}

/** The recognition alternatives of one reading as the review stores them. */
export function uiCaptureCandidates(reading: RecognitionReading): readonly ImportCandidate[] {
  return reading.candidates.map((candidate) => ({
    printingId: candidate.printingId,
    // The public reading reports engine versions for the attempt, not for each candidate, so the
    // alternative names the component that produced it and the evidence it carried.
    provider: 'recognition',
    evidence:
      reading.evidence.printingId === candidate.printingId ||
      (reading.suggestion?.basis === 'corroborated' &&
        reading.suggestion.printingId === candidate.printingId)
        ? captureEvidenceLabels.title
        : captureEvidenceLabels.ranking,
  }));
}

/**
 * One capture observation as UserCards stages it: the printing the reading suggests, with the
 * reading's ordered alternatives beside it, or null when the reading names no usable identity. The
 * suggestion is the editable starting point of review and never evidence of the observed edition
 * (docs/recognition.md#interface).
 */
export function uiCaptureObservation(
  sessionId: string,
  captureId: string,
  reading: RecognitionReading,
): StageCaptureInput | null {
  if (reading.status !== 'possible' || reading.candidates.length === 0) {
    return null;
  }
  const suggested =
    reading.suggestion === null
      ? reading.candidates[0]
      : reading.candidates[reading.suggestion.candidateIndex];
  const printingId = suggested?.printingId ?? reading.candidates[0]?.printingId ?? null;
  if (printingId === null) {
    return null;
  }
  return {
    sessionId,
    captureId,
    printingId,
    // The provider takes the printing's first offered finish; review changes it explicitly.
    finish: null,
    candidates: [...uiCaptureCandidates(reading)],
  };
}

/** The camera capture section of the Import page. */
export function createCaptureControls(options: UiCaptureOptions): UiCaptureControls {
  const document = options.document;
  const view = document.defaultView;
  if (view === null) {
    throw new TypeError('The capture view reads frames from a browsing document.');
  }
  const browser: Window = view;
  const { access, device } = options;

  const heading = document.createElement('h3');
  heading.id = 'import-capture-heading';
  heading.textContent = 'Camera capture';
  const status = document.createElement('p');
  status.id = 'import-camera-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.dataset.uiCaptureCue = 'idle';
  const preview = document.createElement('video');
  preview.id = 'import-camera-preview';
  preview.muted = true;
  preview.playsInline = true;
  preview.setAttribute('aria-label', 'Camera preview');
  preview.hidden = true;
  const startButton = captureButton(document, 'import-camera-start', 'Start camera');
  const stopButton = captureButton(document, 'import-camera-stop', 'Stop camera');
  stopButton.hidden = true;
  const element = document.createElement('section');
  element.id = 'import-capture';
  element.append(heading, status, preview, startButton, stopButton);

  let camera: UiCamera | null = null;
  let recognition: Recognition<HTMLCanvasElement> | null = null;
  let sessionId: string | null = null;
  let controller: AbortController | null = null;
  let attempts = 0;
  let running = false;
  let starting = false;
  let busy = false;
  let prepared = false;
  let preparing: Promise<void> | null = null;
  let closed = options.signal.aborted;
  let admission = createCaptureAdmission();
  let timer: number | null = null;
  let analysis: HTMLCanvasElement | null = null;
  let current: UiCaptureAttempt | null = null;

  if (typeof device.openCamera === 'function') {
    say('Start the camera to capture cards hands-free.', null);
  } else {
    // A deployment without a camera cannot capture; the view says so instead of offering a
    // control that can never work (docs/user-interface.md#capture-and-review).
    startButton.disabled = true;
    say('Camera capture is unavailable in this deployment.', null);
  }
  options.signal.addEventListener(
    'abort',
    () => {
      closed = true;
      stopCapture();
    },
    { once: true },
  );
  startButton.addEventListener('click', () => {
    void startCapture();
  });
  stopButton.addEventListener('click', () => {
    stopCapture();
    say('Capture stopped. Start the camera to scan more cards.', null);
  });

  return { element, stop: stopCapture, dispose: dispose };

  /** Starts the capture session: camera permission, then the hands-free capture loop. */
  async function startCapture(): Promise<void> {
    if (running || starting || closed) {
      return;
    }
    const open = device.openCamera;
    if (typeof open !== 'function') {
      say('Camera capture is unavailable in this deployment.', null);
      return;
    }
    starting = true;
    startButton.disabled = true;
    say('Waiting for camera permission…', null);
    const session = new AbortController();
    controller = session;
    try {
      const granted = await open.call(device);
      if (closed || session.signal.aborted) {
        closeCamera(granted);
        return;
      }
      camera = granted;
      preview.srcObject = granted.stream;
      preview.hidden = false;
      try {
        await preview.play();
      } catch (cause) {
        throw new Error('the camera stream could not be presented', { cause });
      }
      if (closed || session.signal.aborted) {
        stopCapture();
        return;
      }
      sessionId = uiCaptureIdentity();
      recognition = options.createRecognition();
      admission = createCaptureAdmission();
      prepared = false;
      preparing = null;
      running = true;
      starting = false;
      startButton.disabled = false;
      startButton.hidden = true;
      stopButton.hidden = false;
      say('Preparing recognition…', null);
      void ensurePrepared();
      schedule();
    } catch (cause) {
      if (controller === session) {
        controller = null;
      }
      starting = false;
      startButton.disabled = false;
      stopCapture();
      say(
        `Camera unavailable: ${readUiFailureMessage(cause, 'the camera could not be started.')}`,
        'error',
      );
    }
  }

  /** Ends the capture session, releasing the camera and the Recognition session. */
  function stopCapture(): void {
    const session = controller;
    const scanner = recognition;
    const held = sessionId;
    const heldCamera = camera;
    running = false;
    starting = false;
    busy = false;
    controller = null;
    recognition = null;
    sessionId = null;
    prepared = false;
    preparing = null;
    current = null;
    admission = createCaptureAdmission();
    clearTimer();
    session?.abort();
    if (scanner !== null && held !== null) {
      try {
        scanner.dispose({ sessionId: held });
      } catch {
        /* Releasing the recognition session is best effort. */
      }
    }
    camera = null;
    if (heldCamera !== null) {
      closeCamera(heldCamera);
      void Promise.resolve(device.release()).catch(() => {
        /* Releasing the device is best effort. */
      });
    }
    preview.srcObject = null;
    preview.hidden = true;
    startButton.hidden = false;
    startButton.disabled = false;
    stopButton.hidden = true;
  }

  function dispose(): void {
    closed = true;
    stopCapture();
  }

  /** Prepares the Recognition session on demand; a failed preparation is retried by the next one. */
  async function ensurePrepared(): Promise<void> {
    const scanner = recognition;
    const session = sessionId;
    if (prepared || preparing !== null || scanner === null || session === null || closed) {
      await preparing;
      return;
    }
    const signal = controller?.signal;
    preparing = Promise.resolve()
      // A replacement implementation could also fail without returning a promise.
      .then(() =>
        scanner.prepare({
          sessionId: session,
          engines: [...options.engines],
          ...(signal === undefined ? {} : { signal }),
        }),
      )
      .then(
        () => {
          prepared = true;
          if (running && !closed) {
            say('Scanner ready. Hold one card inside the frame until it is accepted.', null);
          }
        },
        (cause: unknown) => {
          if (running && !closed) {
            say(
              `Recognition is unavailable: ${readUiFailureMessage(cause, 'preparation failed')}`,
              null,
            );
          }
        },
      )
      .finally(() => {
        preparing = null;
      });
    await preparing;
  }

  /** Samples the camera and starts one attempt for a settled frame that is due. */
  function tick(): void {
    timer = null;
    if (!running || closed) {
      return;
    }
    const now = browser.performance.now();
    const signature = readSignature();
    if (signature !== null) {
      admission.observe(signature, now);
    }
    if (!busy && admission.ready(now)) {
      void attempt(now);
    }
    schedule();
  }

  function schedule(): void {
    clearTimer();
    if (!running || closed) {
      return;
    }
    timer = browser.setTimeout(tick, UI_CAPTURE.sampleMs);
  }

  function clearTimer(): void {
    if (timer !== null) {
      browser.clearTimeout(timer);
      timer = null;
    }
  }

  /** Runs one capture attempt and settles it with the outcome its readings produced. */
  async function attempt(now: number): Promise<void> {
    const scanner = recognition;
    const session = sessionId;
    const signal = controller?.signal;
    if (scanner === null || session === null || signal === undefined) {
      return;
    }
    busy = true;
    admission.started(now);
    attempts += 1;
    const record: UiCaptureAttempt = {
      sessionId: session,
      captureId: uiCaptureIdentity(),
      id: ((attempts - 1) % (RECOGNITION_LIMITS.maxAttempt - 1)) + 1,
      staged: false,
      entryId: null,
    };
    current = record;
    const frame = readFrame();
    if (frame === null) {
      busy = false;
      settle(record, 'unavailable', 'The camera delivered no frame. Keep one card in view.');
      return;
    }
    await ensurePrepared();
    if (closed || current !== record) {
      return;
    }
    if (!prepared) {
      busy = false;
      settle(record, 'unavailable', 'Recognition is unavailable. Retrying to read the card.');
      return;
    }
    // Readings of one attempt are handled in delivery order, so a late comparison cannot attach
    // alternatives before the observation it belongs to was staged.
    let handled: Promise<void> = Promise.resolve();
    const handle = (reading: RecognitionReading): Promise<void> => {
      handled = handled.then(() => handleReading(record, reading));
      return handled;
    };
    const started = scanner.recognize({
      sessionId: session,
      captureId: record.captureId,
      attempt: record.id,
      frame,
      signal,
      onReading: (later) => {
        void handle(later);
      },
    });
    try {
      await handle(await started.initial);
      await started.completion;
      await handled;
    } catch (cause) {
      if (!closed && current === record) {
        settle(
          record,
          'unavailable',
          readUiFailureMessage(cause, 'Recognition failed. Hold one card still to retry.'),
        );
      }
    } finally {
      if (current === record) {
        busy = false;
      }
    }
  }

  /**
   * Applies one reading of an attempt. Geometry decides admission independently of identity: only
   * a frame the runtime reports as holding one card is staged, and a reading without a usable
   * identity stays unresolved without creating an entry. The first reading that names an identity
   * stages the observation; later readings of the same capture only add alternatives.
   */
  async function handleReading(
    record: UiCaptureAttempt,
    reading: RecognitionReading,
  ): Promise<void> {
    if (closed || !running || current !== record) {
      return;
    }
    const presence = reading.evidence.cardPresence;
    if (presence !== null && presence !== 'single') {
      settle(
        record,
        'guidance',
        presence === 'none'
          ? 'Place one card inside the frame.'
          : 'Wait until only one card is visible.',
      );
      return;
    }
    const observation = uiCaptureObservation(record.sessionId, record.captureId, reading);
    if (observation === null) {
      settle(
        record,
        'unresolved',
        'The card could not be identified. Hold it still to retry; no card was counted.',
      );
      return;
    }
    if (!record.staged) {
      const commit = await stageCaptureObservation(access, observation, controller?.signal);
      if (closed || !running || current !== record) {
        return;
      }
      if (commit.status !== 'committed' || commit.record === null) {
        settle(record, 'unavailable', commit.message ?? 'The capture was not added to review.');
        if (commit.status === 'unknown') {
          // The staging may have committed; the review is refreshed instead of inferring an entry.
          options.reviewChanged({ kind: 'unknown' });
        }
        return;
      }
      record.entryId = commit.record.entry?.entryId ?? null;
      // An explicitly unresolved decision is not recorded by the provider, so the same capture may
      // resolve through a later reading instead of being treated as already staged
      // (docs/user-cards.md#import-and-capture-state).
      record.staged = commit.record.outcome !== 'unresolved';
      settle(record, captureOutcome(commit.record), captureMessage(reading, commit.record));
      options.reviewChanged({
        kind: 'staged',
        session: commit.record.session,
        entryId: record.entryId,
      });
      return;
    }
    if (record.entryId === null) {
      return;
    }
    const commit = await attachImportCandidates(
      access,
      { entryId: record.entryId, candidates: [...uiCaptureCandidates(reading)] },
      controller?.signal,
    );
    if (closed || !running || current !== record) {
      return;
    }
    if (commit.status === 'unknown') {
      options.reviewChanged({ kind: 'unknown' });
      say(commit.message ?? 'The later alternatives may be stored. Reload the import.', null);
      return;
    } else if (commit.status === 'committed' && commit.record !== null) {
      options.reviewChanged({
        kind: 'attached',
        session: commit.record.session,
        entryId: record.entryId,
      });
      // Alternatives never retract the acceptance, so this update carries no cue of its own.
      say(lateMessage(reading), null);
      return;
    }
    say(commit.message ?? 'The later alternatives could not be stored.', null);
  }

  /** Presents one attempt's outcome and the cue it earns, at most once each. */
  function settle(record: UiCaptureAttempt, outcome: UiCaptureOutcome, message: string): void {
    const cue = admission.settled(record.id, outcome, browser.performance.now());
    if (cue !== null) {
      presentCue(cue);
    }
    say(message, null);
  }

  /** Status text of one reading that staged nothing. */
  function captureMessage(reading: RecognitionReading, result: CaptureStageResult): string {
    if (result.outcome === 'suppressed') {
      return 'The same card is already in review. Show a different card or set its quantity in review.';
    }
    if (result.outcome === 'admitted') {
      const name = captureName(reading) ?? 'the card';
      const uncertain =
        reading.disagreement === null
          ? ''
          : ` Identification is uncertain: ${captureNames(reading)}.`;
      const comparing = reading.provisional ? ' Comparing printings…' : '';
      return (
        `Accepted ${name} into review.${uncertain}${comparing} ` +
        'Check printing, finish, condition and quantity before confirming.'
      );
    }
    return 'The card could not be identified. Hold it still to retry; no card was counted.';
  }

  /** The cue one staged observation earns: only an admitted candidate is a success. */
  function captureOutcome(result: CaptureStageResult): UiCaptureOutcome {
    switch (result.outcome) {
      case 'admitted':
        return 'accepted';
      case 'suppressed':
        return 'repeat';
      case 'unresolved':
        return 'unresolved';
    }
  }

  /** Status text of one later comparison; it adds alternatives and never retracts the candidate. */
  function lateMessage(reading: RecognitionReading): string {
    if (reading.status !== 'possible' || reading.candidates.length === 0) {
      return 'A later comparison found no usable identity. Check the accepted card before confirming.';
    }
    const uncertain = reading.disagreement === null ? '' : ' Identification is uncertain.';
    return (
      `A later comparison added ${captureNames(reading)} as alternatives.${uncertain} ` +
      'Review them before confirming.'
    );
  }

  /** Suggested candidate name, or the leading candidate when the reading suggests none. */
  function captureName(reading: RecognitionReading): string | null {
    const suggested =
      reading.suggestion === null
        ? reading.candidates[0]
        : reading.candidates[reading.suggestion.candidateIndex];
    const name = suggested?.name ?? reading.candidates[0]?.name ?? '';
    return name.length === 0 ? null : name.slice(0, uiCaptureNameLength);
  }

  /** Names of the reading's candidates, most likely first and bounded for presentation. */
  function captureNames(reading: RecognitionReading): string {
    const names = [...new Set(reading.candidates.map((candidate) => candidate.name))]
      .filter((name) => name.length > 0)
      .slice(0, 3)
      .map((name) => name.slice(0, uiCaptureNameLength));
    return names.length === 0 ? 'an unknown card' : names.join(', ');
  }

  function say(text: string, cue: UiCaptureCue | null): void {
    if (closed) {
      return;
    }
    status.textContent = text;
    if (cue !== null) {
      presentCue(cue);
    }
  }

  function presentCue(cue: UiCaptureCue): void {
    status.dataset.uiCaptureCue = cue;
  }

  /** Samples the live preview into a bounded brightness signature. */
  function readSignature(): readonly number[] | null {
    if (preview.videoWidth === 0 || preview.videoHeight === 0) {
      return null;
    }
    const view = (analysis ??= document.createElement('canvas'));
    view.width = UI_CAPTURE.signature;
    view.height = UI_CAPTURE.signature;
    const context = view.getContext('2d', { willReadFrequently: true });
    if (context === null) {
      return null;
    }
    context.drawImage(preview, 0, 0, view.width, view.height);
    const pixels = context.getImageData(0, 0, view.width, view.height).data;
    const signature: number[] = [];
    for (let index = 0; index < pixels.length; index += 4) {
      signature.push(
        ((pixels[index] ?? 0) + (pixels[index + 1] ?? 0) + (pixels[index + 2] ?? 0)) / 3,
      );
    }
    return signature;
  }

  /** Reads the current frame, bounded to the image the Recognition contract accepts. */
  function readFrame(): HTMLCanvasElement | null {
    const width = preview.videoWidth;
    const height = preview.videoHeight;
    if (width < 1 || height < 1) {
      return null;
    }
    const scale = Math.min(1, Math.sqrt(RECOGNITION_LIMITS.maxImagePixels / (width * height)));
    const frame = document.createElement('canvas');
    frame.width = Math.max(1, Math.round(width * scale));
    frame.height = Math.max(1, Math.round(height * scale));
    const context = frame.getContext('2d');
    if (context === null) {
      return null;
    }
    context.drawImage(preview, 0, 0, frame.width, frame.height);
    return frame;
  }

  function closeCamera(held: UiCamera): void {
    try {
      held.close();
    } catch {
      /* Releasing the camera is best effort. */
    }
  }
}

function captureButton(document: Document, id: string, label: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.id = id;
  button.textContent = label;
  return button;
}
