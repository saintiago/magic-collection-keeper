import { RecognitionError } from './errors.js';
import { mapEngineOutcome } from './mapping.js';
import {
  readEngines,
  readFrameFacts,
  readIdentifier,
  readIdentity,
  readTimings,
  readVersions,
  type RecognitionCaptureId,
  type RecognitionCatalogPort,
  type RecognitionEngineName,
  type RecognitionEngineOutcome,
  type RecognitionFrameFacts,
  type RecognitionIdentity,
  type RecognitionPreparation,
  type RecognitionReading,
  type RecognitionSessionId,
} from './model.js';

/**
 * The Recognition lifecycle (docs/recognition.md#interface, docs/recognition.md#execution).
 *
 * Prepare starts the runtime's inference pipeline for one session with its enabled engines,
 * Recognize runs one capture attempt and Dispose releases that session. The component owns the
 * public candidate contract around the preserved engines: preparation is demand-driven, one
 * inference runs per session at a time, requests and frames are validated before inference, and
 * readings keep their capture/attempt identity so a stale or later update can be rejected.
 * Cancellation suppresses later output and lets the pipeline release local work; it cannot
 * guarantee the cancellation of an already submitted remote model call.
 */

/** Prepare request: the session identity, the engines it enables and cancellation. */
export interface RecognitionPrepareRequest {
  readonly sessionId: RecognitionSessionId;
  /** Enabled engines; 1 to `RECOGNITION_LIMITS.maxEngines` unique engine names. */
  readonly engines: readonly RecognitionEngineName[];
  readonly signal?: AbortSignal;
}

/** Recognize request: image, session/capture/attempt identity and cancellation. */
export interface RecognitionRecognizeRequest<Frame> {
  readonly sessionId: RecognitionSessionId;
  readonly captureId: RecognitionCaptureId;
  /** Integer attempt identity from `RECOGNITION_LIMITS.minAttempt` to `maxAttempt`. */
  readonly attempt: number;
  readonly frame: Frame;
  readonly signal?: AbortSignal;
  /** Receives later readings of the same attempt; the first reading is the returned initial. */
  readonly onReading?: (reading: RecognitionReading) => void;
}

/** Dispose request: the session whose local resources are released. */
export interface RecognitionDisposeRequest {
  readonly sessionId: RecognitionSessionId;
}

/** One recognition attempt: its initial reading and the completion of all of its readings. */
export interface RecognitionAttempt {
  /**
   * Resolves with the first reading of the attempt, or rejects with a `RecognitionError` when the
   * attempt cannot deliver one. Later readings arrive through the request's callback.
   */
  readonly initial: Promise<RecognitionReading>;
  /**
   * Resolves when no further reading will be delivered for this attempt, whether it delivered
   * readings, failed, was cancelled or its session was disposed. It never rejects.
   */
  readonly completion: Promise<void>;
}

/** Prepare step of the runtime's inference pipeline. */
export interface RecognitionEnginePrepareRequest {
  readonly sessionId: RecognitionSessionId;
  readonly engines: readonly RecognitionEngineName[];
  readonly signal: AbortSignal;
}

/** Ready state a prepared pipeline reports. */
export interface RecognitionEnginePreparation {
  readonly versions?: Readonly<Record<string, string>>;
  readonly timings?: Readonly<Record<string, number>>;
}

/** Recognize step of the runtime's inference pipeline. */
export interface RecognitionEngineRecognizeRequest {
  readonly captureId: RecognitionCaptureId;
  readonly attempt: number;
  readonly signal: AbortSignal;
  /**
   * Delivers a later comparison for the same capture before the returned outcome resolves, for
   * example the later reading of a hybrid path. The component keeps the attempt identity it
   * supplies, and releasing local work on the signal does not guarantee the cancellation of an
   * already submitted remote model call.
   */
  readonly onReading?: (outcome: RecognitionEngineOutcome) => void;
}

/**
 * The runtime's preserved recognition pipeline (docs/recognition.md#engines-and-assets), supplied
 * by Application. It owns engine behaviour and matching policy: the browser ONNX recognition or
 * the Python visual/OCR path, the hybrid early/later comparison, the session call limit of the
 * independent identity check and at most one independent request in flight. The component has
 * already validated the request, including the frame, before calling it.
 */
