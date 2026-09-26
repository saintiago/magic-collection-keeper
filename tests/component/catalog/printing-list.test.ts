import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CATALOG_LIMITS, createCatalog, type Catalog } from '../../../src/catalog/index.js';
import {
  captureCatalogError,
  createCatalogTestDatabase,
  publishCatalog,
  type CatalogTestDatabase,
} from '../../support/catalog-database.js';

const lightningBolt = {
  cardId: 'oracle-lightning-bolt',
  name: 'Lightning Bolt',
  rulesText: 'Lightning Bolt deals 3 damage to any target.',
  typeLine: 'Instant',
  colors: ['R'],
  colorIdentity: ['R'],
  manaValue: 1,
};

const anotherCard = {
  cardId: 'oracle-another-card',
  name: 'Another Card',
};

// Ordered by edition, collector number, language, printing identity.
const printerOrder = [
  'printing-2x2-117-es',
  'printing-m10-146-en',
  'printing-m11-149-en',
  'printing-m11-150-en',
  'printing-sta-109-en',
];

const catalogFixture = {
  revisionId: 'revision-2',
  cards: [lightningBolt, anotherCard],
  printings: [
    {
      printingId: 'printing-m11-149-en',
      cardId: lightningBolt.cardId,
      edition: 'M11',
      collectorNumber: '149',
      language: 'en',
      finishes: ['nonfoil', 'foil'],
    },
    {
      printingId: 'printing-m10-146-en',
      cardId: lightningBolt.cardId,
      edition: 'M10',
      collectorNumber: '146',
      language: 'en',
      finishes: ['nonfoil'],
    },
    {
      printingId: 'printing-2x2-117-es',
      cardId: lightningBolt.cardId,
      edition: '2X2',
      collectorNumber: '117',
      language: 'es',
      finishes: ['nonfoil', 'foil'],
    },
    {
      printingId: 'printing-m11-150-en',
      cardId: lightningBolt.cardId,
      edition: 'M11',
      collectorNumber: '150',
      language: 'en',
      finishes: ['nonfoil', 'foil'],
    },
    {
      printingId: 'printing-sta-109-en',
      cardId: lightningBolt.cardId,
      edition: 'STA',
      collectorNumber: '109',
      language: 'en',
      finishes: ['etched'],
      physical: false,
    },
  ],
};

