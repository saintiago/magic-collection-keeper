/**
 * Component scope: the collection and card-details pages of the UserInterface
 * (docs/user-interface.md#browsing-and-organization, docs/user-cards.md#records-and-associations,
 * docs/user-interface.md#state-ownership-and-restoration).
 *
 * The collection route vocabulary, the owned query the collection view builds, the entries its
 * adapter presents, the copy corrections and their outcomes, and the bulk change over explicit
 * selected copies are asserted here; the pages themselves are exercised as observable browser
 * behavior in tests/browser/collection.spec.ts.
 */

import { describe, expect, it } from 'vitest';

import type { Catalog, PrintingRecord } from '../../../src/catalog/index.js';
import type { SearchEntry, SearchPage } from '../../../src/search/index.js';
import type { SearchClient } from '../../../src/application/index.js';
import type { PhysicalCopy } from '../../../src/usercards/index.js';
import {
  createUserCardsOperations,
  type UserCardsBrowserClient,
} from '../../../src/usercards/browser.js';
import { unusedUserCardsClient } from '../../support/usercards-browser.js';
import {
  collectionSearchRequest,
  copyChangeTool,
  correctCopy,
  createCollectionSearchAccess,
  createCopyAccess,
  readUiCollectionLevel,
  readUiView,
  uiCollectionLevels,
  uiCopyConditions,
  uiEntryKey,
  uiHref,
  type UiCopyAccess,
  type UiCopyCorrection,
  type UiListEntry,
} from '../../../src/ui/index.js';
import { copyConditions } from '../../../src/usercards/index.js';
import { finishes } from '../../../src/catalog/index.js';

/** One Search entry as the collection query returns it for one owned card. */
function entry(overrides: Partial<SearchEntry> = {}): SearchEntry {
  return {
    entryKey: 'card:card-bolt',
    target: { kind: 'card', cardId: 'card-bolt' },
    card: { cardId: 'card-bolt', name: 'Lightning Bolt', matchedName: null },
    printing: null,
    quantity: { copies: 3, intended: null },
    ...overrides,
  };
}

/** One copy record as the private read returns it. */
function copy(overrides: Partial<PhysicalCopy> = {}): PhysicalCopy {
  return {
    copyId: 'copy-1',
    printingId: 'printing-1',
    finish: 'nonfoil',
    condition: 'NM',
    revision: 4,
    ...overrides,
  };
}

/** One correction of one copy. */
function correction(overrides: Partial<UiCopyCorrection> = {}): UiCopyCorrection {
  return {
    copyId: 'copy-1',
    expectedRevision: 4,
    printingId: 'printing-1',
    finish: 'foil',
    condition: 'LP',
    ...overrides,
  };
}

describe('collection routes', () => {
  it('carries the presented query and level in the URL', () => {
    const view = { page: 'collection', query: 'bolt', level: 'copy' } as const;

    expect(uiHref(view)).toBe('#/collection?query=bolt&level=copy');
    expect(readUiView(uiHref(view))).toEqual(view);
  });

  it('keeps the default query and level short', () => {
    expect(uiHref({ page: 'collection', query: '', level: 'card' })).toBe('#/collection');
    expect(readUiView('#/collection')).toEqual({
      page: 'collection',
      query: '',
      level: 'card',
    });
  });

  it('reads the levels the collection presents and defaults an unknown one to cards', () => {
    expect([...uiCollectionLevels]).toEqual(['card', 'printing', 'copy']);
    expect(readUiCollectionLevel('copy')).toBe('copy');
    expect(readUiCollectionLevel('printing')).toBe('printing');
    expect(readUiCollectionLevel('unknown')).toBe('card');
    expect(readUiCollectionLevel(null)).toBe('card');
  });

  it('rejects a query outside the state the page retains', () => {
    expect(readUiView(`#/collection?query=${'x'.repeat(501)}`)).toBeNull();
    expect(() => uiHref({ page: 'collection', query: 'x'.repeat(501), level: 'card' })).toThrow(
      TypeError,
    );
  });
});

