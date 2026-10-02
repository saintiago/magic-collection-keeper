import { describe, expect, it } from 'vitest';

import { createLocalProviders } from '../../../storybook/fixtures.js';
import { ManualProgression } from '../../../storybook/progression.js';
import type { UserCardsReference } from '../../../src/usercards/index.js';

const references: readonly UserCardsReference[] = [
  { kind: 'card', cardId: 'lightning-bolt' },
  { kind: 'printing', printingId: 'm11-149' },
  { kind: 'copy', copyId: 'copy-bolt-1' },
  { kind: 'card', cardId: 'counterspell' },
];

describe('local intended quantities', () => {
  it.each([
    { tagId: undefined, quantities: [null, null, null, null] },
    { tagId: 'tag-wishlist', quantities: [0, 0, 0, 0] },
    { tagId: 'tag-deck', quantities: [4, 0, 0, 0] },
  ])('reads fragments in tag context $tagId', async ({ tagId, quantities }) => {
    const progression = new ManualProgression();
    const account = createLocalProviders(progression).userCards.account('local');
    const read = account.readFragments({ references, tagId });
    progression.advance();
    const result = await read;
    expect([...result.fragments.values()].map((fragment) => fragment.intendedQuantity)).toEqual(
      quantities,
    );
    expect(result.fragments.get('printing:m11-149')?.tagIds).not.toContain('tag-deck');
  });

  it('keeps printing intentions in their tag and aggregates them only toward the card', async () => {
    const progression = new ManualProgression();
    const account = createLocalProviders(progression).userCards.account('local');
    const addition = account.createAssociation({
      tagId: 'tag-wishlist',
      targetLevel: 'printing',
      targetId: 'm11-149',
      quantity: 2,
    });
    progression.advance();
    expect(await addition.observe()).toMatchObject({ state: 'committed' });

    const read = account.readFragments({ references, tagId: 'tag-wishlist' });
    progression.advance();
    expect(
      [...(await read).fragments.values()].map((fragment) => fragment.intendedQuantity),
    ).toEqual([2, 2, 0, 0]);

    for (const level of ['card', 'printing', 'copy'] as const) {
      const collection = account.query({
        scope: { kind: 'collection' },
        resultLevel: level,
        criteria: [{ kind: 'tag', tagId: 'tag-deck' }],
      });
      progression.advance();
      expect((await collection).entries).toMatchObject([{ intendedQuantity: null }]);

      const wishlist = account.query({
        scope: { kind: 'tag', tagId: 'tag-wishlist' },
        resultLevel: level,
      });
      progression.advance();
      expect((await wishlist).entries).toMatchObject(
        level === 'copy' ? [] : [{ intendedQuantity: 2 }],
      );

      const deck = account.query({ scope: { kind: 'tag', tagId: 'tag-deck' }, resultLevel: level });
      progression.advance();
      expect((await deck).entries).toMatchObject(level === 'card' ? [{ intendedQuantity: 4 }] : []);
    }
  });
});
