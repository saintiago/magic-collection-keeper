/**
 * Component scope: the Recognition lifecycle (docs/recognition.md#interface,
 * docs/recognition.md#execution). A controlled engine pipeline exposes demand-driven preparation,
 * preparation failure and retry, request and frame validation before inference, one inference per
 * session, initial and later readings with one identity, completion, cancellation and disposal
 * through the public contract.
 */

import { describe, expect, it } from 'vitest';

import {
  RECOGNITION_LIMITS,
  RecognitionError,
  createRecognition,
  type RecognitionEngineOutcome,
  type RecognitionEnginePreparation,
  type RecognitionEngineRecognizeRequest,
  type RecognitionFrameFacts,
  type RecognitionImageFormat,
  type RecognitionReading,
} from '../../../src/recognition/index.js';

import {
  callerInput,
  createCatalogStub,
  createPipelineStub,
  createRecognitionHarness,
  deferred,
  frameFacts,
  outcome,
  tick,
} from './harness.js';

const prepareRequest = { sessionId: 'session-1', engines: ['browser-onnx'] } as const;

describe('recognition preparation', () => {
  it('starts preparation only when asked and shares one preparation per session', async () => {
    const gate = deferred<RecognitionEnginePreparation>();
    const harness = createRecognitionHarness({
      configurePipeline: (stub) => {
        stub.state.prepare = () => gate.promise;
      },
    });
    expect(harness.pipelines).toHaveLength(0);

    const first = harness.recognition.prepare(prepareRequest);
    const second = harness.recognition.prepare(prepareRequest);
    const stub = harness.current();
    expect(stub.state.prepareCalls).toHaveLength(1);
    expect(stub.state.prepareCalls[0]?.engines).toEqual(['browser-onnx']);
    expect(stub.state.prepareCalls[0]?.sessionId).toBe('session-1');

    gate.resolve({ versions: { visual: '1.2.0' }, timings: { prepareMs: 12 } });
    await expect(first).resolves.toEqual({
      sessionId: 'session-1',
      engines: ['browser-onnx'],
      versions: { visual: '1.2.0' },
      timings: { prepareMs: 12 },
    });
    await expect(second).resolves.toEqual({
      sessionId: 'session-1',
      engines: ['browser-onnx'],
      versions: { visual: '1.2.0' },
      timings: { prepareMs: 12 },
    });
    expect(harness.pipelines).toHaveLength(1);
  });

  it('reports a preparation failure as unavailable, releases it and allows a retry', async () => {
    let failing = true;
    const harness = createRecognitionHarness({
      configurePipeline: (stub) => {
        stub.state.prepare = async () => {
          if (failing) {
            throw new Error('model download failed');
          }
          return { versions: { visual: '1.2.0' } };
        };
      },
    });

    await expect(harness.recognition.prepare(prepareRequest)).rejects.toMatchObject({
      name: 'RecognitionError',
      code: 'unavailable',
    });
    expect(harness.current().state.disposals).toBe(1);

    // The failed session was discarded; a capture without a prepared session is invalid input.
    const discarded = harness.recognition.recognize({
      ...prepareRequest,
      captureId: 'capture-1',
      attempt: 1,
      frame: 'frame',
    });
    await expect(discarded.initial).rejects.toMatchObject({ code: 'invalid-request' });
    await discarded.completion;

    failing = false;
    await expect(harness.recognition.prepare(prepareRequest)).resolves.toMatchObject({
      sessionId: 'session-1',
      versions: { visual: '1.2.0' },
    });
    expect(harness.pipelines).toHaveLength(2);
  });

  it('reports a pipeline the runtime cannot create as unavailable and allows a retry', async () => {
    let failing = true;
    const recognition = createRecognition<string>({
      createEnginePipeline: () => {
        if (failing) {
          throw new Error('engine bundle missing');
        }
        return createPipelineStub().pipeline;
      },
      catalog: createCatalogStub({ cards: [], printings: [] }),
      inspectFrame: () => frameFacts(),
    });

    await expect(recognition.prepare(prepareRequest)).rejects.toMatchObject({
      name: 'RecognitionError',
      code: 'unavailable',
    });

    failing = false;
    await expect(recognition.prepare(prepareRequest)).resolves.toMatchObject({
      sessionId: 'session-1',
      engines: ['browser-onnx'],
    });
  });

  it('rejects a different engine set for a session that is already preparing', async () => {
    const harness = createRecognitionHarness();
    await harness.recognition.prepare(prepareRequest);

    await expect(
      harness.recognition.prepare({
        sessionId: 'session-1',
        engines: ['browser-onnx', 'independent-identity'],
      }),
    ).rejects.toMatchObject({ code: 'invalid-request' });
    expect(harness.pipelines).toHaveLength(1);
  });

  it('keeps the shared preparation when a joining caller cancels', async () => {
    const gate = deferred<RecognitionEnginePreparation>();
    const harness = createRecognitionHarness({
      configurePipeline: (stub) => {
        stub.state.prepare = () => gate.promise;
      },
    });
    const started = harness.recognition.prepare(prepareRequest);
    const controller = new AbortController();
    const joined = harness.recognition.prepare({ ...prepareRequest, signal: controller.signal });

    controller.abort();
    await expect(joined).rejects.toMatchObject({ code: 'cancelled' });
    gate.resolve({ versions: { visual: '1.2.0' } });
    await expect(started).resolves.toMatchObject({ versions: { visual: '1.2.0' } });
    expect(harness.current().state.disposals).toBe(0);
    expect(harness.pipelines).toHaveLength(1);
  });

  it('reports the same classified failure to every caller of a shared preparation', async () => {
    const gate = deferred<RecognitionEnginePreparation>();
    const harness = createRecognitionHarness({
      configurePipeline: (stub) => {
        stub.state.prepare = () => gate.promise;
      },
    });
    const initiating = harness.recognition.prepare(prepareRequest);
    const joining = harness.recognition.prepare(prepareRequest);
    gate.reject(new Error('private provider detail'));

    const failures = await Promise.all(
      [initiating, joining].map((pending) =>
        pending.then(
          () => null,
          (error: unknown) => error,
        ),
      ),
    );
    const [fromInitiator, fromJoiner] = failures;
    expect(fromInitiator).toBeInstanceOf(RecognitionError);
    expect(fromJoiner).toBeInstanceOf(RecognitionError);
    expect(fromInitiator).toMatchObject({ code: 'unavailable' });
    expect(fromJoiner).toMatchObject({
      code: 'unavailable',
      message: (fromInitiator as Error).message,
    });
    // The provider exception stays behind the boundary in both cases.
    expect((fromInitiator as Error).message).not.toContain('private provider detail');
    expect((fromJoiner as Error).message).not.toContain('private provider detail');
    expect((fromInitiator as Error).cause).toBeInstanceOf(Error);
    expect((fromJoiner as Error).cause).toBeInstanceOf(Error);
  });

  it('cancelling preparation releases the session and a retry can succeed', async () => {
    const gate = deferred<RecognitionEnginePreparation>();
    const harness = createRecognitionHarness({
      configurePipeline: (stub) => {
        stub.state.prepare = () => gate.promise;
      },
    });
    const controller = new AbortController();
    const pending = harness.recognition.prepare({ ...prepareRequest, signal: controller.signal });
    const releasing = harness.current();

    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(releasing.state.disposals).toBe(1);

    const discarded = harness.recognition.recognize({
      ...prepareRequest,
      captureId: 'capture-1',
      attempt: 1,
      frame: 'frame',
    });
    await expect(discarded.initial).rejects.toMatchObject({ code: 'invalid-request' });
  });

  it('cancels a capture queued behind preparation when preparation is cancelled', async () => {
    const gate = deferred<RecognitionEnginePreparation>();
    const harness = createRecognitionHarness({
      configurePipeline: (stub) => {
        stub.state.prepare = () => gate.promise;
      },
    });
    const controller = new AbortController();
    const preparing = harness.recognition.prepare({
      ...prepareRequest,
      signal: controller.signal,
    });
    const queued = harness.recognition.recognize({
      ...prepareRequest,
      captureId: 'capture-1',
      attempt: 1,
      frame: 'frame',
    });

    controller.abort();
    await expect(preparing).rejects.toMatchObject({ code: 'cancelled' });
    await expect(queued.initial).rejects.toMatchObject({ code: 'cancelled' });
    await queued.completion;
    expect(harness.current().state.disposals).toBe(1);

    // A preparation that resolves after the cancellation must not infer on the released pipeline.
    gate.resolve({});
    await tick();
    expect(harness.current().state.recognizeCalls).toHaveLength(0);
  });

  it('settles a capture queued behind a preparation that never settles when the session ends', async () => {
    const gate = deferred<RecognitionEnginePreparation>();
    const harness = createRecognitionHarness({
      configurePipeline: (stub) => {
        stub.state.prepare = () => gate.promise;
      },
    });
    const preparing = harness.recognition.prepare(prepareRequest);
    const queued = harness.recognition.recognize({
      ...prepareRequest,
      captureId: 'capture-1',
      attempt: 1,
      frame: 'frame',
    });

    harness.recognition.dispose({ sessionId: 'session-1' });
    await expect(preparing).rejects.toMatchObject({ code: 'cancelled' });
    await expect(queued.initial).rejects.toMatchObject({ code: 'cancelled' });
    await queued.completion;
    expect(harness.current().state.disposals).toBe(1);
  });

  it('dispose during preparation releases the pending session immediately', async () => {
    const gate = deferred<RecognitionEnginePreparation>();
    const harness = createRecognitionHarness({
      configurePipeline: (stub) => {
        stub.state.prepare = () => gate.promise;
      },
    });
    const pending = harness.recognition.prepare(prepareRequest);
    const preparing = harness.current();

    harness.recognition.dispose({ sessionId: 'session-1' });
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(preparing.state.disposals).toBe(1);

    const discarded = harness.recognition.recognize({
      ...prepareRequest,
      captureId: 'capture-1',
      attempt: 1,
      frame: 'frame',
    });
    await expect(discarded.initial).rejects.toMatchObject({ code: 'invalid-request' });
  });
});