describe('collection query', () => {
  it('always evaluates the owned records of the presented level', () => {
    expect(collectionSearchRequest({ text: ' bolt ', level: 'copy' }, 50, null)).toEqual({
      resultLevel: 'copy',
      query: 'bolt',
      criteria: [{ kind: 'owned' }],
      pageSize: 50,
    });
  });

  it('presents every owned entry of the level for an empty expression', () => {
    expect(collectionSearchRequest({ text: '   ', level: 'card' }, 20, null)).toEqual({
      resultLevel: 'card',
      criteria: [{ kind: 'owned' }],
      pageSize: 20,
    });
  });

  it('carries the continuation of the page that produced it unchanged', () => {
    expect(collectionSearchRequest({ text: '', level: 'printing' }, 20, 'cursor-1')).toEqual({
      resultLevel: 'printing',
      criteria: [{ kind: 'owned' }],
      pageSize: 20,
      continuation: 'cursor-1',
    });
  });
});

describe('collection search access', () => {
  it('presents the owned entries and quantities Search evaluated', async () => {
    const requests: unknown[] = [];
    const pages: SearchPage = {
      status: 'ready',
      entries: [
        entry(),
        entry({
          entryKey: 'copy:copy-1',
          target: { kind: 'copy', copyId: 'copy-1' },
          printing: {
            printingId: 'printing-1',
            edition: 'M11',
            collectorNumber: '149',
            language: 'en',
          },
          quantity: { copies: 1, intended: null },
        }),
      ],
      totalCount: 2,
      continuation: 'cursor-2',
      revisions: {
        generation: 'generation-1',
        catalogRevision: 'revision-1',
        catalogPosition: '1',
        privateRevision: 'private-1',
      },
    };
    const search: SearchClient = {
      execute(input) {
        requests.push(input);
        return Promise.resolve(pages);
      },
      counts: () => Promise.reject(new Error('The list source reads no private counts.')),
    };
    const catalog = {
      resolve: () =>
        Promise.resolve({
          revision: revision(),
          cards: new Map(),
          printings: new Map(),
          missing: [],
        }),
      listCardPrintings: () => Promise.reject(new Error('The list source reads no printings.')),
    } as unknown as Catalog;
    const access = createCollectionSearchAccess(search, catalog);
    const signal = new AbortController().signal;

    const read = await access.source.load({
      context: { text: 'bolt', level: 'copy' },
      pageSize: 50,
      continuation: 'cursor-1',
      signal,
    });
    if (read.status !== 'page') {
      throw new Error('The collection source did not report a page.');
    }

    expect(requests).toEqual([
      {
        resultLevel: 'copy',
        query: 'bolt',
        criteria: [{ kind: 'owned' }],
        pageSize: 50,
        continuation: 'cursor-1',
      },
    ]);
    expect(read.continuation).toBe('cursor-2');
    expect(read.entries).toEqual<readonly UiListEntry[]>([
      {
        key: 'card:card-bolt',
        target: { kind: 'card', cardId: 'card-bolt' },
        basic: {
          card: { cardId: 'card-bolt', name: 'Lightning Bolt', matchedName: null },
          printing: null,
        },
        quantity: { copies: 3, intended: null },
      },
      {
        key: 'copy:copy-1',
        target: { kind: 'copy', copyId: 'copy-1' },
        basic: {
          card: { cardId: 'card-bolt', name: 'Lightning Bolt', matchedName: null },
          printing: {
            printingId: 'printing-1',
            edition: 'M11',
            collectorNumber: '149',
            language: 'en',
          },
        },
        quantity: { copies: 1, intended: null },
      },
    ]);
    expect(read.entries.map((presented) => uiEntryKey(presented.target))).toEqual([
      'card:card-bolt',
      'copy:copy-1',
    ]);
  });

  it('reads images of the printings the presented entries name', async () => {
    const references: unknown[] = [];
    const printing = printingRecord();
    const catalog = {
      resolve(input: readonly unknown[]) {
        references.push(...input);
        return Promise.resolve({
          revision: revision(),
          cards: new Map(),
          printings: new Map([[printing.printingId, printing]]),
          missing: [],
        });
      },
      listCardPrintings: () => Promise.reject(new Error('The list source reads no printings.')),
    } as unknown as Catalog;
    const search: SearchClient = {
      execute: () => Promise.reject(new Error('The images reader runs no query.')),
      counts: () => Promise.reject(new Error('The images reader reads no private counts.')),
    };
    const access = createCollectionSearchAccess(search, catalog);

    const results = await access.images.read({
      keys: ['printing:printing-1', 'card:card-bolt'],
      information: ['images'],
      signal: new AbortController().signal,
    });

    expect(references).toEqual([{ kind: 'printing', printingId: 'printing-1' }]);
    expect(results).toEqual([
      {
        key: 'printing:printing-1',
        status: 'ready',
        values: [{ src: 'https://images.test/normal.jpg', alt: 'M11 149 · en' }],
      },
      { key: 'card:card-bolt', status: 'absent', values: null },
    ]);
  });
});

