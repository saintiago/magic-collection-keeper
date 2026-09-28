/**
 * Component scope: the headless CardList contract (docs/card-list.md#interface,
 * docs/card-list.md#loading-and-recovery, docs/card-list.md#selection-and-restoration,
 * docs/testing.md#cardlist).
 *
 * The list contract is exercised without a DOM or page code: controlled sources, fragment readers
 * and tools drive response order, retries, invalidated sequences, bounded acquisition, selection
 * beyond the loaded window, retention and restoration, account scoping and local change
 * invalidation while the journeys observe the published snapshots.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  CARD_LIST_LIMITS,
  createCardList,
  groupCardListEntries,
  type CardListChange,
  type CardListChangeSource,
  type CardListEntry,
  type CardListFragmentKind,
  type CardListFragmentReader,
  type CardListOperationOutcome,
  type CardListPage,
  type CardListSource,
  type CardListSourceRequest,
  type CardListTarget,
} from '../../../src/card-list/index.js';

/** One source request a controlled list issued. */
interface SourceRequest {
  readonly context: string;
  readonly pageSize: number;
  readonly continuation: string | null;
  readonly required: readonly string[];
  readonly aborted: () => boolean;
}

/** One controlled source: every request is recorded and settled by the test. */
interface ControlledSource {
  readonly source: CardListSource<string>;
  readonly requests: readonly SourceRequest[];
  settle(id: number, page: Partial<CardListPage> & { entries: readonly CardListEntry[] }): void;
  invalidate(id: number): void;
  fail(id: number, message: string): void;
}

function controlledSource(
  affects?: (change: CardListChange, context: string) => boolean,
): ControlledSource {
  const requests: SourceRequest[] = [];
  const pending = new Map<
    number,
    {
      resolve(read: ({ status: 'page' } & CardListPage) | { status: 'invalidated' }): void;
      reject(cause: Error): void;
    }
  >();
  const source: CardListSource<string> = {
    ...(affects === undefined ? {} : { affects }),
    load(request: CardListSourceRequest<string>) {
      const id = requests.length + 1;
      let aborted = false;
      request.signal.addEventListener('abort', () => {
        aborted = true;
      });
      requests.push({
        context: request.context,
        pageSize: request.pageSize,
        continuation: request.continuation,
        required: [...request.required.positions],
        aborted: () => aborted,
      });
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
    },
  };
  return {
    source,
    requests,
    settle(id, page) {
      const waiting = pending.get(id);
      if (waiting === undefined) {
        throw new Error(`No source request ${id} is waiting.`);
      }
      pending.delete(id);
      waiting.resolve({
        status: 'page',
        entries: page.entries,
        continuation: page.continuation ?? null,
        current: page.current !== false,
      });
    },
    invalidate(id) {
      const waiting = pending.get(id);
      if (waiting === undefined) {
        throw new Error(`No source request ${id} is waiting.`);
      }
      pending.delete(id);
      waiting.resolve({ status: 'invalidated' });
    },
    fail(id, message) {
      const waiting = pending.get(id);
      if (waiting === undefined) {
        throw new Error(`No source request ${id} is waiting.`);
      }
      pending.delete(id);
      waiting.reject(new Error(message));
    },
  };
}

function card(cardId: string): CardListEntry {
  return {
    key: `card:${cardId}`,
    target: { kind: 'card', cardId },
    basic: { card: { cardId, name: `Card ${cardId}`, matchedName: null }, printing: null },
    quantity: null,
  };
}

function copy(copyId: string, printingId: string): CardListEntry {
  return {
    key: `copy:${copyId}`,
    target: { kind: 'copy', copyId },
    basic: {
      card: { cardId: `card-${printingId}`, name: 'Lightning Bolt', matchedName: null },
      printing: { printingId, edition: 'BLB', collectorNumber: '1', language: 'en' },
    },
    quantity: { copies: 1, intended: null },
  };
}

function printing(printingId: string): CardListEntry {
  return {
    key: `printing:${printingId}`,
    target: { kind: 'printing', printingId },
    basic: {
      card: { cardId: `card-${printingId}`, name: 'Lightning Bolt', matchedName: null },
      printing: { printingId, edition: 'BLB', collectorNumber: '1', language: 'en' },
    },
    quantity: null,
  };
}

