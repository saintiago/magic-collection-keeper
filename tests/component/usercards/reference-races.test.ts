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
  type UserCardsSqlTransactor,
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

const knownPrintings = new Map([[printing.printingId, printing]]);

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
        references.flatMap((reference) => {
          const found =
            reference.kind === 'printing' ? knownPrintings.get(reference.printingId) : undefined;
          return found === undefined ? [] : [[found.printingId, found] as const];
        }),
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

function isTagLock(statement: string): boolean {
  return (
    statement.includes('insert into usercards_private.tag') ||
    (statement.includes('from usercards_private.tag') && statement.includes('for update'))
  );
}

function signal() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function pauseAfterTagLock(connection: PostgresConnection) {
  const reached = signal();
  const released = signal();
  const base = connection.transactor();
  let paused = false;
  const sql: UserCardsSqlTransactor = {
    query: base.query,
    transaction(work) {
      return base.transaction((statements) =>
        work({
          async query(statement, parameters) {
            const rows = await statements.query(statement, parameters);
            if (!paused && isTagLock(statement)) {
              paused = true;
              reached.resolve();
              await released.promise;
            }
            return rows;
          },
        }),
      );
    },
  };
  return { sql, reached: reached.promise, release: released.resolve };
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
  it.for([
    ['ownership', false],
    ['ownership', true],
    ['association creation', false],
    ['association creation', true],
    ['association correction', false],
    ['association correction', true],
  ] as const)(
    'serializes %s with confirmation (prepared reference: %s)',
    { timeout: 30_000 },
    async ([operation, prepared], context) => {
      if (unavailable !== '') {
        context.skip(`A real PostgreSQL server is unavailable: ${unavailable}`);
        return;
      }
      if (holder === undefined || contender === undefined) throw new Error('Missing connections.');
      const id = `${operation}-${prepared}`;
      const account = { accountId: id };
      const selected = { ...printing, printingId: id };
      knownPrintings.set(selected.printingId, selected);
      const cards = createUserCards({ sql: holder.transactor(), catalog });
      // Establish the domain tag without preparing the printing under test.
      await cards.createCopies(account, {
        printingId: printing.printingId,
        finish: 'nonfoil',
        condition: null,
        quantity: 1,
      });
      const tag = (await cards.createTag(account, { kind: 'wishlist', label: 'Planned' })).tag;
      const existing =
        operation === 'association correction'
          ? (
              await cards.createAssociation(account, {
                tagId: tag.tagId,
                targetLevel: 'printing',
                targetId: printing.printingId,
                quantity: 1,
              })
            ).association
          : null;
      if (prepared) {
        await cards.createCopies(account, {
          printingId: selected.printingId,
          finish: 'nonfoil',
          condition: null,
          quantity: 1,
        });
      }
      await cards.stageImportEntries(account, {
        sessionId: id,
        source: { kind: 'text', id },
        entries: [{ entryId: id, printingId: selected.printingId, finish: 'nonfoil', quantity: 1 }],
      });
      const confirmation = {
        operationId: id,
        sessionId: id,
        destination:
          operation === 'ownership'
            ? { kind: 'ownership' as const }
            : { kind: 'tag' as const, tagId: tag.tagId },
        entries: [{ entryId: id, expectedRevision: 1 }],
      };
      const held = pauseAfterTagLock(holder);
      const holdingCards = createUserCards({ sql: held.sql, catalog });
      const waitingForTag = signal();
      const competingCards = createUserCards({
        sql: contender.transactor({
          onStatement(statement) {
            if (isTagLock(statement)) waitingForTag.resolve();
          },
        }),
        catalog,
      });
      const first =
        operation === 'ownership'
          ? holdingCards.createCopies(account, {
              printingId: selected.printingId,
              finish: 'nonfoil',
              condition: null,
              quantity: 1,
            })
          : holdingCards.confirmImport(account, confirmation);
      await within(held.reached, 'The first writer did not acquire its domain tag.');
      const second =
        operation === 'ownership'
          ? competingCards.confirmImport(account, confirmation)
          : existing === null
            ? competingCards.createAssociation(account, {
                tagId: tag.tagId,
                targetLevel: 'printing',
                targetId: selected.printingId,
                quantity: 1,
              })
            : competingCards.changeAssociation(account, {
                associationId: existing.associationId,
                expectedRevision: existing.revision,
                targetLevel: 'printing',
                targetId: selected.printingId,
                quantity: 1,
              });
      const outcomes = Promise.allSettled([first, second]);
      try {
        await within(waitingForTag.promise, 'The competing writer did not request its domain tag.');
      } finally {
        held.release();
      }
      const results = await within(outcomes, 'The competing mutations did not finish.');
      expect(results[0]?.status).toBe('fulfilled');
      if (operation === 'ownership') {
        expect(results[1]?.status).toBe('fulfilled');
      } else {
        // Confirmation won this tag/printing. The competing association correctly reports the
        // duplicate target as a domain conflict, never database unavailability or a deadlock.
        expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'conflict' } });
      }
      expect(
        await contender.query(
          'select card_id from usercards_private.printing_reference where printing_id = $1',
          [selected.printingId],
        ),
      ).toEqual([{ card_id: selected.cardId }]);
      const receipt = await competingCards.recoverImportOperation(account, id);
      expect(receipt.outcome).toBe('recorded');
    },
  );
});