describe('copy corrections', () => {
  it('declares the condition vocabulary of the UserCards provider', () => {
    expect([...uiCopyConditions]).toEqual([...copyConditions]);
  });

  it('reports a committed change with the copy the component returned', async () => {
    const corrected = copy({ finish: 'foil', condition: 'LP', revision: 5 });
    const access = copyAccess({ correct: () => Promise.resolve(corrected) });

    const outcome = await correctCopy(access, correction());

    expect(outcome).toEqual({ status: 'committed', message: null, copy: corrected });
  });

  it('reports a revision conflict without touching the change', async () => {
    const failure = Object.assign(new Error('The copy changed after this revision.'), {
      code: 'conflict',
    });
    const access = copyAccess({ correct: () => Promise.reject(failure) });

    const outcome = await correctCopy(access, correction());

    expect(outcome.status).toBe('conflict');
    expect(outcome.copy).toBeNull();
    expect(outcome.message).toMatch(/changed since you read it/);
  });

  it('reports a definite failure of the operation', async () => {
    const failure = Object.assign(new Error('This account has no copy with that identity.'), {
      code: 'not-found',
    });
    const access = copyAccess({ correct: () => Promise.reject(failure) });

    const outcome = await correctCopy(access, correction());

    expect(outcome).toEqual({
      status: 'failed',
      message: 'This account has no copy with that identity.',
      copy: null,
    });
  });

  it('keeps matching attributes at a higher revision separate from an unknown outcome', async () => {
    const access = copyAccess({
      correct: () => Promise.reject(new Error('The service could not be reached.')),
      read: () =>
        Promise.resolve({
          copies: [copy({ finish: 'foil', condition: 'LP', revision: 5 })],
          missing: [],
        }),
    });

    const outcome = await correctCopy(access, correction());

    expect(outcome.status).toBe('unknown');
    expect(outcome.copy?.revision).toBe(5);
  });

  it('keeps a lost response uncertain when the read shows the revision it quoted', async () => {
    const stored = copy({ revision: 4 });
    const access = copyAccess({
      correct: () => Promise.reject(new Error('The service could not be reached.')),
      read: () => Promise.resolve({ copies: [stored], missing: [] }),
    });

    const outcome = await correctCopy(access, correction());

    // The unchanged revision does not establish a failure: the change may still commit.
    expect(outcome.status).toBe('unknown');
    expect(outcome.copy).toEqual(stored);
  });

  it('keeps a lost response uncertain when already matching attributes did not move', async () => {
    const stored = copy({ revision: 4, finish: 'foil', condition: 'LP' });
    const access = copyAccess({
      correct: () => Promise.reject(new Error('The service could not be reached.')),
      read: () => Promise.resolve({ copies: [stored], missing: [] }),
    });

    const outcome = await correctCopy(access, correction());

    // Observing the requested attributes alone does not establish the operation's commitment.
    expect(outcome.status).toBe('unknown');
    expect(outcome.copy).toEqual(stored);
  });

  it('keeps a lost response uncertain when the recorded state shows other attributes', async () => {
    const stored = copy({ revision: 6, condition: 'HP' });
    const access = copyAccess({
      correct: () => Promise.reject(new Error('The service could not be reached.')),
      read: () => Promise.resolve({ copies: [stored], missing: [] }),
    });

    const outcome = await correctCopy(access, correction());

    expect(outcome.status).toBe('unknown');
    expect(outcome.copy).toEqual(stored);
  });

  it('keeps a cancelled change uncertain even when the read matches at a higher revision', async () => {
    const corrected = copy({ finish: 'foil', condition: 'LP', revision: 5 });
    const access = copyAccess({
      correct: () =>
        Promise.reject(
          Object.assign(new Error('The invocation was cancelled.'), { code: 'cancelled' }),
        ),
      read: () => Promise.resolve({ copies: [corrected], missing: [] }),
    });

    const outcome = await correctCopy(access, correction());

    // A cancellation after dispatch leaves the commitment open, so it is recovered like a lost
    // response instead of being reported as a definite failure.
    expect(outcome.status).toBe('unknown');
    expect(outcome.copy).toEqual(corrected);
  });

  it('reports a copy the recovery read no longer finds instead of a failed write', async () => {
    const access = copyAccess({
      correct: () => Promise.reject(new Error('The service could not be reached.')),
      read: () => Promise.resolve({ copies: [], missing: ['copy-1'] }),
    });

    const outcome = await correctCopy(access, correction());

    expect(outcome).toEqual({
      status: 'unknown',
      message: 'The outcome is unknown. This copy is no longer in the collection.',
      copy: null,
    });
  });

  it('reports an unknown outcome when neither the change nor the copy can be read', async () => {
    const access = copyAccess({
      correct: () => Promise.reject(new Error('The service could not be reached.')),
      read: () => Promise.reject(new Error('The service could not be reached.')),
    });

    const outcome = await correctCopy(access, correction());

    expect(outcome.status).toBe('unknown');
    expect(outcome.copy).toBeNull();
  });
});

