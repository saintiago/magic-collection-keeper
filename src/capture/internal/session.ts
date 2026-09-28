/**
 * One Capture session (docs/capture.md#interface, docs/capture.md#admission-and-lifecycle).
 *
 * The session owns the device lifecycle, the hands-free sampling loop, the admission decision and
 * the staging coordination around one account and one pending import. A frame is admitted only
 * when the runtime reports affirmative single-card geometry and the same reading names a usable
 * identity; the provider decides a repeat, and an attempt whose outcome is not established stays
 * with the UserCards operation that owns its identity instead of being guessed by a second
 * observation. Every observable state leaves through immutable snapshots and identified events, so
 * a screen presents the component without owning any of its decisions and a session runs without
 * one.
 */

import {
  RECOGNITION_LIMITS,
  type Recognition,
  type RecognitionCardPresence,
  type RecognitionReading,
} from '../../recognition/index.js';
import type {
  CaptureStageResult,
  ImportEntryChangeResult,
  StageCaptureInput,
} from '../../usercards/index.js';

import type {
  Capture,
  CaptureAttempt,
  CaptureCamera,
  CaptureComparisonEvent,
  CaptureEvent,
  CaptureEventDraft,
  CaptureOptions,
  CaptureOperationOutcome,
  CaptureReading,
  CaptureSnapshot,
  CaptureStatus,
  CaptureTimers,
  CaptureUnavailableEvent,
} from './contract.js';
import { createCaptureIdentity } from './identity.js';
import { CAPTURE_LIMITS } from './limits.js';
import { captureObservation, captureReading, storedCandidates } from './reading.js';
import {
  createCaptureAdmission,
  type CaptureAdmission,
  type CaptureAttemptOutcome,
} from './scheduler.js';

/** One capture attempt of the running session. */
interface Attempt {
  /** Pending import this attempt's observation stages under. */
  readonly sessionId: string;
  readonly captureId: string;
  readonly id: number;
  /** Whether one of the attempt's readings staged an observation. */
  staged: boolean;
  /** Entry the observation was admitted as, or null while none is reviewable. */
  entryId: string | null;
  /**
   * The observation this attempt is submitting now, or null once its request settled. Recovery
   * replays the attempt UserCards retains under the capture identity, not a copy of this input.
   */
  staging: StageCaptureInput | null;
  /** Whether the provider has not established this attempt's staging outcome yet. */
  unresolved: boolean;
  /** Usable later readings, retained until their alternatives are attached to the admitted entry. */
  alternatives: { readonly reading: RecognitionReading; uncertain: boolean }[];
  /** Latest reading the attempt delivered, presented as its provisional evidence. */
  reading: CaptureReading | null;
}

