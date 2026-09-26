/**
 * Component scope: reads must stay inside the deployed transport's response limits. Application
 * reaches Aurora through the RDS Data API, which caps a returned row at 64 KB; a statement that
 * aggregates a whole batch or page into one row fails despite valid catalog data. The executor
 * below enforces that limit like the deployed transport, so these cases fail whenever a read
 * returns an oversized row again.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CATALOG_LIMITS,
  createCatalog,
  type Catalog,
  type CatalogSqlExecutor,
} from '../../../src/catalog/index.js';
import {
  createCatalogTestDatabase,
  publishCatalog,
  type CatalogTestDatabase,
} from '../../support/catalog-database.js';

/** AWS documents a 64 KB limit per row in an RDS Data API response. */
const dataApiRowLimitBytes = 65_536;

/** Fails a read whose rows would not fit through the Data API, like the deployed transport. */
function enforceDataApiRowLimit(sql: CatalogSqlExecutor): CatalogSqlExecutor {
  return {
    async query(statement, parameters) {
      const rows = await sql.query(statement, parameters);
      for (const row of rows) {
        const size = Buffer.byteLength(JSON.stringify(row), 'utf8');
        if (size > dataApiRowLimitBytes) {
          throw new Error(`A catalog row of ${size} bytes exceeds the Data API row limit.`);
        }
      }
      return rows;
    },
  };
}

/** A rules text in the length range of a real card with a long text box. */
const rulesText = 'This card has a long rules text. '.repeat(17).slice(0, 584);

function cardIdFor(index: number): string {
  return `abcdef01-2345-6789-abcd-${String(index).padStart(12, '0')}`;
}

function printingIdFor(index: number): string {
  return `fedcba98-7654-3210-fedc-${String(index).padStart(12, '0')}`;
}

function imageUrl(variant: string, index: number): string {
  return (
    `https://cards.scryfall.io/${variant}/front/a/1/abcdef01-2345-6789-abcd-` +
    `${String(index).padStart(12, '0')}.jpg?1696522800`
  );
}

const cardBatch = Array.from({ length: CATALOG_LIMITS.maxResolutionReferences }, (_, index) => ({
  cardId: cardIdFor(index),
  name: `Batch Card ${index}`,
  names: [
    { language: 'de', name: `Stapelkarte ${index}` },
    { language: 'ja', name: `カード${index}` },
  ],
  rulesText,
  typeLine: 'Legendary Creature — Human Wizard',
  colors: ['U'],
  colorIdentity: ['U', 'B'],
  manaValue: 3,
}));

const printingCount = CATALOG_LIMITS.maxPrintingPageSize + 1;
const printingBatch = Array.from({ length: printingCount }, (_, index) => ({
  printingId: printingIdFor(index),
  cardId: cardIdFor(0),
  edition: 'MKM',
  collectorNumber: String(index + 1),
  language: 'en',
  finishes: ['nonfoil', 'foil'],
  physical: true,
  images: {
    small: imageUrl('small', index),
    normal: imageUrl('normal', index),
    large: imageUrl('large', index),
    artCrop: imageUrl('art_crop', index),
  },
}));

describe('catalog reads through the Data API row limit', () => {
  let database: CatalogTestDatabase;
  let catalog: Catalog;

  beforeEach(async () => {
    database = await createCatalogTestDatabase();
    await publishCatalog(database, {
      revisionId: 'revision-large',
      cards: cardBatch,
      printings: printingBatch,
    });
    catalog = createCatalog({ sql: enforceDataApiRowLimit(database.sql) });
  });

  afterEach(async () => {
    await database.close();
  });

  it('resolves a maximum card batch with its translated names', async () => {
    const resolution = await catalog.resolve(
      cardBatch.map((card) => ({ kind: 'card' as const, cardId: card.cardId })),
    );

    expect(resolution.missing).toEqual([]);
    expect(resolution.cards.size).toBe(CATALOG_LIMITS.maxResolutionReferences);
    const aliases = [...resolution.cards.values()].flatMap((card) => card.names);
    expect(aliases).toHaveLength(2 * CATALOG_LIMITS.maxResolutionReferences);
    expect(resolution.cards.get(cardIdFor(0))?.rulesText).toBe(rulesText);
  });

  it('resolves a maximum printing batch with its image references', async () => {
    const resolution = await catalog.resolve(
      printingBatch
        .slice(0, CATALOG_LIMITS.maxResolutionReferences)
        .map((printing) => ({ kind: 'printing' as const, printingId: printing.printingId })),
    );

    expect(resolution.missing).toEqual([]);
    expect(resolution.printings.size).toBe(CATALOG_LIMITS.maxResolutionReferences);
    const images = [...resolution.printings.values()].flatMap((printing) => [
      printing.images.small,
      printing.images.normal,
      printing.images.large,
      printing.images.artCrop,
    ]);
    expect(images.filter((image) => image !== null)).toHaveLength(
      4 * CATALOG_LIMITS.maxResolutionReferences,
    );
  });

  it('lists a maximum printing page and continues to the last printing', async () => {
    const page = await catalog.listCardPrintings(cardIdFor(0), {
      pageSize: CATALOG_LIMITS.maxPrintingPageSize,
    });
    expect(page.printings).toHaveLength(CATALOG_LIMITS.maxPrintingPageSize);
    expect(page.continuation).not.toBeNull();

    const last = await catalog.listCardPrintings(cardIdFor(0), {
      pageSize: CATALOG_LIMITS.maxPrintingPageSize,
      continuation: page.continuation ?? '',
    });
    expect(last.printings).toHaveLength(1);
    expect(last.continuation).toBeNull();

    const listed = new Set([...page.printings, ...last.printings].map((p) => p.printingId));
    expect(listed.size).toBe(printingCount);
  });
});