describe('bulk copy changes', () => {
  it('reads the revision of every selected copy and corrects exactly them', async () => {
    const reads: (readonly string[])[] = [];
    const corrections: UiCopyCorrection[] = [];
    const access = copyAccess({
      read(copyIds) {
        reads.push([...copyIds]);
        return Promise.resolve({
          copies: [
            copy({ copyId: 'copy-1', revision: 2 }),
            copy({ copyId: 'copy-2', revision: 7, finish: 'foil' }),
          ],
          missing: [],
        });
      },
      correct(input) {
        corrections.push(input);
        return Promise.resolve(copy({ copyId: input.copyId, finish: input.finish }));
      },
    });
    const tool = copyChangeTool({
      id: 'apply-finish',
      label: 'Apply finish',
      access,
      change: () => ({ finish: 'etched' }),
      guidance: 'Choose the finish to apply.',
    });

    const outcome = await tool.tool.invoke({
      targets: [
        { kind: 'copy', copyId: 'copy-1' },
        { kind: 'copy', copyId: 'copy-2' },
      ],
      selection: { keys: ['copy:copy-1', 'copy:copy-2'], targets: [] },
      signal: new AbortController().signal,
    });

    expect(reads).toEqual([['copy-1', 'copy-2']]);
    expect(corrections).toEqual([
      {
        copyId: 'copy-1',
        expectedRevision: 2,
        printingId: 'printing-1',
        finish: 'etched',
        condition: 'NM',
      },
      {
        copyId: 'copy-2',
        expectedRevision: 7,
        printingId: 'printing-1',
        finish: 'etched',
        condition: 'NM',
      },
    ]);
    expect(outcome).toEqual({ status: 'committed', message: 'Saved 2 copies.' });
  });

  it('never reports a partially applied selection as saved', async () => {
    const access = copyAccess({
      read: () =>
        Promise.resolve({
          copies: [copy({ copyId: 'copy-1' }), copy({ copyId: 'copy-2' })],
          missing: [],
        }),
      correct(input) {
        return input.copyId === 'copy-2'
          ? Promise.reject(Object.assign(new Error('The copy changed.'), { code: 'conflict' }))
          : Promise.resolve(copy({ copyId: input.copyId, condition: input.condition }));
      },
    });
    const tool = copyChangeTool({
      id: 'apply-condition',
      label: 'Apply condition',
      access,
      change: () => ({ condition: null }),
      guidance: 'Choose the condition to apply.',
    });

    const outcome = await tool.tool.invoke({
      targets: [
        { kind: 'copy', copyId: 'copy-1' },
        { kind: 'copy', copyId: 'copy-2' },
      ],
      selection: { keys: ['copy:copy-1', 'copy:copy-2'], targets: [] },
      signal: new AbortController().signal,
    });

    expect(outcome.status).toBe('conflict');
    expect(outcome.message).toMatch(/1 of 2 copies changed/);
  });

  it('acts on nothing when the selection names another entry level', async () => {
    let reads = 0;
    const access = copyAccess({
      read() {
        reads += 1;
        return Promise.resolve({ copies: [], missing: [] });
      },
      correct: () => Promise.reject(new Error('The change must not run.')),
    });
    const tool = copyChangeTool({
      id: 'apply-finish',
      label: 'Apply finish',
      access,
      change: () => ({ finish: 'foil' }),
      guidance: 'Choose the finish to apply.',
    });

    const outcome = await tool.tool.invoke({
      targets: [{ kind: 'card', cardId: 'card-1' }],
      selection: { keys: ['card:card-1'], targets: [] },
      signal: new AbortController().signal,
    });

    expect(outcome.status).toBe('failed');
    expect(reads).toBe(0);
  });

  it('asks for a choice before applying a change the controls do not name', async () => {
    const access = copyAccess({
      read: () => Promise.reject(new Error('The change must not read.')),
      correct: () => Promise.reject(new Error('The change must not run.')),
    });
    const tool = copyChangeTool({
      id: 'apply-finish',
      label: 'Apply finish',
      access,
      change: () => null,
      guidance: 'Choose the finish to apply to the selected copies.',
    });

    const outcome = await tool.tool.invoke({
      targets: [{ kind: 'copy', copyId: 'copy-1' }],
      selection: { keys: ['copy:copy-1'], targets: [] },
      signal: new AbortController().signal,
    });

    expect(outcome).toEqual({
      status: 'failed',
      message: 'Choose the finish to apply to the selected copies.',
    });
  });
});

