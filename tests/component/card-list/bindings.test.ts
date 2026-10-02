import { UserCardsError } from '../../../src/usercards/index.js';
/**
 * Component scope: the source bindings of CardList (docs/card-list.md#interface,
 * docs/card-list.md#required-interfaces-and-source-bindings, docs/search.md#scryfall-compatibility).
 *
 * The Search request a query binding builds, the entries it presents, the private counts it reads
 * as one bounded fragment and the account-local recent-activity store are asserted here; the list
 * behavior built on these bindings is exercised without a rendering dependency in
 * tests/component/card-list/card-list.test.ts and as browser journeys through the UserInterface.
 */

import { describe, expect, it } from 'vitest';

import type { ImportEntry } from '../../../src/usercards/index.js';
import type { CatalogReference } from '../../../src/catalog/index.js';
import {
  CARD_LIST_LIMITS,
  cardListEntryKey,
  createRecentActivity,
  pendingEntriesBinding,
  tagAssociationsBinding,
  type CardListEntry,
} from '../../../src/card-list/index.js';

/** One catalog query with the controls a browsing page presents. */
function listEntry(key: string, cardId: string): CardListEntry {
  return {
    key,
    target: { kind: 'card', cardId },
    basic: { card: { cardId, name: 'Lightning Bolt', matchedName: null }, printing: null },
    quantity: null,
  };
}