/** Timer and clock of one session when the deployment supplies none. */
const defaultTimers: CaptureTimers = {
  now: () => performance.now(),
  schedule: (task, delayMs) => setTimeout(task, delayMs),
  cancel: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export function createCapture<Frame>(options: CaptureOptions<Frame>): Capture {
  const device = options.device;
  const staging = options.staging;
  const timers = options.timers ?? defaultTimers;
  const identity = options.identity ?? (() => createCaptureIdentity('capture'));

  let closed = false;
  /** Live camera of this session, or null while none is open. */
  let camera: CaptureCamera<Frame> | null = null;
  let recognition: Recognition<Frame> | null = null;
  /** Identity of the Recognition session of the open camera. */
  let recognitionSession: string | null = null;
  /** Cancellation of the open camera: stopping aborts the readings of the released camera. */
  let controller: AbortController | null = null;
  /** Cancellation of the whole session; disposing withdraws the requests it still holds. */
  const lifecycle = new AbortController();
  let running = false;
  let starting = false;
  let prepared = false;
  let preparing: Promise<void> | null = null;
  /** Whether one attempt is running Recognition now. */
  let busy = false;
  /** Whether one staging request or its alternatives are in flight. */
  let saving = false;
  let attempts = 0;
  let admission: CaptureAdmission = createCaptureAdmission();
  let timer: unknown = null;
  let current: Attempt | null = null;
  /**
   * A submitted write belongs to the session, not to the camera or Recognition lifetime. New
   * attempts wait until it is resolved; stopping the camera still leaves explicit recovery.
   */
  let pending: Attempt | null = null;
  /**
   * Capture identities whose staging outcome UserCards has not established, oldest first. The
   * provider keeps the attempt and its input, so this session recovers them through their own
   * handles — also when the page was reloaded in between
   * (docs/user-cards.md#browser-operation-lifecycle).
   */
  let retained: readonly string[] = [];
  let events: readonly CaptureEvent[] = [];
  let sequence = 0;
  let status: CaptureStatus =
    typeof device.openCamera === 'function'
      ? { kind: 'idle', failure: null }
      : { kind: 'unavailable', failure: null };
  const listeners = new Set<(snapshot: CaptureSnapshot) => void>();

  refreshRetained();

  return {
    importId: options.importId,
    accountId: options.accountId,
    prepare,
    start,
    stop,
    retry,
    observe,
    dispose,
  };

  /** Prepares the camera and the Recognition session on demand, reporting failures as state. */
  async function prepare(): Promise<void> {
    if (running || starting || closed || pending !== null || retained.length > 0) {
      return;
    }
    const open = device.openCamera;
    if (typeof open !== 'function') {
      status = { kind: 'unavailable', failure: null };
      publish();
      return;
    }
    starting = true;
    status = { kind: 'starting', failure: null };
    publish();
    const session = new AbortController();
    controller = session;
    try {
      const granted = await open.call(device);
      if (closed || controller !== session) {
        // A stop, a dispose or a later start already replaced this camera lifetime: the stream
        // this superseded request granted is closed without touching the live one
        // (docs/capture.md#admission-and-lifecycle).
        closeCamera(granted);
        return;
      }
      camera = granted;
      recognition = options.createRecognition();
      recognitionSession = identity();
      admission = createCaptureAdmission();
      prepared = false;
      preparing = null;
      running = true;
      starting = false;
      status = { kind: 'preparing', failure: null };
      publish();
      void ensurePrepared();
      schedule();
    } catch (cause) {
      if (closed || controller !== session) {
        // A superseded acquisition never changes the state of the camera that replaced it.
        return;
      }
      stopLive();
      status = { kind: 'failed', failure: failureMessage(cause) };
      publish();
    }
  }

  /** Starts the hands-free capture loop, preparing the camera when it is not open yet. */
  async function start(): Promise<void> {
    await prepare();
  }

  /** Ends the live session, releasing the camera and the Recognition session. */
  function stop(): void {
    if (status.kind === 'unavailable') {
      return;
    }
    stopLive();
    if (status.kind !== 'failed') {
      status = { kind: 'stopped', failure: null };
    }
    publish();
  }

  /** Releases the live device work of this session; a submitted write stays with its operation. */
  function stopLive(): void {
    const session = controller;
    const scanner = recognition;
    const held = recognitionSession;
    const heldCamera = camera;
    running = false;
    starting = false;
    busy = false;
    controller = null;
    recognition = null;
    recognitionSession = null;
    prepared = false;
    preparing = null;
    current = null;
    if (pending === null) {
      admission = createCaptureAdmission();
    }
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
  }

  /** Recovers every attempt whose staging outcome or later alternatives are not established. */
  async function retry(): Promise<void> {
    if (busy || saving || closed) {
      return;
    }
    if (pending !== null) {
      // The attempt this session presents still has work: its staging outcome or its later
      // alternatives are not established yet, so that attempt is what recovery resumes.
      await saveCapture(pending);
      return;
    }
    refreshRetained();
    for (const captureId of retained) {
      const attempt = staging.resume(captureId);
      if (attempt === null) {
        continue;
      }
      attempts += 1;
      await saveCapture({
        sessionId: attempt.input.sessionId,
        captureId,
        id: attemptIdentity(attempts),
        staged: false,
        entryId: null,
        staging: null,
        unresolved: true,
        alternatives: [],
        reading: null,
      });
      if (closed) {
        return;
      }
    }
    refreshRetained();
    publish();
  }

  /** Returns the current state and delivers every following update. */
  function observe(listener: (snapshot: CaptureSnapshot) => void): () => void {
    if (closed) {
      return () => {};
    }
    listeners.add(listener);
    listener(snapshot());
    return () => {
      listeners.delete(listener);
    };
  }

  /** Ends the session: the camera, its readings and every subscription are released. */
  function dispose(): void {
    if (closed) {
      return;
    }
    closed = true;
    stopLive();
    lifecycle.abort();
    listeners.clear();
  }

  /** Current immutable state of the session. */
  function snapshot(): CaptureSnapshot {
    const attempt: CaptureAttempt | null =
      current === null
        ? null
        : { captureId: current.captureId, attempt: current.id, reading: current.reading };
    return {
      status,
      preview: camera?.preview ?? null,
      attempt,
      events,
      recoverable: pending !== null || retained.length > 0,
      busy: busy || saving,
      running,
    };
  }

  function publish(): void {
    if (closed) {
      return;
    }
    const state = snapshot();
    for (const listener of [...listeners]) {
      listener(state);
    }
  }

  /** Publishes one identified event, keeping the bounded history of the session. */
  function next(draft: CaptureEventDraft): void {
    sequence += 1;
    events = [...events, { ...draft, sequence } as CaptureEvent].slice(
      -CAPTURE_LIMITS.eventHistory,
    );
    publish();
  }

  /** Reads back the capture attempts UserCards still retains for this account. */
  function refreshRetained(): void {
    retained = staging
      .retained()
      .flatMap((attempt) => (attempt.captureId === pending?.captureId ? [] : [attempt.captureId]));
  }

  /**
   * Prepares the Recognition session on demand; a failed preparation is retried by the next one.
   * A failure that cannot run inference is reported without preventing the session from sampling
   * again or from recovering an attempt that already staged something. Every continuation belongs
   * to the camera lifetime that began it: a preparation of a released camera writes no readiness
   * and reports no failure into the run that replaced it (docs/capture.md#admission-and-lifecycle).
   */
  async function ensurePrepared(): Promise<void> {
    const scanner = recognition;
    const session = recognitionSession;
    if (prepared || preparing !== null || scanner === null || session === null || closed) {
      await preparing;
      return;
    }
    const cameraLifetime = controller;
    const signal = cameraLifetime?.signal;
    const preparation = Promise.resolve()
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
          if (closed || controller !== cameraLifetime) {
            return;
          }
          prepared = true;
          if (running) {
            status = { kind: 'running', failure: null };
            publish();
          }
        },
        (cause: unknown) => {
          if (closed || controller !== cameraLifetime || !running) {
            return;
          }
          settleUnavailable(null, 'preparation', failureMessage(cause), false);
        },
      )
      .finally(() => {
        if (preparing === preparation) {
          preparing = null;
        }
      });
    preparing = preparation;
    await preparation;
  }

  /** Samples the camera and starts one attempt for a settled frame that is due. */
  function tick(): void {
    timer = null;
    if (!running || closed) {
      return;
    }
    const at = timers.now();
    const signature = camera?.sample() ?? null;
    if (signature !== null) {
      admission.observe(signature, at);
    }
    if (!busy && pending === null && admission.ready(at)) {
      void attempt();
    }
    schedule();
  }

  function schedule(): void {
    clearTimer();
    if (!running || closed) {
      return;
    }
    timer = timers.schedule(tick, CAPTURE_LIMITS.sampleMs);
  }

  function clearTimer(): void {
    if (timer !== null) {
      timers.cancel(timer);
      timer = null;
    }
  }

  /** Runs one capture attempt and settles it with the outcome its readings produced. */
  async function attempt(): Promise<void> {
    const scanner = recognition;
    const session = recognitionSession;
    const signal = controller?.signal;
    if (scanner === null || session === null || signal === undefined) {
      return;
    }
    busy = true;
    admission.started(timers.now());
    attempts += 1;
    const record: Attempt = {
      sessionId: options.importId,
      captureId: identity(),
      id: attemptIdentity(attempts),
      staged: false,
      entryId: null,
      staging: null,
      unresolved: false,
      alternatives: [],
      reading: null,
    };
    current = record;
    publish();
    const frame = camera?.read() ?? null;
    if (frame === null) {
      busy = false;
      settleUnavailable(record, 'frame', null, false);
      return;
    }
    await ensurePrepared();
    if (closed || current !== record) {
      return;
    }
    if (!prepared) {
      busy = false;
      settleUnavailable(record, 'recognition', null, false);
      return;
    }
    // Retain each reading on delivery, before any network wait. The single save drains retained
    // alternatives in order, even if the camera stops while an earlier write is in flight.
    let handled: Promise<void> = Promise.resolve();
    const handle = (reading: RecognitionReading): Promise<void> => {
      if (closed || !running || current !== record) {
        return handled;
      }
      record.reading = captureReading(reading);
      // The current evidence is observable as soon as it arrives: a pending staging request or
      // attachment serializes its own work, never the publication of a newer reading
      // (docs/capture.md#internal-design).
      publish();
      const retained =
        (record.staging !== null || record.entryId !== null) &&
        reading.evidence.cardPresence === 'single' &&
        captureObservation(record.sessionId, record.captureId, reading) !== null;
      if (retained) {
        record.alternatives.push({ reading, uncertain: false });
      }
      handled = handled.then(() => handleReading(record, reading, retained));
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
      if (!closed && current === record && pending !== record) {
        settleUnavailable(record, 'recognition', failureMessage(cause), false);
      }
    } finally {
      if (current === record) {
        busy = false;
      }
      publish();
    }
  }

  /**
   * Applies one reading of an attempt. Geometry decides admission independently of identity: only
   * a reading the runtime reports as holding one card is staged, a frame whose geometry is not
   * established is never affirmative evidence, and a reading without a usable identity stays
   * unresolved without creating an entry. The first reading that names an identity stages its
   * observation; later readings of the same capture only add alternatives, so an accepted capture
   * is never retracted by a comparison that finds no usable identity
   * (docs/capture.md#admission-and-lifecycle).
   */
  async function handleReading(
    record: Attempt,
    reading: RecognitionReading,
    retained: boolean,
  ): Promise<void> {
    if (closed || !running || current !== record) {
      return;
    }
    // An earlier save may already have drained this delivered comparison while this handler
    // waited. Do not attach it twice or replay an attachment that was definitely rejected.
    if (
      retained &&
      record.staged &&
      !record.alternatives.some((alternative) => alternative.reading === reading)
    ) {
      return;
    }
    const presence = reading.evidence.cardPresence;
    const observation =
      presence === 'single'
        ? captureObservation(record.sessionId, record.captureId, reading)
        : null;
    if (record.staging !== null || record.unresolved) {
      // Keep every usable comparison before replaying: that response may be lost too. Even an
      // unusable comparison must recover the prior write before it can report any admission.
      if (observation !== null && !retained) {
        record.alternatives.push({ reading, uncertain: false });
      }
      await saveCapture(record);
      if (closed || !running || current !== record || pending === record || observation !== null) {
        return;
      }
      // A recorded suppression/unresolved outcome has no entry for this comparison to explain.
      if (record.entryId === null) {
        return;
      }
    }
    if (presence !== 'single') {
      if (record.entryId !== null) {
        // The review already holds this capture's entry, so the later comparison explains its own
        // uncertainty instead of denying the acceptance.
        settleComparison(record, reading, 'unusable', null);
        return;
      }
      if (presence === null) {
        // The frame's geometry was never established, so the reading admits nothing.
        settleUnresolved(record, 'geometry');
        return;
      }
      settleGuidance(record, presence);
      return;
    }
    if (observation === null) {
      if (record.entryId !== null) {
        settleComparison(record, reading, 'unusable', null);
        return;
      }
      settleUnresolved(record, 'identity');
      return;
    }
    if (!record.staged) {
      // If the first submission was rejected or unresolved, this reading can stage the capture
      // itself. It no longer needs a separate attachment alongside that same observation.
      record.alternatives = record.alternatives.filter(
        (alternative) => alternative.reading !== reading,
      );
      record.staging = observation;
      await saveCapture(record, reading);
    } else if (record.entryId !== null) {
      if (!retained) {
        record.alternatives.push({ reading, uncertain: false });
      }
      await saveCapture(record);
    }
  }

  /**
   * Resolves the submitted observation and then drains its later readings in delivery order.
   * Each request keeps its original input until acknowledged. Recognition completion and camera
   * stop cannot discard it, and replay never relies on a session refresh to infer an entry ID.
   */
  async function saveCapture(record: Attempt, initialReading?: RecognitionReading): Promise<void> {
    pending = record;
    saving = true;
    publish();
    try {
      if (record.staging !== null || record.unresolved) {
        const commit = await submitCapture(record);
        if (closed) {
          return;
        }
        if (commit.state !== 'committed') {
          if (commit.state === 'unknown') {
            // The provider keeps the attempt: the session presents the recovery control and keeps
            // nothing of the observation it dispatched itself.
            record.staging = null;
            record.unresolved = true;
            options.reviewed?.({ kind: 'unknown' });
            settleUnavailable(record, 'staging', null, true);
          } else {
            // A definite refusal establishes that the observation staged nothing.
            record.staging = null;
            record.unresolved = false;
            settleUnavailable(record, 'staging', commit.message, false);
          }
          return;
        }
        const result = commit.record;
        record.staging = null;
        record.unresolved = false;
        record.entryId = result.entry?.entryId ?? null;
        // An explicitly unresolved decision is not recorded by the provider, so a later reading
        // can still resolve the capture. Suppression and admission are authoritative decisions.
        record.staged = result.outcome !== 'unresolved';
        const reading = initialReading === undefined ? null : captureReading(initialReading);
        if (result.outcome === 'admitted' && record.entryId !== null) {
          settleAccepted(record, record.entryId, result.replayed, reading);
        } else if (result.outcome === 'suppressed') {
          settleRepeat(record, result.replayed, reading);
        } else {
          settleUnresolved(record, 'identity');
        }
        options.reviewed?.({
          kind: 'staged',
          session: result.session,
          entryId: record.entryId,
        });
      }
      if (record.entryId === null) {
        record.alternatives = [];
        return;
      }
      while (record.alternatives.length > 0) {
        const alternative = record.alternatives[0];
        if (alternative === undefined) {
          break;
        }
        const { reading } = alternative;
        const commit = await attachCapture(record.entryId, reading);
        if (closed) {
          return;
        }
        if (commit.state !== 'committed') {
          if (commit.state === 'unknown') {
            alternative.uncertain = true;
            options.reviewed?.({ kind: 'unknown' });
          } else if (!alternative.uncertain) {
            // A first request that was definitely rejected has no lost outcome to recover.
            record.alternatives.shift();
            settleComparison(record, reading, 'rejected', commit.message);
            return;
          }
          settleComparison(record, reading, 'unverified', null);
          return;
        }
        record.alternatives.shift();
        options.reviewed?.({
          kind: 'attached',
          session: commit.record.session,
          entryId: record.entryId,
        });
        // Alternatives never retract the acceptance, so this update carries no cue of its own.
        settleComparison(record, reading, 'attached', null);
      }
    } finally {
      saving = false;
      if (!record.unresolved && record.staging === null && record.alternatives.length === 0) {
        pending = null;
      }
      refreshRetained();
      publish();
    }
  }

  /**
   * Submits the observation this attempt holds, or replays the attempt UserCards retains under the
   * capture identity. Recovery goes through the provider's own handle and input, so a reloaded
   * session re-reads the recorded decision instead of composing a second observation
   * (docs/user-cards.md#browser-operation-lifecycle).
   */
  async function submitCapture(
    record: Attempt,
  ): Promise<CaptureOperationOutcome<CaptureStageResult>> {
    if (record.unresolved) {
      // The replay runs under this session's cancellation scope, not the departed caller scope the
      // retained request was begun with (docs/user-cards.md#browser-operation-lifecycle).
      const attempt = staging.resume(record.captureId, lifecycle.signal);
      return attempt === null ? { state: 'unknown' } : attempt.observe();
    }
    const observation = record.staging;
    if (observation === null) {
      return { state: 'unknown' };
    }
    return staging.stage(observation, lifecycle.signal).observe();
  }

  /** Attaches one later reading's alternatives to the entry the attempt was admitted as. */
  async function attachCapture(
    entryId: string,
    reading: RecognitionReading,
  ): Promise<CaptureOperationOutcome<ImportEntryChangeResult>> {
    return staging
      .attach({ entryId, candidates: [...storedCandidates(reading)] }, lifecycle.signal)
      .observe();
  }

  /** One attempt's identified feedback: accepted, suppressed, unresolved, guided or failed. */
  function settleAccepted(
    record: Attempt,
    entryId: string,
    replayed: boolean,
    reading: CaptureReading | null,
  ): void {
    next({
      kind: 'accepted',
      captureId: record.captureId,
      attempt: record.id,
      cue: cueFor(record, 'accepted'),
      entryId,
      replayed,
      reading,
    });
  }

  function settleRepeat(record: Attempt, replayed: boolean, reading: CaptureReading | null): void {
    next({
      kind: 'repeat',
      captureId: record.captureId,
      attempt: record.id,
      cue: cueFor(record, 'repeat'),
      replayed,
      reading,
    });
  }

  function settleUnresolved(record: Attempt, reason: 'identity' | 'geometry'): void {
    next({
      kind: 'unresolved',
      captureId: record.captureId,
      attempt: record.id,
      cue: cueFor(record, 'unresolved'),
      reason,
    });
  }

  function settleGuidance(
    record: Attempt,
    presence: Exclude<RecognitionCardPresence, 'single'>,
  ): void {
    next({
      kind: 'guidance',
      captureId: record.captureId,
      attempt: record.id,
      // Geometry guidance earns no cue of its own; the presentation withdraws the cue of the
      // attempt before it instead of leaving a success cue presented for this frame.
      cue: cueFor(record, 'guidance'),
      presence,
    });
  }

  function settleUnavailable(
    record: Attempt | null,
    reason: CaptureUnavailableEvent['reason'],
    failure: string | null,
    recoverable: boolean,
  ): void {
    next({
      kind: 'unavailable',
      captureId: record?.captureId ?? null,
      attempt: record?.id ?? null,
      cue: record === null ? null : cueFor(record, 'unavailable'),
      reason,
      failure,
      recoverable,
    });
  }

  function settleComparison(
    record: Attempt,
    reading: RecognitionReading,
    outcome: CaptureComparisonEvent['outcome'],
    failure: string | null,
  ): void {
    next({
      kind: 'comparison',
      captureId: record.captureId,
      attempt: record.id,
      cue: null,
      reading: captureReading(reading),
      outcome,
      failure,
    });
  }

  /** The cue one settled attempt earns, at most once for each kind of attempt. */
  function cueFor(record: Attempt, outcome: CaptureAttemptOutcome) {
    return admission.settled(record.id, outcome, timers.now());
  }

  /** Bounded attempt identity the Recognition contract accepts. */
  function attemptIdentity(count: number): number {
    return ((count - 1) % (RECOGNITION_LIMITS.maxAttempt - 1)) + 1;
  }

  function closeCamera(held: CaptureCamera<Frame>): void {
    try {
      held.close();
    } catch {
      /* Releasing the camera is best effort. */
    }
  }
}

/** Message of one failure, or null when the runtime reported none. */
function failureMessage(cause: unknown): string | null {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : null;
}
