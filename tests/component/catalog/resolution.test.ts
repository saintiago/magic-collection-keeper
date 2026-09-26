import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CATALOG_LIMITS,
  CatalogError,
  createCatalog,
  type Catalog,
  type CatalogReference,
} from '../../../src/catalog/index.js';
import {
  captureCatalogError,
  createCatalogTestDatabase,
  publishCatalog,
  type CatalogTestDatabase,
} from '../../support/catalog-database.js';

const lightningBolt = {
  cardId: 'oracle-lightning-bolt',
  name: 'Lightning Bolt',
  names: [
    { language: 'de', name: 'Blitzschlag' },
    { language: 'es', name: 'Relámpago' },
  ],
  rulesText: 'Lightning Bolt deals 3 damage to any target.',
  typeLine: 'Instant',
  colors: ['R'],
  colorIdentity: ['R'],
  manaValue: 1,
};

const delverOfSecrets = {
  cardId: 'oracle-delver-of-secrets',
  name: 'Delver of Secrets // Insectile Aberration',
  names: [
    { language: 'en', name: 'Delver of Secrets' },
    { language: 'en', name: 'Insectile Aberration' },
  ],
};

const m11Printing = {
  printingId: 'printing-m11-149-en',
  cardId: lightningBolt.cardId,
  edition: 'M11',
  collectorNumber: '149',
  language: 'en',
  finishes: ['nonfoil', 'foil'],
  physical: true,
  images: {
    small: 'https://images.example.test/m11-149-small.jpg',
    normal: 'https://images.example.test/m11-149-normal.jpg',
    large: 'https://images.example.test/m11-149-large.jpg',
    artCrop: 'https://images.example.test/m11-149-art.jpg',
  },
};

const staPrinting = {
  printingId: 'printing-sta-109-en',
  cardId: lightningBolt.cardId,
  edition: 'STA',
  collectorNumber: '109',
  language: 'en',
  finishes: ['etched'],
  physical: false,
};

function newCatalog(database: CatalogTestDatabase): Catalog {
  return createCatalog({ sql: database.sql });
}

