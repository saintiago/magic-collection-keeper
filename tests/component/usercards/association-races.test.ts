/**
 * Concurrent writers of one tag's associations must report the documented recoverable conflict
 * instead of a database outage (docs/user-cards.md#interface, #persistence-and-recovery). PGlite
 * serves one connection, so these interleavings run against a real PostgreSQL server: one writer
 * holds a claimed tag/target pair, the other changes an association to it, and the held writer
 * commits before the second one is allowed to read again.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Catalog } from '../../../src/catalog/index.js';
import {
  createUserCards,
  UserCardsError,
  usercardsSchemaSql,
  type TrustedUserContext,
  type UserCards,
} from '../../../src/usercards/index.js';
import {
  startPostgresServer,
  type PostgresConnection,
  type PostgresServer,
} from '../../support/postgres-server.js';

const alice: TrustedUserContext = { accountId: 'cognito-alice' };

/** These interleavings store copy membership only, so no catalog reference is resolved. */
const unusedCatalog: Catalog = {
  async resolve() {
    throw new Error('This check resolves no catalog reference.');
  },
  async listCardPrintings() {
    throw new Error('This check resolves no catalog reference.');
  },
};

async function captureUserCardsError(promise: Promise<unknown>): Promise<UserCardsError> {
  const outcome = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  if (!(outcome instanceof UserCardsError)) {
    throw new Error(`Expected a UserCardsError, received ${String(outcome)}.`);
  }
  return outcome;
}

interface HeldWriter {
  readonly cards: UserCards;
  /** Resolves once the held transaction claimed its record and is waiting to commit. */
  readonly claimed: Promise<void>;
  release(): void;
}

/** A writer whose transaction stays open after its statements, like a competing editor. */
function heldWriter(connection: PostgresConnection): HeldWriter {
  let announce: () => void = () => {};
  const claimed = new Promise<void>((resolve) => {
    announce = resolve;
  });
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cards = createUserCards({
    sql: connection.transactor({
      beforeCommit: async () => {
        announce();
        await released;
      },
    }),
    catalog: unusedCatalog,
  });
  return { cards, claimed, release: () => release() };
}

/** The statement that settles the tag/target pair: the tag lock, or the guarded write itself. */
function isPairStatement(statement: string): boolean {
  return statement.includes('for update') || statement.includes('not exists (');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function waitForReached(reached: Promise<void>): Promise<void> {
  const expired = delay(10_000).then(() => {
    throw new Error('The competing writer never reached its tag/target statement.');
  });
  await Promise.race([reached, expired]);
}

interface Fixture {
  readonly holder: PostgresConnection;
  readonly contender: PostgresConnection;
  readonly cards: UserCards;
  readonly deckId: string;
}

describe('usercards association races', () => {
  let server: PostgresServer | undefined;
  let fixture: Fixture | undefined;
  let unavailable = '';
  const connections: PostgresConnection[] = [];

  beforeAll(async () => {
    try {
      server = await startPostgresServer(usercardsSchemaSql);
    } catch (cause) {
      unavailable = cause instanceof Error ? cause.message : String(cause);
      return;
    }
    const holder = await server.connect();
    const contender = await server.connect();
    connections.push(holder, contender);
    await contender.query(
      `insert into usercards_private.copy
         (copy_id, account_id, printing_id, finish, condition, revision)
       values ('copy-1', $1, 'printing-x', 'nonfoil', 'NM', 1),
              ('copy-2', $1, 'printing-x', 'nonfoil', 'NM', 1),
              ('copy-3', $1, 'printing-x', 'nonfoil', 'NM', 1),
              ('copy-4', $1, 'printing-x', 'nonfoil', 'NM', 1),
              ('copy-5', $1, 'printing-x', 'nonfoil', 'NM', 1)`,
      [alice.accountId],
    );
    const cards = createUserCards({ sql: contender.transactor(), catalog: unusedCatalog });
    const deck = await cards.createTag(alice, { kind: 'deck', label: 'Burn' });
    fixture = { holder, contender, cards, deckId: deck.tag.tagId };
  }, 120_000);

  afterAll(async () => {
    for (const connection of connections) {
      await connection.close();
    }
    await server?.close();
  }, 120_000);

  async function seedAssociation(cards: UserCards, deckId: string, copyId: string) {
    const created = await cards.createAssociation(alice, {
      tagId: deckId,
      targetLevel: 'copy',
      targetId: copyId,
    });
    return created.association.associationId;
  }

  /**
   * Runs `competing` while the held writer's claim is uncommitted, releases the held writer, and
   * returns the competing writer's error. The held writer always commits before this returns.
   */
  async function raceHeldClaim(
    contender: PostgresConnection,
    held: HeldWriter,
    inFlight: Promise<unknown>,
    competing: (cards: UserCards) => Promise<unknown>,
  ): Promise<UserCardsError> {
    await held.claimed;
    let announce: () => void = () => {};
    const reached = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const contenderCards = createUserCards({
      sql: contender.transactor({
        onStatement: (statement) => {
          if (isPairStatement(statement)) {
            announce();
          }
        },
      }),
      catalog: unusedCatalog,
    });
    const competingCall = competing(contenderCards);
    await waitForReached(reached);
    // Let the competing writer reach the database and block on the uncommitted claim.
    await delay(250);
    held.release();
    const error = await captureUserCardsError(competingCall);
    await inFlight;
    return error;
  }

  it('reports a change that races another change as a conflict', async (context) => {
    if (fixture === undefined) {
      context.skip(`A real PostgreSQL server is unavailable: ${unavailable}`);
      return;
    }
    const { holder, contender, cards, deckId } = fixture;
    const first = await seedAssociation(cards, deckId, 'copy-1');
    const second = await seedAssociation(cards, deckId, 'copy-2');
    const held = heldWriter(holder);

    const inFlight = held.cards.changeAssociation(alice, {
      associationId: first,
      expectedRevision: 1,
      targetLevel: 'copy',
      targetId: 'copy-3',
    });
    const error = await raceHeldClaim(contender, held, inFlight, (competing) =>
      competing.changeAssociation(alice, {
        associationId: second,
        expectedRevision: 1,
        targetLevel: 'copy',
        targetId: 'copy-3',
      }),
    );

    expect(error.code).toBe('conflict');
    const read = await cards.readAssociations(alice, [first, second]);
    expect(read.associations.get(first)).toMatchObject({ targetId: 'copy-3', revision: 2 });
    expect(read.associations.get(second)).toMatchObject({ targetId: 'copy-2', revision: 1 });
  }, 60_000);

  it('reports a change that races the claim of a new association as a conflict', async (context) => {
    if (fixture === undefined) {
      context.skip(`A real PostgreSQL server is unavailable: ${unavailable}`);
      return;
    }
    const { holder, contender, cards, deckId } = fixture;
    const existing = await seedAssociation(cards, deckId, 'copy-5');
    const held = heldWriter(holder);

    const inFlight = held.cards.createAssociation(alice, {
      tagId: deckId,
      targetLevel: 'copy',
      targetId: 'copy-4',
    });
    const error = await raceHeldClaim(contender, held, inFlight, (competing) =>
      competing.changeAssociation(alice, {
        associationId: existing,
        expectedRevision: 1,
        targetLevel: 'copy',
        targetId: 'copy-4',
      }),
    );

    expect(error.code).toBe('conflict');
    const read = await cards.readAssociations(alice, [existing]);
    expect(read.associations.get(existing)).toMatchObject({ targetId: 'copy-5', revision: 1 });
  }, 60_000);
});
