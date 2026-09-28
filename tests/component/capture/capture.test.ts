/**
 * Component scope: the headless Capture component (docs/capture.md#interface,
 * docs/capture.md#admission-and-lifecycle, docs/testing.md#capture).
 *
 * A controlled device supplies frames and a scripted engine pipeline supplies readings, so one
 * session runs without a browser camera: it admits a settled single-card frame only with a usable
 * identity from the same capture, coordinates staging through UserCards' real browser operation
 * lifecycle, keeps an unknown outcome recoverable through its own handle, attaches later
 * comparisons and releases the camera and the Recognition session. The CaptureControls
 * presentation of these states is exercised as browser behavior in tests/browser/capture.spec.ts.
 */

import { describe, expect, it } from 'vitest';

import { CAPTURE_LIMITS, createCapture, type CaptureSnapshot } from '../../../src/capture/index.js';
import { recognitionEngineNames } from '../../../src/recognition/index.js';

import {
  createCaptureHarness,
  entry,
  flush,
  session,
  still,
  TestClock,
  type CaptureHarness,
  type TestFrame,
} from './harness.js';

/** Presents a motionless frame and runs the loop until one attempt is due. */
async function settleFrame(
  harness: CaptureHarness,
  signature: readonly number[] = still,
): Promise<void> {
  harness.scene(signature, { width: 320, height: 240 });
  await harness.advance(CAPTURE_LIMITS.settleMs + CAPTURE_LIMITS.sampleMs * 2);
}