export interface RecognitionEnginePipeline<Frame> {
  prepare(request: RecognitionEnginePrepareRequest): Promise<RecognitionEnginePreparation>;
  recognize(
    frame: Frame,
    request: RecognitionEngineRecognizeRequest,
  ): Promise<RecognitionEngineOutcome>;
  /** Releases local work of this session; safe to call after a failed preparation or disposal. */
  dispose(): void;
}

export interface RecognitionDependencies<Frame> {
  /**
   * Creates the pipeline for one session. Preparation is demand-driven: the factory is only
   * called when a session is prepared, and the prepared engines are reused for that session's
   * captures without mixing request state.
   */
  readonly createEnginePipeline: () => RecognitionEnginePipeline<Frame>;
  /** Catalog reads used to validate candidate identities and resolve canonical printings. */
  readonly catalog: RecognitionCatalogPort;
  /**
   * Reads the bounded facts of a runtime frame. Returning null, throwing or reporting facts
   * outside the accepted bounds rejects the capture as invalid input before any inference.
   */
  readonly inspectFrame: (frame: Frame) => RecognitionFrameFacts | null;
}

export interface Recognition<Frame> {
  /** Prepares a session, or returns the shared preparation of an already prepared one. */
  prepare(request: RecognitionPrepareRequest): Promise<RecognitionPreparation>;
  /** Starts one capture attempt, or returns an attempt that fails immediately. */
  recognize(request: RecognitionRecognizeRequest<Frame>): RecognitionAttempt;
  /** Releases a session's local resources and prevents further delivery for it. */
  dispose(request: RecognitionDisposeRequest): void;
}

interface ActiveAttempt {
  readonly controller: AbortController;
  readonly initial: Promise<RecognitionReading>;
  readonly completion: Promise<void>;
  resolveInitial: (reading: RecognitionReading) => void;
  rejectInitial: (error: unknown) => void;
  resolveCompletion: () => void;
  revision: number;
  delivered: boolean;
  /** Delivery finished: no further reading will be delivered for this attempt. */
  finished: boolean;
}

interface Session<Frame> {
  readonly sessionId: RecognitionSessionId;
  readonly engines: readonly RecognitionEngineName[];
  readonly pipeline: RecognitionEnginePipeline<Frame>;
  readonly controller: AbortController;
  readonly preparation: Promise<RecognitionPreparation>;
  active: ActiveAttempt | null;
}

