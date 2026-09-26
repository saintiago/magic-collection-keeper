import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCatalog, type Catalog } from '../../../src/catalog/index.js';
import {
  createUserCards,
  type CorrectCopyInput,
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

const m10Printing = {
  printingId: 'printing-m10-146-en',
  cardId: lightningBolt.cardId,
  edition: 'M10',
  collectorNumber: '146',
  language: 'en',
  finishes: ['nonfoil'],
  physical: true,
};

const staPrinting = {
  printingId: 'printing-sta-109-en',
  cardId: lightningBolt.cardId,
  edition: 'STA',
  collectorNumber: '109',
  language: 'en',
  finishes: ['etched'],
  physical: false,
};

describe('usercards copy corrections', () => {
  let database: UserCardsTestDatabase;
  let catalog: Catalog;
  let userCards: UserCards;

  beforeEach(async () => {
    database = await createUserCardsTestDatabase();
    await publishCatalog(database, {
      revisionId: 'revision-1',
      cards: [lightningBolt],
      printings: [m11Printing, m10Printing, staPrinting],
    });
    catalog = createCatalog({ sql: database.sql });
    userCards = createUserCards({ sql: database.sql, catalog });
  });

  afterEach(async () => {
    await database.close();
  });

  async function createCopy(condition: 'NM' | 'LP' | null = 'NM'): Promise<string> {
    const created = await userCards.createCopies(alice, {
      printingId: m11Printing.printingId,
      finish: 'foil',
      condition,
      quantity: 1,
    });
    return created.copies[0]?.copyId as string;
  }

  it('corrects printing, finish and condition in place while keeping the copy identity', async () => {
    const copyId = await createCopy('LP');

    const corrected = await userCards.correctCopy(alice, {
      copyId,
      expectedRevision: 1,
      printingId: m10Printing.printingId,
      finish: 'nonfoil',
      condition: 'HP',
    });

    expect(corrected.privateRevision).toBe('2');
    expect(corrected.copies).toEqual([
      {
        copyId,
        printingId: m10Printing.printingId,
        finish: 'nonfoil',
        condition: 'HP',
        revision: 2,
      },
    ]);

    const read = await userCards.readCopies(alice, [copyId]);
    expect(read.privateRevision).toBe('2');
    expect(read.copies.get(copyId)).toEqual(corrected.copies[0]);
  });

  it('supplies a condition for a copy whose condition was unknown', async () => {
    const copyId = await createCopy(null);

    const corrected = await userCards.correctCopy(alice, {
      copyId,
      expectedRevision: 1,
      printingId: m11Printing.printingId,
      finish: 'foil',
      condition: 'MP',
    });

    expect(corrected.copies[0]).toMatchObject({
      copyId,
      printingId: m11Printing.printingId,
      finish: 'foil',
      condition: 'MP',
      revision: 2,
    });
  });

  it('re-validates the corrected printing and finish through the catalog', async () => {
    const copyId = await createCopy('NM');
    const base: CorrectCopyInput = {
      copyId,
      expectedRevision: 1,
      printingId: m11Printing.printingId,
      finish: 'foil',
      condition: 'NM',
    };

    const missing = await captureUserCardsError(
      userCards.correctCopy(alice, { ...base, printingId: 'printing-missing' }),
    );
    expect(missing.code).toBe('not-found');

    const notPhysical = await captureUserCardsError(
      userCards.correctCopy(alice, {
        ...base,
        printingId: staPrinting.printingId,
        finish: 'etched',
      }),
    );
    expect(notPhysical.code).toBe('invalid-request');

    const unavailableFinish = await captureUserCardsError(
      userCards.correctCopy(alice, {
        ...base,
        printingId: m10Printing.printingId,
        finish: 'foil',
      }),
    );
    expect(unavailableFinish.code).toBe('invalid-request');

    // Every rejected correction left the copy at its stored revision and attributes.
    const unchanged = await userCards.readCopies(alice, [copyId]);
    expect(unchanged.copies.get(copyId)).toEqual({
      copyId,
      printingId: m11Printing.printingId,
      finish: 'foil',
      condition: 'NM',
      revision: 1,
    });
    expect(unchanged.privateRevision).toBe('1');
  });

  it('rejects a correction whose revision is stale and keeps the newer copy intact', async () => {
    const copyId = await createCopy('LP');
    await userCards.correctCopy(alice, {
      copyId,
      expectedRevision: 1,
      printingId: m10Printing.printingId,
      finish: 'nonfoil',
      condition: 'MP',
    });

    const conflict = await captureUserCardsError(
      userCards.correctCopy(alice, {
        copyId,
        expectedRevision: 1,
        printingId: m11Printing.printingId,
        finish: 'foil',
        condition: 'NM',
      }),
    );
    expect(conflict.code).toBe('conflict');

    const current = await userCards.readCopies(alice, [copyId]);
    expect(current.privateRevision).toBe('2');
    expect(current.copies.get(copyId)).toEqual({
      copyId,
      printingId: m10Printing.printingId,
      finish: 'nonfoil',
      condition: 'MP',
      revision: 2,
    });
  });

  it("treats another account's copy as missing without revealing it", async () => {
    const copyId = await createCopy('NM');
    const foreign: CorrectCopyInput = {
      copyId,
      expectedRevision: 1,
      printingId: m11Printing.printingId,
      finish: 'foil',
      condition: 'NM',
    };

    const foreignError = await captureUserCardsError(userCards.correctCopy(bob, foreign));
    const unknownError = await captureUserCardsError(
      userCards.correctCopy(bob, { ...foreign, copyId: 'copy-unknown' }),
    );
    expect(foreignError.code).toBe('not-found');
    expect(foreignError.message).toBe(unknownError.message);

    const read = await userCards.readCopies(bob, [copyId]);
    expect(read.copies.size).toBe(0);
    expect(read.missing).toEqual([copyId]);

    // Alice's copy and private revision are untouched by the foreign attempts.
    const stored = await userCards.readCopies(alice, [copyId]);
    expect(stored.privateRevision).toBe('1');
    expect(stored.copies.get(copyId)).toMatchObject({
      printingId: m11Printing.printingId,
      finish: 'foil',
      condition: 'NM',
      revision: 1,
    });
  });

  it('rolls back a correction whose private revision cannot be published', async () => {
    const copyId = await createCopy('LP');
    const failing = createUserCards({
      sql: failRevisionStatements(database.sql),
      catalog,
    });

    const error = await captureUserCardsError(
      failing.correctCopy(alice, {
        copyId,
        expectedRevision: 1,
        printingId: m11Printing.printingId,
        finish: 'nonfoil',
        condition: 'HP',
      }),
    );
    expect(error.code).toBe('unavailable');

    const unchanged = await userCards.readCopies(alice, [copyId]);
    expect(unchanged.privateRevision).toBe('1');
    expect(unchanged.copies.get(copyId)).toEqual({
      copyId,
      printingId: m11Printing.printingId,
      finish: 'foil',
      condition: 'LP',
      revision: 1,
    });
  });

  it('rejects malformed corrections', async () => {
    const copyId = await createCopy('NM');
    const base = {
      copyId,
      expectedRevision: 1,
      printingId: m11Printing.printingId,
      finish: 'foil',
      condition: 'NM',
    };

    for (const input of [
      { ...base, copyId: '' },
      { ...base, expectedRevision: 0 },
      { ...base, expectedRevision: 1.5 },
      { ...base, finish: 'glossy' },
      { ...base, condition: 'MINT' },
      { ...base, printingId: '' },
    ]) {
      const error = await captureUserCardsError(
        userCards.correctCopy(alice, callerInput<CorrectCopyInput>(input)),
      );
      expect(error.code).toBe('invalid-request');
    }
  });
});
