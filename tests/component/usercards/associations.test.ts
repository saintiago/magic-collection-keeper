import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CatalogError, createCatalog, type Catalog } from '../../../src/catalog/index.js';
import {
  createUserCards,
  USERCARDS_LIMITS,
  type CreateAssociationInput,
  type ChangeAssociationInput,
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

const m10Printing = {
  printingId: 'printing-m10-146-en',
  cardId: lightningBolt.cardId,
  edition: 'M10',
  collectorNumber: '146',
  language: 'en',
  finishes: ['nonfoil'],
  physical: true,
};

describe('usercards associations', () => {
  let database: UserCardsTestDatabase;
  let catalog: Catalog;
  let userCards: UserCards;

  beforeEach(async () => {
    database = await createUserCardsTestDatabase();
    await publishCatalog(database, {
      revisionId: 'revision-1',
      cards: [lightningBolt],
      printings: [m11Printing, m10Printing],
    });
    catalog = createCatalog({ sql: database.sql });
    userCards = createUserCards({ sql: database.sql, catalog });
  });

  afterEach(async () => {
    await database.close();
  });

  async function createCopy(context: TrustedUserContext = alice): Promise<string> {
    const created = await userCards.createCopies(context, {
      printingId: m11Printing.printingId,
      finish: 'nonfoil',
      condition: 'NM',
      quantity: 1,
    });
    return created.copies[0]?.copyId as string;
  }

  async function createDeck(label = 'Burn'): Promise<string> {
    const created = await userCards.createTag(alice, { kind: 'deck', label });
    return created.tag.tagId;
  }

  it('creates card and printing associations with their intended quantities', async () => {
    const wishlist = await userCards.createTag(alice, { kind: 'wishlist', label: 'To buy' });
    const deck = await createDeck();

    const cardAssociation = await userCards.createAssociation(alice, {
      tagId: wishlist.tag.tagId,
      targetLevel: 'card',
      targetId: lightningBolt.cardId,
      quantity: 2,
    });
    expect(cardAssociation.association).toEqual({
      associationId: cardAssociation.association.associationId,
      tagId: wishlist.tag.tagId,
      targetLevel: 'card',
      targetId: lightningBolt.cardId,
      quantity: 2,
      revision: 1,
    });

    const printingAssociation = await userCards.createAssociation(alice, {
      tagId: deck,
      targetLevel: 'printing',
      targetId: m11Printing.printingId,
      quantity: 4,
    });
    expect(printingAssociation.association).toMatchObject({
      tagId: deck,
      targetLevel: 'printing',
      targetId: m11Printing.printingId,
      quantity: 4,
      revision: 1,
    });

    const read = await userCards.readAssociations(alice, [
      cardAssociation.association.associationId,
      printingAssociation.association.associationId,
      'association-unknown',
    ]);
    expect(read.privateRevision).toBe('4');
    expect(read.associations.size).toBe(2);
    expect(read.associations.get(cardAssociation.association.associationId)).toEqual(
      cardAssociation.association,
    );
    expect(read.missing).toEqual(['association-unknown']);
  });

  it('keeps the association identity while refining and broadening the target level', async () => {
    const wishlist = await userCards.createTag(alice, { kind: 'wishlist', label: 'To buy' });
    const created = await userCards.createAssociation(alice, {
      tagId: wishlist.tag.tagId,
      targetLevel: 'card',
      targetId: lightningBolt.cardId,
      quantity: 2,
    });
    const associationId = created.association.associationId;

    const refined = await userCards.changeAssociation(alice, {
      associationId,
      expectedRevision: 1,
      targetLevel: 'printing',
      targetId: m11Printing.printingId,
      quantity: 2,
    });
    expect(refined.association).toEqual({
      associationId,
      tagId: wishlist.tag.tagId,
      targetLevel: 'printing',
      targetId: m11Printing.printingId,
      quantity: 2,
      revision: 2,
    });

    const broadened = await userCards.changeAssociation(alice, {
      associationId,
      expectedRevision: 2,
      targetLevel: 'card',
      targetId: lightningBolt.cardId,
      quantity: 3,
    });
    expect(broadened.association).toEqual({
      associationId,
      tagId: wishlist.tag.tagId,
      targetLevel: 'card',
      targetId: lightningBolt.cardId,
      quantity: 3,
      revision: 3,
    });

    const read = await userCards.readAssociations(alice, [associationId]);
    expect(read.associations.get(associationId)).toEqual(broadened.association);
  });

  it('associates individual copies without a quantity', async () => {
    const deck = await createDeck();
    const copyId = await createCopy();

    const stated = await userCards.createAssociation(alice, {
      tagId: deck,
      targetLevel: 'copy',
      targetId: copyId,
      quantity: null,
    });
    expect(stated.association).toMatchObject({
      targetLevel: 'copy',
      targetId: copyId,
      quantity: null,
      revision: 1,
    });

    const other = await userCards.createAssociation(alice, {
      tagId: deck,
      targetLevel: 'copy',
      targetId: await createCopy(),
    });
    expect(other.association.quantity).toBeNull();
  });

  it('rejects quantities on copy membership and intent targets without one', async () => {
    const deck = await createDeck();
    const copyId = await createCopy();

    const quantityOnCopy = await captureUserCardsError(
      userCards.createAssociation(alice, {
        tagId: deck,
        targetLevel: 'copy',
        targetId: copyId,
        quantity: 2,
      }),
    );
    expect(quantityOnCopy.code).toBe('invalid-request');

    const missingQuantity = await captureUserCardsError(
      userCards.createAssociation(alice, {
        tagId: deck,
        targetLevel: 'card',
        targetId: lightningBolt.cardId,
      }),
    );
    expect(missingQuantity.code).toBe('invalid-request');

    const quantityOnPrinting = await captureUserCardsError(
      userCards.createAssociation(alice, {
        tagId: deck,
        targetLevel: 'printing',
        targetId: m11Printing.printingId,
        quantity: USERCARDS_LIMITS.maxAssociationQuantity + 1,
      }),
    );
    expect(quantityOnPrinting.code).toBe('invalid-request');
  });

  it('leaves location membership and ownership to their own operations', async () => {
    const location = await userCards.createTag(alice, { kind: 'location', label: 'Binder' });
    const copyId = await createCopy();

    const locationAssociation = await captureUserCardsError(
      userCards.createAssociation(alice, {
        tagId: location.tag.tagId,
        targetLevel: 'copy',
        targetId: copyId,
      }),
    );
    expect(locationAssociation.code).toBe('invalid-request');

    const listed = await userCards.listTags(alice);
    const owned = listed.tags.find((tag) => tag.kind === 'owned');
    const ownership = await captureUserCardsError(
      userCards.createAssociation(alice, {
        tagId: owned?.tagId as string,
        targetLevel: 'copy',
        targetId: copyId,
      }),
    );
    expect(ownership.code).toBe('invalid-request');

    const wishlist = await userCards.createTag(alice, { kind: 'wishlist', label: 'Wanted' });
    const wishlistCopy = await captureUserCardsError(
      userCards.createAssociation(alice, {
        tagId: wishlist.tag.tagId,
        targetLevel: 'copy',
        targetId: copyId,
      }),
    );
    expect(wishlistCopy.code).toBe('invalid-request');
  });

  it('resolves the target through the catalog and the account before storing', async () => {
    const deck = await createDeck();

    const unknownCard = await captureUserCardsError(
      userCards.createAssociation(alice, {
        tagId: deck,
        targetLevel: 'card',
        targetId: 'card-missing',
        quantity: 1,
      }),
    );
    expect(unknownCard.code).toBe('not-found');

    const unknownPrinting = await captureUserCardsError(
      userCards.createAssociation(alice, {
        tagId: deck,
        targetLevel: 'printing',
        targetId: 'printing-missing',
        quantity: 1,
      }),
    );
    expect(unknownPrinting.code).toBe('not-found');

    const offline: Catalog = {
      async resolve() {
        throw new CatalogError('unavailable', 'The catalog database could not be read.');
      },
      async listCardPrintings() {
        throw new CatalogError('unavailable', 'The catalog database could not be read.');
      },
    };
    const withoutCatalog = createUserCards({ sql: database.sql, catalog: offline });
    const unavailable = await captureUserCardsError(
      withoutCatalog.createAssociation(alice, {
        tagId: deck,
        targetLevel: 'card',
        targetId: lightningBolt.cardId,
        quantity: 1,
      }),
    );
    expect(unavailable.code).toBe('unavailable');

    // Another account's copy is missing exactly like a copy that never existed.
    const foreignCopyId = await createCopy(bob);
    const foreignCopy = await captureUserCardsError(
      userCards.createAssociation(alice, {
        tagId: deck,
        targetLevel: 'copy',
        targetId: foreignCopyId,
      }),
    );
    const unknownCopy = await captureUserCardsError(
      userCards.createAssociation(alice, {
        tagId: deck,
        targetLevel: 'copy',
        targetId: 'copy-unknown',
      }),
    );
    expect(foreignCopy.code).toBe('not-found');
    expect(foreignCopy.message).toBe(unknownCopy.message);
  });

  it('reports a stale revision as a conflict and keeps the newer association', async () => {
    const deck = await createDeck();
    const created = await userCards.createAssociation(alice, {
      tagId: deck,
      targetLevel: 'card',
      targetId: lightningBolt.cardId,
      quantity: 1,
    });
    const associationId = created.association.associationId;
    await userCards.changeAssociation(alice, {
      associationId,
      expectedRevision: 1,
      targetLevel: 'card',
      targetId: lightningBolt.cardId,
      quantity: 4,
    });

    const conflict = await captureUserCardsError(
      userCards.changeAssociation(alice, {
        associationId,
        expectedRevision: 1,
        targetLevel: 'printing',
        targetId: m10Printing.printingId,
        quantity: 2,
      }),
    );
    expect(conflict.code).toBe('conflict');

    const current = await userCards.readAssociations(alice, [associationId]);
    expect(current.associations.get(associationId)).toEqual({
      associationId,
      tagId: deck,
      targetLevel: 'card',
      targetId: lightningBolt.cardId,
      quantity: 4,
      revision: 2,
    });
  });

  it('refuses to double a tag target through the generic change', async () => {
    const deck = await createDeck();
    const first = await userCards.createAssociation(alice, {
      tagId: deck,
      targetLevel: 'card',
      targetId: lightningBolt.cardId,
      quantity: 1,
    });
    const second = await userCards.createAssociation(alice, {
      tagId: deck,
      targetLevel: 'printing',
      targetId: m10Printing.printingId,
      quantity: 1,
    });

    const duplicate = await captureUserCardsError(
      userCards.changeAssociation(alice, {
        associationId: second.association.associationId,
        expectedRevision: 1,
        targetLevel: 'card',
        targetId: lightningBolt.cardId,
        quantity: 2,
      }),
    );
    expect(duplicate.code).toBe('conflict');

    const repeated = await captureUserCardsError(
      userCards.createAssociation(alice, {
        tagId: deck,
        targetLevel: 'card',
        targetId: lightningBolt.cardId,
        quantity: 1,
      }),
    );
    expect(repeated.code).toBe('conflict');

    const read = await userCards.readAssociations(alice, [
      first.association.associationId,
      second.association.associationId,
    ]);
    expect(read.associations.get(second.association.associationId)?.targetLevel).toBe('printing');
    expect(read.associations.size).toBe(2);
  });

  it('refuses quantity-bearing copy membership and quantity-free intent in storage', async () => {
    const deck = await createDeck();
    const copyId = await createCopy();

    await expect(
      database.exec(
        `insert into usercards_private.association
           (association_id, account_id, tag_id, tag_kind, target_level, target_id, quantity, revision)
         values ('association-injected', '${alice.accountId}', '${deck}', 'deck', 'copy',
                 '${copyId}', 2, 1)`,
      ),
    ).rejects.toThrow(/check constraint/);
    await expect(
      database.exec(
        `insert into usercards_private.association
           (association_id, account_id, tag_id, tag_kind, target_level, target_id, quantity, revision)
         values ('association-injected', '${alice.accountId}', '${deck}', 'deck', 'card',
                 '${lightningBolt.cardId}', null, 1)`,
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it('removes an association only while its revision still holds', async () => {
    const deck = await createDeck();
    const created = await userCards.createAssociation(alice, {
      tagId: deck,
      targetLevel: 'card',
      targetId: lightningBolt.cardId,
      quantity: 1,
    });
    const associationId = created.association.associationId;

    const removed = await userCards.removeAssociation(alice, {
      associationId,
      expectedRevision: 1,
    });
    expect(removed.privateRevision).toBe('3');
    expect(removed.associationId).toBe(associationId);

    const again = await captureUserCardsError(
      userCards.removeAssociation(alice, { associationId, expectedRevision: 1 }),
    );
    expect(again.code).toBe('not-found');

    const stale = await captureUserCardsError(
      userCards.removeAssociation(alice, { associationId, expectedRevision: 2 }),
    );
    expect(stale.code).toBe('not-found');
  });

  it('renames a tag without changing its associations', async () => {
    const deck = await createDeck('Burn');
    const created = await userCards.createAssociation(alice, {
      tagId: deck,
      targetLevel: 'card',
      targetId: lightningBolt.cardId,
      quantity: 4,
    });
    const associationId = created.association.associationId;

    const renamed = await userCards.renameTag(alice, {
      tagId: deck,
      expectedRevision: 1,
      label: 'Mono red',
    });
    expect(renamed.tag.label).toBe('Mono red');

    const read = await userCards.readAssociations(alice, [associationId]);
    expect(read.associations.get(associationId)).toEqual(created.association);
  });

  it("keeps another account's associations and tags out of reach", async () => {
    const deck = await createDeck();
    const created = await userCards.createAssociation(alice, {
      tagId: deck,
      targetLevel: 'card',
      targetId: lightningBolt.cardId,
      quantity: 1,
    });
    const associationId = created.association.associationId;

    const foreignRead = await userCards.readAssociations(bob, [associationId]);
    expect(foreignRead.associations.size).toBe(0);
    expect(foreignRead.missing).toEqual([associationId]);
    expect(foreignRead.privateRevision).toBe('0');

    const foreignTag = await captureUserCardsError(
      userCards.createAssociation(bob, {
        tagId: deck,
        targetLevel: 'card',
        targetId: lightningBolt.cardId,
        quantity: 1,
      }),
    );
    expect(foreignTag.code).toBe('not-found');

    const foreignChange = await captureUserCardsError(
      userCards.changeAssociation(bob, {
        associationId,
        expectedRevision: 1,
        targetLevel: 'card',
        targetId: lightningBolt.cardId,
        quantity: 3,
      }),
    );
    const unknownChange = await captureUserCardsError(
      userCards.changeAssociation(bob, {
        associationId: 'association-unknown',
        expectedRevision: 1,
        targetLevel: 'card',
        targetId: lightningBolt.cardId,
        quantity: 3,
      }),
    );
    expect(foreignChange.code).toBe('not-found');
    expect(foreignChange.message).toBe(unknownChange.message);

    const foreignRemoval = await captureUserCardsError(
      userCards.removeAssociation(bob, { associationId, expectedRevision: 1 }),
    );
    expect(foreignRemoval.code).toBe('not-found');

    const stored = await userCards.readAssociations(alice, [associationId]);
    expect(stored.associations.get(associationId)).toEqual(created.association);
    expect(stored.privateRevision).toBe('2');
  });

  it('rejects malformed association requests', async () => {
    const deck = await createDeck();
    for (const input of [
      { tagId: '', targetLevel: 'card', targetId: lightningBolt.cardId, quantity: 1 },
      { tagId: deck, targetLevel: 'deck', targetId: lightningBolt.cardId, quantity: 1 },
      { tagId: deck, targetLevel: 'card', targetId: '', quantity: 1 },
      { tagId: deck, targetLevel: 'card', targetId: lightningBolt.cardId, quantity: 0 },
      { tagId: deck, targetLevel: 'card', targetId: lightningBolt.cardId, quantity: 1.5 },
    ]) {
      const error = await captureUserCardsError(
        userCards.createAssociation(alice, callerInput<CreateAssociationInput>(input)),
      );
      expect(error.code).toBe('invalid-request');
    }

    const created = await userCards.createAssociation(alice, {
      tagId: deck,
      targetLevel: 'card',
      targetId: lightningBolt.cardId,
      quantity: 1,
    });
    for (const input of [
      {
        associationId: '',
        expectedRevision: 1,
        targetLevel: 'card',
        targetId: lightningBolt.cardId,
        quantity: 1,
      },
      {
        associationId: created.association.associationId,
        expectedRevision: 0,
        targetLevel: 'card',
        targetId: lightningBolt.cardId,
        quantity: 1,
      },
      {
        associationId: created.association.associationId,
        expectedRevision: 1,
        targetLevel: 'card',
        targetId: lightningBolt.cardId,
      },
    ]) {
      const error = await captureUserCardsError(
        userCards.changeAssociation(alice, callerInput<ChangeAssociationInput>(input)),
      );
      expect(error.code).toBe('invalid-request');
    }

    for (const input of [
      { associationId: created.association.associationId },
      { associationId: created.association.associationId, expectedRevision: 0 },
      { associationId: '', expectedRevision: 1 },
    ]) {
      const error = await captureUserCardsError(
        userCards.removeAssociation(alice, callerInput(input)),
      );
      expect(error.code).toBe('invalid-request');
    }

    const tooManyReferences = await captureUserCardsError(
      userCards.readAssociations(
        alice,
        Array.from(
          { length: USERCARDS_LIMITS.maxReadReferences + 1 },
          (_, index) => `association-${index}`,
        ),
      ),
    );
    expect(tooManyReferences.code).toBe('invalid-request');

    for (const context of [undefined, {}, { accountId: '' }]) {
      const error = await captureUserCardsError(
        userCards.readAssociations(callerInput<TrustedUserContext>(context), []),
      );
      expect(error.code).toBe('invalid-request');
    }
  });
});