export function createRecognition<Frame>(
  dependencies: RecognitionDependencies<Frame>,
): Recognition<Frame> {
  const createPipeline = dependencies?.createEnginePipeline;
  if (typeof createPipeline !== 'function') {
    throw new TypeError('createRecognition requires a factory for the runtime engine pipeline.');
  }
  const catalog = dependencies?.catalog;
  if (typeof catalog?.resolve !== 'function') {
    throw new TypeError('createRecognition requires the Catalog resolve contract.');
  }
  const inspectFrame = dependencies?.inspectFrame;
  if (typeof inspectFrame !== 'function') {
    throw new TypeError('createRecognition requires a runtime frame inspector.');
  }

  const sessions = new Map<RecognitionSessionId, Session<Frame>>();

  async function prepare(request: RecognitionPrepareRequest): Promise<RecognitionPreparation> {
    const sessionId = readIdentifier(request?.sessionId, 'session identity');
    const engines = readEngines(request?.engines);
    const signal = request?.signal;
    throwIfCancelled(signal);

    const existing = sessions.get(sessionId);
    if (existing) {
      if (!sameEngines(existing.engines, engines)) {
        throw new RecognitionError(
          'invalid-request',
          'The session is already preparing a different engine set.',
        );
      }
      // A joining caller waits on the shared preparation; its own cancellation ends only its
      // wait, while cancelling the session ends the preparation for every caller.
      const joined = signal
        ? AbortSignal.any([signal, existing.controller.signal])
        : existing.controller.signal;
      return watch(existing.preparation, joined);
    }

    let pipeline: RecognitionEnginePipeline<Frame>;
    try {
      pipeline = createPipeline();
    } catch (error) {
      // A pipeline the runtime cannot even create means recognition is unavailable, not a
      // malformed request (docs/recognition.md#execution).
      throw asFailure(error);
    }
    const controller = new AbortController();
    const preparation = (async (): Promise<RecognitionPreparation> => {
      try {
        const ready = await pipeline.prepare({ sessionId, engines, signal: controller.signal });
        return {
          sessionId,
          engines: [...engines],
          versions: readVersions(ready?.versions),
          timings: readTimings(ready?.timings),
        };
      } catch (error) {
        // Every caller of the shared preparation — the initiator and each joining caller — receives
        // the same classified failure instead of a raw provider error
        // (docs/recognition.md#interface).
        throw controller.signal.aborted ? cancelledError(controller.signal) : asFailure(error);
      }
    })();
    // The shared preparation is awaited through the calls below; keep it handled so an aborted
    // caller cannot leave an unhandled rejection behind.
    preparation.catch(() => {});
    const session: Session<Frame> = {
      sessionId,
      engines,
      pipeline,
      controller,
      preparation,
      active: null,
    };
    sessions.set(sessionId, session);

    const onAbort = () => {
      if (sessions.get(sessionId) !== session) {
        return;
      }
      sessions.delete(sessionId);
      controller.abort(signal?.reason);
      release(pipeline);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    // The caller that starts the preparation owns its cancellation: aborting it or disposing the
    // session ends the shared preparation instead of waiting for a pipeline that never settles.
    const awaiting = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      return await watch(preparation, awaiting);
    } catch (error) {
      if (sessions.get(sessionId) === session) {
        sessions.delete(sessionId);
        release(pipeline);
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  function recognize(request: RecognitionRecognizeRequest<Frame>): RecognitionAttempt {
    let identity: RecognitionIdentity;
    try {
      identity = readIdentity(request?.sessionId, request?.captureId, request?.attempt);
    } catch (error) {
      return failedAttempt(asFailure(error));
    }
    const signal = request?.signal;
    if (signal?.aborted) {
      return failedAttempt(cancelledError(signal));
    }
    const session = sessions.get(identity.sessionId);
    if (!session) {
      return failedAttempt(
        new RecognitionError('invalid-request', 'The session has not been prepared.'),
      );
    }
    const frame = request?.frame;
    try {
      if (frame === undefined) {
        throw new RecognitionError('invalid-request', 'The captured frame could not be read.');
      }
      readFrameFacts(inspectFrame(frame));
    } catch (error) {
      return failedAttempt(asInvalidFrame(error));
    }
    if (session.active) {
      return failedAttempt(new RecognitionError('busy', 'Scanner busy. Retry this card.'));
    }

    const controller = new AbortController();
    // The attempt follows the caller, this attempt and the session it belongs to: preparation
    // cancelled or a session disposed while the capture waits releases the attempt instead of
    // leaving it pending over a pipeline the session already released
    // (docs/recognition.md#execution).
    const combined = AbortSignal.any([
      controller.signal,
      session.controller.signal,
      ...(signal ? [signal] : []),
    ]);
    let resolveInitial!: (reading: RecognitionReading) => void;
    let rejectInitial!: (error: unknown) => void;
    let resolveCompletion!: () => void;
    const initial = new Promise<RecognitionReading>((resolve, reject) => {
      resolveInitial = resolve;
      rejectInitial = reject;
    });
    // The caller receives this rejection through `initial`; keep it handled so a caller that only
    // watches completion does not trip an unhandled rejection.
    initial.catch(() => {});
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const active: ActiveAttempt = {
      controller,
      initial,
      completion,
      resolveInitial,
      rejectInitial,
      resolveCompletion,
      revision: 0,
      delivered: false,
      finished: false,
    };
    session.active = active;

    /** No further reading will be delivered for this attempt. */
    const finishDelivery = (): void => {
      if (active.finished) {
        return;
      }
      active.finished = true;
      active.resolveCompletion();
    };

    /**
     * The session accepts the next capture only once its pipeline released this attempt, so a
     * failed, cancelled or superseded delivery cannot start a second inference beside outstanding
     * local work in the reused engines (docs/recognition.md#execution).
     */
    const releaseSession = (): void => {
      if (session.active === active) {
        session.active = null;
      }
    };

    const onAbort = () => {
      if (active.finished) {
        return;
      }
      if (!active.delivered) {
        active.rejectInitial(cancelledError(combined));
      }
      finishDelivery();
    };
    combined.addEventListener('abort', onAbort, { once: true });

    let queue: Promise<void> = Promise.resolve();
    function publish(outcome: RecognitionEngineOutcome): Promise<void> {
      queue = queue.then(() => deliver(outcome));
      return queue;
    }

    async function deliver(outcome: RecognitionEngineOutcome): Promise<void> {
      if (active.finished || combined.aborted) {
        return;
      }
      let reading: RecognitionReading;
      try {
        reading = await mapEngineOutcome(outcome, {
          identity,
          revision: active.revision + 1,
          catalog,
          signal: combined,
        });
      } catch (error) {
        if (!active.delivered && !active.finished && !combined.aborted) {
          active.rejectInitial(asFailure(error));
          finishDelivery();
          // A terminal mapping failure ends this attempt's delivery while the pipeline may still
          // hold outstanding inference: cancel it, and stay busy until the pipeline releases the
          // attempt instead of starting a second inference beside it.
          controller.abort();
        }
        return;
      }
      if (active.finished || combined.aborted) {
        return;
      }
      active.revision += 1;
      if (!active.delivered) {
        active.delivered = true;
        active.resolveInitial(reading);
        return;
      }
      const consumer = request?.onReading;
      if (consumer) {
        // A consumer callback reports nothing back; it must not break the engine's delivery loop.
        try {
          consumer(reading);
        } catch {
          /* A consumer callback cannot break the attempt. */
        }
      }
    }

    const task = (async () => {
      try {
        // A capture may arrive while the session is still preparing; it waits for the shared
        // preparation instead of starting a second one.
        await watch(session.preparation, combined);
        // A session cancelled while the capture waited must not run inference on the pipeline it
        // already released, even when the preparation resolves late.
        combined.throwIfAborted();
        if (sessions.get(identity.sessionId) !== session) {
          throw cancelledError(combined);
        }
        const outcome = await session.pipeline.recognize(frame, {
          captureId: identity.captureId,
          attempt: identity.attempt,
          signal: combined,
          onReading: (later) => {
            void publish(later);
          },
        });
        await publish(outcome);
        if (!active.delivered && !active.finished && !combined.aborted) {
          active.rejectInitial(
            new RecognitionError('unavailable', 'Recognition produced no reading.'),
          );
        }
      } catch (error) {
        // An outcome the pipeline delivered before failing may still be mapping; drain it so an
        // early reading survives a failed later comparison.
        await queue;
        if (!active.delivered && !active.finished && !combined.aborted) {
          active.rejectInitial(asFailure(error));
        }
      } finally {
        combined.removeEventListener('abort', onAbort);
        finishDelivery();
        releaseSession();
      }
    })();
    void task;

    return { initial, completion };
  }

  function dispose(request: RecognitionDisposeRequest): void {
    const sessionId = readIdentifier(request?.sessionId, 'session identity');
    const session = sessions.get(sessionId);
    if (!session) {
      return;
    }
    sessions.delete(sessionId);
    session.controller.abort();
    session.active?.controller.abort();
    release(session.pipeline);
  }

  return { prepare, recognize, dispose };
}

function failedAttempt(error: RecognitionError): RecognitionAttempt {
  const initial = Promise.reject(error);
  initial.catch(() => {});
  return { initial, completion: Promise.resolve() };
}

function sameEngines(
  current: readonly RecognitionEngineName[],
  requested: readonly RecognitionEngineName[],
): boolean {
  return (
    current.length === requested.length &&
    current.every((engine, index) => engine === requested[index])
  );
}

function cancelledError(signal?: AbortSignal): RecognitionError {
  return new RecognitionError('cancelled', 'The recognition attempt was cancelled.', {
    cause: signal?.reason,
  });
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw cancelledError(signal);
  }
}

/** Rejects with cancellation for this caller without cancelling a shared preparation for others. */
function watch<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return work;
  }
  throwIfCancelled(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancelledError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function asFailure(error: unknown): RecognitionError {
  if (error instanceof RecognitionError) {
    return error;
  }
  return new RecognitionError('unavailable', 'Recognition is unavailable.', { cause: error });
}

/**
 * A frame the runtime cannot read is invalid input rather than unavailable inference, whether the
 * inspector returned null, reported facts outside the bounds or threw (docs/recognition.md#execution).
 */
function asInvalidFrame(error: unknown): RecognitionError {
  if (error instanceof RecognitionError) {
    return error;
  }
  return new RecognitionError('invalid-request', 'The captured frame could not be read.', {
    cause: error,
  });
}

function release<Frame>(pipeline: RecognitionEnginePipeline<Frame>): void {
  try {
    pipeline.dispose();
  } catch {
    /* Releasing resources must not mask the outcome that caused it. */
  }
}
