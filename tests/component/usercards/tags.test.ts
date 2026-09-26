import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCatalog, type Catalog } from '../../../src/catalog/index.js';
import {
  createUserCards,
  USERCARDS_LIMITS,
  type CreateTagInput,
  type TrustedUserContext,
  type UserCards,
} from '../../../src/usercards/index.js';
import { publishCatalog } from '../../support/catalog-database.js';
import {
  captureUserCardsError,
  createUserCardsTestDatabase,
  type UserCardsTestDatabase,
} from '../../support/usercards-database.js';
import { callerInput } from './harness.js';

const alice: TrustedUserContext = { accountId: 'cognito-alice' };
const bob: TrustedUserContext = { accountId: 'cognito-bob' };

const lightningBolt = {
  cardId: 'oracle-lightning-bolt',
  name: 'Lightning Bolt',
  colors: ['R'],
  colorIdentity: ['R'],
  manaValue: 1,
};

const m11Printing = {
  printingId: 'printing-m11-149-en',
  cardId: lightningBolt.cardId,
  edition: 'M11',
  collectorNumber: '149',
  language: 'en',
  finishes: ['nonfoil', 'foil'],
  physical: true,
};

describe('usercards tags', () => {
  let database: UserCardsTestDatabase;
  let catalog: Catalog;
  let userCards: UserCards;

  beforeEach(async () => {
    database = await createUserCardsTestDatabase();
    await publishCatalog(database, {
      revisionId: 'revision-1',
      cards: [lightningBolt],
      printings: [m11Printing],
    });
    catalog = createCatalog({ sql: database.sql });
    userCards = createUserCards({ sql: database.sql, catalog });
  });

  afterEach(async () => {
    await database.close();
  });

  async function createCopy(): Promise<string> {
    const created = await userCards.createCopies(alice, {
      printingId: m11Printing.printingId,
      finish: 'nonfoil',
      condition: 'NM',
      quantity: 1,
    });
    return created.copies[0]?.copyId as string;
  }

  it('creates tags with stable identities, kinds and editable labels', async () => {
    const created = await userCards.createTag(alice, { kind: 'deck', label: 'Burn' });

    expect(created.privateRevision).toBe('1');
    expect(created.tag).toEqual({
      tagId: created.tag.tagId,
      kind: 'deck',
      label: 'Burn',
      system: false,
      revision: 1,
    });

    const read = await userCards.readTags(alice, [created.tag.tagId, 'tag-unknown']);
    expect(read.privateRevision).toBe('1');
    expect([...read.tags.keys()]).toEqual([created.tag.tagId]);
    expect(read.tags.get(created.tag.tagId)).toEqual(created.tag);
    expect(read.missing).toEqual(['tag-unknown']);
  });

  it('renames a label while keeping the tag identity, and guards the revision', async () => {
    const created = await userCards.createTag(alice, { kind: 'wishlist', label: 'To buy' });
    const tagId = created.tag.tagId;

    const renamed = await userCards.renameTag(alice, {
      tagId,
      expectedRevision: 1,
      label: 'Wanted',
    });
    expect(renamed.privateRevision).toBe('2');
    expect(renamed.tag).toEqual({
      tagId,
      kind: 'wishlist',
      label: 'Wanted',
      system: false,
      revision: 2,
    });

    const conflict = await captureUserCardsError(
      userCards.renameTag(alice, { tagId, expectedRevision: 1, label: 'Stale' }),
    );
    expect(conflict.code).toBe('conflict');

    const current = await userCards.readTags(alice, [tagId]);
    expect(current.tags.get(tagId)?.label).toBe('Wanted');
    expect(current.privateRevision).toBe('2');
  });

  it('keeps the system owned tag out of caller tag operations', async () => {
    const rejected = await captureUserCardsError(
      userCards.createTag(alice, callerInput<CreateTagInput>({ kind: 'owned', label: 'Owned' })),
    );
    expect(rejected.code).toBe('invalid-request');

    await createCopy();
    const listed = await userCards.listTags(alice);
    const owned = listed.tags.find((tag) => tag.kind === 'owned');
    expect(owned).toMatchObject({ kind: 'owned', system: true, revision: 1 });

    const rename = await captureUserCardsError(
      userCards.renameTag(alice, {
        tagId: owned?.tagId as string,
        expectedRevision: owned?.revision as number,
        label: 'Mine',
      }),
    );
    expect(rename.code).toBe('invalid-request');

    const unchanged = await userCards.readTags(alice, [owned?.tagId as string]);
    expect(unchanged.tags.get(owned?.tagId as string)?.label).toBe(owned?.label);
  });

  it("reports another account's tag as missing without revealing it", async () => {
    const created = await userCards.createTag(alice, { kind: 'other', label: 'Extras' });
    const tagId = created.tag.tagId;

    const foreignRead = await userCards.readTags(bob, [tagId, 'tag-unknown']);
    expect(foreignRead.tags.size).toBe(0);
    expect(foreignRead.missing).toEqual([tagId, 'tag-unknown']);
    expect(foreignRead.privateRevision).toBe('0');

    const foreignRename = await captureUserCardsError(
      userCards.renameTag(bob, { tagId, expectedRevision: 1, label: 'Taken' }),
    );
    const unknownRename = await captureUserCardsError(
      userCards.renameTag(bob, { tagId: 'tag-unknown', expectedRevision: 1, label: 'Taken' }),
    );
    expect(foreignRename.code).toBe('not-found');
    expect(foreignRename.message).toBe(unknownRename.message);

    const stored = await userCards.readTags(alice, [tagId]);
    expect(stored.tags.get(tagId)?.label).toBe('Extras');
    expect(stored.privateRevision).toBe('1');
  });

  it('lists tags in stable identity order with a bounded continuation', async () => {
    const created = [];
    for (const label of ['Alpha', 'Beta', 'Gamma']) {
      created.push((await userCards.createTag(alice, { kind: 'other', label })).tag);
    }
    const ordered = created.map((tag) => tag.tagId).sort();

    const first = await userCards.listTags(alice, { pageSize: 2 });
    expect(first.privateRevision).toBe('3');
    expect(first.tags.map((tag) => tag.tagId)).toEqual(ordered.slice(0, 2));
    expect(first.continuation).not.toBeNull();

    const second = await userCards.listTags(alice, {
      pageSize: 2,
      continuation: first.continuation as string,
    });
    expect(second.tags.map((tag) => tag.tagId)).toEqual(ordered.slice(2));
    expect(second.continuation).toBeNull();

    // A change after the page was read invalidates its continuation instead of skipping or
    // repeating tags.
    await userCards.createTag(alice, { kind: 'other', label: 'Delta' });
    const stale = await captureUserCardsError(
      userCards.listTags(alice, { pageSize: 2, continuation: first.continuation as string }),
    );
    expect(stale.code).toBe('conflict');
  });

  it('rejects malformed tag requests and reads', async () => {
    for (const input of [
      { kind: 'deck', label: '' },
      { kind: 'deck', label: 'x'.repeat(USERCARDS_LIMITS.maxIdentifierLength + 1) },
      { kind: 'binder', label: 'Sleeves' },
      { kind: 'deck' },
    ]) {
      const error = await captureUserCardsError(
        userCards.createTag(alice, callerInput<CreateTagInput>(input)),
      );
      expect(error.code).toBe('invalid-request');
    }

    const created = await userCards.createTag(alice, { kind: 'deck', label: 'Burn' });
    for (const input of [
      { tagId: '', expectedRevision: 1, label: 'Renamed' },
      { tagId: created.tag.tagId, expectedRevision: 0, label: 'Renamed' },
      { tagId: created.tag.tagId, expectedRevision: 1, label: '' },
      { tagId: created.tag.tagId, label: 'Renamed' },
    ]) {
      const error = await captureUserCardsError(
        userCards.renameTag(alice, callerInput({ ...input })),
      );
      expect(error.code).toBe('invalid-request');
    }

    for (const pageSize of [0, USERCARDS_LIMITS.maxTagPageSize + 1, 1.5]) {
      const error = await captureUserCardsError(userCards.listTags(alice, { pageSize }));
      expect(error.code).toBe('invalid-request');
    }
    const unreadableContinuation = await captureUserCardsError(
      userCards.listTags(alice, { continuation: 'not-a-continuation' }),
    );
    expect(unreadableContinuation.code).toBe('invalid-request');

    const tooManyReferences = await captureUserCardsError(
      userCards.readTags(
        alice,
        Array.from(
          { length: USERCARDS_LIMITS.maxReadReferences + 1 },
          (_, index) => `tag-${index}`,
        ),
      ),
    );
    expect(tooManyReferences.code).toBe('invalid-request');

    for (const context of [undefined, {}, { accountId: '' }]) {
      const error = await captureUserCardsError(
        userCards.readTags(callerInput<TrustedUserContext>(context), []),
      );
      expect(error.code).toBe('invalid-request');
    }
  });
});
