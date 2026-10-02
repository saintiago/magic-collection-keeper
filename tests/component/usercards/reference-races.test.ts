/**
 * Stable printing references are global metadata shared by account-local mutations. PGlite has one
 * connection, so this check uses real PostgreSQL to hold the first insertion open while another
 * account records the same previously absent relationship.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Catalog, type PrintingRecord } from '../../../src/catalog/index.js';
import {
  createUserCards,
  usercardsSchemaSql,
  type TrustedUserContext,
} from '../../../src/usercards/index.js';
import {
  startPostgresServer,
  type PostgresConnection,
  type PostgresServer,
} from '../../support/postgres-server.js';

const alice: TrustedUserContext = { accountId: 'cognito-alice' };
const bob: TrustedUserContext = { accountId: 'cognito-bob' };

const printing: PrintingRecord = {
  printingId: 'printing-shared',
  cardId: 'card-shared',
  edition: 'TST',
  collectorNumber: '1',
  language: 'en',
  finishes: ['nonfoil'],
  physical: true,
  images: { small: null, normal: null, large: null, artCrop: null },
};

const catalog: Catalog = {
  async resolve(references) {
    return {
      revision: {
        revisionId: 'revision-1',
        sourceName: 'test',
        sourceVersion: '1',
        publishedAt: '2026-10-02T00:00:00.000Z',
      },
      cards: new Map(),
      printings: new Map(
        references
          .filter(
            (reference) =>
              reference.kind === 'printing' && reference.printingId === printing.printingId,
          )
          .map(() => [printing.printingId, printing]),
      ),
      missing: [],
    };
  },
  async listCardPrintings() {
    throw new Error('This check lists no printings.');
  },
};

function within<T>(promise: Promise<T>, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(message)), 10_000);
    }),
  ]);
}

describe('usercards stable reference races', () => {
  let server: PostgresServer | undefined;
  let holder: PostgresConnection | undefined;
  let contender: PostgresConnection | undefined;
  let unavailable = '';

  beforeAll(async () => {
    try {
      server = await startPostgresServer(usercardsSchemaSql);
    } catch (cause) {
      unavailable = cause instanceof Error ? cause.message : String(cause);
      return;
    }
    holder = await server.connect();
    contender = await server.connect();
  }, 120_000);

  afterAll(async () => {
    await holder?.close();
    await contender?.close();
    await server?.close();
  }, 120_000);

  it('accepts concurrent first insertion of the same printing-to-card relationship', async (context) => {
    if (unavailable !== '') {
      context.skip(`A real PostgreSQL server is unavailable: ${unavailable}`);
      return;
    }
    if (holder === undefined || contender === undefined) {
      throw new Error('The stable-reference fixture has no connections.');
    }

    let firstReachedCommit: () => void = () => {};
    const firstClaimed = new Promise<void>((resolve) => {
      firstReachedCommit = resolve;
    });
    let releaseFirst: () => void = () => {};
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = createUserCards({
      sql: holder.transactor({
        beforeCommit: async () => {
          firstReachedCommit();
          await firstReleased;
        },
      }),
      catalog,
    }).createCopies(alice, {
      printingId: printing.printingId,
      finish: 'nonfoil',
      condition: 'NM',
      quantity: 1,
    });
    await within(firstClaimed, 'The first mutation did not claim the stable reference.');

    let secondReachedReference: () => void = () => {};
    const secondContending = new Promise<void>((resolve) => {
      secondReachedReference = resolve;
    });
    const second = createUserCards({
      sql: contender.transactor({
        onStatement(statement) {
          if (statement.includes('insert into usercards_private.printing_reference')) {
            secondReachedReference();
          }
        },
      }),
      catalog,
    }).createCopies(bob, {
      printingId: printing.printingId,
      finish: 'nonfoil',
      condition: 'LP',
      quantity: 1,
    });
    await within(secondContending, 'The second mutation did not contend for the stable reference.');
    releaseFirst();

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { copies: [{ printingId: printing.printingId }] },
      { copies: [{ printingId: printing.printingId }] },
    ]);
    const conflictingCatalog: Catalog = {
      ...catalog,
      async resolve(references) {
        const resolution = await catalog.resolve(references);
        return {
          ...resolution,
          printings: new Map([[printing.printingId, { ...printing, cardId: 'different-card' }]]),
        };
      },
    };
    await expect(
      createUserCards({ sql: contender.transactor(), catalog: conflictingCatalog }).createCopies(
        bob,
        {
          printingId: printing.printingId,
          finish: 'nonfoil',
          condition: null,
          quantity: 1,
        },
      ),
    ).rejects.toMatchObject({ code: 'unavailable' });
    await expect(
      contender.query(
        'select printing_id, card_id from usercards_private.printing_reference order by printing_id',
      ),
    ).resolves.toEqual([{ printing_id: printing.printingId, card_id: printing.cardId }]);
    await expect(
      contender.query('select copy_id from usercards_private.copy'),
    ).resolves.toHaveLength(2);
  }, 30_000);
});
