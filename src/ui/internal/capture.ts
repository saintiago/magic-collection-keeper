/**
 * Capture conventions of the Import page (docs/ui/capture-controls.md,
 * docs/capture.md#interface).
 *
 * The view presents one Capture session of the Import page: it owns the mounted preview surface,
 * the controls and the accessible status line, observes the session's status, provisional evidence
 * and identified feedback and forwards start, stop and retry. It makes no admission or matching
 * decision of its own: the session decides what a frame was admitted as, and a success cue is
 * presented only for the accepted event it reported. Disposal detaches the preview and disposes
 * the session through its public contract, so no camera, stream or subscription stays alive.
 */

import type {
  Capture,
  CaptureBrowser,
  CaptureBrowserDevice,
  CaptureComparisonEvent,
  CaptureCue,
  CaptureEvent,
  CapturePreview,
  CaptureReading,
  CaptureReviewChange,
  CaptureSnapshot,
  CaptureStatusKind,
} from '../../capture/index.js';

/** Longest candidate name the capture status presents, so one engine reading stays bounded. */
const uiCaptureNameLength = 120;

/** Longest candidate names the capture status lists as alternatives. */
const uiCaptureNameCount = 3;

export interface UiCaptureOptions {
  readonly document: Document;
  /** Capture capability Application supplies; the view owns the session it creates. */
  readonly capture: CaptureBrowser;
  /** Verified account the session stages for. */
  readonly accountId: string;
  /** Pending import identity this mounted view binds the session to. */
  readonly importId: string;
  /** Device capability of this deployment; one without a camera only reports that. */
  readonly device: CaptureBrowserDevice;
  /** Aborted when the view closes; its work must not change a replacement view. */
  readonly signal: AbortSignal;
  /** Reports that the pending review changed, so the page presents what the provider now holds. */
  readonly reviewChanged: (change: CaptureReviewChange) => void;
}

export interface UiCaptureControls {
  /** The capture section this view presents. */
  readonly element: HTMLElement;
  /** Ends the capture session, keeping the imported review. */
  stop(): void;
  /** Ends the capture session and releases the device. */
  dispose(): void;
}