describe('capture session', () => {
  it('reports a deployment without a camera and starts no work', async () => {
    const harness = createCaptureHarness({ camera: false });

    expect(harness.current().status).toEqual({ kind: 'unavailable', failure: null });
    await harness.capture.start();

    expect(harness.current().status.kind).toBe('unavailable');
    expect(harness.preparations()).toEqual([]);
    expect(harness.recognitions()).toEqual([]);
    expect(harness.camera().opened).toBe(0);
  });

  it('reports a refused camera and keeps the session startable', async () => {
    const harness = createCaptureHarness({ denial: 'Camera permission was refused.' });

    await harness.capture.start();

    expect(harness.current().status).toEqual({
      kind: 'failed',
      failure: 'Camera permission was refused.',
    });
    expect(harness.current().running).toBe(false);
    expect(harness.preparations()).toEqual([]);
    expect(harness.recognitions()).toEqual([]);
    expect(harness.camera().opened).toBe(1);
  });

  it('admits a settled single-card frame with its suggestion and alternatives', async () => {
    const harness = createCaptureHarness();
    harness.script({
      candidates: [{ cardId: 'card-bolt', printingId: 'printing-bolt' }],
      printingId: 'printing-bolt',
    });
    await harness.capture.start();
    await settleFrame(harness);

    const staged = harness.captures()[0];
    expect(staged?.input).toEqual({
      sessionId: 'import-1',
      // The observation carries the identity of the attempt the same frame was read for.
      captureId: harness.recognitions()[0]?.captureId,
      printingId: 'printing-bolt',
      finish: null,
      candidates: [
        { printingId: 'printing-bolt', provider: 'recognition', evidence: 'title-evidence' },
      ],
    });
    harness.settleCapture(staged!, {
      privateRevision: 'private-2',
      outcome: 'admitted',
      replayed: false,
      session: session(),
      entry: entry(),
    });
    await flush();

    expect(harness.events()).toContainEqual(
      expect.objectContaining({
        kind: 'accepted',
        cue: 'accepted',
        captureId: staged?.input.captureId,
        entryId: 'capture-1',
        replayed: false,
        reading: expect.objectContaining({
          suggestedPrintingId: 'printing-bolt',
          presence: 'single',
          uncertain: false,
        }),
      }),
    );
    expect(harness.reviews()).toContainEqual({
      kind: 'staged',
      session: session(),
      entryId: 'capture-1',
    });
    expect(harness.current().recoverable).toBe(false);
  });

  it('never admits a frame that has not settled', async () => {
    const harness = createCaptureHarness();
    harness.script({ candidates: [{ cardId: 'card-bolt', printingId: 'printing-bolt' }] });
    await harness.capture.start();

    harness.scene(still, { width: 320, height: 240 }, true);
    await harness.advance(CAPTURE_LIMITS.settleMs * 4);

    expect(harness.recognitions()).toEqual([]);
    expect(harness.captures()).toEqual([]);
  });

  it('guides the owner instead of admitting geometry that is not exactly one card', async () => {
    const harness = createCaptureHarness();
    await harness.capture.start();
    const presences = ['none', 'multiple', 'ambiguous'] as const;
    for (const [index, presence] of presences.entries()) {
      harness.script({
        candidates: [{ cardId: 'card-bolt', printingId: 'printing-bolt' }],
        cardPresence: presence,
      });
      await settleFrame(harness, [121 + index, 121 + index, 121 + index, 121 + index]);
      // The attempt settles with guidance, so the next scene may start another one.
      await harness.advance(CAPTURE_LIMITS.retryMs.guidance + CAPTURE_LIMITS.sampleMs);
    }

    expect(harness.captures()).toEqual([]);
    expect(
      harness
        .events()
        .filter((event) => event.kind === 'guidance')
        .map((event) => (event.kind === 'guidance' ? event.presence : null)),
    ).toEqual(['none', 'multiple', 'ambiguous']);
    expect(harness.current().recoverable).toBe(false);
  });

  it('treats a frame without established geometry as unresolved, not as admission', async () => {
    const harness = createCaptureHarness();
    harness.script({
      candidates: [{ cardId: 'card-bolt', printingId: 'printing-bolt' }],
      cardPresence: null,
    });
    await harness.capture.start();
    await settleFrame(harness);

    expect(harness.captures()).toEqual([]);
    expect(harness.events()).toContainEqual(
      expect.objectContaining({ kind: 'unresolved', reason: 'geometry', cue: 'error' }),
    );
  });

  it('leaves a single-card frame without a usable identity unresolved', async () => {
    const harness = createCaptureHarness();
    harness.script({ status: 'unknown', cardPresence: 'single' });
    await harness.capture.start();
    await settleFrame(harness);

    expect(harness.captures()).toEqual([]);
    expect(harness.events()).toContainEqual(
      expect.objectContaining({ kind: 'unresolved', reason: 'identity', cue: 'error' }),
    );
    // An unresolved reading is no success: the admitted event stays absent.
    expect(harness.events().some((event) => event.kind === 'accepted')).toBe(false);
  });

  it('reports a camera that delivers no frame as an unavailable attempt', async () => {
    const harness = createCaptureHarness();
    await harness.capture.start();
    harness.scene(still, null);
    await harness.advance(CAPTURE_LIMITS.settleMs + CAPTURE_LIMITS.sampleMs * 2);

    expect(harness.recognitions()).toEqual([]);
    expect(harness.captures()).toEqual([]);
    expect(harness.events()).toContainEqual(
      expect.objectContaining({
        kind: 'unavailable',
        reason: 'frame',
        cue: 'error',
        recoverable: false,
      }),
    );
  });

  it('resolves an unresolved attempt with a later comparison of the same capture', async () => {
    const harness = createCaptureHarness();
    harness.script({
      status: 'unknown',
      cardPresence: 'single',
      provisional: true,
      later: {
        candidates: [{ cardId: 'card-bolt', printingId: 'printing-bolt' }],
        printingId: 'printing-bolt',
      },
    });
    await harness.capture.start();
    await settleFrame(harness);
    expect(harness.captures()).toEqual([]);

    harness.completeLater();
    await flush();
    const staged = harness.captures()[0];
    expect(staged?.input.captureId).toBe(harness.recognitions()[0]?.captureId);
    harness.settleCapture(staged!, {
      privateRevision: 'private-2',
      outcome: 'admitted',
      replayed: false,
      session: session(),
      entry: entry(),
    });
    await flush();

    // The late reading resolved the attempt the frame belongs to; no second observation exists.
    expect(harness.captures()).toHaveLength(1);
    expect(harness.events().some((event) => event.kind === 'accepted')).toBe(true);
  });

  it('attaches later comparisons as alternatives beside the admitted entry', async () => {
    const harness = createCaptureHarness();
    harness.script({
      candidates: [{ cardId: 'card-bolt', printingId: 'printing-bolt' }],
      printingId: 'printing-bolt',
      provisional: true,
      later: {
        candidates: [
          { cardId: 'card-bolt', printingId: 'printing-bolt' },
          { cardId: 'card-ring', printingId: 'printing-ring' },
        ],
        printingId: 'printing-bolt',
      },
    });
    await harness.capture.start();
    await settleFrame(harness);
    const staged = harness.captures()[0]!;
    harness.settleCapture(staged, {
      privateRevision: 'private-2',
      outcome: 'admitted',
      replayed: false,
      session: session(),
      entry: entry(),
    });
    await flush();

    harness.completeLater();
    await flush();
    expect(harness.attachments()[0]?.input).toEqual({
      entryId: 'capture-1',
      candidates: [
        { printingId: 'printing-bolt', provider: 'recognition', evidence: 'title-evidence' },
        { printingId: 'printing-ring', provider: 'recognition', evidence: 'engine-ranking' },
      ],
    });
    harness.settleAttach(harness.attachments()[0]!, {
      privateRevision: 'private-3',
      session: session({ revision: 3 }),
      entry: entry({ revision: 4 }),
    });
    await flush();

    expect(harness.events()).toContainEqual(
      expect.objectContaining({
        kind: 'comparison',
        outcome: 'attached',
        cue: null,
        reading: expect.objectContaining({ candidates: expect.any(Array) }),
      }),
    );
    // The accepted capture stays accepted; the comparison never retracts it.
    expect(harness.events().some((event) => event.kind === 'accepted')).toBe(true);
  });

  it('keeps a lost staging response recoverable and starts no second attempt', async () => {
    const harness = createCaptureHarness();
    harness.script({ candidates: [{ cardId: 'card-bolt', printingId: 'printing-bolt' }] });
    await harness.capture.start();
    await settleFrame(harness);
    const submitted = harness.captures()[0]!;
    submitted.fail('unavailable', 'Response lost.');
    await flush();

    expect(harness.current().recoverable).toBe(true);
    expect(harness.events()).toContainEqual(
      expect.objectContaining({ kind: 'unavailable', reason: 'staging', recoverable: true }),
    );
    expect(harness.reviews()).toContainEqual({ kind: 'unknown' });

    // A changed scene cannot replace the outstanding capture with a new identity.
    await settleFrame(harness, [200, 200, 200, 200]);
    expect(harness.recognitions()).toHaveLength(1);
    expect(harness.captures()).toHaveLength(1);

    // Recovery replays exactly the observation the capture identity owns.
    void harness.capture.retry();
    await flush();
    const replay = harness.captures()[1];
    expect(replay?.input).toEqual(submitted.input);
    harness.settleCapture(replay!, {
      privateRevision: 'private-2',
      outcome: 'admitted',
      replayed: true,
      session: session(),
      entry: entry(),
    });
    await flush();

    expect(harness.current().recoverable).toBe(false);
    expect(harness.events().some((event) => event.kind === 'accepted' && event.replayed)).toBe(
      true,
    );
  });

  it('rejects a definite staging refusal without keeping it recoverable', async () => {
    const harness = createCaptureHarness();
    harness.script({ candidates: [{ cardId: 'card-bolt', printingId: 'printing-bolt' }] });
    await harness.capture.start();
    await settleFrame(harness);
    harness.captures()[0]!.fail('invalid-request', 'The capture was refused.');
    await flush();

    expect(harness.current().recoverable).toBe(false);
    expect(harness.current().busy).toBe(false);
    expect(harness.events()).toContainEqual(
      expect.objectContaining({
        kind: 'unavailable',
        reason: 'staging',
        recoverable: false,
        failure: 'The capture was refused.',
      }),
    );
  });

  it('reports a preparation failure without a success cue and keeps sampling', async () => {
    const harness = createCaptureHarness();
    harness.failPreparation('the models are missing.');
    harness.script({ status: 'unknown' });
    await harness.capture.start();
    await settleFrame(harness);

    expect(harness.events()).toContainEqual(
      expect.objectContaining({
        kind: 'unavailable',
        reason: 'preparation',
        cue: null,
      }),
    );
    // The Recognition component owns its failure vocabulary; the session preserves what it
    // reported instead of inventing a successful attempt.
    expect(harness.events().find((event) => event.kind === 'unavailable')?.failure).toBeTruthy();
    expect(harness.events().some((event) => event.cue === 'accepted')).toBe(false);
    expect(harness.current().running).toBe(true);
  });

  it('releases the camera and reports the stop while keeping a submitted write recoverable', async () => {
    const harness = createCaptureHarness();
    harness.script({ candidates: [{ cardId: 'card-bolt', printingId: 'printing-bolt' }] });
    await harness.capture.start();
    await settleFrame(harness);

    harness.capture.stop();
    expect(harness.camera().closed).toBe(true);
    expect(harness.camera().released).toBe(1);
    expect(harness.current().status.kind).toBe('stopped');
    expect(harness.current().running).toBe(false);
    expect(harness.current().recoverable).toBe(true);

    const submitted = harness.captures()[0]!;
    submitted.fail('unavailable', 'Response lost.');
    await flush();
    void harness.capture.retry();
    await flush();
    expect(harness.captures()[1]?.input).toEqual(submitted.input);
  });

  it('suppresses late readings after disposal', async () => {
    const harness = createCaptureHarness();
    harness.script({
      candidates: [{ cardId: 'card-bolt', printingId: 'printing-bolt' }],
      provisional: true,
      later: { candidates: [{ cardId: 'card-bolt', printingId: 'printing-bolt' }] },
    });
    await harness.capture.start();
    await settleFrame(harness);
    const staged = harness.captures()[0]!;
    harness.settleCapture(staged, {
      privateRevision: 'private-2',
      outcome: 'admitted',
      replayed: false,
      session: session(),
      entry: entry(),
    });
    await flush();

    harness.capture.dispose();
    const observed = harness.states.length;
    harness.completeLater();
    await flush();

    expect(harness.attachments()).toEqual([]);
    expect(harness.states.length).toBe(observed);
    expect(harness.camera().closed).toBe(true);
  });

  it('recovers an attempt an earlier session left retained, without a camera', async () => {
    const harness = createCaptureHarness({
      retained: {
        sessionId: 'import-earlier',
        captureId: 'capture-earlier',
        printingId: 'printing-bolt',
      },
    });
    await flush();

    expect(harness.current().recoverable).toBe(true);
    void harness.capture.retry();
    await flush();
    const replay = harness.captures()[1];
    expect(replay?.input).toEqual({
      sessionId: 'import-earlier',
      captureId: 'capture-earlier',
      printingId: 'printing-bolt',
    });
    harness.settleCapture(replay!, {
      privateRevision: 'private-2',
      outcome: 'suppressed',
      replayed: true,
      session: session({ sessionId: 'import-earlier' }),
      entry: null,
    });
    await flush();

    expect(harness.current().recoverable).toBe(false);
    expect(harness.events()).toContainEqual(
      expect.objectContaining({ kind: 'repeat', cue: 'repeat', replayed: true }),
    );
  });

  it('bounds the events one snapshot retains', async () => {
    const harness = createCaptureHarness({
      retained: {
        sessionId: 'import-1',
        captureId: 'capture-earlier',
        printingId: 'printing-bolt',
      },
    });
    await flush();
    for (let index = 0; index < CAPTURE_LIMITS.eventHistory + 4; index += 1) {
      void harness.capture.retry();
      await flush();
      harness.captures()[index]?.fail('unavailable', 'Response lost.');
      await flush();
    }

    expect(harness.current().events.length).toBeLessThanOrEqual(CAPTURE_LIMITS.eventHistory);
    expect(harness.current().events.length).toBeGreaterThan(0);
  });

  it('keeps the replacement camera when a superseded acquisition fails', async () => {
    const harness = createCaptureHarness();
    harness.holdCamera();
    void harness.capture.start();
    await flush();
    harness.capture.stop();
    harness.holdCamera();
    void harness.capture.start();
    await flush();
    expect(harness.current().status.kind).toBe('starting');

    // The refused request of the first start belongs to the lifetime the stop ended: its failure
    // must not stop the camera the replacement is acquiring.
    harness.denyCamera('Camera permission was refused.');
    await flush();

    expect(harness.current().status.kind).toBe('starting');
    expect(harness.events()).toEqual([]);
    harness.grantCamera();
    await flush();

    expect(harness.camera().opened).toBe(2);
    expect(harness.camera().closed).toBe(false);
    expect(harness.current().status.kind).toBe('running');
  });

  it('recovers a retained attempt under the lifetime of the session that replays it', async () => {
    const harness = createCaptureHarness();
    harness.script({
      candidates: [{ cardId: 'card-bolt', printingId: 'printing-bolt' }],
      printingId: 'printing-bolt',
    });
    await harness.capture.start();
    await settleFrame(harness);
    const first = harness.captures()[0]!;

    // Leaving the view ends the caller scope the submission was begun with; the observation stays
    // with the account and is recovered when the owner returns
    // (docs/user-cards.md#browser-operation-lifecycle).
    harness.capture.dispose();
    expect(first.aborted).toBe(true);
    first.fail('unavailable', 'Response lost.');
    await flush();

    const returning = harness.reopen();
    expect(harness.current().recoverable).toBe(true);
    void returning.retry();
    await flush();

    const replay = harness.captures()[1];
    expect(replay?.input).toEqual(first.input);
    // The replay carries the recovering lifetime, not the aborted scope of the departed view.
    expect(replay?.aborted).toBe(false);
  });

  it('keeps only the replacement camera when a superseded acquisition grants late', async () => {
    const harness = createCaptureHarness();
    harness.holdCamera();
    void harness.capture.start();
    await flush();
    harness.capture.stop();
    harness.holdCamera();
    void harness.capture.start();
    await flush();

    // The stream the first start granted arrives late; it is released without touching the
    // acquisition of the replacement.
    harness.grantCamera();
    await flush();
    expect(harness.current().status.kind).toBe('starting');

    harness.grantCamera();
    harness.script({ candidates: [{ cardId: 'card-bolt', printingId: 'printing-bolt' }] });
    await flush();
    await settleFrame(harness);

    expect(harness.current().status.kind).toBe('running');
    expect(harness.captures()).toHaveLength(1);
  });

  it('ignores a preparation of the camera its replacement superseded', async () => {
    const harness = createCaptureHarness();
    harness.holdPreparation();
    harness.holdPreparation();
    await harness.capture.start();
    harness.capture.stop();
    await harness.capture.start();
    expect(harness.preparations()).toHaveLength(2);
    expect(harness.current().status.kind).toBe('preparing');

    // The cancellation of the released run's preparation reports into no later run.
    await flush();
    expect(harness.events()).toEqual([]);
    expect(harness.current().status.kind).toBe('preparing');

    // The replacement's own preparation is what announces the readiness of its run.
    harness.completePreparation();
    harness.completePreparation();
    await flush();
    expect(harness.current().status.kind).toBe('running');
  });

  it('writes no readiness from the preparation of a camera its replacement owns', async () => {
    const clock = new TestClock();
    const preparations: (() => void)[] = [];
    const session = createCapture<TestFrame>({
      accountId: 'alice',
      importId: 'import-1',
      device: {
        openCamera: () =>
          Promise.resolve({
            preview: { stream: {} as MediaStream },
            sample: () => null,
            read: () => null,
            close: () => {},
          }),
        release: () => {},
      },
      // The supplied runtime holds each preparation open, so the case decides when a released
      // camera's preparation settles relative to the run that replaced it.
      createRecognition: () => ({
        prepare: (request) =>
          new Promise((resolve) => {
            preparations.push(() =>
              resolve({
                sessionId: request.sessionId,
                engines: [...request.engines],
                versions: {},
                timings: {},
              }),
            );
          }),
        recognize: () => ({
          initial: Promise.reject(new Error('The case runs no inference.')),
          completion: Promise.resolve(),
        }),
        dispose: () => {},
      }),
      staging: {
        stage: () => ({
          operationId: 'capture-1',
          observe: () => Promise.resolve({ state: 'unknown' as const }),
        }),
        attach: () => ({
          operationId: 'entry-1',
          observe: () => Promise.resolve({ state: 'unknown' as const }),
        }),
        retained: () => [],
        resume: () => null,
      },
      engines: recognitionEngineNames(false),
      timers: clock,
    });
    const states: CaptureSnapshot[] = [];
    session.observe((snapshot) => states.push(snapshot));

    await session.start();
    session.stop();
    await session.start();
    expect(preparations).toHaveLength(2);
    expect(states.at(-1)?.status.kind).toBe('preparing');

    // The released run's preparation completing late announces nothing about the replacement.
    preparations[0]!();
    await flush();
    expect(states.at(-1)?.status.kind).toBe('preparing');

    preparations[1]!();
    await flush();
    expect(states.at(-1)?.status.kind).toBe('running');
    session.dispose();
  });

  it('publishes a later reading while its earlier submission is still unresolved', async () => {
    const harness = createCaptureHarness();
    harness.script({
      candidates: [{ cardId: 'card-bolt', printingId: 'printing-bolt' }],
      printingId: 'printing-bolt',
      provisional: true,
      later: [
        { candidates: [{ cardId: 'card-bolt', printingId: 'printing-bolt' }] },
        { candidates: [{ cardId: 'card-ring', printingId: 'printing-ring' }] },
      ],
    });
    await harness.capture.start();
    await settleFrame(harness);
    expect(harness.captures()).toHaveLength(1);

    harness.completeLater();
    await flush();

    // The submission is still in flight, yet the newer reading is the observable evidence.
    expect(harness.current().busy).toBe(true);
    expect(harness.current().attempt?.reading?.revision).toBe(2);
    expect(harness.current().attempt?.reading?.candidates).toEqual([
      expect.objectContaining({ printingId: 'printing-bolt' }),
    ]);
    expect(harness.events().some((event) => event.kind === 'accepted')).toBe(false);

    const staged = harness.captures()[0]!;
    harness.settleCapture(staged, {
      privateRevision: 'private-2',
      outcome: 'admitted',
      replayed: false,
      session: session(),
      entry: entry(),
    });
    await flush();
    expect(harness.events().some((event) => event.kind === 'accepted')).toBe(true);
  });

  it('publishes a later reading while its earlier alternatives are attached', async () => {
    const harness = createCaptureHarness();
    harness.script({
      candidates: [{ cardId: 'card-bolt', printingId: 'printing-bolt' }],
      printingId: 'printing-bolt',
      provisional: true,
      later: [
        { candidates: [{ cardId: 'card-bolt', printingId: 'printing-bolt' }] },
        { candidates: [{ cardId: 'card-ring', printingId: 'printing-ring' }] },
      ],
    });
    await harness.capture.start();
    await settleFrame(harness);
    harness.completeLater();
    await flush();
    harness.settleCapture(harness.captures()[0]!, {
      privateRevision: 'private-2',
      outcome: 'admitted',
      replayed: false,
      session: session(),
      entry: entry(),
    });
    await flush();
    expect(harness.attachments()).toHaveLength(1);

    harness.completeLater();
    await flush();

    expect(harness.current().busy).toBe(true);
    expect(harness.current().attempt?.reading?.revision).toBe(3);
    expect(harness.current().attempt?.reading?.candidates).toEqual([
      expect.objectContaining({ printingId: 'printing-ring' }),
    ]);
  });
});
