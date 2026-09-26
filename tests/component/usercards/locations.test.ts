import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCatalog, type Catalog } from '../../../src/catalog/index.js';
import {
  createUserCards,
  type Association,
  type SetCopyLocationInput,
  type TrustedUserContext,
  type UserCards,
} from '../../../src/usercards/index.js';
import { publishCatalog } from '../../support/catalog-database.js';
import {
  captureUserCardsError,
  createUserCardsTestDatabase,
  type UserCardsTestDatabase,
} from '../../support/usercards-database.js';
import { callerInput, failRevisionStatements } from './harness.js';

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

describe('usercards physical locations', () => {
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

  async function createCopy(context: TrustedUserContext = alice): Promise<string> {
    const created = await userCards.createCopies(context, {
      printingId: m11Printing.printingId,
      finish: 'nonfoil',
      condition: 'NM',
      quantity: 1,
    });
    return created.copies[0]?.copyId as string;
  }

  async function createLocation(label: string): Promise<string> {
    const created = await userCards.createTag(alice, { kind: 'location', label });
    return created.tag.tagId;
  }

  async function locationRows(
    accountId: string,
    copyId: string,
  ): Promise<readonly Record<string, unknown>[]> {
    return database.query(
      `select tag_id, revision
         from usercards_private.association
        where account_id = $1 and tag_kind = 'location' and target_level = 'copy'
          and target_id = $2
        order by tag_id`,
      [accountId, copyId],
    );
  }

  it('stores each copy as owned through the system owned tag', async () => {
    const copyId = await createCopy();

    const rows = await database.query(
      `select tag.kind, tag.system, association.target_level
         from usercards_private.association as association
         join usercards_private.tag as tag on tag.tag_id = association.tag_id
        where association.account_id = $1 and association.target_id = $2`,
      [alice.accountId, copyId],
    );
    expect(rows).toEqual([{ kind: 'owned', system: true, target_level: 'copy' }]);

    const other = await database.query(
      `select count(*)::int as owned from usercards_private.association
        where account_id = $1 and tag_kind = 'owned'`,
      [bob.accountId],
    );
    expect(other[0]?.owned).toBe(0);
  });

  it('moves a copy between locations and replaces the previous membership', async () => {
    const binder = await createLocation('Binder');
    const box = await createLocation('Box');
    const copyId = await createCopy();

    const first = await userCards.setCopyLocation(alice, {
      copyId,
      locationTagId: binder,
      expectedRevision: 1,
    });
    expect(first.copy.revision).toBe(2);
    expect(first.location).toEqual({
      associationId: first.location?.associationId,
      tagId: binder,
      targetLevel: 'copy',
      targetId: copyId,
      quantity: null,
      revision: 1,
    });

    const second = await userCards.setCopyLocation(alice, {
      copyId,
      locationTagId: box,
      expectedRevision: 2,
    });
    expect(second.copy.revision).toBe(3);
    expect(second.location).toEqual({
      associationId: first.location?.associationId,
      tagId: box,
      targetLevel: 'copy',
      targetId: copyId,
      quantity: null,
      revision: 2,
    });
    expect(await locationRows(alice.accountId, copyId)).toEqual([{ tag_id: box, revision: 2 }]);

    // The move publishes a private revision and keeps the copy's ownership membership.
    const read = await userCards.readCopies(alice, [copyId]);
    expect(read.privateRevision).toBe('5');
    expect(read.copies.get(copyId)?.revision).toBe(3);
    const owned = await database.query(
      `select count(*)::int as owned from usercards_private.association
        where account_id = $1 and tag_kind = 'owned' and target_id = $2`,
      [alice.accountId, copyId],
    );
    expect(owned[0]?.owned).toBe(1);
  });

  it('clears a location without changing ownership', async () => {
    const binder = await createLocation('Binder');
    const copyId = await createCopy();
    await userCards.setCopyLocation(alice, {
      copyId,
      locationTagId: binder,
      expectedRevision: 1,
    });

    const cleared = await userCards.setCopyLocation(alice, {
      copyId,
      locationTagId: null,
      expectedRevision: 2,
    });
    expect(cleared.copy.revision).toBe(3);
    expect(cleared.location).toBeNull();
    expect(await locationRows(alice.accountId, copyId)).toEqual([]);

    const owned = await database.query(
      `select count(*)::int as owned from usercards_private.association
        where account_id = $1 and tag_kind = 'owned' and target_id = $2`,
      [alice.accountId, copyId],
    );
    expect(owned[0]?.owned).toBe(1);
  });

  it('keeps location and ownership membership out of the generic association removal', async () => {
    const binder = await createLocation('Binder');
    const copyId = await createCopy();
    const moved = await userCards.setCopyLocation(alice, {
      copyId,
      locationTagId: binder,
      expectedRevision: 1,
    });
    const locationAssociation = moved.location as Association;

    const removedLocation = await captureUserCardsError(
      userCards.removeAssociation(alice, {
        associationId: locationAssociation.associationId,
        expectedRevision: locationAssociation.revision,
      }),
    );
    expect(removedLocation.code).toBe('invalid-request');
    expect(await locationRows(alice.accountId, copyId)).toEqual([{ tag_id: binder, revision: 1 }]);

    const owned = await database.query(
      `select association_id, revision from usercards_private.association
        where account_id = $1 and tag_kind = 'owned' and target_id = $2`,
      [alice.accountId, copyId],
    );
    const removedOwnership = await captureUserCardsError(
      userCards.removeAssociation(alice, {
        associationId: String(owned[0]?.association_id),
        expectedRevision: Number(owned[0]?.revision),
      }),
    );
    expect(removedOwnership.code).toBe('invalid-request');
    const stillOwned = await database.query(
      `select count(*)::int as owned from usercards_private.association
        where account_id = $1 and tag_kind = 'owned' and target_id = $2`,
      [alice.accountId, copyId],
    );
    expect(stillOwned[0]?.owned).toBe(1);
  });

  it('reports a competing move as a conflict and keeps the move that committed first', async () => {
    const binder = await createLocation('Binder');
    const box = await createLocation('Box');
    const copyId = await createCopy();

    await userCards.setCopyLocation(alice, { copyId, locationTagId: binder, expectedRevision: 1 });
    const conflict = await captureUserCardsError(
      userCards.setCopyLocation(alice, { copyId, locationTagId: box, expectedRevision: 1 }),
    );
    expect(conflict.code).toBe('conflict');

    const read = await userCards.readCopies(alice, [copyId]);
    expect(read.copies.get(copyId)?.revision).toBe(2);
    expect(await locationRows(alice.accountId, copyId)).toEqual([{ tag_id: binder, revision: 1 }]);
  });

  it('rolls back a move whose private revision cannot be published', async () => {
    const binder = await createLocation('Binder');
    const copyId = await createCopy();
    const failing = createUserCards({
      sql: failRevisionStatements(database.sql),
      catalog,
    });

    const error = await captureUserCardsError(
      failing.setCopyLocation(alice, { copyId, locationTagId: binder, expectedRevision: 1 }),
    );
    expect(error.code).toBe('unavailable');

    const read = await userCards.readCopies(alice, [copyId]);
    expect(read.privateRevision).toBe('2');
    expect(read.copies.get(copyId)?.revision).toBe(1);
    expect(await locationRows(alice.accountId, copyId)).toEqual([]);
  });

  it('refuses a second location membership for one copy in storage', async () => {
    const binder = await createLocation('Binder');
    const box = await createLocation('Box');
    const copyId = await createCopy();
    await userCards.setCopyLocation(alice, { copyId, locationTagId: binder, expectedRevision: 1 });

    await expect(
      database.exec(
        `insert into usercards_private.association
           (association_id, account_id, tag_id, tag_kind, target_level, target_id, quantity, revision)
         values ('association-injected', '${alice.accountId}', '${box}', 'location', 'copy',
                 '${copyId}', null, 1)`,
      ),
    ).rejects.toThrow(/duplicate key/);
    expect(await locationRows(alice.accountId, copyId)).toEqual([{ tag_id: binder, revision: 1 }]);
  });

  it('requires an authorized location tag and copy', async () => {
    const deck = await userCards.createTag(alice, { kind: 'deck', label: 'Burn' });
    const binder = await createLocation('Binder');
    const copyId = await createCopy();

    const notALocation = await captureUserCardsError(
      userCards.setCopyLocation(alice, {
        copyId,
        locationTagId: deck.tag.tagId,
        expectedRevision: 1,
      }),
    );
    expect(notALocation.code).toBe('invalid-request');

    const unknownTag = await captureUserCardsError(
      userCards.setCopyLocation(alice, {
        copyId,
        locationTagId: 'tag-unknown',
        expectedRevision: 1,
      }),
    );
    const foreignTag = await captureUserCardsError(
      userCards.setCopyLocation(bob, {
        copyId,
        locationTagId: binder,
        expectedRevision: 1,
      }),
    );
    expect(unknownTag.code).toBe('not-found');
    expect(foreignTag.code).toBe('not-found');

    const unknownCopy = await captureUserCardsError(
      userCards.setCopyLocation(alice, {
        copyId: 'copy-unknown',
        locationTagId: binder,
        expectedRevision: 1,
      }),
    );
    const foreignCopyId = await createCopy(bob);
    const foreignCopy = await captureUserCardsError(
      userCards.setCopyLocation(alice, {
        copyId: foreignCopyId,
        locationTagId: binder,
        expectedRevision: 1,
      }),
    );
    expect(unknownCopy.code).toBe('not-found');
    expect(foreignCopy.code).toBe('not-found');
    expect(foreignCopy.message).toBe(unknownCopy.message);

    const untouched = await userCards.readCopies(alice, [copyId]);
    expect(untouched.copies.get(copyId)?.revision).toBe(1);
    expect(await locationRows(alice.accountId, copyId)).toEqual([]);
  });

  it('does not move or reserve copies when a planned deck association changes', async () => {
    const deck = await userCards.createTag(alice, { kind: 'deck', label: 'Burn' });
    const copyId = await createCopy();

    const planned = await userCards.createAssociation(alice, {
      tagId: deck.tag.tagId,
      targetLevel: 'card',
      targetId: lightningBolt.cardId,
      quantity: 4,
    });
    const refined = await userCards.changeAssociation(alice, {
      associationId: planned.association.associationId,
      expectedRevision: 1,
      targetLevel: 'printing',
      targetId: m11Printing.printingId,
      quantity: 4,
    });
    expect(refined.association.targetLevel).toBe('printing');

    // The planned deck references the card and printing only; the physical copy keeps its
    // revision, its location and its ownership membership.
    const copy = await userCards.readCopies(alice, [copyId]);
    expect(copy.copies.get(copyId)?.revision).toBe(1);
    expect(await locationRows(alice.accountId, copyId)).toEqual([]);
    const memberships = await database.query(
      `select target_level from usercards_private.association
        where account_id = $1 and tag_id = $2 order by target_level`,
      [alice.accountId, deck.tag.tagId],
    );
    expect(memberships).toEqual([{ target_level: 'printing' }]);
  });

  it('rejects malformed location requests', async () => {
    const binder = await createLocation('Binder');
    const copyId = await createCopy();

    for (const input of [
      { copyId: '', locationTagId: binder, expectedRevision: 1 },
      { copyId, locationTagId: binder, expectedRevision: 0 },
      { copyId, locationTagId: binder, expectedRevision: 1.5 },
      { copyId, expectedRevision: 1 },
      { copyId, locationTagId: '', expectedRevision: 1 },
    ]) {
      const error = await captureUserCardsError(
        userCards.setCopyLocation(alice, callerInput<SetCopyLocationInput>(input)),
      );
      expect(error.code).toBe('invalid-request');
    }

    for (const context of [undefined, {}, { accountId: '' }]) {
      const error = await captureUserCardsError(
        userCards.setCopyLocation(callerInput<TrustedUserContext>(context), {
          copyId,
          locationTagId: binder,
          expectedRevision: 1,
        }),
      );
      expect(error.code).toBe('invalid-request');
    }
  });
});
