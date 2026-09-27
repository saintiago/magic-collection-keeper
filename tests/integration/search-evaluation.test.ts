/**
 * Integration scope: Search evaluation over the real Catalog and UserCards query surfaces
 * (docs/search.md#required-query-contracts, docs/search.md#evaluation-and-grouping). The cases run
 * real PostgreSQL statements against the published views, with private fixtures written through
 * UserCards' own contract: membership, grouping, exact counts, ordering and continuation
 * invalidation are the observable promises this provider contract makes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SearchError, type SearchPage, type SearchRequestInput } from '../../src/search/index.js';
import type { TrustedUserContext } from '../../src/usercards/index.js';
import { publishCatalog } from '../support/catalog-database.js';
import { createSearchTestDatabase, type SearchTestDatabase } from '../support/search-database.js';

const alice = { accountId: 'cognito-alice' };
const bob = { accountId: 'cognito-bob' };

const lightningBolt = {
  cardId: 'oracle-lightning-bolt',
  name: 'Lightning Bolt',
  names: [
    { language: 'de', name: 'Blitzschlag' },
    { language: 'ja', name: '稲妻' },
    { language: 'es', name: 'Relámpago' },
  ],
  rulesText: 'Lightning Bolt deals 3 damage to any target.',
  typeLine: 'Instant',
  colors: ['R'],
  colorIdentity: ['R'],
  manaValue: 1,
};

const counterspell = {
  cardId: 'oracle-counterspell',
  name: 'Counterspell',
  rulesText: 'Counter target spell.',
  typeLine: 'Instant',
  colors: ['U'],
  colorIdentity: ['U'],
  manaValue: 2,
};

const llanowarElves = {
  cardId: 'oracle-llanowar-elves',
  name: 'Llanowar Elves',
  typeLine: 'Creature — Elf Druid',
  colors: ['G'],
  colorIdentity: ['G'],
  manaValue: 1,
};

const mysticSnake = {
  cardId: 'oracle-mystic-snake',
  name: 'Mystic Snake',
  typeLine: 'Creature — Snake',
  colors: ['U', 'G'],
  colorIdentity: ['U', 'G'],
  manaValue: 4,
};

const m11Bolt = {
  printingId: 'printing-bolt-m11-149-en',
  cardId: lightningBolt.cardId,
  edition: 'M11',
  collectorNumber: '149',
  language: 'en',
  finishes: ['nonfoil', 'foil'],
};

const staBolt = {
  printingId: 'printing-bolt-sta-109-en',
  cardId: lightningBolt.cardId,
  edition: 'STA',
  collectorNumber: '109',
  language: 'en',
  finishes: ['etched'],
  physical: false,
};

const germanBolt = {
  printingId: 'printing-bolt-m10-146-de',
  cardId: lightningBolt.cardId,
  edition: 'M10',
  collectorNumber: '146',
  language: 'de',
  finishes: ['nonfoil'],
};

const mh2Counterspell = {
  printingId: 'printing-counterspell-mh2-267-en',
  cardId: counterspell.cardId,
  edition: 'MH2',
  collectorNumber: '267',
  language: 'en',
  finishes: ['nonfoil'],
};

const m11Elves = {
  printingId: 'printing-elves-m11-179-en',
  cardId: llanowarElves.cardId,
  edition: 'M11',
  collectorNumber: '179',
  language: 'en',
  finishes: ['nonfoil'],
};

const mh2Snake = {
  printingId: 'printing-snake-mh2-200-en',
  cardId: mysticSnake.cardId,
  edition: 'MH2',
  collectorNumber: '200',
  language: 'en',
  finishes: ['nonfoil', 'foil'],
};

describe('search evaluation', () => {
  let database: SearchTestDatabase;

  beforeEach(async () => {
    database = await createSearchTestDatabase();
    await publishCatalog(database, {
      revisionId: 'revision-1',
      cards: [lightningBolt, counterspell, llanowarElves, mysticSnake],
      printings: [m11Bolt, staBolt, germanBolt, mh2Counterspell, m11Elves, mh2Snake],
    });
  });

  afterEach(async () => {
    await database.close();
  });

  async function createCopies(
    context: TrustedUserContext,
    printingId: string,
    quantity: number,
    finish: 'nonfoil' | 'foil' | 'etched' = 'nonfoil',
  ): Promise<readonly string[]> {
    const created = await database.userCards.createCopies(context, {
      printingId,
      finish,
      condition: 'NM',
      quantity,
    });
    return created.copies.map((copy) => copy.copyId);
  }

  async function createTag(
    context: TrustedUserContext,
    kind: 'deck' | 'wishlist' | 'location' | 'other',
    label: string,
  ): Promise<string> {
    const created = await database.userCards.createTag(context, { kind, label });
    return created.tag.tagId;
  }

  async function captureSearchError(run: () => Promise<unknown>): Promise<SearchError> {
    const outcome = await run().then(
      () => undefined,
      (cause: unknown) => cause,
    );
    if (!(outcome instanceof SearchError)) {
      throw new Error(`Expected a SearchError, received ${String(outcome)}.`);
    }
    return outcome;
  }

  function names(page: SearchPage): readonly string[] {
    return page.entries.map((entry) => entry.card.name);
  }

  describe('public criteria', () => {
    it('filters a card query over the published catalog and counts it exactly', async () => {
      const page = await database.search.execute({ resultLevel: 'card', query: 'c:r' });

      expect(page.totalCount).toBe(1);
      expect(page.continuation).toBeNull();
      expect(page.revisions).toEqual({ catalogRevision: 'revision-1', privateRevision: null });
      expect(page.entries.map((entry) => entry.card.name)).toEqual(['Lightning Bolt']);
      expect(page.entries[0]).toMatchObject({
        entryKey: 'card:oracle-lightning-bolt',
        target: { kind: 'card', cardId: 'oracle-lightning-bolt' },
        printing: null,
        quantity: null,
      });
    });

    it('returns an explicit empty result with an exact zero count', async () => {
      const page = await database.search.execute({ resultLevel: 'card', query: 'set:znr' });

      expect(page.entries).toEqual([]);
      expect(page.totalCount).toBe(0);
      expect(page.continuation).toBeNull();
    });

    it('selects the same entries from a text expression and the equivalent UI criteria', async () => {
      const fromText = await database.search.execute({
        resultLevel: 'card',
        query: 'c:UG t:creature',
      });
      const fromControls = await database.search.execute({
        resultLevel: 'card',
        criteria: [
          { kind: 'color', comparison: '>=', colors: ['G', 'U'] },
          { kind: 'type', text: 'Creature' },
        ],
      });

      expect(names(fromText)).toEqual(['Mystic Snake']);
      expect(fromControls.entries).toEqual(fromText.entries);
    });

    it('compares card color and color identity without mixing them', async () => {
      const exact = await database.search.execute({ resultLevel: 'card', query: 'c=ug' });
      const atLeast = await database.search.execute({ resultLevel: 'card', query: 'c>=u' });
      const identityWithin = await database.search.execute({ resultLevel: 'card', query: 'id<=u' });
      const identityAtLeast = await database.search.execute({
        resultLevel: 'card',
        query: 'id>=ug',
      });
      const notBlue = await database.search.execute({ resultLevel: 'card', query: '-c:u' });

      expect(names(exact)).toEqual(['Mystic Snake']);
      expect(names(atLeast)).toEqual(['Counterspell', 'Mystic Snake']);
      expect(names(identityWithin)).toEqual(['Counterspell']);
      expect(names(identityAtLeast)).toEqual(['Mystic Snake']);
      expect(names(notBlue)).toEqual(['Lightning Bolt', 'Llanowar Elves']);
    });

    it('orders by the requested field and keeps a stable identity tie-breaker', async () => {
      const byName = await database.search.execute({ resultLevel: 'card', query: 'mv>=1' });
      const byManaValue = await database.search.execute({
        resultLevel: 'card',
        query: 'mv>=1',
        ordering: { field: 'manaValue', direction: 'descending' },
      });

      expect(names(byName)).toEqual([
        'Counterspell',
        'Lightning Bolt',
        'Llanowar Elves',
        'Mystic Snake',
      ]);
      expect(names(byManaValue)).toEqual([
        'Mystic Snake',
        'Counterspell',
        // Lightning Bolt and Llanowar Elves share mana value 1; the entry identity breaks the tie.
        'Lightning Bolt',
        'Llanowar Elves',
      ]);
    });

    it('reads translated names and keeps the matched name for display', async () => {
      const translated = await database.search.execute({
        resultLevel: 'card',
        query: 'name:Blitzschlag',
      });
      const canonical = await database.search.execute({ resultLevel: 'card', query: 'bolt' });
      const japanese = await database.search.execute({ resultLevel: 'card', query: 'name:稲妻' });

      expect(translated.entries).toHaveLength(1);
      expect(translated.entries[0]?.card).toEqual({
        cardId: lightningBolt.cardId,
        name: 'Lightning Bolt',
        matchedName: 'Blitzschlag',
      });
      expect(canonical.entries[0]?.card.matchedName).toBeNull();
      expect(japanese.entries[0]?.card.matchedName).toBe('稲妻');
    });

    it('matches rules text and type text', async () => {
      const rules = await database.search.execute({ resultLevel: 'card', query: 'o:damage' });
      const type = await database.search.execute({ resultLevel: 'card', query: 't:elf' });

      expect(names(rules)).toEqual(['Lightning Bolt']);
      expect(names(type)).toEqual(['Llanowar Elves']);
    });

    it('applies printing criteria at card level and reports the printing at printing level', async () => {
      const cardLevel = await database.search.execute({ resultLevel: 'card', query: 'set:m10' });
      const printingLevel = await database.search.execute({
        resultLevel: 'printing',
        query: 'set:m10',
      });
      const german = await database.search.execute({ resultLevel: 'printing', query: 'lang:de' });
      const etched = await database.search.execute({ resultLevel: 'printing', query: 'is:etched' });
      const etchedCard = await database.search.execute({
        resultLevel: 'card',
        query: 'is:etched',
      });

      expect(names(cardLevel)).toEqual(['Lightning Bolt']);
      expect(cardLevel.entries[0]?.printing).toBeNull();
      expect(printingLevel.entries).toHaveLength(1);
      expect(printingLevel.entries[0]).toMatchObject({
        entryKey: `printing:${germanBolt.printingId}`,
        target: { kind: 'printing', printingId: germanBolt.printingId },
        printing: {
          printingId: germanBolt.printingId,
          edition: 'M10',
          collectorNumber: '146',
          language: 'de',
        },
      });
      expect(german.entries).toEqual(printingLevel.entries);
      expect(etched.entries[0]?.printing?.printingId).toBe(staBolt.printingId);
      expect(names(etchedCard)).toEqual(['Lightning Bolt']);
    });
  });

  describe('private criteria', () => {
    it('matches owned copies at every result level with exact grouped counts', async () => {
      await createCopies(alice, m11Bolt.printingId, 2);
      await createCopies(alice, germanBolt.printingId, 1);

      const cardLevel = await database.search.execute(
        { resultLevel: 'card', criteria: [{ kind: 'owned' }] },
        alice,
      );
      const printingLevel = await database.search.execute(
        { resultLevel: 'printing', criteria: [{ kind: 'owned' }] },
        alice,
      );
      const copyLevel = await database.search.execute(
        { resultLevel: 'copy', criteria: [{ kind: 'owned' }] },
        alice,
      );

      expect(cardLevel.totalCount).toBe(1);
      expect(cardLevel.revisions.privateRevision).not.toBeNull();
      expect(cardLevel.entries).toHaveLength(1);
      expect(cardLevel.entries[0]?.quantity).toEqual({ copies: 3, intended: null });
      // Three translated names must not multiply the card's copies.
      expect(printingLevel.entries.map((entry) => entry.quantity)).toEqual([
        { copies: 1, intended: null },
        { copies: 2, intended: null },
      ]);
      expect(printingLevel.totalCount).toBe(2);
      expect(copyLevel.entries.map((entry) => entry.target.kind)).toEqual(['copy', 'copy', 'copy']);
      expect(copyLevel.entries.map((entry) => entry.quantity)).toEqual([
        { copies: 1, intended: null },
        { copies: 1, intended: null },
        { copies: 1, intended: null },
      ]);
    });

    it('keeps the requested set and ownership on the same printing', async () => {
      await createCopies(alice, m11Bolt.printingId, 2);

      const inSet = await database.search.execute(
        {
          resultLevel: 'card',
          criteria: [{ kind: 'set', edition: 'M10' }, { kind: 'owned' }],
        },
        alice,
      );
      const ownedSet = await database.search.execute(
        {
          resultLevel: 'card',
          criteria: [{ kind: 'set', edition: 'M11' }, { kind: 'owned' }],
        },
        alice,
      );
      const copiesInSet = await database.search.execute(
        {
          resultLevel: 'copy',
          criteria: [{ kind: 'set', edition: 'M10' }, { kind: 'owned' }],
        },
        alice,
      );

      // The card has an M10 printing, but the account owns only M11 copies.
      expect(inSet.entries).toEqual([]);
      expect(inSet.totalCount).toBe(0);
      expect(names(ownedSet)).toEqual(['Lightning Bolt']);
      expect(ownedSet.entries[0]?.quantity).toEqual({ copies: 2, intended: null });
      expect(copiesInSet.entries).toEqual([]);
    });

    it('keeps a deck requirement and its physical copies distinct', async () => {
      const [copyId] = await createCopies(alice, m11Bolt.printingId, 1);
      const deck = await createTag(alice, 'deck', 'Burn');
      await database.userCards.createAssociation(alice, {
        tagId: deck,
        targetLevel: 'card',
        targetId: lightningBolt.cardId,
        quantity: 4,
      });
      await database.userCards.createAssociation(alice, {
        tagId: deck,
        targetLevel: 'copy',
        targetId: copyId as string,
        quantity: null,
      });

      const cardLevel = await database.search.execute(
        { resultLevel: 'card', criteria: [{ kind: 'tag', tagId: deck }] },
        alice,
      );
      const copyLevel = await database.search.execute(
        { resultLevel: 'copy', criteria: [{ kind: 'tag', tagId: deck }] },
        alice,
      );

      expect(cardLevel.entries).toHaveLength(1);
      expect(cardLevel.entries[0]?.quantity).toEqual({ copies: 1, intended: 4 });
      expect(copyLevel.entries).toHaveLength(1);
      expect(copyLevel.entries[0]).toMatchObject({
        target: { kind: 'copy', copyId },
        quantity: { copies: 1, intended: 4 },
      });
    });

    it('does not multiply an entry for several matching printing associations', async () => {
      const wishlist = await createTag(alice, 'wishlist', 'To buy');
      await database.userCards.createAssociation(alice, {
        tagId: wishlist,
        targetLevel: 'printing',
        targetId: m11Bolt.printingId,
        quantity: 1,
      });
      await database.userCards.createAssociation(alice, {
        tagId: wishlist,
        targetLevel: 'printing',
        targetId: staBolt.printingId,
        quantity: 2,
      });

      const page = await database.search.execute(
        { resultLevel: 'card', criteria: [{ kind: 'tag', tagId: wishlist }] },
        alice,
      );
      const printingPage = await database.search.execute(
        { resultLevel: 'printing', criteria: [{ kind: 'tag', tagId: wishlist }] },
        alice,
      );

      expect(page.entries).toHaveLength(1);
      expect(page.totalCount).toBe(1);
      expect(page.entries[0]?.quantity).toEqual({ copies: 0, intended: 3 });
      expect(printingPage.entries.map((entry) => entry.quantity?.intended)).toEqual([1, 2]);
    });

    it('does not multiply a physical copy that matches several tags', async () => {
      const [copyId] = await createCopies(alice, m11Bolt.printingId, 1);
      const deck = await createTag(alice, 'deck', 'Burn');
      const binder = await createTag(alice, 'other', 'Binder');
      for (const tagId of [deck, binder]) {
        await database.userCards.createAssociation(alice, {
          tagId,
          targetLevel: 'copy',
          targetId: copyId as string,
          quantity: null,
        });
      }

      const page = await database.search.execute(
        {
          resultLevel: 'copy',
          criteria: [
            { kind: 'tag', tagId: deck },
            { kind: 'tag', tagId: binder },
          ],
        },
        alice,
      );

      expect(page.entries).toHaveLength(1);
      expect(page.totalCount).toBe(1);
      expect(page.entries[0]?.quantity).toEqual({ copies: 1, intended: null });
    });

    it('isolates the account of a private query', async () => {
      const aliceCopies = await createCopies(alice, m11Bolt.printingId, 2);
      const bobCopies = await createCopies(bob, m11Bolt.printingId, 1, 'foil');

      const alicePage = await database.search.execute({ resultLevel: 'copy' }, alice);
      const bobPage = await database.search.execute({ resultLevel: 'copy' }, bob);

      expect(alicePage.entries.map((entry) => entry.target)).toEqual(
        aliceCopies.map((copyId) => ({ kind: 'copy', copyId })),
      );
      expect(bobPage.entries.map((entry) => entry.target)).toEqual(
        bobCopies.map((copyId) => ({ kind: 'copy', copyId })),
      );
    });

    it('filters private membership before the page boundary', async () => {
      await createCopies(alice, mh2Snake.printingId, 1);

      // The only owned card is last in the public name order, so a public page of one filtered
      // afterwards would come back empty.
      const first = await database.search.execute(
        { resultLevel: 'card', criteria: [{ kind: 'owned' }], pageSize: 1 },
        alice,
      );

      expect(names(first)).toEqual(['Mystic Snake']);
      expect(first.totalCount).toBe(1);
      expect(first.continuation).toBeNull();
    });
  });

  describe('pagination and continuation', () => {
    it('continues the same result sequence across pages', async () => {
      const first = await database.search.execute({
        resultLevel: 'card',
        query: 't:creature',
        pageSize: 1,
      });
      const second = await database.search.execute({
        resultLevel: 'card',
        query: 't:creature',
        pageSize: 1,
        continuation: first.continuation,
      });

      expect(names(first)).toEqual(['Llanowar Elves']);
      expect(first.totalCount).toBe(2);
      expect(first.continuation).not.toBeNull();
      expect(names(second)).toEqual(['Mystic Snake']);
      expect(second.totalCount).toBe(2);
      expect(second.continuation).toBeNull();
      expect(second.revisions).toEqual(first.revisions);
    });

    const changedRequests: readonly (readonly [string, Partial<SearchRequestInput>])[] = [
      ['changed criteria', { query: 't:instant' }],
      ['changed ordering', { ordering: { field: 'manaValue', direction: 'descending' } }],
    ];

    it.each(changedRequests)('rejects a continuation after %s', async (_case, change) => {
      const first = await database.search.execute({
        resultLevel: 'card',
        query: 't:creature',
        pageSize: 1,
      });

      const error = await captureSearchError(() =>
        database.search.execute({
          resultLevel: 'card',
          query: 't:creature',
          pageSize: 1,
          continuation: first.continuation,
          ...change,
        }),
      );

      expect(error.code).toBe('stale-continuation');
    });

    it('rejects a continuation of another account', async () => {
      await createCopies(alice, m11Bolt.printingId, 2);
      const first = await database.search.execute({ resultLevel: 'copy', pageSize: 1 }, alice);

      const error = await captureSearchError(() =>
        database.search.execute(
          { resultLevel: 'copy', pageSize: 1, continuation: first.continuation },
          bob,
        ),
      );

      expect(error.code).toBe('stale-continuation');
    });

    it('rejects a continuation after the catalog revision changed', async () => {
      const first = await database.search.execute({
        resultLevel: 'card',
        query: 't:creature',
        pageSize: 1,
      });
      await publishCatalog(database, {
        revisionId: 'revision-2',
        cards: [lightningBolt, counterspell, llanowarElves, mysticSnake],
        printings: [m11Bolt, staBolt, germanBolt, mh2Counterspell, m11Elves, mh2Snake],
      });

      const error = await captureSearchError(() =>
        database.search.execute({
          resultLevel: 'card',
          query: 't:creature',
          pageSize: 1,
          continuation: first.continuation,
        }),
      );

      expect(error.code).toBe('stale-continuation');
    });

    it('rejects a continuation after the private revision changed', async () => {
      await createCopies(alice, m11Bolt.printingId, 1);
      await createCopies(alice, m11Elves.printingId, 1);
      const first = await database.search.execute({ resultLevel: 'copy', pageSize: 1 }, alice);
      await createCopies(alice, mh2Snake.printingId, 1);

      const error = await captureSearchError(() =>
        database.search.execute(
          { resultLevel: 'copy', pageSize: 1, continuation: first.continuation },
          alice,
        ),
      );

      expect(error.code).toBe('stale-continuation');
    });

    it('reports an unavailable evaluation instead of an empty page', async () => {
      await database.exec('delete from catalog_private.revision');

      const error = await captureSearchError(() =>
        database.search.execute({ resultLevel: 'card', query: 't:creature' }),
      );

      expect(error.code).toBe('unavailable');
    });
  });
});
