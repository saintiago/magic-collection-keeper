/** Component scope: Catalog-owned public query evaluation and historical resolution. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CatalogError,
  createCatalog,
  createCatalogSynchronizer,
  type CatalogService,
} from '../../../src/catalog/index.js';
import {
  createCatalogTestDatabase,
  type CatalogTestDatabase,
} from '../../support/catalog-database.js';
import { createSnapshotSource } from '../../support/catalog-snapshot.js';

function printing(options: {
  id: string;
  cardId: string;
  name: string;
  language?: string;
  translatedName?: string;
  set: string;
  colors: string[];
  type: string;
  manaValue: number;
  finishes?: string[];
}): unknown {
  return {
    object: 'card',
    id: options.id,
    oracle_id: options.cardId,
    name: options.name,
    printed_name: options.translatedName,
    lang: options.language ?? 'en',
    set: options.set,
    collector_number: options.id,
    finishes: options.finishes ?? ['nonfoil'],
    nonfoil: (options.finishes ?? ['nonfoil']).includes('nonfoil'),
    foil: (options.finishes ?? ['nonfoil']).includes('foil'),
    etched: (options.finishes ?? ['nonfoil']).includes('etched'),
    digital: false,
    oracle_text: `${options.name} draws a card.`,
    type_line: options.type,
    colors: options.colors,
    color_identity: options.colors,
    cmc: options.manaValue,
  };
}

const boltEn = printing({
  id: 'bolt-en',
  cardId: 'bolt',
  name: 'Lightning Bolt',
  set: 'lea',
  colors: ['R'],
  type: 'Instant',
  manaValue: 1,
  finishes: ['nonfoil', 'foil'],
});
const boltEs = printing({
  id: 'bolt-es',
  cardId: 'bolt',
  name: 'Lightning Bolt',
  translatedName: 'Relámpago',
  language: 'es',
  set: '4ed',
  colors: ['R'],
  type: 'Instant',
  manaValue: 1,
});
const bird = printing({
  id: 'bird-en',
  cardId: 'bird',
  name: 'Sky Bird',
  set: 'lea',
  colors: ['U'],
  type: 'Creature — Bird',
  manaValue: 2,
});
const elf = printing({
  id: 'elf-en',
  cardId: 'elf',
  name: 'Forest Elf',
  set: 'lea',
  colors: ['G'],
  type: 'Creature — Elf',
  manaValue: 1,
});

async function capture(run: () => Promise<unknown>): Promise<CatalogError> {
  const result = await run().then(
    () => null,
    (cause: unknown) => cause,
  );
  if (!(result instanceof CatalogError))
    throw new Error(`Expected CatalogError, got ${String(result)}`);
  return result;
}

describe('catalog public queries', () => {
  let database: CatalogTestDatabase;
  let catalog: CatalogService;

  beforeEach(async () => {
    database = await createCatalogTestDatabase();
    await createCatalogSynchronizer({
      sql: database.sql,
      snapshots: createSnapshotSource({
        cards: { sourceVersion: 'one', records: [boltEn, boltEs, bird, elf] },
      }),
    }).synchronize({ dataset: 'cards' });
    catalog = createCatalog({ sql: database.sql });
  });

  afterEach(async () => database.close());

  it('normalizes text and structured criteria into the same current card membership', async () => {
    const text = await catalog.query({ resultLevel: 'card', query: 't:creature mv>=1' });
    const structured = await catalog.query({
      resultLevel: 'card',
      criteria: [
        { kind: 'type', text: 'CREATURE' },
        { kind: 'manaValue', comparison: '>=', value: 1 },
      ],
    });

    expect(text.entries.map((entry) => entry.entryKey)).toEqual(['card:elf', 'card:bird']);
    expect(structured.entries).toEqual(text.entries);
    expect(text.totalCount).toBe(2);
  });

  it('preserves translated display names and requires printing predicates on one printing', async () => {
    const translated = await catalog.query({ resultLevel: 'card', query: 'name:relámpago' });
    expect(translated.entries).toHaveLength(1);
    expect(translated.entries[0]?.card.matchedName).toBe('Relámpago');
    expect(translated.entries[0]?.card.names).toContainEqual({
      language: 'es',
      name: 'Relámpago',
    });

    for (const resultLevel of ['card', 'printing'] as const) {
      const multiword = await catalog.query({
        resultLevel,
        query: 'name:relámpago lightning',
      });
      expect(multiword.entries).toHaveLength(resultLevel === 'card' ? 1 : 2);
      expect(multiword.entries.every((entry) => entry.card.matchedName === 'Relámpago')).toBe(true);
    }

    const impossible = await catalog.query({
      resultLevel: 'card',
      query: 'set:lea lang:es',
    });
    expect(impossible.entries).toEqual([]);
    expect(impossible.totalCount).toBe(0);
  });

  it('returns each matching printing once with complete public basics', async () => {
    const page = await catalog.query({
      resultLevel: 'printing',
      query: 'name:bolt is:foil',
    });

    expect(page.totalCount).toBe(1);
    expect(page.entries[0]).toMatchObject({
      entryKey: 'printing:bolt-en',
      target: { kind: 'printing', printingId: 'bolt-en' },
      card: { cardId: 'bolt', name: 'Lightning Bolt' },
      printing: {
        printingId: 'bolt-en',
        cardId: 'bolt',
        edition: 'lea',
        finishes: ['nonfoil', 'foil'],
      },
    });
  });

  it('groups cards before ordering and revision-bound pagination', async () => {
    const first = await catalog.query({ resultLevel: 'card', pageSize: 1 });
    expect(first.totalCount).toBe(3);
    expect(first.entries).toHaveLength(1);
    expect(first.continuation).not.toBeNull();

    const second = await catalog.query({
      resultLevel: 'card',
      pageSize: 1,
      continuation: first.continuation,
    });
    expect(second.entries[0]?.entryKey).not.toBe(first.entries[0]?.entryKey);
    expect(second.revision).toEqual(first.revision);

    const changedQuery = await capture(() =>
      catalog.query({
        resultLevel: 'card',
        query: 't:creature',
        pageSize: 1,
        continuation: first.continuation,
      }),
    );
    expect(changedQuery.code).toBe('stale-continuation');

    await createCatalogSynchronizer({
      sql: database.sql,
      snapshots: createSnapshotSource({
        cards: { sourceVersion: 'two', records: [boltEn, boltEs, bird, elf] },
      }),
    }).synchronize({ dataset: 'cards' });
    const changedRevision = await capture(() =>
      catalog.query({
        resultLevel: 'card',
        pageSize: 1,
        continuation: first.continuation,
      }),
    );
    expect(changedRevision.code).toBe('stale-continuation');
  });

  it('rejects unsupported expressions explicitly', async () => {
    const problem = await capture(() =>
      catalog.query({ resultLevel: 'card', query: 'unique:prints' }),
    );
    expect(problem.code).toBe('unsupported-query');
    expect(problem.message).toContain('unique:prints');
  });

  it('removes provider-dropped records from queries but keeps exact references resolvable', async () => {
    await createCatalogSynchronizer({
      sql: database.sql,
      snapshots: createSnapshotSource({
        cards: { sourceVersion: 'two', records: [bird, elf] },
      }),
    }).synchronize({ dataset: 'cards' });

    expect((await catalog.query({ resultLevel: 'card', query: 'bolt' })).entries).toEqual([]);
    const historical = await catalog.resolve([
      { kind: 'card', cardId: 'bolt' },
      { kind: 'printing', printingId: 'bolt-es' },
    ]);
    expect(historical.missing).toEqual([]);
    expect(historical.printings.get('bolt-es')?.cardId).toBe('bolt');
  });
});