describe('recognition attempts', () => {
  it('waits for the shared preparation of a capture started right after prepare', async () => {
    const gate = deferred<RecognitionEnginePreparation>();
    const harness = createRecognitionHarness({
      configurePipeline: (stub) => {
        stub.state.prepare = () => gate.promise;
      },
    });
    const ready = harness.recognition.prepare(prepareRequest);
    const attempt = harness.recognition.recognize({
      ...prepareRequest,
      captureId: 'capture-1',
      attempt: 1,
      frame: 'frame',
    });
    await tick();
    expect(harness.current().state.recognizeCalls).toHaveLength(0);

    gate.resolve({});
    await ready;
    await expect(attempt.initial).resolves.toMatchObject({ status: 'unknown' });
    await attempt.completion;
    expect(harness.current().state.recognizeCalls).toHaveLength(1);
  });

  it('rejects invalid identities, invalid frames and unprepared sessions before inference', async () => {
    const harness = createRecognitionHarness();
    await harness.recognition.prepare(prepareRequest);
    const stub = harness.current();

    const invalid = [
      { sessionId: '', captureId: 'capture-1', attempt: 1 },
      { sessionId: 'session-1', captureId: 'capture 1', attempt: 1 },
      {
        sessionId: 'session-1',
        captureId: 'c'.repeat(RECOGNITION_LIMITS.maxIdentifierLength + 1),
        attempt: 1,
      },
      {
        sessionId: 'session-1',
        captureId: 'capture-1',
        attempt: RECOGNITION_LIMITS.minAttempt - 1,
      },
      {
        sessionId: 'session-1',
        captureId: 'capture-1',
        attempt: RECOGNITION_LIMITS.maxAttempt + 1,
      },
      { sessionId: 'session-1', captureId: 'capture-1', attempt: 1.5 },
      { sessionId: 'session-1', captureId: 'capture-1', attempt: true },
      { sessionId: 'session-2', captureId: 'capture-1', attempt: 1 },
      { sessionId: 'session-1', captureId: 'capture-1', attempt: 1, frame: 'unreadable' },
    ] as const;
    for (const request of invalid) {
      const attempt = harness.recognition.recognize(callerInput({ frame: 'frame', ...request }));
      await expect(attempt.initial).rejects.toMatchObject({ code: 'invalid-request' });
      await attempt.completion;
    }
    expect(stub.state.recognizeCalls).toHaveLength(0);
  });

  it('rejects frames outside the accepted bounds before inference', async () => {
    const rejected: Array<RecognitionFrameFacts | null> = [
      null,
      frameFacts({ width: RECOGNITION_LIMITS.minImageDimension - 1 }),
      frameFacts({ height: RECOGNITION_LIMITS.minImageDimension - 1 }),
      frameFacts({ width: 4000, height: 1001 }),
      frameFacts({ encodedBytes: RECOGNITION_LIMITS.maxImageBytes + 1 }),
      frameFacts({ encodedBytes: 0 }),
      frameFacts({ format: 'gif' as RecognitionImageFormat }),
    ];
    for (const facts of rejected) {
      const harness = createRecognitionHarness({ inspectFrame: () => facts });
      await harness.recognition.prepare(prepareRequest);
      const attempt = harness.recognition.recognize({
        ...prepareRequest,
        captureId: 'capture-1',
        attempt: 1,
        frame: 'frame',
      });
      await expect(attempt.initial).rejects.toMatchObject({ code: 'invalid-request' });
      await attempt.completion;
      expect(harness.current().state.recognizeCalls).toHaveLength(0);
    }
  });

  it('reports a frame the runtime cannot read as invalid input before inference', async () => {
    const harness = createRecognitionHarness({
      inspectFrame: () => {
        throw new Error('frame stream closed');
      },
    });
    await harness.recognition.prepare(prepareRequest);
    const attempt = harness.recognition.recognize({
      ...prepareRequest,
      captureId: 'capture-1',
      attempt: 1,
      frame: 'frame',
    });

    await expect(attempt.initial).rejects.toMatchObject({
      name: 'RecognitionError',
      code: 'invalid-request',
    });
    await attempt.completion;
    expect(harness.current().state.recognizeCalls).toHaveLength(0);
  });

  it('keeps one inference per session and reports busy for a concurrent capture', async () => {
    const gate = deferred<RecognitionEngineOutcome>();
    const harness = createRecognitionHarness({
      configurePipeline: (stub) => {
        stub.state.recognize = () => gate.promise;
      },
    });
    await harness.recognition.prepare(prepareRequest);
    const stub = harness.current();

    const first = harness.recognition.recognize({
      ...prepareRequest,
      captureId: 'capture-1',
      attempt: 1,
      frame: 'frame',
    });
    const busy = harness.recognition.recognize({
      ...prepareRequest,
      captureId: 'capture-2',
      attempt: 2,
      frame: 'frame',
    });
    await expect(busy.initial).rejects.toMatchObject({ code: 'busy' });
    await busy.completion;
    expect(stub.state.recognizeCalls).toHaveLength(1);

    gate.resolve(outcome());
    await expect(first.initial).resolves.toMatchObject({ status: 'unknown' });
    await first.completion;

    stub.state.recognize = async () => outcome();
    const next = harness.recognition.recognize({
      ...prepareRequest,
      captureId: 'capture-2',
      attempt: 2,
      frame: 'frame',
    });
    await expect(next.initial).resolves.toMatchObject({
      identity: { sessionId: 'session-1', captureId: 'capture-2', attempt: 2 },
    });
    await next.completion;
  });

  it('delivers later readings of one attempt until completion', async () => {
    const gate = deferred<RecognitionEngineOutcome>();
    const harness = createRecognitionHarness({
      configurePipeline: (stub) => {
        stub.state.recognize = async (_frame, request) => {
          request.onReading?.(outcome({ provisional: true }));
          return gate.promise;
        };
      },
    });
    await harness.recognition.prepare(prepareRequest);

    const readings: RecognitionReading[] = [];
    const attempt = harness.recognition.recognize({
      ...prepareRequest,
      captureId: 'capture-7',
      attempt: 3,
      frame: 'frame',
      onReading: (reading) => readings.push(reading),
    });
    const initial = await attempt.initial;
    expect(initial.identity).toEqual({
      sessionId: 'session-1',
      captureId: 'capture-7',
      attempt: 3,
    });
    expect(initial.revision).toBe(1);
    expect(initial.provisional).toBe(true);

    let completed = false;
    void attempt.completion.then(() => {
      completed = true;
    });
    await tick();
    expect(completed).toBe(false);

    gate.resolve(outcome({ versions: { visual: '1.2.0' } }));
    await attempt.completion;
    expect(completed).toBe(true);
    expect(readings).toHaveLength(1);
    expect(readings[0]?.identity).toEqual(initial.identity);
    expect(readings[0]?.revision).toBe(2);
    expect(readings[0]?.provisional).toBe(false);
    expect(readings[0]?.versions).toEqual({ visual: '1.2.0' });
  });

  it('cancels outstanding inference on a mapping failure and stays busy until it releases', async () => {
    const gate = deferred<RecognitionEngineOutcome>();
    const stub = createPipelineStub();
    stub.state.recognize = (_frame, request) => {
      // A hybrid-style early outcome arrives while the engine call stays outstanding, and the
      // published Catalog cannot validate it.
      request.onReading?.(
        outcome({
          status: 'possible',
          candidates: [
            { cardId: 'card-bolt', printingId: 'printing-bolt', name: 'Bolt', score: 0.9 },
          ],
        }),
      );
      return gate.promise;
    };
    const recognition = createRecognition<string>({
      createEnginePipeline: () => stub.pipeline,
      catalog: {
        resolve: async () => {
          throw new Error('catalog unavailable');
        },
      },
      inspectFrame: () => frameFacts(),
    });
    await recognition.prepare(prepareRequest);

    const failed = recognition.recognize({
      ...prepareRequest,
      captureId: 'capture-1',
      attempt: 1,
      frame: 'frame',
    });
    await expect(failed.initial).rejects.toMatchObject({ code: 'unavailable' });
    await failed.completion;
    // The terminal mapping failure cancelled the inference the pipeline still held.
    expect(stub.state.recognizeCalls).toHaveLength(1);
    expect(stub.state.recognizeCalls[0]?.signal.aborted).toBe(true);

    // Until that inference is released, the attempt still occupies the session.
    const retry = recognition.recognize({
      ...prepareRequest,
      captureId: 'capture-2',
      attempt: 2,
      frame: 'frame',
    });
    await expect(retry.initial).rejects.toMatchObject({ code: 'busy' });
    await retry.completion;
    expect(stub.state.recognizeCalls).toHaveLength(1);

    gate.resolve(outcome());
    await tick();
    stub.state.recognize = async () => outcome({ versions: { visual: 'later' } });
    const next = recognition.recognize({
      ...prepareRequest,
      captureId: 'capture-3',
      attempt: 3,
      frame: 'frame',
    });
    await expect(next.initial).resolves.toMatchObject({
      status: 'unknown',
      versions: { visual: 'later' },
    });
    await next.completion;
    expect(stub.state.recognizeCalls).toHaveLength(2);
  });

  it('cancellation suppresses later output and releases the attempt', async () => {
    const gate = deferred<RecognitionEngineOutcome>();
    const signals: AbortSignal[] = [];
    const harness = createRecognitionHarness({
      configurePipeline: (stub) => {
        stub.state.recognize = (_frame, request) => {
          signals.push(request.signal);
          return gate.promise;
        };
      },
    });
    await harness.recognition.prepare(prepareRequest);

    const controller = new AbortController();
    const readings: RecognitionReading[] = [];
    const attempt = harness.recognition.recognize({
      ...prepareRequest,
      captureId: 'capture-1',
      attempt: 1,
      frame: 'frame',
      signal: controller.signal,
      onReading: (reading) => readings.push(reading),
    });
    await tick();
    expect(signals).toHaveLength(1);

    const cancelled = expect(attempt.initial).rejects.toMatchObject({ code: 'cancelled' });
    controller.abort();
    await cancelled;
    expect(signals[0]?.aborted).toBe(true);
    await attempt.completion;

    gate.resolve(outcome({ status: 'possible' }));
    await tick();
    expect(readings).toHaveLength(0);
  });

  it('dispose suppresses delivery for the session and frees its identity for a fresh one', async () => {
    const gate = deferred<RecognitionEngineOutcome>();
    const harness = createRecognitionHarness({
      configurePipeline: (stub) => {
        stub.state.recognize = () => gate.promise;
      },
    });
    await harness.recognition.prepare(prepareRequest);
    const released = harness.current();
    const readings: RecognitionReading[] = [];
    const attempt = harness.recognition.recognize({
      ...prepareRequest,
      captureId: 'capture-1',
      attempt: 1,
      frame: 'frame',
      onReading: (reading) => readings.push(reading),
    });
    const cancelled = expect(attempt.initial).rejects.toMatchObject({ code: 'cancelled' });

    harness.recognition.dispose({ sessionId: 'session-1' });
    await cancelled;
    await attempt.completion;
    expect(released.state.disposals).toBe(1);

    gate.resolve(outcome({ status: 'possible' }));
    await tick();
    expect(readings).toHaveLength(0);

    const disposed = harness.recognition.recognize({
      ...prepareRequest,
      captureId: 'capture-2',
      attempt: 2,
      frame: 'frame',
    });
    await expect(disposed.initial).rejects.toMatchObject({ code: 'invalid-request' });

    await harness.recognition.prepare(prepareRequest);
    expect(harness.pipelines).toHaveLength(2);
    const fresh = harness.recognition.recognize({
      ...prepareRequest,
      captureId: 'capture-3',
      attempt: 3,
      frame: 'frame',
    });
    await expect(fresh.initial).resolves.toMatchObject({
      identity: { captureId: 'capture-3', attempt: 3 },
    });
    await fresh.completion;
  });

  it('does not deliver a stale reading of an earlier attempt into a later one', async () => {
    const requests: RecognitionEngineRecognizeRequest[] = [];
    const gate = deferred<RecognitionEngineOutcome>();
    const harness = createRecognitionHarness({
      configurePipeline: (stub) => {
        stub.state.recognize = async (_frame, request) => {
          requests.push(request);
          if (request.attempt === 2) {
            request.onReading?.(outcome());
            return gate.promise;
          }
          return outcome();
        };
      },
    });
    await harness.recognition.prepare(prepareRequest);

    const first = harness.recognition.recognize({
      ...prepareRequest,
      captureId: 'capture-1',
      attempt: 1,
      frame: 'frame',
    });
    await first.initial;
    await first.completion;

    const readings: RecognitionReading[] = [];
    const second = harness.recognition.recognize({
      ...prepareRequest,
      captureId: 'capture-2',
      attempt: 2,
      frame: 'frame',
      onReading: (reading) => readings.push(reading),
    });
    const initial = await second.initial;
    expect(initial.identity).toEqual({
      sessionId: 'session-1',
      captureId: 'capture-2',
      attempt: 2,
    });

    // The first attempt's late pipeline callback arrives while the second attempt is in flight
    // and must not be delivered as a reading of it.
    requests[0]?.onReading?.(outcome({ status: 'possible' }));
    await tick();
    expect(readings).toHaveLength(0);

    gate.resolve(outcome({ versions: { visual: 'later' } }));
    await second.completion;
    expect(readings).toHaveLength(1);
    expect(readings[0]?.identity).toEqual({
      sessionId: 'session-1',
      captureId: 'capture-2',
      attempt: 2,
    });
    expect(readings[0]?.revision).toBe(2);
  });

  it('reports unavailable inference and keeps an earlier reading when a comparison fails', async () => {
    const harness = createRecognitionHarness({
      configurePipeline: (stub) => {
        stub.state.recognize = async () => {
          throw new Error('provider failure with private detail');
        };
      },
    });
    await harness.recognition.prepare(prepareRequest);
    const failed = harness.recognition.recognize({
      ...prepareRequest,
      captureId: 'capture-1',
      attempt: 1,
      frame: 'frame',
    });
    await expect(failed.initial).rejects.toMatchObject({
      name: 'RecognitionError',
      code: 'unavailable',
    });
    const failure = await failed.initial.then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(RecognitionError);
    expect((failure as Error).message).not.toContain('private detail');
    expect((failure as Error).cause).toBeInstanceOf(Error);
    await failed.completion;

    const pipelineBusy = createRecognitionHarness({
      configurePipeline: (stub) => {
        stub.state.recognize = async () => {
          throw new RecognitionError('busy', 'Scanner busy. Retry this card.');
        };
      },
    });
    await pipelineBusy.recognition.prepare(prepareRequest);
    const busy = pipelineBusy.recognition.recognize({
      ...prepareRequest,
      captureId: 'capture-1',
      attempt: 1,
      frame: 'frame',
    });
    await expect(busy.initial).rejects.toMatchObject({ code: 'busy' });
    await busy.completion;

    const later = createRecognitionHarness({
      configurePipeline: (stub) => {
        stub.state.recognize = async (_frame, request) => {
          request.onReading?.(outcome({ status: 'possible' }));
          throw new Error('comparison failed');
        };
      },
    });
    await later.recognition.prepare(prepareRequest);
    const attempt = later.recognition.recognize({
      ...prepareRequest,
      captureId: 'capture-1',
      attempt: 1,
      frame: 'frame',
    });
    await expect(attempt.initial).resolves.toMatchObject({ revision: 1, status: 'unknown' });
    await attempt.completion;
  });
});

