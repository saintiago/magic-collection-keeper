/**
 * Component scope: the Recognition candidate contract (docs/recognition.md#interface). Raw engine
 * outcomes are mapped into catalog-validated readings: candidate identities and canonical names
 * come from the published Catalog, no-card/multiple-card/ambiguous geometry stays unknown, a
 * suggestion always belongs to the candidate set, and only engine evidence makes a printing
 * corroborated.
 */

import { describe, expect, it } from 'vitest';

import {
  RECOGNITION_LIMITS,
  type RecognitionEngineOutcome,
  type RecognitionReading,
} from '../../../src/recognition/index.js';

import {
  callerInput,
  card,
  createRecognitionHarness,
  outcome,
  printing,
  type CatalogFixture,
  type RecognitionHarness,
} from './harness.js';

const bolt = card('card-bolt', 'Lightning Bolt');
const counterspell = card('card-counterspell', 'Counterspell');
const boltM11 = printing('printing-bolt-m11', 'card-bolt', '149', 'M11');
const boltSta = printing('printing-bolt-sta', 'card-bolt', '109', 'STA');
const counterspellM11 = printing('printing-counterspell-m11', 'card-counterspell', '57', 'M11');
const fixture: CatalogFixture = {
  cards: [bolt, counterspell],
  printings: [boltM11, boltSta, counterspellM11],
};

const prepareRequest = { sessionId: 'session-1', engines: ['browser-onnx'] } as const;

function harnessFor(
  result: unknown,
  options: { readonly fixture?: CatalogFixture } = {},
): RecognitionHarness {
  return createRecognitionHarness({
    fixture: options.fixture ?? fixture,
    configurePipeline: (stub) => {
      stub.state.recognize = async () => callerInput<RecognitionEngineOutcome>(result);
    },
  });
}

async function readOutcome(
  result: unknown,
  options: { readonly fixture?: CatalogFixture } = {},
): Promise<RecognitionReading> {
  const harness = harnessFor(result, options);
  await harness.recognition.prepare(prepareRequest);
  const attempt = harness.recognition.recognize({
    ...prepareRequest,
    captureId: 'capture-1',
    attempt: 1,
    frame: 'frame',
  });
  return attempt.initial;
}