function unresolved(copyId: string): CardListEntry {
  return {
    key: `copy:${copyId}`,
    target: { kind: 'copy', copyId },
    basic: null,
    quantity: null,
  };
}

function options(
  source: CardListSource<string>,
  overrides: Partial<Parameters<typeof createCardList<string>>[0]> = {},
): Parameters<typeof createCardList<string>>[0] {
  return {
    source,
    context: 'result',
    accountId: 'alice',
    pageSize: 2,
    ...overrides,
  };
}

/** Waits until the list work started by a call settled. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('equivalent copy grouping', () => {
  it('groups consecutive copies of one printing and keeps their source order', () => {
    const entries = [
      copy('1', 'printing-1'),
      copy('2', 'printing-1'),
      copy('3', 'printing-2'),
      copy('4', 'printing-1'),
    ];

    const groups = groupCardListEntries(entries);

    expect(groups.map((group) => [...group.keys])).toEqual([
      ['copy:1', 'copy:2'],
      ['copy:3'],
      ['copy:4'],
    ]);
    expect(groups.flatMap((group) => group.keys)).toEqual(entries.map((entry) => entry.key));
    expect(new Set(groups.map((group) => group.key)).size).toBe(groups.length);
  });

  it('keeps cards, printings and unresolved copies outside a copy group', () => {
    const entries = [
      card('1'),
      printing('printing-1'),
      unresolved('2'),
      copy('3', 'printing-1'),
      copy('4', 'printing-1'),
    ];

    const groups = groupCardListEntries(entries);

    expect(groups.map((group) => [...group.keys])).toEqual([
      ['card:1'],
      ['printing:printing-1'],
      ['copy:2'],
      ['copy:3', 'copy:4'],
    ]);
  });

  it('presents nothing for an empty window and declares positive bounds', () => {
    expect(groupCardListEntries([])).toEqual([]);
    expect(CARD_LIST_LIMITS.page).toBeGreaterThan(0);
    expect(CARD_LIST_LIMITS.window).toBeGreaterThanOrEqual(CARD_LIST_LIMITS.page);
    expect(CARD_LIST_LIMITS.fragmentBatch).toBeGreaterThan(0);
    expect(CARD_LIST_LIMITS.fragmentItems).toBeGreaterThan(0);
  });
});

describe('CardList construction', () => {
  it('rejects construction without the boundaries it presents', () => {
    expect(() => createCardList({} as unknown as Parameters<typeof createCardList>[0])).toThrow(
      TypeError,
    );
    expect(() => createCardList(options({} as CardListSource<string>))).toThrow(TypeError);
    expect(() => createCardList(options(controlledSource().source, { accountId: '' }))).toThrow(
      TypeError,
    );
  });

  it('rejects a page size outside the declared bound', () => {
    for (const pageSize of [0, -1, 1.5, Number.NaN, CARD_LIST_LIMITS.page + 1]) {
      expect(() => createCardList(options(controlledSource().source, { pageSize }))).toThrow(
        TypeError,
      );
    }
  });

  it('rejects fragment kinds and tools that do not read or invoke', () => {
    const source = controlledSource().source;
    expect(() => createCardList(options(source, { fragments: { images: {} as never } }))).toThrow(
      TypeError,
    );
    expect(() =>
      createCardList(
        options(source, { tools: [{ id: 'wishlist', label: 'Wishlist', tool: {} as never }] }),
      ),
    ).toThrow(TypeError);
    expect(() =>
      createCardList(
        options(source, {
          tools: [
            {
              id: 'wishlist',
              label: 'Wishlist',
              tool: { invoke: () => Promise.resolve({ status: 'committed', message: null }) },
            },
            {
              id: 'wishlist',
              label: 'Other',
              tool: { invoke: () => Promise.resolve({ status: 'committed', message: null }) },
            },
          ],
        }),
      ),
    ).toThrow(TypeError);
  });

  it('rejects a cancellation signal or a change source it cannot use', () => {
    const source = controlledSource().source;
    expect(() => createCardList(options(source, { signal: {} as AbortSignal }))).toThrow(TypeError);
    expect(() => createCardList(options(source, { changes: {} as CardListChangeSource }))).toThrow(
      TypeError,
    );
  });

  it('restores nothing from a handle another account or list produced', () => {
    const first = createCardList(options(controlledSource().source, { accountId: 'alice' }));
    const retained = first.retain();
    first.dispose();

    const otherAccount = createCardList(
      options(controlledSource().source, { restored: retained, accountId: 'bob' }),
    );
    const foreign = createCardList(
      options(controlledSource().source, { restored: { kind: 'something-else' } as never }),
    );

    expect(otherAccount.restoration).toBeNull();
    expect(foreign.restoration).toBeNull();
    otherAccount.dispose();
    foreign.dispose();
  });
});

describe('window acquisition and recovery', () => {
  it('publishes the first page and reports empty, failed and caught-up states distinctly', async () => {
    const controlled = controlledSource();
    const list = createCardList(options(controlled.source));
    const snapshots: string[] = [];
    const unsubscribe = list.subscribe((snapshot) =>
      snapshots.push(JSON.stringify(snapshot.empty)),
    );

    expect(list.snapshot()).toMatchObject({ context: 'result', loading: true, error: null });
    expect(snapshots).toHaveLength(0);
    controlled.settle(1, { entries: [card('1'), card('2')], continuation: 'next' });
    await settle();
    expect(list.snapshot()).toMatchObject({ loading: false, hasMore: true, empty: false });
    expect(list.snapshot().entries.map((entry) => entry.entry.key)).toEqual(['card:1', 'card:2']);
    expect(list.snapshot().groups.map((group) => [...group.keys])).toEqual([
      ['card:1'],
      ['card:2'],
    ]);
    expect(snapshots.length).toBeGreaterThan(0);

    unsubscribe();
    const seen = snapshots.length;
    list.demand({ entries: 4 });
    expect(controlled.requests).toHaveLength(2);
    controlled.settle(2, { entries: [], continuation: null });
    await settle();
    expect(snapshots.length).toBe(seen);
    expect(list.snapshot().entries).toHaveLength(2);
    list.dispose();
  });

  it('repeats a temporary failure at its position and never repeats a rejected continuation', async () => {
    const controlled = controlledSource();
    const list = createCardList(options(controlled.source));
    controlled.settle(1, { entries: [card('1'), card('2')], continuation: 'next' });
    await settle();

    list.demand({ entries: 4 });
    controlled.fail(2, 'Results unavailable');
    await settle();
    expect(list.snapshot()).toMatchObject({ error: 'Results unavailable', hasMore: false });
    expect(list.snapshot().entries).toHaveLength(2);

    // The retry repeats the failed position instead of restarting the result.
    list.retry();
    expect(controlled.requests[2]).toMatchObject({ continuation: 'next' });
    controlled.settle(3, { entries: [card('3')], continuation: 'third' });
    await settle();
    expect(list.snapshot().entries.map((entry) => entry.entry.key)).toEqual([
      'card:1',
      'card:2',
      'card:3',
    ]);

    // A sequence the provider invalidated restarts from its first page.
    list.demand({ entries: 5 });
    expect(controlled.requests[3]).toMatchObject({ continuation: 'third' });
    controlled.invalidate(4);
    await settle();
    expect(controlled.requests[4]).toMatchObject({ continuation: null });
    controlled.settle(5, { entries: [card('9')], continuation: null });
    await settle();
    expect(list.snapshot().entries.map((entry) => entry.entry.key)).toEqual(['card:9']);
    list.dispose();
  });

  it('keeps a window the source invalidated until its restart failed and retries that restart', async () => {
    const controlled = controlledSource();
    const list = createCardList(options(controlled.source));
    controlled.settle(1, { entries: [card('1')], continuation: 'next' });
    await settle();

    list.demand({ entries: 2 });
    controlled.invalidate(2);
    await settle();
    controlled.fail(3, 'The restart failed.');
    await settle();

    expect(list.snapshot()).toMatchObject({ error: 'The restart failed.' });
    expect(list.snapshot().entries.map((entry) => entry.entry.key)).toEqual(['card:1']);
    list.retry();
    expect(controlled.requests[3]).toMatchObject({ continuation: null });
    list.dispose();
  });

  it('acquires only the demanded extent, bounded by its window', async () => {
    const controlled = controlledSource();
    const list = createCardList(options(controlled.source, { pageSize: 1 }));
    controlled.settle(1, { entries: [card('1')], continuation: 'p2' });
    await settle();

    list.demand({ entries: 3 });
    controlled.settle(2, { entries: [card('2')], continuation: 'p3' });
    await settle();
    controlled.settle(3, { entries: [card('3')], continuation: 'p4' });
    await settle();
    expect(controlled.requests).toHaveLength(3);
    expect(list.snapshot().entries).toHaveLength(3);
    expect(list.snapshot().hasMore).toBe(true);

    // A demand beyond the window bound acquires no further page than the bound allows.
    list.demand({ entries: CARD_LIST_LIMITS.window + 10 });
    expect(controlled.requests).toHaveLength(4);
    list.dispose();
  });

  it('drops a withdrawn response and disposes its work with the list', async () => {
    const controlled = controlledSource();
    const controller = new AbortController();
    const list = createCardList(options(controlled.source, { signal: controller.signal }));
    list.refresh();
    expect(controlled.requests[0]!.aborted()).toBe(true);
    controlled.settle(2, { entries: [card('2')], continuation: null });
    await settle();
    expect(list.snapshot().entries.map((entry) => entry.entry.key)).toEqual(['card:2']);

    controller.abort();
    expect(list.snapshot().entries).toHaveLength(0);
    list.dispose();
  });
});

describe('selection and tools', () => {
  it('keeps two independent instances apart', async () => {
    const first = controlledSource();
    const second = controlledSource();
    const one = createCardList(options(first.source, { pageSize: 1, context: 'first' }));
    const other = createCardList(options(second.source, { pageSize: 1, context: 'second' }));
    first.settle(1, { entries: [card('1')], continuation: null });
    second.settle(1, { entries: [card('2')], continuation: null });
    await settle();

    one.setSelected('card:1', true);
    expect(one.snapshot()).toMatchObject({ context: 'first', selection: { keys: ['card:1'] } });
    expect(other.snapshot()).toMatchObject({ context: 'second', selection: { keys: [] } });
    expect(other.snapshot().entries.map((entry) => entry.entry.key)).toEqual(['card:2']);
    one.dispose();
    expect(other.snapshot().entries).toHaveLength(1);
    other.dispose();
  });

  it('selects a whole group and lets one member leave it again', async () => {
    const controlled = controlledSource();
    const list = createCardList(options(controlled.source, { pageSize: 3 }));
    controlled.settle(1, {
      entries: [copy('1', 'printing-1'), copy('2', 'printing-1'), card('3')],
      continuation: null,
    });
    await settle();

    const group = list.snapshot().groups[0]!;
    list.setGroupSelected(group.keys, true);
    expect(list.snapshot().selection.keys).toEqual(['copy:1', 'copy:2']);
    list.setSelected('copy:2', false);
    expect(list.snapshot().selection.keys).toEqual(['copy:1']);
    list.clearSelection();
    expect(list.actionContext().targets).toEqual([]);
    list.dispose();
  });

  it('keeps a selection beyond the loaded window and reports aligned explicit targets', async () => {
    const controlled = controlledSource();
    const list = createCardList(options(controlled.source, { pageSize: 1 }));
    controlled.settle(1, { entries: [card('1')], continuation: 'p2' });
    await settle();
    // A page beyond the window retires the entries it leaves while selection keeps their targets.
    list.demand({ entries: 2 });
    controlled.settle(2, { entries: [card('2')], continuation: 'p3' });
    await settle();
    list.demand({ entries: 3 });
    controlled.settle(3, { entries: [card('3')], continuation: null });
    await settle();

    list.setSelected('card:1', true);
    list.setSelected('card:2', true);
    list.setSelected('card:3', true);
    expect(list.snapshot().selection.keys).toEqual(['card:1', 'card:2', 'card:3']);
    expect(list.actionContext().targets).toEqual([
      { kind: 'card', cardId: '1' },
      { kind: 'card', cardId: '2' },
      { kind: 'card', cardId: '3' },
    ]);
    // A key selected before its entry arrived is kept until the source presents it.
    list.setSelected('card:4', true);
    expect(list.snapshot().selection.keys).toEqual(['card:1', 'card:2', 'card:3']);
    expect(list.actionContext().keys).toHaveLength(3);
    list.setSelected('card:3', false);
    expect(list.snapshot().selection.keys).toEqual(['card:1', 'card:2']);
    list.clearSelection();
    expect(list.snapshot().selection.keys).toEqual([]);
    list.dispose();
  });

  it('keeps more than a hundred selected entries without a history bound', async () => {
    const controlled = controlledSource();
    const list = createCardList(options(controlled.source, { pageSize: 100 }));
    const first = Array.from({ length: 100 }, (_, index) => card(`a${index}`));
    controlled.settle(1, { entries: first, continuation: 'next' });
    await settle();
    list.demand({ entries: 200 });
    const second = Array.from({ length: 100 }, (_, index) => card(`b${index}`));
    controlled.settle(2, { entries: second, continuation: null });
    await settle();

    for (const entry of [...first, ...second]) {
      list.setSelected(entry.key, true);
    }
    expect(list.snapshot().selection.keys).toHaveLength(200);
    expect(list.actionContext().targets).toHaveLength(200);
    // The retained state carries the whole selection, not a bounded window of it.
    const retained = list.retain() as unknown as { selection: readonly string[] };
    expect(retained.selection).toHaveLength(200);
    list.dispose();
  });

  it('offers a tool only when every selected entry reports it available', async () => {
    const controlled = controlledSource();
    const availability: CardListFragmentReader<readonly string[]> = {
      read(request) {
        return Promise.resolve(
          request.keys.map((key) => ({
            key,
            status: 'ready' as const,
            values: key === 'card:1' ? ['wishlist'] : [],
          })),
        );
      },
    };
    const invoked: CardListTarget[][] = [];
    const list = createCardList(
      options(controlled.source, {
        fragments: { tools: availability },
        tools: [
          {
            id: 'wishlist',
            label: 'Add to wishlist',
            tool: {
              invoke(request) {
                invoked.push([...request.targets]);
                return Promise.resolve({ status: 'committed', message: null });
              },
            },
          },
        ],
      }),
    );
    controlled.settle(1, { entries: [card('1'), card('2')], continuation: null });
    await settle();

    list.setSelected('card:1', true);
    await settle();
    expect(list.snapshot().tools[0]).toMatchObject({ id: 'wishlist', available: true });
    list.setSelected('card:2', true);
    await settle();
    expect(list.snapshot().tools[0]).toMatchObject({ available: false });
    await expect(list.invoke('wishlist')).resolves.toBeNull();

    list.setSelected('card:2', false);
    await settle();
    await expect(list.invoke('wishlist')).resolves.toEqual({ status: 'committed', message: null });
    expect(invoked).toEqual([[{ kind: 'card', cardId: '1' }]]);
    list.dispose();
  });

  it('reports an invocation without a receipt as unknown instead of a failure', async () => {
    const controlled = controlledSource();
    const list = createCardList(
      options(controlled.source, {
        tools: [
          {
            id: 'wishlist',
            label: 'Add to wishlist',
            tool: { invoke: () => Promise.reject(new Error('The response was lost.')) },
          },
        ],
      }),
    );
    controlled.settle(1, { entries: [card('1')], continuation: null });
    await settle();
    list.setSelected('card:1', true);

    await expect(list.invoke('wishlist')).resolves.toEqual({ status: 'unknown', message: null });
    list.dispose();
  });
});

describe('enrichment', () => {
  it('reads fragments independently in bounded batches and keeps a failure retryable', async () => {
    const controlled = controlledSource();
    const requests: { readonly kind: CardListFragmentKind; readonly keys: readonly string[] }[] =
      [];
    const pending = new Map<
      number,
      {
        resolve(results: readonly unknown[]): void;
        reject(cause: Error): void;
      }
    >();
    const reader = (kind: CardListFragmentKind) => ({
      read(request: { readonly keys: readonly string[] }) {
        const id = requests.length + 1;
        requests.push({ kind, keys: [...request.keys] });
        return new Promise<readonly unknown[]>((resolve, reject) => {
          pending.set(id, { resolve, reject });
        });
      },
    });
    const list = createCardList(
      options(controlled.source, {
        pageSize: 3,
        fragments: {
          images: reader('images') as never,
          ownership: reader('ownership') as never,
        },
      }),
    );
    controlled.settle(1, {
      entries: [printing('1'), printing('2'), printing('3')],
      continuation: null,
    });
    await settle();

    expect(requests.map((request) => request.kind)).toEqual(['images', 'ownership']);
    expect(requests.every((request) => request.keys.length <= CARD_LIST_LIMITS.fragmentBatch)).toBe(
      true,
    );

    const first = list.snapshot().entries[0]!;
    expect(first.fragments.get('images')).toEqual({ status: 'loading' });
    pending.get(1)!.resolve([{ key: 'printing:1', status: 'absent', values: null }]);
    pending.get(2)!.reject(new Error('Counts unavailable'));
    await settle();

    expect(list.snapshot().entries[0]!.fragments.get('images')).toEqual({ status: 'absent' });
    expect(list.snapshot().entries[1]!.fragments.get('ownership')).toMatchObject({
      status: 'failed',
      message: 'Counts unavailable',
    });

    // The failed entry's fragment is retried on demand while the other entry keeps its state.
    list.reloadFragment('printing:2', 'ownership');
    pending
      .get(3)!
      .resolve([{ key: 'printing:2', status: 'ready', values: { owned: 1, locations: 1 } }]);
    await settle();
    expect(list.snapshot().entries[1]!.fragments.get('ownership')).toEqual({
      status: 'ready',
      values: { owned: 1, locations: 1, intended: null },
    });
    expect(list.snapshot().entries[0]!.fragments.get('images')).toEqual({ status: 'absent' });
    list.dispose();
  });
});

describe('retention and restoration', () => {
  it('re-acquires the retained window from its own position and reports the position', async () => {
    const first = controlledSource();
    const list = createCardList(options(first.source, { pageSize: 2 }));
    first.settle(1, { entries: [card('1'), card('2')], continuation: 'next' });
    await settle();
    list.demand({ entries: 4 });
    first.settle(2, { entries: [card('3'), card('4')], continuation: null });
    await settle();
    list.setSelected('card:2', true);
    list.reportPosition({ scrollTop: 40, focus: { control: 'select', key: 'card:2' } });
    const retained = list.retain();
    list.dispose();

    const second = controlledSource();
    const restored = createCardList(
      options(second.source, { pageSize: 2, restored: retained, context: 'other' }),
    );
    expect(second.requests[0]).toMatchObject({ context: 'result', continuation: null });
    expect(restored.snapshot().context).toBe('result');
    second.settle(1, { entries: [card('1'), card('2')], continuation: 'next' });
    await settle();
    expect(second.requests[1]).toMatchObject({ continuation: 'next' });
    second.settle(2, { entries: [card('3'), card('4')], continuation: null });
    await settle();

    await expect(restored.restoration!.presented).resolves.toEqual({
      scrollTop: 40,
      focus: { control: 'select', key: 'card:2' },
    });
    expect(restored.snapshot().selection.keys).toEqual(['card:2']);
    restored.dispose();
  });

  it('reports an interrupted restoration and keeps the intended window when it fails', async () => {
    const first = controlledSource();
    const list = createCardList(options(first.source, { pageSize: 2 }));
    first.settle(1, { entries: [card('1'), card('2')], continuation: null });
    await settle();
    const retained = list.retain();
    list.dispose();

    const second = controlledSource();
    const restored = createCardList(options(second.source, { pageSize: 2, restored: retained }));
    second.fail(1, 'Results unavailable');
    await expect(restored.restoration!.presented).rejects.toThrow('Results unavailable');

    // The intended state stays retained, and releasing it reports the interruption once.
    restored.release();
    expect(restored.snapshot().entries).toHaveLength(0);
    restored.dispose();
  });

  it('keeps user interaction when the presentation reports that it did not apply the position', async () => {
    const first = controlledSource();
    const list = createCardList(options(first.source, { pageSize: 2 }));
    first.settle(1, { entries: [card('1')], continuation: null });
    await settle();
    list.reportPosition({ scrollTop: 30, focus: { control: 'select', key: 'card:1' } });
    const retained = list.retain();
    list.dispose();

    const second = controlledSource();
    const restored = createCardList(options(second.source, { pageSize: 2, restored: retained }));
    restored.reportPosition({ applied: false });
    second.settle(1, { entries: [card('1')], continuation: null });

    await expect(restored.restoration!.presented).resolves.toEqual({ scrollTop: 0, focus: null });
    const next = restored.retain() as unknown as { scrollTop: number; focus: unknown };
    expect(next.focus).toBeNull();
    expect(next.scrollTop).toBe(0);
    restored.dispose();
  });
});

describe('local committed changes and freshness', () => {
  it('reacquires from a change, reports the awaited position until the source incorporated it', async () => {
    const controlled = controlledSource();
    const list = createCardList(options(controlled.source));
    controlled.settle(1, { entries: [card('1')], continuation: null });
    await settle();

    list.changed({ scope: 'copies', records: ['copy-1'], imports: [], position: '42' });
    expect(controlled.requests[1]).toMatchObject({ required: ['42'] });
    expect(list.snapshot().awaiting).toEqual(['42']);

    // A usable page that has not incorporated the position stays labelled as updating.
    controlled.settle(2, { entries: [card('1')], continuation: null, current: false });
    await settle();
    expect(list.snapshot().awaiting).toEqual(['42']);
    expect(list.snapshot().empty).toBe(false);

    list.changed({ scope: 'copies', records: [], imports: [], position: null });
    controlled.settle(3, { entries: [card('1')], continuation: null, current: true });
    await settle();
    expect(list.snapshot().awaiting).toEqual([]);
    list.dispose();
  });

  it('reacquires only the changes the source declares affected', async () => {
    const controlled = controlledSource((change, context) => change.imports.includes(context));
    const list = createCardList(options(controlled.source, { context: 'import-a' }));
    controlled.settle(1, { entries: [card('1')], continuation: null });
    await settle();

    list.changed({ scope: 'imports', records: [], imports: ['import-b'], position: null });
    expect(controlled.requests).toHaveLength(1);
    list.changed({ scope: 'imports', records: [], imports: ['import-a'], position: '7' });
    expect(controlled.requests).toHaveLength(2);
    expect(controlled.requests[1]).toMatchObject({ required: ['7'] });
    list.dispose();
  });

  it('subscribes to the account’s change source and stops on dispose', async () => {
    const controlled = controlledSource();
    const listeners = new Set<(change: CardListChange) => void>();
    const changes: CardListChangeSource = {
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const list = createCardList(options(controlled.source, { changes }));
    controlled.settle(1, { entries: [card('1')], continuation: null });
    await settle();

    for (const listener of listeners) {
      listener({ scope: 'associations', records: [], imports: [], position: null });
    }
    expect(controlled.requests).toHaveLength(2);
    list.dispose();
    expect(listeners.size).toBe(0);
  });
});

describe('outcomes the contract keeps distinct', () => {
  it('never presents an unreadable source answer as an empty result', async () => {
    const controlled = controlledSource();
    const list = createCardList(options(controlled.source));
    (controlled as { settle: (id: number, page: unknown) => void }).settle(1, {
      entries: [{ key: '', target: { kind: 'card', cardId: '1' } }],
    });
    await settle();

    expect(list.snapshot().error).toContain('unreadable entry');
    expect(list.snapshot().entries).toHaveLength(0);
    expect(list.snapshot().empty).toBe(false);
    list.dispose();
  });

  it('never invokes a tool for an empty or partial selection', async () => {
    const controlled = controlledSource();
    const invoke = vi.fn((): Promise<CardListOperationOutcome> =>
      Promise.resolve({ status: 'committed', message: null }),
    );
    const list = createCardList(
      options(controlled.source, { tools: [{ id: 'tool', label: 'Tool', tool: { invoke } }] }),
    );
    controlled.settle(1, { entries: [card('1')], continuation: null });
    await settle();

    await expect(list.invoke('tool')).resolves.toBeNull();
    // A selection naming an entry that has not arrived yet cannot act on a subset.
    list.setSelected('card:2', true);
    list.setSelected('card:1', true);
    await expect(list.invoke('tool')).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
    list.dispose();
  });
});