describe('recognition sessions', () => {
  it('reuses prepared engines per session without mixing their request state', async () => {
    const gate = deferred<RecognitionEngineOutcome>();
    const harness = createRecognitionHarness({
      configurePipeline: (stub) => {
        stub.state.recognize = async (_frame, request) =>
          request.captureId === 'capture-b' ? outcome() : gate.promise;
      },
    });
    await harness.recognition.prepare({ sessionId: 'session-a', engines: ['browser-onnx'] });
    await harness.recognition.prepare({ sessionId: 'session-b', engines: ['python-ocr'] });
    expect(harness.pipelines).toHaveLength(2);
    expect(harness.pipelines[0]?.state.prepareCalls[0]?.engines).toEqual(['browser-onnx']);
    expect(harness.pipelines[1]?.state.prepareCalls[0]?.engines).toEqual(['python-ocr']);

    // Both sessions infer at the same time; one session's inference is not the other's.
    const first = harness.recognition.recognize({
      sessionId: 'session-a',
      captureId: 'capture-a',
      attempt: 1,
      frame: 'frame',
    });
    const second = harness.recognition.recognize({
      sessionId: 'session-b',
      captureId: 'capture-b',
      attempt: 1,
      frame: 'frame',
    });
    await expect(second.initial).resolves.toMatchObject({
      identity: { sessionId: 'session-b', captureId: 'capture-b', attempt: 1 },
      status: 'unknown',
    });
    await second.completion;
    expect(harness.pipelines[0]?.state.recognizeCalls).toHaveLength(1);
    expect(harness.pipelines[1]?.state.recognizeCalls).toHaveLength(1);

    gate.resolve(outcome({ versions: { visual: 'a' } }));
    await expect(first.initial).resolves.toMatchObject({
      identity: { sessionId: 'session-a', captureId: 'capture-a', attempt: 1 },
      versions: { visual: 'a' },
    });
    await first.completion;

    // Disposing one session releases only its own pipeline.
    harness.recognition.dispose({ sessionId: 'session-a' });
    expect(harness.pipelines[0]?.state.disposals).toBe(1);
    expect(harness.pipelines[1]?.state.disposals).toBe(0);

    const stillReady = harness.recognition.recognize({
      sessionId: 'session-b',
      captureId: 'capture-b',
      attempt: 2,
      frame: 'frame',
    });
    await expect(stillReady.initial).resolves.toMatchObject({
      identity: { sessionId: 'session-b', attempt: 2 },
    });
    await stillReady.completion;
  });
});