describe('catalog resolution', () => {
  let database: CatalogTestDatabase;
  let catalog: Catalog;

  beforeEach(async () => {
    database = await createCatalogTestDatabase();
    await publishCatalog(database, {
      revisionId: 'revision-2',
      sourceVersion: 'snapshot-9',
      publishedAt: '2026-09-26T20:00:00.000Z',
      cards: [lightningBolt, delverOfSecrets],
      printings: [m11Printing, staPrinting],
    });
    catalog = newCatalog(database);
  });

  afterEach(async () => {
    await database.close();
  });

  it('resolves cards and exact printings with the revision, language, finishes and images', async () => {
    const resolution = await catalog.resolve([
      { kind: 'card', cardId: lightningBolt.cardId },
      { kind: 'printing', printingId: m11Printing.printingId },
    ]);

    expect(resolution.revision).toEqual({
      revisionId: 'revision-2',
      sourceName: 'scryfall',
      sourceVersion: 'snapshot-9',
      publishedAt: '2026-09-26T20:00:00.000Z',
    });
    expect(resolution.missing).toEqual([]);
    expect(resolution.cards.get(lightningBolt.cardId)).toEqual({
      cardId: 'oracle-lightning-bolt',
      name: 'Lightning Bolt',
      names: [
        { language: 'de', name: 'Blitzschlag' },
        { language: 'es', name: 'Relámpago' },
      ],
      rulesText: 'Lightning Bolt deals 3 damage to any target.',
      typeLine: 'Instant',
      colors: ['R'],
      colorIdentity: ['R'],
      manaValue: 1,
    });
    expect(resolution.printings.get(m11Printing.printingId)).toEqual({
      printingId: 'printing-m11-149-en',
      cardId: 'oracle-lightning-bolt',
      edition: 'M11',
      collectorNumber: '149',
      language: 'en',
      finishes: ['nonfoil', 'foil'],
      physical: true,
      images: {
        small: 'https://images.example.test/m11-149-small.jpg',
        normal: 'https://images.example.test/m11-149-normal.jpg',
        large: 'https://images.example.test/m11-149-large.jpg',
        artCrop: 'https://images.example.test/m11-149-art.jpg',
      },
    });
  });

  it('keeps unpublished card information explicit and printing facts on the printing', async () => {
    const resolution = await catalog.resolve([{ kind: 'card', cardId: delverOfSecrets.cardId }]);

    expect(resolution.cards.get(delverOfSecrets.cardId)).toEqual({
      cardId: 'oracle-delver-of-secrets',
      name: 'Delver of Secrets // Insectile Aberration',
      names: [
        { language: 'en', name: 'Delver of Secrets' },
        { language: 'en', name: 'Insectile Aberration' },
      ],
      rulesText: null,
      typeLine: null,
      colors: [],
      colorIdentity: [],
      manaValue: null,
    });
  });

  it('reports an unpublished printing as missing instead of substituting another edition', async () => {
    const resolution = await catalog.resolve([
      { kind: 'printing', printingId: 'printing-m11-149-de' },
      { kind: 'printing', printingId: m11Printing.printingId },
    ]);

    expect(resolution.missing).toEqual([{ kind: 'printing', printingId: 'printing-m11-149-de' }]);
    expect([...resolution.printings.keys()]).toEqual([m11Printing.printingId]);
    expect(resolution.printings.get(m11Printing.printingId)?.edition).toBe('M11');
  });

  it('preserves requested identities and reports missing references once, in request order', async () => {
    const resolution = await catalog.resolve([
      { kind: 'card', cardId: 'oracle-unknown' },
      { kind: 'card', cardId: lightningBolt.cardId },
      { kind: 'printing', printingId: 'printing-unknown' },
      { kind: 'card', cardId: lightningBolt.cardId },
      { kind: 'printing', printingId: m11Printing.printingId },
      { kind: 'card', cardId: 'oracle-unknown' },
    ]);

    expect(resolution.missing).toEqual([
      { kind: 'card', cardId: 'oracle-unknown' },
      { kind: 'printing', printingId: 'printing-unknown' },
    ]);
    expect([...resolution.cards.keys()]).toEqual([lightningBolt.cardId]);
    expect([...resolution.printings.keys()]).toEqual([m11Printing.printingId]);
  });

  it('keeps each card names attached to its own playable identity', async () => {
    const resolution = await catalog.resolve([
      { kind: 'card', cardId: delverOfSecrets.cardId },
      { kind: 'card', cardId: lightningBolt.cardId },
    ]);

    expect(resolution.cards.get(lightningBolt.cardId)?.names).toEqual([
      { language: 'de', name: 'Blitzschlag' },
      { language: 'es', name: 'Relámpago' },
    ]);
    expect(resolution.cards.get(delverOfSecrets.cardId)?.names).toEqual([
      { language: 'en', name: 'Delver of Secrets' },
      { language: 'en', name: 'Insectile Aberration' },
    ]);
  });

  it('resolves an empty request to the published revision without records', async () => {
    const resolution = await catalog.resolve([]);

    expect(resolution.revision.revisionId).toBe('revision-2');
    expect(resolution.cards.size).toBe(0);
    expect(resolution.printings.size).toBe(0);
    expect(resolution.missing).toEqual([]);
  });

  it('rejects a batch beyond the documented bound', async () => {
    const references: CatalogReference[] = Array.from(
      { length: CATALOG_LIMITS.maxResolutionReferences + 1 },
      (_, index) => ({ kind: 'card', cardId: `oracle-${index}` }),
    );

    const error = await captureCatalogError(catalog.resolve(references));
    expect(error).toBeInstanceOf(CatalogError);
    expect(error.code).toBe('invalid-request');
  });

  it('rejects a reference that does not carry a typed identity', async () => {
    const mistyped = [
      { kind: 'printing', cardId: lightningBolt.cardId },
      { kind: 'card', cardId: '' },
    ] as unknown as CatalogReference[];

    const error = await captureCatalogError(catalog.resolve(mistyped));
    expect(error.code).toBe('invalid-request');
  });

  it('reports an unreadable catalog as unavailable instead of a missing record', async () => {
    const failing = createCatalog({
      sql: {
        async query() {
          throw new Error('the database connection was lost');
        },
      },
    });

    const error = await captureCatalogError(
      failing.resolve([{ kind: 'card', cardId: lightningBolt.cardId }]),
    );
    expect(error.code).toBe('unavailable');
    expect(error.cause).toBeInstanceOf(Error);
  });

  it('reports an unpublished catalog as unavailable instead of an empty catalog', async () => {
    const empty = await createCatalogTestDatabase();
    try {
      const error = await captureCatalogError(
        newCatalog(empty).resolve([{ kind: 'card', cardId: lightningBolt.cardId }]),
      );
      expect(error.code).toBe('unavailable');
      expect(error.message).toMatch(/no published revision/);
    } finally {
      await empty.close();
    }
  });

  it('serves reads from the published catalog without a live provider request', async () => {
    const provider = vi.fn(() => {
      throw new Error('a live provider must not be called for a read');
    });
    vi.stubGlobal('fetch', provider);
    try {
      const resolution = await catalog.resolve([{ kind: 'card', cardId: lightningBolt.cardId }]);

      expect(resolution.cards.size).toBe(1);
      expect(provider).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