describe('catalog printing listing', () => {
  let database: CatalogTestDatabase;
  let catalog: Catalog;

  beforeEach(async () => {
    database = await createCatalogTestDatabase();
    await publishCatalog(database, catalogFixture);
    catalog = createCatalog({ sql: database.sql });
  });

  afterEach(async () => {
    await database.close();
  });

  it('pages a card printing list in a stable order and ends with an explicit continuation', async () => {
    const first = await catalog.listCardPrintings(lightningBolt.cardId, { pageSize: 2 });

    expect(first.cardId).toBe(lightningBolt.cardId);
    expect(first.cardExists).toBe(true);
    expect(first.revision.revisionId).toBe('revision-2');
    expect(first.printings.map((printing) => printing.printingId)).toEqual(
      printerOrder.slice(0, 2),
    );
    expect(first.continuation).not.toBeNull();

    const second = await catalog.listCardPrintings(lightningBolt.cardId, {
      pageSize: 2,
      continuation: first.continuation ?? '',
    });
    expect(second.printings.map((printing) => printing.printingId)).toEqual(
      printerOrder.slice(2, 4),
    );
    expect(second.continuation).not.toBeNull();

    const third = await catalog.listCardPrintings(lightningBolt.cardId, {
      pageSize: 2,
      continuation: second.continuation ?? '',
    });
    expect(third.printings.map((printing) => printing.printingId)).toEqual(printerOrder.slice(4));
    expect(third.continuation).toBeNull();
    expect(third.printings[0]).toMatchObject({
      edition: 'STA',
      language: 'en',
      finishes: ['etched'],
      physical: false,
    });
  });

  it('bounds the default page and continues to the last printing exactly once', async () => {
    const total = CATALOG_LIMITS.defaultPrintingPageSize + 1;
    await publishCatalog(database, {
      revisionId: 'revision-3',
      cards: [lightningBolt],
      printings: Array.from({ length: total }, (_, index) => ({
        printingId: `printing-default-${index}`,
        cardId: lightningBolt.cardId,
        edition: 'TST',
        collectorNumber: String(index + 1),
        language: 'en',
      })),
    });

    const first = await catalog.listCardPrintings(lightningBolt.cardId);
    expect(first.printings).toHaveLength(CATALOG_LIMITS.defaultPrintingPageSize);
    expect(first.continuation).not.toBeNull();

    const last = await catalog.listCardPrintings(lightningBolt.cardId, {
      continuation: first.continuation ?? '',
    });
    expect(last.printings).toHaveLength(1);
    expect(last.continuation).toBeNull();

    const listed = [...first.printings, ...last.printings].map((printing) => printing.printingId);
    expect(new Set(listed).size).toBe(total);
  });

  it('rejects a page size outside the documented bounds', async () => {
    for (const pageSize of [
      CATALOG_LIMITS.minPrintingPageSize - 1,
      CATALOG_LIMITS.maxPrintingPageSize + 1,
      2.5,
    ]) {
      const error = await captureCatalogError(
        catalog.listCardPrintings(lightningBolt.cardId, { pageSize }),
      );
      expect(error.code).toBe('invalid-request');
    }
  });

  it('distinguishes an unknown card from a card without printings', async () => {
    const unknown = await catalog.listCardPrintings('oracle-unknown');
    expect(unknown.cardExists).toBe(false);
    expect(unknown.printings).toEqual([]);
    expect(unknown.continuation).toBeNull();

    await publishCatalog(database, {
      revisionId: 'revision-3',
      cards: [anotherCard],
      printings: [],
    });
    const withoutPrintings = await catalog.listCardPrintings(anotherCard.cardId);
    expect(withoutPrintings.cardExists).toBe(true);
    expect(withoutPrintings.printings).toEqual([]);
    expect(withoutPrintings.continuation).toBeNull();
  });

  it('rejects a continuation that belongs to another card', async () => {
    const first = await catalog.listCardPrintings(lightningBolt.cardId, { pageSize: 2 });
    expect(first.continuation).not.toBeNull();

    const error = await captureCatalogError(
      catalog.listCardPrintings(anotherCard.cardId, {
        pageSize: 2,
        continuation: first.continuation ?? '',
      }),
    );
    expect(error.code).toBe('stale-continuation');
  });

  it('rejects an unreadable continuation', async () => {
    const error = await captureCatalogError(
      catalog.listCardPrintings(lightningBolt.cardId, { continuation: 'not-a-continuation' }),
    );
    expect(error.code).toBe('stale-continuation');
  });

  it('rejects a continuation once a new revision is published', async () => {
    const first = await catalog.listCardPrintings(lightningBolt.cardId, { pageSize: 2 });
    expect(first.continuation).not.toBeNull();

    await publishCatalog(database, { ...catalogFixture, revisionId: 'revision-3' });

    const error = await captureCatalogError(
      catalog.listCardPrintings(lightningBolt.cardId, {
        pageSize: 2,
        continuation: first.continuation ?? '',
      }),
    );
    expect(error.code).toBe('stale-continuation');
    expect(error.message).toMatch(/start the printing list again/);
  });

  it('continues a printing list whose identifiers reach the documented length bound', async () => {
    const cardId = '界'.repeat(CATALOG_LIMITS.maxIdentifierLength);
    const revisionId = 'r'.repeat(CATALOG_LIMITS.maxIdentifierLength);
    await publishCatalog(database, {
      revisionId,
      cards: [{ cardId, name: 'Boundary Card' }],
      printings: [
        {
          printingId: 'printing-boundary-1',
          cardId,
          edition: 'TST',
          collectorNumber: '1',
          language: 'en',
        },
        {
          printingId: 'printing-boundary-2',
          cardId,
          edition: 'TST',
          collectorNumber: '2',
          language: 'en',
        },
      ],
    });

    const first = await catalog.listCardPrintings(cardId, { pageSize: 1 });
    expect(first.printings.map((printing) => printing.printingId)).toEqual(['printing-boundary-1']);
    expect(first.continuation).not.toBeNull();

    const second = await catalog.listCardPrintings(cardId, {
      pageSize: 1,
      continuation: first.continuation ?? '',
    });
    expect(second.printings.map((printing) => printing.printingId)).toEqual([
      'printing-boundary-2',
    ]);
    expect(second.continuation).toBeNull();
  });

  it('reports an unreadable catalog as unavailable instead of an empty list', async () => {
    const failing = createCatalog({
      sql: {
        async query() {
          throw new Error('the database connection was lost');
        },
      },
    });

    const error = await captureCatalogError(failing.listCardPrintings(lightningBolt.cardId));
    expect(error.code).toBe('unavailable');
  });
});
