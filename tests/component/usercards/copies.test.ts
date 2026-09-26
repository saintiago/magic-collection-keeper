import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CatalogError, createCatalog, type Catalog } from '../../../src/catalog/index.js';
import {
  createUserCards,
  USERCARDS_LIMITS,
  type CreateCopiesInput,
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

describe('usercards copy storage', () => {
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

  it('stores one individual copy per requested quantity with stable identities', async () => {
    const created = await userCards.createCopies(alice, {
      printingId: m11Printing.printingId,
      finish: 'foil',
      condition: 'LP',
      quantity: 3,
    });

    expect(created.privateRevision).toBe('1');
    expect(created.copies).toHaveLength(3);
    const copyIds = created.copies.map((copy) => copy.copyId);
    expect(new Set(copyIds).size).toBe(3);
    for (const copy of created.copies) {
      expect(copy).toEqual({
        copyId: copy.copyId,
        printingId: m11Printing.printingId,
        finish: 'foil',
        condition: 'LP',
        revision: 1,
      });
    }

    const read = await userCards.readCopies(alice, copyIds);
    expect(read.privateRevision).toBe('1');
    expect(read.missing).toEqual([]);
    expect([...read.copies.keys()].sort()).toEqual([...copyIds].sort());
    expect(read.copies.get(copyIds[0] as string)).toMatchObject({
      printingId: m11Printing.printingId,
      finish: 'foil',
      condition: 'LP',
      revision: 1,
    });
  });

  it('keeps an unknown condition explicit and never stores one it was not given', async () => {
    const created = await userCards.createCopies(alice, {
      printingId: m11Printing.printingId,
      finish: 'nonfoil',
      condition: null,
      quantity: 1,
    });
    const copyId = created.copies[0]?.copyId as string;

    const read = await userCards.readCopies(alice, [copyId]);
    expect(read.copies.get(copyId)).toMatchObject({ condition: null });

    // A request that leaves the condition out instead of stating it is invalid: a suggestion
    // cannot establish a physical condition.
    const omitted = await captureUserCardsError(
      userCards.createCopies(
        alice,
        callerInput<CreateCopiesInput>({
          printingId: m11Printing.printingId,
          finish: 'nonfoil',
          quantity: 1,
        }),
      ),
    );
    expect(omitted.code).toBe('invalid-request');
    const revision = await userCards.readCopies(alice, []);
    expect(revision.privateRevision).toBe('1');
  });

  it('resolves the printing and its physical attributes through the catalog before storing', async () => {
    const unknownPrinting = await captureUserCardsError(
      userCards.createCopies(alice, {
        printingId: 'printing-missing',
        finish: 'nonfoil',
        condition: null,
        quantity: 1,
      }),
    );
    expect(unknownPrinting.code).toBe('not-found');

    const notPhysical = await captureUserCardsError(
      userCards.createCopies(alice, {
        printingId: staPrinting.printingId,
        finish: 'etched',
        condition: 'NM',
        quantity: 1,
      }),
    );
    expect(notPhysical.code).toBe('invalid-request');

    const unavailableFinish = await captureUserCardsError(
      userCards.createCopies(alice, {
        printingId: m10Printing.printingId,
        finish: 'foil',
        condition: 'NM',
        quantity: 1,
      }),
    );
    expect(unavailableFinish.code).toBe('invalid-request');

    // None of the rejected requests stored a copy or advanced the private revision.
    const unchanged = await userCards.readCopies(alice, []);
    expect(unchanged.privateRevision).toBe('0');
    expect(unchanged.copies.size).toBe(0);
  });

  it('reports an unavailable catalog as a temporary failure, not as a missing printing', async () => {
    const offline: Catalog = {
      async resolve() {
        throw new CatalogError('unavailable', 'The catalog database could not be read.');
      },
      async listCardPrintings() {
        throw new CatalogError('unavailable', 'The catalog database could not be read.');
      },
    };
    const withoutCatalog = createUserCards({ sql: database.sql, catalog: offline });

    const error = await captureUserCardsError(
      withoutCatalog.createCopies(alice, {
        printingId: m11Printing.printingId,
        finish: 'foil',
        condition: null,
        quantity: 1,
      }),
    );
    expect(error.code).toBe('unavailable');
  });

  it('rolls back copies whose private revision cannot be published', async () => {
    const failing = createUserCards({
      sql: failRevisionStatements(database.sql),
      catalog,
    });

    const error = await captureUserCardsError(
      failing.createCopies(alice, {
        printingId: m11Printing.printingId,
        finish: 'foil',
        condition: 'NM',
        quantity: 2,
      }),
    );
    expect(error.code).toBe('unavailable');

    const stored = await database.query(
      'select count(*)::int as copies from usercards_private.copy',
    );
    expect(stored[0]?.copies).toBe(0);
    const unchanged = await userCards.readCopies(alice, []);
    expect(unchanged.privateRevision).toBe('0');
  });

  it('scopes the private revision to the trusted account', async () => {
    await userCards.createCopies(alice, {
      printingId: m11Printing.printingId,
      finish: 'nonfoil',
      condition: 'NM',
      quantity: 1,
    });

    expect((await userCards.readCopies(alice, [])).privateRevision).toBe('1');
    expect((await userCards.readCopies(bob, [])).privateRevision).toBe('0');

    await userCards.createCopies(bob, {
      printingId: m11Printing.printingId,
      finish: 'foil',
      condition: null,
      quantity: 1,
    });
    expect((await userCards.readCopies(bob, [])).privateRevision).toBe('1');
    expect((await userCards.readCopies(alice, [])).privateRevision).toBe('1');
  });

  it('rejects malformed requests and missing trusted context', async () => {
    const request = {
      printingId: m11Printing.printingId,
      finish: 'nonfoil',
      condition: 'NM',
      quantity: 1,
    };
    for (const quantity of [0, USERCARDS_LIMITS.maxCreateQuantity + 1, 1.5]) {
      const error = await captureUserCardsError(
        userCards.createCopies(alice, callerInput<CreateCopiesInput>({ ...request, quantity })),
      );
      expect(error.code).toBe('invalid-request');
    }
    const unknownFinish = await captureUserCardsError(
      userCards.createCopies(
        alice,
        callerInput<CreateCopiesInput>({ ...request, finish: 'glossy' }),
      ),
    );
    expect(unknownFinish.code).toBe('invalid-request');

    const tooManyReferences = await captureUserCardsError(
      userCards.readCopies(
        alice,
        Array.from(
          { length: USERCARDS_LIMITS.maxReadReferences + 1 },
          (_, index) => `copy-${index}`,
        ),
      ),
    );
    expect(tooManyReferences.code).toBe('invalid-request');
    const unreadableReference = await captureUserCardsError(
      userCards.readCopies(alice, callerInput<readonly string[]>([42])),
    );
    expect(unreadableReference.code).toBe('invalid-request');

    for (const context of [undefined, {}, { accountId: '' }]) {
      const error = await captureUserCardsError(
        userCards.readCopies(callerInput<TrustedUserContext>(context), []),
      );
      expect(error.code).toBe('invalid-request');
    }
  });

  it('reads each requested reference once and reports unknown or foreign references as missing', async () => {
    const created = await userCards.createCopies(alice, {
      printingId: m11Printing.printingId,
      finish: 'nonfoil',
      condition: 'NM',
      quantity: 1,
    });
    const copyId = created.copies[0]?.copyId as string;

    const duplicated = await userCards.readCopies(alice, [copyId, copyId, 'copy-unknown']);
    expect([...duplicated.copies.keys()]).toEqual([copyId]);
    expect(duplicated.missing).toEqual(['copy-unknown']);

    // Another account's reference is missing exactly like a reference that never existed.
    const foreign = await userCards.readCopies(bob, [copyId, 'copy-unknown']);
    expect(foreign.copies.size).toBe(0);
    expect(foreign.missing).toEqual([copyId, 'copy-unknown']);
    expect(foreign.privateRevision).toBe('0');
  });

  it('requires a transaction-capable executor and the catalog contract', () => {
    expect(() =>
      createUserCards(callerInput<Parameters<typeof createUserCards>[0]>({ catalog })),
    ).toThrow(TypeError);
    expect(() =>
      createUserCards(
        callerInput<Parameters<typeof createUserCards>[0]>({ sql: database.sql, catalog: {} }),
      ),
    ).toThrow(TypeError);
  });
});