/** The catalog query's binding over the supplied contracts, as the browsing page composes it. */
describe('pending-import and tag-association bindings', () => {
  it('translates one import’s pending entries and keeps their provider records', async () => {
    let entryIds = ['entry-1', 'entry-2'];
    const requests: { readonly sessionId: string; readonly pageSize?: number }[] = [];
    const binding = pendingEntriesBinding({
      entries: {
        entries: (input) => {
          requests.push({ sessionId: input.sessionId, pageSize: input.pageSize });
          return Promise.resolve({
            privateRevision: 'private-1',
            session: {
              sessionId: input.sessionId,
              sourceKind: 'manual',
              sourceId: 'manual',
              state: 'pending',
              pendingEntries: 1,
              confirmedEntries: 0,
              discardedEntries: 0,
              sourceReference: null,
              revision: 3,
            },
            entries: (
              [
                {
                  entryId: 'entry-1',
                  sessionId: input.sessionId,
                  position: 0,
                  state: 'pending',
                  cardId: 'card-1',
                  printingId: 'printing-1',
                  finish: 'nonfoil',
                  condition: 'NM',
                  quantity: 2,
                  candidates: [],
                  sourceLine: null,
                  revision: 4,
                },
                {
                  entryId: 'entry-2',
                  sessionId: input.sessionId,
                  position: 1,
                  state: 'pending',
                  cardId: null,
                  printingId: null,
                  finish: null,
                  condition: null,
                  quantity: 1,
                  candidates: [],
                  sourceLine: null,
                  revision: 1,
                },
              ] satisfies readonly ImportEntry[]
            ).filter((entry) => entryIds.includes(entry.entryId)),
            continuation: 'next',
          });
        },
      },
      catalog: {
        resolve: (references: readonly CatalogReference[]) =>
          Promise.resolve({
            revision: {
              revisionId: 'r',
              sourceName: 'fixture',
              sourceVersion: '1',
              publishedAt: '',
            },
            cards: new Map([['card-bolt', { cardId: 'card-bolt', name: 'Lightning Bolt' }]]),
            printings: new Map(
              references.flatMap((reference) =>
                reference.kind === 'printing'
                  ? [
                      [
                        reference.printingId,
                        {
                          printingId: reference.printingId,
                          cardId: 'card-bolt',
                          edition: 'M11',
                          collectorNumber: '149',
                          language: 'en',
                          finishes: ['nonfoil'],
                        },
                      ] as const,
                    ]
                  : [],
              ),
            ),
            missing: [],
          }) as never,
      } as never,
    });

    const page = await binding.source.load({
      context: 'manual',
      pageSize: 50,
      continuation: null,
      signal: new AbortController().signal,
    });
    expect(requests).toEqual([{ sessionId: 'manual', pageSize: 50 }]);
    expect(page).toMatchObject({
      status: 'page',

      continuation: 'next',
      entries: [
        {
          key: 'pending:entry-1',
          target: { kind: 'pending', entryId: 'entry-1' },
          basic: { card: { name: 'Lightning Bolt' }, printing: { printingId: 'printing-1' } },
        },
        { key: 'pending:entry-2', basic: null },
      ],
    });
    // The provider record and the session its read reported stay available to the page reviewing
    // the entry, under the entry's own key.
    expect(binding.record('pending:entry-1')?.entry).toMatchObject({
      entryId: 'entry-1',
      revision: 4,
    });
    expect(binding.record('pending:entry-2')?.printing).toBeNull();
    expect(binding.keys()).toEqual(['pending:entry-1', 'pending:entry-2']);
    expect(binding.session()).toMatchObject({ sessionId: 'manual', revision: 3 });
    entryIds = ['entry-2'];
    const request = {
      context: 'manual',
      pageSize: 50,
      signal: new AbortController().signal,
    };
    await binding.source.load({ ...request, continuation: 'next' });
    expect(binding.record('pending:entry-1')).not.toBeNull();
    await binding.source.load({ ...request, continuation: null });
    expect(binding.record('pending:entry-1')).toBeNull();
    expect(binding.keys()).toEqual(['pending:entry-2']);
    expect(
      binding.source.affects?.({ scope: 'imports', records: [], imports: ['other'] }, 'manual'),
    ).toBe(false);
  });

  it('reports an import continuation the provider invalidated instead of repeating it', async () => {
    const binding = pendingEntriesBinding({
      entries: {
        entries: () =>
          Promise.reject(new UserCardsError('stale-continuation', 'The import changed.')),
      },
      catalog: { resolve: () => Promise.reject(new Error('No resolution.')) } as never,
    });
    await expect(
      binding.source.load({
        context: 'manual',
        pageSize: 50,
        continuation: 'cursor-1',
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ status: 'invalidated' });
  });

  it('translates one tag’s associations with their records, ownership and sequence reads', async () => {
    const binding = tagAssociationsBinding({
      tagId: 'tag-wish',
      read: {
        constraints: { batch: { references: 50 } },
        associations: () =>
          Promise.resolve({
            privateRevision: 'private-1',
            associations: [
              {
                associationId: 'association-1',
                tagId: 'tag-wish',
                targetLevel: 'card',
                targetId: 'card-bolt',
                quantity: 4,
                revision: 2,
              },
            ],
            continuation: null,
          }) as never,
        readCopies: () => Promise.resolve({ copies: new Map(), missing: [] }) as never,
      } as never,
      catalog: {
        resolve: () =>
          Promise.resolve({
            revision: {
              revisionId: 'r',
              sourceName: 'fixture',
              sourceVersion: '1',
              publishedAt: '',
            },
            cards: new Map([['card-bolt', { cardId: 'card-bolt', name: 'Lightning Bolt' }]]),
            printings: new Map(),
            missing: [],
          }) as never,
      } as never,
      counts: {
        ofBatch: (targets, tagId) =>
          Promise.resolve(
            new Map(
              targets.map((target) => [
                cardListEntryKey(target),
                { owned: 1, locations: 1, intended: tagId === 'tag-wish' ? 4 : null },
              ]),
            ),
          ),
      },
    });

    const page = await binding.source.load({
      context: 'tag-wish',
      pageSize: 50,
      continuation: null,
      signal: new AbortController().signal,
    });
    expect(page).toMatchObject({
      status: 'page',

      entries: [
        {
          key: 'association:association-1',
          target: { kind: 'card', cardId: 'card-bolt' },
          basic: { card: { name: 'Lightning Bolt' } },
        },
      ],
    });
    expect(binding.record('association:association-1')).toMatchObject({
      associationId: 'association-1',
      quantity: 4,
    });

    const request = {
      context: 'tag-wish',
      pageSize: 50,
      continuation: null,
      signal: new AbortController().signal,
    };
    // Private membership is usable even while Search cannot yet answer the progress read.
    await expect(binding.source.load(request)).resolves.toMatchObject({
      entries: [{ key: 'association:association-1' }],
    });

    // The ownership fragment reads the association's own typed target and the presented tag's
    // intended quantity, so a copy-level association is not mistaken for a card.
    const ownership = await binding.ownership.read({
      keys: ['association:association-1'],
      information: ['ownership'],
      signal: new AbortController().signal,
    });
    expect(ownership).toEqual([
      {
        key: 'association:association-1',
        status: 'ready',
        values: { owned: 1, locations: 1, intended: 4 },
      },
    ]);
  });
});

describe('bounded, account-isolated recent card activity', () => {
  it('honors the requested page bound and continues the recorded history', async () => {
    const recent = createRecentActivity();
    for (const index of [1, 2, 3]) {
      recent.record('alice', listEntry(`card:${index}`, String(index)));
    }
    const source = recent.source('alice');
    const load = (continuation: string | null, pageSize: number) =>
      source.load({
        context: 'alice',
        pageSize,
        continuation,
        signal: new AbortController().signal,
      });

    // The recorded history is one bounded sequence like every other source: a page holds at most
    // the requested entries and names the continuation of the rest.
    const page = await load(null, 2);
    expect(page).toMatchObject({
      status: 'page',
      entries: [{ key: 'card:3' }, { key: 'card:2' }],
    });
    const continuation = page.status === 'page' ? page.continuation : null;
    expect(continuation).not.toBeNull();
    await expect(load(continuation, 2)).resolves.toMatchObject({
      status: 'page',
      entries: [{ key: 'card:1' }],
      continuation: null,
    });
    await expect(load(null, CARD_LIST_LIMITS.page)).resolves.toMatchObject({
      entries: [{ key: 'card:3' }, { key: 'card:2' }, { key: 'card:1' }],
      continuation: null,
    });
  });

  it('presents the most recent entry first and keeps one entry per card', () => {
    const recent = createRecentActivity();
    recent.record('alice', listEntry('card:1', '1'));
    recent.record('alice', listEntry('card:2', '2'));
    recent.record('alice', listEntry('card:1', '1'));

    expect(recent.entries('alice').map((kept) => kept.key)).toEqual(['card:1', 'card:2']);
  });

  it('bounds the entries of one account', () => {
    const recent = createRecentActivity(2);
    for (const index of [1, 2, 3]) {
      recent.record('alice', listEntry(`card:${index}`, String(index)));
    }

    expect(recent.entries('alice').map((kept) => kept.key)).toEqual(['card:3', 'card:2']);
  });

  it('never presents one account’s activity to another and forgets the account it is told to', () => {
    const recent = createRecentActivity();
    recent.record('alice', listEntry('card:1', '1'));
    recent.record('bob', listEntry('card:2', '2'));

    expect(recent.entries('bob').map((kept) => kept.key)).toEqual(['card:2']);
    recent.clear('alice');
    expect(recent.entries('alice')).toEqual([]);
    expect(recent.entries('bob')).toHaveLength(1);
  });

  it('records no entry without resolved card information and keeps its bound finite', () => {
    const recent = createRecentActivity();
    recent.record('alice', {
      key: 'copy:unresolved',
      target: { kind: 'copy', copyId: 'unresolved' },
      basic: null,
      quantity: null,
    });

    expect(recent.entries('alice')).toEqual([]);
    expect(() => recent.record('', listEntry('card:1', '1'))).toThrow(TypeError);
    expect(() => createRecentActivity(0)).toThrow(TypeError);
  });
});