describe('recognition candidate mapping', () => {
  it('validates candidate identities against Catalog and keeps the engine order', async () => {
    const reading = await readOutcome(
      outcome({
        status: 'possible',
        candidates: [
          {
            cardId: bolt.cardId,
            printingId: boltM11.printingId,
            name: 'Bolt (OCR read)',
            score: 0.91,
          },
          { cardId: bolt.cardId, printingId: boltSta.printingId, name: 'Bolt', score: 0.72 },
        ],
      }),
    );

    expect(reading.status).toBe('possible');
    expect(reading.candidates.map((candidate) => candidate.printingId)).toEqual([
      'printing-bolt-m11',
      'printing-bolt-sta',
    ]);
    // The canonical name comes from Catalog, not from the engine's reading.
    expect(reading.candidates.map((candidate) => candidate.name)).toEqual([
      'Lightning Bolt',
      'Lightning Bolt',
    ]);
    expect(reading.candidates.map((candidate) => candidate.score)).toEqual([0.91, 0.72]);
    expect(reading.candidates.every((candidate) => candidate.cardId === 'card-bolt')).toBe(true);
  });

  it('suggests the leading candidate as editable representative printing', async () => {
    const reading = await readOutcome(
      outcome({
        status: 'possible',
        candidates: [
          { cardId: bolt.cardId, printingId: boltM11.printingId, name: 'Bolt', score: null },
          { cardId: bolt.cardId, printingId: boltSta.printingId, name: 'Bolt', score: null },
        ],
      }),
    );

    expect(reading.suggestion).toEqual({
      candidateIndex: 0,
      printingId: 'printing-bolt-m11',
      basis: 'representative',
    });
    // A representative suggestion is not evidence that the observed edition was recognized.
    expect(reading.evidence.printingId).toBeNull();
    expect(reading.evidence.titleCorroborated).toBe(false);
  });

  it('marks an engine-corroborated printing as evidence and suggestion basis', async () => {
    const reading = await readOutcome(
      outcome({
        status: 'possible',
        candidates: [
          { cardId: bolt.cardId, printingId: boltM11.printingId, name: 'Bolt', score: 0.9 },
          { cardId: bolt.cardId, printingId: boltSta.printingId, name: 'Bolt', score: 0.8 },
        ],
        evidence: {
          printingId: boltSta.printingId,
          titleLanguage: 'es',
          titleCorroborated: true,
          cardPresence: 'single',
        },
      }),
    );

    expect(reading.suggestion).toEqual({
      candidateIndex: 1,
      printingId: 'printing-bolt-sta',
      basis: 'corroborated',
    });
    expect(reading.evidence).toEqual({
      printingId: 'printing-bolt-sta',
      titleLanguage: 'es',
      titleCorroborated: true,
      cardPresence: 'single',
    });
  });

  it('never promotes a printing Catalog cannot resolve into evidence', async () => {
    const reading = await readOutcome(
      outcome({
        status: 'possible',
        candidates: [
          { cardId: bolt.cardId, printingId: boltM11.printingId, name: 'Bolt', score: null },
        ],
        evidence: {
          printingId: 'printing-not-published',
          titleLanguage: null,
          titleCorroborated: false,
          cardPresence: 'single',
        },
      }),
    );

    expect(reading.status).toBe('possible');
    expect(reading.suggestion).toMatchObject({
      candidateIndex: 0,
      printingId: 'printing-bolt-m11',
      basis: 'representative',
    });
    // The engine's own evidence stays visible behind the mapping boundary.
    expect(reading.evidence.printingId).toBe('printing-not-published');
  });

  it('drops candidates the published Catalog cannot validate', async () => {
    const harness = harnessFor(
      outcome({
        status: 'possible',
        candidates: [
          { cardId: bolt.cardId, printingId: 'printing-not-published', name: 'Bolt', score: null },
          // The printing exists but belongs to another playable identity.
          {
            cardId: bolt.cardId,
            printingId: counterspellM11.printingId,
            name: 'Wrong pair',
            score: 0.4,
          },
        ],
        evidence: {
          printingId: null,
          titleLanguage: 'en',
          titleCorroborated: true,
          cardPresence: 'single',
        },
      }),
    );
    await harness.recognition.prepare(prepareRequest);
    const attempt = harness.recognition.recognize({
      ...prepareRequest,
      captureId: 'capture-1',
      attempt: 1,
      frame: 'frame',
    });
    const reading = await attempt.initial;

    expect(reading.status).toBe('unknown');
    expect(reading.candidates).toEqual([]);
    expect(reading.suggestion).toBeNull();
    expect(reading.evidence.titleLanguage).toBe('en');
    expect(reading.evidence.titleCorroborated).toBe(true);
    expect(harness.catalogCalls).toHaveLength(1);
  });

  it('reports no usable identity for possible outcomes without a candidate', async () => {
    const harness = harnessFor(outcome({ status: 'possible' }));
    await harness.recognition.prepare(prepareRequest);
    const attempt = harness.recognition.recognize({
      ...prepareRequest,
      captureId: 'capture-1',
      attempt: 1,
      frame: 'frame',
    });
    const reading = await attempt.initial;

    expect(reading.status).toBe('unknown');
    expect(reading.candidates).toEqual([]);
    expect(reading.suggestion).toBeNull();
    expect(harness.catalogCalls).toHaveLength(0);
  });

  it.each(['none', 'multiple', 'ambiguous'] as const)(
    'does not turn %s card geometry into a successful identity',
    async (cardPresence) => {
      const harness = harnessFor(
        outcome({
          status: 'possible',
          candidates: [
            { cardId: bolt.cardId, printingId: boltM11.printingId, name: 'Bolt', score: 0.9 },
          ],
          evidence: {
            printingId: boltM11.printingId,
            titleLanguage: null,
            titleCorroborated: false,
            cardPresence,
          },
        }),
      );
      await harness.recognition.prepare(prepareRequest);
      const attempt = harness.recognition.recognize({
        ...prepareRequest,
        captureId: 'capture-1',
        attempt: 1,
        frame: 'frame',
      });
      const reading = await attempt.initial;

      expect(reading.status).toBe('unknown');
      expect(reading.candidates).toEqual([]);
      expect(reading.suggestion).toBeNull();
      expect(reading.evidence.cardPresence).toBe(cardPresence);
      expect(harness.catalogCalls).toHaveLength(0);
    },
  );

  it('does not turn a possible outcome without established geometry into an identity', async () => {
    // A pipeline that reports candidates but no card count has not established that the frame
    // holds exactly one card, so the identity is not affirmative evidence.
    const harness = harnessFor(
      outcome({
        status: 'possible',
        candidates: [
          { cardId: bolt.cardId, printingId: boltM11.printingId, name: 'Bolt', score: 0.9 },
        ],
        evidence: {
          printingId: boltM11.printingId,
          titleLanguage: null,
          titleCorroborated: false,
          cardPresence: null,
        },
      }),
    );
    await harness.recognition.prepare(prepareRequest);
    const attempt = harness.recognition.recognize({
      ...prepareRequest,
      captureId: 'capture-1',
      attempt: 1,
      frame: 'frame',
    });
    const reading = await attempt.initial;

    expect(reading.status).toBe('unknown');
    expect(reading.candidates).toEqual([]);
    expect(reading.suggestion).toBeNull();
    expect(reading.evidence.cardPresence).toBeNull();
    expect(harness.catalogCalls).toHaveLength(0);
  });

  it('retains disagreement between candidate identities', async () => {
    const reading = await readOutcome(
      outcome({
        status: 'possible',
        candidates: [
          { cardId: bolt.cardId, printingId: boltM11.printingId, name: 'Bolt', score: 0.8 },
          {
            cardId: counterspell.cardId,
            printingId: counterspellM11.printingId,
            name: 'Counterspell',
            score: 0.7,
          },
          { cardId: bolt.cardId, printingId: boltSta.printingId, name: 'Bolt', score: 0.6 },
        ],
      }),
    );

    expect(reading.status).toBe('possible');
    expect(reading.disagreement).toEqual({ cardIds: ['card-bolt', 'card-counterspell'] });
  });

  it('keeps a late hybrid comparison as its own reading beside the early candidate', async () => {
    const harness = createRecognitionHarness({
      fixture,
      configurePipeline: (stub) => {
        stub.state.recognize = async (_frame, request) => {
          // The early candidate arrives while the later comparison is still running.
          request.onReading?.(
            outcome({
              status: 'possible',
              candidates: [
                { cardId: bolt.cardId, printingId: boltM11.printingId, name: 'Bolt', score: 0.9 },
              ],
              evidence: {
                printingId: null,
                titleLanguage: 'en',
                titleCorroborated: true,
                cardPresence: 'single',
              },
              provisional: true,
              versions: { visual: '1.2.0' },
            }),
          );
          // The comparison resolves later with a competing identity beside the early one.
          return outcome({
            status: 'possible',
            candidates: [
              { cardId: bolt.cardId, printingId: boltM11.printingId, name: 'Bolt', score: 0.9 },
              {
                cardId: counterspell.cardId,
                printingId: counterspellM11.printingId,
                name: 'Counterspell',
                score: 0.88,
              },
            ],
            evidence: {
              printingId: null,
              titleLanguage: 'en',
              titleCorroborated: true,
              cardPresence: 'single',
            },
            versions: { visual: '1.2.0' },
          });
        };
      },
    });
    await harness.recognition.prepare(prepareRequest);

    const readings: RecognitionReading[] = [];
    const attempt = harness.recognition.recognize({
      ...prepareRequest,
      captureId: 'capture-1',
      attempt: 1,
      frame: 'frame',
      onReading: (reading) => readings.push(reading),
    });
    const initial = await attempt.initial;
    await attempt.completion;

    expect(initial).toMatchObject({
      revision: 1,
      status: 'possible',
      provisional: true,
      disagreement: null,
      evidence: { titleCorroborated: true, cardPresence: 'single' },
      versions: { visual: '1.2.0' },
    });
    expect(initial.candidates.map((candidate) => candidate.cardId)).toEqual([bolt.cardId]);

    // The late comparison keeps the attempt identity and carries the competing identities
    // instead of silently replacing the early reading with one certain match.
    expect(readings).toHaveLength(1);
    expect(readings[0]).toMatchObject({
      identity: { sessionId: 'session-1', captureId: 'capture-1', attempt: 1 },
      revision: 2,
      status: 'possible',
      provisional: false,
      disagreement: { cardIds: [bolt.cardId, counterspell.cardId] },
      evidence: { titleCorroborated: true, cardPresence: 'single' },
    });
    // The early reading is not rewritten by the later comparison.
    expect(initial.revision).toBe(1);
    expect(initial.provisional).toBe(true);
    expect(initial.candidates.map((candidate) => candidate.cardId)).toEqual([bolt.cardId]);
  });

  it('bounds the candidate list of a reading', async () => {
    const printings = Array.from({ length: 7 }, (_unused, index) =>
      printing(`printing-bolt-${index}`, 'card-bolt', `${index + 1}`),
    );
    const reading = await readOutcome(
      outcome({
        status: 'possible',
        candidates: printings.map((record, index) => ({
          cardId: 'card-bolt',
          printingId: record.printingId,
          name: 'Bolt',
          score: index / 10,
        })),
      }),
      { fixture: { cards: [bolt], printings } },
    );

    expect(reading.candidates).toHaveLength(RECOGNITION_LIMITS.maxCandidates);
    expect(reading.candidates.map((candidate) => candidate.printingId)).toEqual([
      'printing-bolt-0',
      'printing-bolt-1',
      'printing-bolt-2',
      'printing-bolt-3',
      'printing-bolt-4',
    ]);
  });

  it('retains disagreement with a competing identity behind repeated printings', async () => {
    const printings = Array.from({ length: 5 }, (_unused, index) =>
      printing(`printing-bolt-${index}`, 'card-bolt', `${index + 1}`),
    );
    const reading = await readOutcome(
      outcome({
        status: 'possible',
        candidates: [
          ...printings.map((record, index) => ({
            cardId: 'card-bolt',
            printingId: record.printingId,
            name: 'Bolt',
            score: index / 10,
          })),
          {
            cardId: counterspell.cardId,
            printingId: counterspellM11.printingId,
            name: 'Counterspell',
            score: 0.05,
          },
        ],
      }),
      { fixture: { cards: [bolt, counterspell], printings: [...printings, counterspellM11] } },
    );

    // The displayed list stays bounded, but the competing playable identity is not erased.
    expect(reading.candidates).toHaveLength(RECOGNITION_LIMITS.maxCandidates);
    expect(reading.disagreement).toEqual({
      cardIds: [bolt.cardId, counterspell.cardId],
    });
  });

  it('keeps a corroborated printing the display bound would drop', async () => {
    const printings = Array.from({ length: 5 }, (_unused, index) =>
      printing(`printing-bolt-${index}`, 'card-bolt', `${index + 1}`),
    );
    const reading = await readOutcome(
      outcome({
        status: 'possible',
        candidates: [
          ...printings.map((record, index) => ({
            cardId: 'card-bolt',
            printingId: record.printingId,
            name: 'Bolt',
            score: index / 10,
          })),
          {
            cardId: counterspell.cardId,
            printingId: counterspellM11.printingId,
            name: 'Counterspell',
            score: 0.05,
          },
        ],
        evidence: {
          printingId: counterspellM11.printingId,
          titleLanguage: 'en',
          titleCorroborated: true,
          cardPresence: 'single',
        },
      }),
      { fixture: { cards: [bolt, counterspell], printings: [...printings, counterspellM11] } },
    );

    // The engine corroborated a printing outside the leading five; it stays reviewable instead of
    // being replaced by a representative printing of the leading identity.
    expect(reading.suggestion).toEqual({
      candidateIndex: RECOGNITION_LIMITS.maxCandidates - 1,
      printingId: counterspellM11.printingId,
      basis: 'corroborated',
    });
    expect(
      reading.candidates.some((candidate) => candidate.printingId === counterspellM11.printingId),
    ).toBe(true);
  });

  it.each([
    { corroborated: 0, expected: [0, 1, 2, 3, 4] },
    { corroborated: 2, expected: [0, 1, 2, 3, 4] },
    { corroborated: 4, expected: [0, 1, 2, 3, 4] },
    { corroborated: 5, expected: [0, 1, 2, 3, 5] },
  ])(
    'preserves unique ordered choices when printing $corroborated is corroborated',
    async ({ corroborated, expected }) => {
      const printings = Array.from({ length: 6 }, (_, index) =>
        printing(`p${index}`, bolt.cardId, `${index}`),
      );
      const reading = await readOutcome(
        outcome({
          status: 'possible',
          candidates: printings.map((record) => ({
            cardId: bolt.cardId,
            printingId: record.printingId,
            name: bolt.name,
            score: null,
          })),
          evidence: {
            printingId: `p${corroborated}`,
            titleLanguage: 'en',
            titleCorroborated: true,
            cardPresence: 'single',
          },
        }),
        { fixture: { cards: [bolt], printings } },
      );
      expect(reading.candidates.map((candidate) => candidate.printingId)).toEqual(
        expected.map((index) => `p${index}`),
      );
      expect(reading.suggestion).toEqual({
        printingId: `p${corroborated}`,
        candidateIndex: expected.indexOf(corroborated),
        basis: 'corroborated',
      });
    },
  );

  it('reports an unsupported engine outcome as unavailable inference', async () => {
    const harness = harnessFor(callerInput({ ...outcome(), status: 'confirmed' }));
    await harness.recognition.prepare(prepareRequest);
    const attempt = harness.recognition.recognize({
      ...prepareRequest,
      captureId: 'capture-1',
      attempt: 1,
      frame: 'frame',
    });

    await expect(attempt.initial).rejects.toMatchObject({ code: 'unavailable' });
    await attempt.completion;
  });

  it('keeps only the bounded engine versions and timings in the reading', async () => {
    const reading = await readOutcome(
      outcome(
        callerInput({
          versions: { visual: '1.2.0', ocr: '', broken: 7 },
          timings: { visualMs: 12.5, broken: -1, other: Number.NaN },
        }),
      ),
    );

    expect(reading.versions).toEqual({ visual: '1.2.0' });
    expect(reading.timings).toEqual({ visualMs: 12.5 });
  });

  it('returns a reading that carries no ownership or physical condition', async () => {
    const reading = await readOutcome(
      outcome({
        status: 'possible',
        candidates: [
          { cardId: bolt.cardId, printingId: boltM11.printingId, name: 'Bolt', score: 0.9 },
        ],
      }),
    );

    expect(Object.keys(reading).sort()).toEqual([
      'candidates',
      'disagreement',
      'evidence',
      'identity',
      'provisional',
      'revision',
      'status',
      'suggestion',
      'timings',
      'versions',
    ]);
    expect(reading.identity).toEqual({
      sessionId: 'session-1',
      captureId: 'capture-1',
      attempt: 1,
    });
  });
});