/** The camera capture section of the Import page. */
export function createCaptureControls(options: UiCaptureOptions): UiCaptureControls {
  const document = options.document;
  const { device } = options;
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
  const recoverButton = captureButton(document, 'import-camera-recover', 'Recover capture');
  recoverButton.hidden = true;
  const element = document.createElement('section');
  element.id = 'import-capture';
  element.append(heading, status, preview, startButton, stopButton, recoverButton);

  const session: Capture = options.capture.create({
    accountId: options.accountId,
    importId: options.importId,
    device,
    reviewed: options.reviewChanged,
  });
  const cameraAvailable = typeof device.openCamera === 'function';
  if (!cameraAvailable) {
    // A deployment without a camera cannot capture; the view says so instead of offering a
    // control that can never work (docs/ui/capture-controls.md#presentation-and-lifetime).
    startButton.disabled = true;
  }
  /** Lifecycle kind the status line presents now, so a repaint does not repeat its text. */
  let presentedStatus: CaptureStatusKind | null = null;
  /** Highest event identity the view has presented; a redraw never repeats a cue. */
  let presentedEvent = 0;
  /** Reading identity the status line presents now, so a repaint does not repeat its text. */
  let presentedReading: string | null = null;
  /** Whether this view already released its subscription, its session and its preview. */
  let disposed = false;

  const unsubscribe = session.observe(paint);
  const stopObserving = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    options.signal.removeEventListener('abort', stopObserving);
    unsubscribe();
    session.dispose();
    // Disposal detaches what this view attached: no stream or preview state stays on its surface
    // (docs/ui/capture-controls.md#presentation-and-lifetime).
    presentPreview(null);
  };
  options.signal.addEventListener('abort', stopObserving, { once: true });
  if (options.signal.aborted) {
    stopObserving();
  }
  startButton.addEventListener('click', () => {
    void session.start();
  });
  stopButton.addEventListener('click', () => {
    session.stop();
  });
  recoverButton.addEventListener('click', () => {
    void session.retry();
  });

  return { element, stop: () => session.stop(), dispose: stopObserving };

  /** Presents one published state: the preview, the status line, the current evidence and events. */
  function paint(snapshot: CaptureSnapshot): void {
    presentPreview(snapshot.preview);
    presentStatus(snapshot);
    presentReading(snapshot.attempt?.reading ?? null);
    for (const event of snapshot.events) {
      if (event.sequence <= presentedEvent) {
        continue;
      }
      presentedEvent = event.sequence;
      presentEvent(event);
    }
    startButton.hidden = snapshot.running;
    stopButton.hidden = !snapshot.running;
    recoverButton.hidden = !snapshot.recoverable;
    recoverButton.disabled = snapshot.busy;
    startButton.disabled =
      !cameraAvailable ||
      snapshot.running ||
      snapshot.status.kind === 'starting' ||
      snapshot.recoverable;
  }

  /**
   * Presents the attempt's current provisional evidence once per reading: the candidates the
   * reading holds and its uncertainty, without a cue and without presenting its suggestion as a
   * certain identity (docs/ui/capture-controls.md#presentation-and-lifetime). A settled, certain
   * reading is what its own outcome event reports, and an event the same state carries replaces
   * this text below.
   */
  function presentReading(reading: CaptureReading | null): void {
    const identity =
      reading === null ? null : `${reading.captureId}:${reading.attempt}:${reading.revision}`;
    if (identity === presentedReading) {
      return;
    }
    presentedReading = identity;
    if (
      reading === null ||
      reading.status !== 'possible' ||
      reading.candidates.length === 0 ||
      (!reading.provisional && !reading.uncertain)
    ) {
      return;
    }
    const names = captureNames(reading);
    say(
      reading.uncertain
        ? `Reading one of ${names}. Identification is uncertain.`
        : `Reading ${captureName(reading) ?? names}.`,
      null,
    );
  }

  /** Attaches the session's live preview to the surface this view presents. */
  function presentPreview(attached: CapturePreview | null): void {
    const stream = attached?.stream ?? null;
    if (preview.srcObject === stream) {
      return;
    }
    preview.srcObject = stream;
    preview.hidden = stream === null;
    if (stream !== null) {
      // The device presented the stream it samples before reporting it; replaying it here is
      // presentation only, and its failure is reported by the device's own start.
      void Promise.resolve(preview.play()).catch(() => {
        /* Presenting the live preview is best effort. */
      });
    }
  }

  /** Text of the current lifecycle state; an event's own outcome replaces it below. */
  function presentStatus(snapshot: CaptureSnapshot): void {
    const { kind, failure } = snapshot.status;
    if (kind === presentedStatus) {
      return;
    }
    presentedStatus = kind;
    switch (kind) {
      case 'idle':
        say('Start the camera to capture cards hands-free.', null);
        return;
      case 'unavailable':
        say('Camera capture is unavailable in this deployment.', null);
        return;
      case 'starting':
        say('Waiting for camera permission…', null);
        return;
      case 'preparing':
        say('Preparing recognition…', null);
        return;
      case 'running':
        say('Scanner ready. Hold one card inside the frame until it is accepted.', null);
        return;
      case 'stopped':
        // An attempt whose outcome is not established keeps presenting its own message; the
        // stopped session is what recovery resumes (docs/capture.md#admission-and-lifecycle).
        if (!snapshot.recoverable) {
          say('Capture stopped. Start the camera to scan more cards.', null);
        }
        return;
      case 'failed':
        say(`Camera unavailable: ${failure ?? 'the camera could not be started.'}`, 'error');
        return;
    }
  }

  /** One identified event: its message and the cue only an accepted or failed outcome earns. */
  function presentEvent(event: CaptureEvent): void {
    switch (event.kind) {
      case 'accepted':
        presentCue(event.cue);
        say(
          event.reading === null
            ? 'The earlier capture was already accepted into review.'
            : acceptedMessage(event.reading),
          null,
        );
        return;
      case 'repeat':
        presentCue(event.cue);
        say(
          'The same card is already in review. Show a different card or set its quantity in review.',
          null,
        );
        return;
      case 'unresolved':
        presentCue(event.cue);
        say(
          event.reason === 'geometry'
            ? 'The frame was not admitted as one card. Hold one card still to retry; no card was counted.'
            : 'The card could not be identified. Hold it still to retry; no card was counted.',
          null,
        );
        return;
      case 'guidance':
        // Geometry guidance earns no cue of its own; it withdraws the cue of the attempt before it
        // so no frame is presented with the cue of an earlier attempt.
        clearCue();
        say(
          event.presence === 'none'
            ? 'Place one card inside the frame.'
            : 'Wait until only one card is visible.',
          null,
        );
        return;
      case 'unavailable':
        presentCue(event.cue);
        say(unavailableMessage(event.reason, event.failure, event.recoverable), null);
        return;
      case 'comparison':
        say(comparisonMessage(event), null);
        return;
    }
  }

  /** Status text of one admitted observation, as the reading that staged it reported it. */
  function acceptedMessage(reading: CaptureReading): string {
    const name = captureName(reading) ?? 'the card';
    const uncertain = reading.uncertain
      ? ` Identification is uncertain: ${captureNames(reading)}.`
      : '';
    const comparing = reading.provisional ? ' Comparing printings…' : '';
    return (
      `Accepted ${name} into review.${uncertain}${comparing} ` +
      'Check printing, finish, condition and quantity before confirming.'
    );
  }

  /** Status text of one attempt or submission that could not complete. */
  function unavailableMessage(
    reason: 'frame' | 'preparation' | 'recognition' | 'staging',
    failure: string | null,
    recoverable: boolean,
  ): string {
    switch (reason) {
      case 'frame':
        return 'The camera delivered no frame. Keep one card in view.';
      case 'preparation':
        return `Recognition is unavailable: ${failure ?? 'preparation failed'}`;
      case 'recognition':
        return failure ?? 'Recognition failed. Hold one card still to retry.';
      case 'staging':
        if (recoverable) {
          return (
            'The staging outcome is unknown. The capture may be in review; use Recover ' +
            'capture to check it.'
          );
        }
        return failure ?? 'The capture was not added to review.';
    }
  }

  /** Status text of one later comparison; it never retracts the accepted capture. */
  function comparisonMessage(event: CaptureComparisonEvent): string {
    if (event.outcome === 'rejected') {
      return event.failure ?? 'The later alternatives could not be stored.';
    }
    if (event.outcome === 'unverified') {
      return (
        'The capture is in review, but its later alternatives are not yet verified. Use ' +
        'Recover capture to retry.'
      );
    }
    if (event.outcome === 'attached') {
      return lateMessage(event.reading);
    }
    // A comparison whose frame still holds one card but names no usable identity explains its own
    // uncertainty; only geometry that no longer establishes one card reports that instead.
    return event.reading.presence === 'single'
      ? lateMessage(event.reading)
      : lateGeometryMessage(event.reading.presence);
  }

  /** Status text of one later comparison that added alternatives beside the accepted entry. */
  function lateMessage(reading: CaptureReading): string {
    if (reading.status !== 'possible' || reading.candidates.length === 0) {
      return 'A later comparison found no usable identity. Check the accepted card before confirming.';
    }
    const uncertain = reading.uncertain ? ' Identification is uncertain.' : '';
    return (
      `A later comparison added ${captureNames(reading)} as alternatives.${uncertain} ` +
      'Review them before confirming.'
    );
  }

  /** Status text of one later comparison whose frame geometry does not establish one card. */
  function lateGeometryMessage(presence: CaptureReading['presence']): string {
    const observed =
      presence === null
        ? 'A later comparison could not establish one card'
        : presence === 'none'
          ? 'A later comparison no longer sees a card'
          : 'A later comparison no longer sees exactly one card';
    return `${observed}. Check the accepted card before confirming.`;
  }

  /** Suggested candidate name, or the leading candidate when the reading suggests none. */
  function captureName(reading: CaptureReading): string | null {
    const suggested =
      reading.suggestedPrintingId === null
        ? undefined
        : reading.candidates.find(
            (candidate) => candidate.printingId === reading.suggestedPrintingId,
          );
    const name = suggested?.name ?? reading.candidates[0]?.name ?? '';
    return name.length === 0 ? null : name.slice(0, uiCaptureNameLength);
  }

  /** Names of the reading's candidates, most likely first and bounded for presentation. */
  function captureNames(reading: CaptureReading): string {
    const names = [...new Set(reading.candidates.map((candidate) => candidate.name))]
      .filter((name) => name.length > 0)
      .slice(0, uiCaptureNameCount)
      .map((name) => name.slice(0, uiCaptureNameLength));
    return names.length === 0 ? 'an unknown card' : names.join(', ');
  }

  function say(text: string, cue: CaptureCue | null): void {
    status.textContent = text;
    if (cue !== null) {
      presentCue(cue);
    }
  }

  /** Presents the cue one identified event earned; an event without one leaves the cue as it is. */
  function presentCue(cue: CaptureCue | null): void {
    if (cue !== null) {
      status.dataset.uiCaptureCue = cue;
    }
  }

  /** Withdraws the presented cue, so no frame is presented with the cue of an earlier attempt. */
  function clearCue(): void {
    status.dataset.uiCaptureCue = 'idle';
  }
}

function captureButton(document: Document, id: string, label: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.id = id;
  button.textContent = label;
  return button;
}
