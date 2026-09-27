import { describe, expect, it, vi } from 'vitest';
import {
  findCatalogPrinting,
  type Catalog,
  type CardRecord,
  type PrintingRecord,
} from '../../../src/catalog/index.js';
import { testRevision } from '../../support/application.js';

const card: CardRecord = {
  cardId: 'bolt',
  name: 'Lightning Bolt',
  names: [],
  rulesText: null,
  typeLine: null,
  colors: [],
  colorIdentity: [],
  manaValue: null,
};
const printing: PrintingRecord = {
  printingId: 'bolt-m11',
  cardId: 'bolt',
  edition: 'M11',
  collectorNumber: '149',
  language: 'en',
  finishes: ['nonfoil'],
  physical: true,
  images: { small: null, normal: null, large: null, artCrop: null },
};
const lookup = { cardId: 'bolt', edition: 'm11', collectorNumber: '149', language: 'EN' };
function catalog(): Catalog {
  return {
    resolve: vi.fn(async () => ({
      revision: testRevision,
      cards: new Map([['bolt', card]]),
      printings: new Map(),
      missing: [],
    })),
    listCardPrintings: vi.fn(async (cardId) => ({
      cardId,
      cardExists: true,
      revision: testRevision,
      printings: [printing],
      continuation: null,
    })),
  };
}
describe('Catalog printing selection', () => {
  it('owns case-insensitive constraints and returns canonical records using a replacement read contract', async () => {
    await expect(findCatalogPrinting(catalog(), lookup)).resolves.toEqual({ card, printing });
    await expect(findCatalogPrinting(catalog(), { ...lookup, language: 'es' })).resolves.toBeNull();
  });
  it('does not report absence when a match occurs after fifty pages', async () => {
    const provider = catalog();
    provider.listCardPrintings = vi.fn(async (cardId, options) => {
      const page = Number(options?.continuation ?? '0');
      return {
        cardId,
        cardExists: true,
        revision: testRevision,
        printings: page === 50 ? [printing] : [],
        continuation: page === 50 ? null : String(page + 1),
      };
    });
    await expect(findCatalogPrinting(provider, lookup)).resolves.toEqual({ card, printing });
  });
  it('rejects a catalog change between printing selection and card hydration', async () => {
    const provider = catalog();
    provider.resolve = vi.fn(async () => ({
      revision: { ...testRevision, revisionId: 'changed' },
      cards: new Map([['bolt', card]]),
      printings: new Map(),
      missing: [],
    }));
    await expect(findCatalogPrinting(provider, lookup)).rejects.toMatchObject({
      code: 'stale-continuation',
    });
  });
  it('reports broken pagination as unavailable rather than absence', async () => {
    const provider = catalog();
    provider.listCardPrintings = vi.fn(async (cardId) => ({
      cardId,
      cardExists: true,
      revision: testRevision,
      printings: [],
      continuation: 'repeated',
    }));
    await expect(findCatalogPrinting(provider, lookup)).rejects.toMatchObject({
      code: 'unavailable',
    });
  });
});