describe('copy access', () => {
  it('reads and corrects copies through the UserCards contract', async () => {
    const stored = copy();
    const reads: (readonly string[])[] = [];
    const client: UserCardsBrowserClient = {
      ...unusedUserCardsClient(),
      readCopies(copyIds: readonly string[]) {
        reads.push([...copyIds]);
        return Promise.resolve({
          privateRevision: 'private-1',
          copies: new Map([[stored.copyId, stored]]),
          missing: ['copy-2'],
        });
      },
      correctCopy: (input) =>
        Promise.resolve({
          privateRevision: 'private-2',
          publicationPosition: '2',
          copies: [copy({ ...input })],
        }),
    };
    const access = createCopyAccess(
      createUserCardsOperations({ client, storage: null }).account('alice'),
    );

    await expect(access.read(['copy-1', 'copy-2'])).resolves.toEqual({
      copies: [stored],
      missing: ['copy-2'],
    });
    await expect(access.correct(correction()).observe()).resolves.toMatchObject({
      state: 'committed',
      record: { copies: [{ copyId: 'copy-1', finish: 'foil', condition: 'LP' }] },
    });
    expect(reads).toEqual([['copy-1', 'copy-2']]);
  });

  it('declares the finish vocabulary of the Catalog provider', () => {
    expect([...finishes]).toEqual(['nonfoil', 'foil', 'etched']);
  });
});

/** One copy access over the supplied read and change behavior. */
function copyAccess(options: {
  readonly read?: (copyIds: readonly string[]) => Promise<{
    readonly copies: readonly PhysicalCopy[];
    readonly missing: readonly string[];
  }>;
  readonly correct: (input: UiCopyCorrection) => Promise<PhysicalCopy>;
}): UiCopyAccess {
  const read = options.read ?? (() => Promise.resolve({ copies: [], missing: [] }));
  const client: UserCardsBrowserClient = {
    ...unusedUserCardsClient(),
    async readCopies(copyIds) {
      const result = await read(copyIds);
      return {
        privateRevision: 'private-1',
        copies: new Map(result.copies.map((stored) => [stored.copyId, stored] as const)),
        missing: [...result.missing],
      };
    },
    async correctCopy(input) {
      return {
        privateRevision: 'private-2',
        publicationPosition: '2',
        copies: [await options.correct(input)],
      };
    },
  };
  return createCopyAccess(createUserCardsOperations({ client, storage: null }).account('alice'));
}

function printingRecord(): PrintingRecord {
  return {
    printingId: 'printing-1',
    cardId: 'card-bolt',
    edition: 'M11',
    collectorNumber: '149',
    language: 'en',
    finishes: ['nonfoil', 'foil'],
    physical: true,
    images: {
      small: 'https://images.test/small.jpg',
      normal: 'https://images.test/normal.jpg',
      large: null,
      artCrop: null,
    },
  };
}

function revision(): {
  revisionId: string;
  sourceName: string;
  sourceVersion: string;
  publishedAt: string;
} {
  return {
    revisionId: 'revision-1',
    sourceName: 'fixture',
    sourceVersion: '1',
    publishedAt: '2026-09-01T00:00:00.000Z',
  };
}
