/**
 * Integration scope: Recognition validates and resolves candidate identities through the real
 * Catalog read contract over PostgreSQL. The engine pipeline stays a controlled substitute, so
 * this proves the provider's actual output — published revisions, canonical names and missing
 * references — reaches the mapped reading (docs/recognition.md#interface, docs/testing.md).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCatalog } from '../../src/catalog/index.js';
import {
  createRecognition,
  type Recognition,
  type RecognitionCatalogPort,
  type RecognitionEngineOutcome,
} from '../../src/recognition/index.js';
import {
  createCatalogTestDatabase,
  publishCatalog,
  type CatalogTestDatabase,
} from '../support/catalog-database.js';

const lightningBolt = {
  cardId: 'oracle-lightning-bolt',
  name: 'Lightning Bolt',
  names: [{ language: 'es', name: 'Relámpago' }],
};

const m11Printing = {
  printingId: 'printing-m11-149-en',
  cardId: lightningBolt.cardId,
  edition: 'M11',
  collectorNumber: '149',
  language: 'en',
  finishes: ['nonfoil', 'foil'],
  physical: true,
};

function harnessOutcome(
  candidates: RecognitionEngineOutcome['candidates'],
): RecognitionEngineOutcome {
  return {
    status: 'possible',
    candidates,
    evidence: {
      printingId: null,
      titleLanguage: 'en',
      titleCorroborated: true,
      cardPresence: 'single',
    },
    provisional: false,
    versions: { visual: '1.2.0' },
    timings: { visualMs: 12 },
  };
}

describe('recognition candidate resolution through Catalog', () => {
  let database: CatalogTestDatabase;
  let recognition: Recognition<string>;

  beforeEach(async () => {
    database = await createCatalogTestDatabase();
    await publishCatalog(database, {
      revisionId: 'revision-1',
      cards: [lightningBolt],
      printings: [m11Printing],
    });
  });

  afterEach(async () => {
    await database.close();
  });

  function recognizeWith(
    outcome: RecognitionEngineOutcome,
    catalog: RecognitionCatalogPort = createCatalog({ sql: database.sql }),
  ): Recognition<string> {
    const recognitionInstance = createRecognition<string>({
      createEnginePipeline: () => ({
        prepare: async () => ({}),
        recognize: async () => outcome,
        dispose: () => {},
      }),
      catalog,
      inspectFrame: () => ({ width: 400, height: 560, format: 'jpeg', encodedBytes: 2048 }),
    });
    return recognitionInstance;
  }

  async function read(instance: Recognition<string>) {
    await instance.prepare({ sessionId: 'session-1', engines: ['browser-onnx'] });
    const attempt = instance.recognize({
      sessionId: 'session-1',
      captureId: 'capture-1',
      attempt: 1,
      frame: 'frame',
    });
    return attempt.initial;
  }

  it('maps published printings and drops identities the revision does not contain', async () => {
    recognition = recognizeWith(
      harnessOutcome([
        {
          cardId: lightningBolt.cardId,
          printingId: m11Printing.printingId,
          name: 'Bolt (engine read)',
          score: 0.91,
        },
        {
          cardId: lightningBolt.cardId,
          printingId: 'printing-not-published',
          name: 'Reprint',
          score: 0.55,
        },
      ]),
    );
    const reading = await read(recognition);

    expect(reading.status).toBe('possible');
    expect(reading.candidates).toEqual([
      {
        cardId: lightningBolt.cardId,
        printingId: m11Printing.printingId,
        name: 'Lightning Bolt',
        score: 0.91,
      },
    ]);
    expect(reading.suggestion).toEqual({
      candidateIndex: 0,
      printingId: m11Printing.printingId,
      basis: 'representative',
    });
    expect(reading.evidence.titleCorroborated).toBe(true);
    expect(reading.versions).toEqual({ visual: '1.2.0' });
    expect(reading.timings).toEqual({ visualMs: 12 });
  });

  it('reports an unknown reading when no proposed identity is published', async () => {
    recognition = recognizeWith(
      harnessOutcome([
        {
          cardId: 'oracle-not-published',
          printingId: 'printing-not-published',
          name: 'Unknown card',
          score: 0.7,
        },
      ]),
    );
    const reading = await read(recognition);

    expect(reading.status).toBe('unknown');
    expect(reading.candidates).toEqual([]);
    expect(reading.suggestion).toBeNull();
    expect(reading.evidence).toMatchObject({ titleLanguage: 'en', titleCorroborated: true });
  });

  it('fails the attempt as unavailable when the Catalog read cannot serve the revision', async () => {
    recognition = recognizeWith(
      harnessOutcome([
        {
          cardId: lightningBolt.cardId,
          printingId: m11Printing.printingId,
          name: 'Lightning Bolt',
          score: 0.9,
        },
      ]),
      {
        resolve: async () => {
          throw new Error('catalog unavailable');
        },
      },
    );
    await recognition.prepare({ sessionId: 'session-1', engines: ['browser-onnx'] });
    const attempt = recognition.recognize({
      sessionId: 'session-1',
      captureId: 'capture-1',
      attempt: 1,
      frame: 'frame',
    });

    await expect(attempt.initial).rejects.toMatchObject({ code: 'unavailable' });
    await attempt.completion;
  });
});
