/**
 * A source import reconciles the lines it offers with what that import already recorded inside the
 * transaction that stages them, behind the session lock (docs/user-cards.md#source-imports,
 * docs/user-cards.md#persistence-and-recovery). A review, a discard or a competing import of the
 * same list that commits first is therefore observed instead of overwritten, and the reported counts
 * are the committed ones. PGlite serves one connection, so these interleavings run against a real
 * PostgreSQL server: one writer holds the session until the other import is waiting for it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Catalog, type PrintingRecord } from '../../../src/catalog/index.js';
import {
  createSourceImports,
  createUserCards,
  usercardsSchemaSql,
  type MoxfieldDeckSource,
  type TrustedUserContext,
  type UserCardsSqlTransactor,
} from '../../../src/usercards/index.js';
import {
  startPostgresServer,
  type PostgresConnection,
  type PostgresServer,
} from '../../support/postgres-server.js';

const alice: TrustedUserContext = { accountId: 'cognito-alice' };

const m11Printing: PrintingRecord = {
  printingId: 'printing-m11-149-en',
  cardId: 'oracle-lightning-bolt',
  edition: 'M11',
  collectorNumber: '149',
  language: 'en',
  finishes: ['nonfoil', 'foil'],
  physical: true,
  images: { small: null, normal: null, large: null, artCrop: null },
};

/** A substitute catalog for the one fixed printing of these interleavings. */
const catalog: Catalog = {
  async resolve(references) {
    const printings = new Map<string, PrintingRecord>();
    for (const reference of references) {
      if (reference.kind === 'printing' && reference.printingId === m11Printing.printingId) {
        printings.set(m11Printing.printingId, m11Printing);
      }
    }
    return {
      revision: {
        revisionId: 'revision-1',
        sourceName: 'scryfall',
        sourceVersion: '2026-09-26',
        publishedAt: '2026-09-26T20:00:00.000Z',
      },
      cards: new Map(),
      printings,
      missing: [],
    };
  },
  async listCardPrintings() {
    throw new Error('This check lists no printings.');
  },
};

/** The public deck link one interleaving imports. */
function deckUrl(sourceId: string): string {
  return `https://moxfield.com/decks/${sourceId}`;
}

/** Identity of the import one interleaving stages into; both writers of a case name the same list. */
function importId(sourceId: string): string {
  return `import-${sourceId}`;
}

/** A deck document with one mainboard line of the given quantity. */
function deckDocument(quantity: number): unknown {
  return {
    name: 'Keeper race deck',
    isPrivate: false,
    boards: {
      mainboard: {
        cards: {
          'mainboard-0': {
            quantity,
            finish: 'nonfoil',
            card: {
              name: 'Lightning Bolt',
              scryfall_id: m11Printing.printingId,
              set: 'm11',
              cn: '149',
              lang: 'en',
            },
          },
        },
      },
    },
  };
}

/** A deck source that publishes one fixed document. */
function deckSource(document: unknown): MoxfieldDeckSource {
  return {
    async readDeck() {
      return document;
    },
  };
}

interface HeldWriter<Operations> {
  readonly operations: Operations;
  /** Resolves once the held transaction is waiting to commit, holding its locks. */
  readonly claimed: Promise<void>;
  release(): void;
}

/** One writer whose transaction stays open at the point it is about to commit. */
function heldWriter<Operations>(
  connection: PostgresConnection,
  build: (sql: UserCardsSqlTransactor) => Operations,
): HeldWriter<Operations> {
  let announce: () => void = () => {};
  const claimed = new Promise<void>((resolve) => {
    announce = resolve;
  });
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const operations = build(
    connection.transactor({
      beforeCommit: async () => {
        announce();
        await released;
      },
    }),
  );
  return { operations, claimed, release: () => release() };
}

/** Resolves when the waiting import reaches the session its transaction serializes on. */
function sessionClaimWatcher(): {
  readonly reached: Promise<void>;
  onStatement(statement: string): void;
} {
  let announce: () => void = () => {};
  const reached = new Promise<void>((resolve) => {
    announce = resolve;
  });
  return {
    reached,
    onStatement: (statement) => {
      if (
        statement.includes('for update') ||
        statement.includes('insert into usercards_private.import_session')
      ) {
        announce();
      }
    },
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function waitFor(reached: Promise<void>, description: string): Promise<void> {
  const expired = delay(10_000).then(() => {
    throw new Error(`The competing writer never reached its ${description}.`);
  });
  await Promise.race([reached, expired]);
}

interface Fixture {
  readonly holder: PostgresConnection;
  readonly contender: PostgresConnection;
}

describe('usercards source import races', () => {
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
    fixture = { holder, contender };
  }, 120_000);

  afterAll(async () => {
    for (const connection of connections) {
      await connection.close();
    }
    await server?.close();
  }, 120_000);

  /** The quantity one session is holding for review, so overstaging is asserted directly. */
  async function pendingQuantity(
    connection: PostgresConnection,
    sessionId: string,
  ): Promise<number> {
    const rows = await connection.query(
      `select coalesce(sum(quantity), 0)::int as quantity
         from usercards_private.import_entry
        where account_id = $1 and session_id = $2 and state = 'pending'`,
      [alice.accountId, sessionId],
    );
    return Number(rows[0]?.quantity);
  }

  async function copyCount(connection: PostgresConnection): Promise<number> {
    const rows = await connection.query(
      'select count(*)::int as count from usercards_private.copy where account_id = $1',
      [alice.accountId],
    );
    return Number(rows[0]?.count);
  }

  function requireFixture(): Fixture {
    if (fixture === undefined) {
      throw new Error(`A local PostgreSQL server is unavailable. ${unavailable}`.trim());
    }
    return fixture;
  }

  it('reconciles a review that commits while an import waits for the session', async () => {
    const { holder, contender } = requireFixture();
    const url = deckUrl('keeper_review_deck_1');
    const imports = createSourceImports({
      sql: contender.transactor(),
      catalog,
      decks: deckSource(deckDocument(1)),
    });
    const sessionId = importId('keeper_review_deck_1');
    const first = await imports.stageSourceImport(alice, { format: 'moxfield', sessionId, url });
    const entryId = first.rows[0]?.entryId as string;
    expect(first.staged).toBe(1);

    // The review read the pending quantity of one and holds the session until the import waits.
    const held = heldWriter(holder, (sql) => createUserCards({ sql, catalog }));
    const review = held.operations.reviewImportEntry(alice, {
      entryId,
      expectedRevision: 1,
      printingId: m11Printing.printingId,
      finish: 'nonfoil',
      condition: null,
      quantity: 4,
    });
    await waitFor(held.claimed, 'session lock');

    const claim = sessionClaimWatcher();
    const waiting = createSourceImports({
      sql: contender.transactor({ onStatement: claim.onStatement }),
      catalog,
      decks: deckSource(deckDocument(4)),
    });
    const staged = waiting.stageSourceImport(alice, { format: 'moxfield', sessionId, url });
    await waitFor(claim.reached, 'session lock');
    held.release();

    const reviewed = await review;
    const outcome = await staged;
    expect(reviewed.entry.quantity).toBe(4);
    // The import declares the reviewed four, so it stages nothing over the committed review.
    expect(outcome.staged).toBe(0);
    expect(outcome.rows.map((row) => row.outcome)).toEqual(['pending']);
    expect(await pendingQuantity(contender, outcome.session.sessionId)).toBe(4);
    expect(await copyCount(contender)).toBe(0);
  });

  it('stages a discarded line again when the discard commits before the import reads it', async () => {
    const { holder, contender } = requireFixture();
    const url = deckUrl('keeper_discard_deck_1');
    const imports = createSourceImports({
      sql: contender.transactor(),
      catalog,
      decks: deckSource(deckDocument(2)),
    });
    const sessionId = importId('keeper_discard_deck_1');
    const first = await imports.stageSourceImport(alice, { format: 'moxfield', sessionId, url });
    const entryId = first.rows[0]?.entryId as string;

    const held = heldWriter(holder, (sql) => createUserCards({ sql, catalog }));
    const discard = held.operations.discardImportEntry(alice, { entryId, expectedRevision: 1 });
    await waitFor(held.claimed, 'session lock');

    const claim = sessionClaimWatcher();
    const waiting = createSourceImports({
      sql: contender.transactor({ onStatement: claim.onStatement }),
      catalog,
      decks: deckSource(deckDocument(2)),
    });
    const staged = waiting.stageSourceImport(alice, { format: 'moxfield', sessionId, url });
    await waitFor(claim.reached, 'session lock');
    held.release();

    await discard;
    const outcome = await staged;
    // The discarded quantity is no longer covered, so the import stages it again for review.
    expect(outcome.staged).toBe(1);
    expect(outcome.rows.map((row) => row.outcome)).toEqual(['staged']);
    expect(outcome.rows[0]?.entryId).not.toBe(entryId);
    expect(await pendingQuantity(contender, outcome.session.sessionId)).toBe(2);
    expect(await copyCount(contender)).toBe(0);
  });

  it('reports the committed outcome when two identical imports overlap', async () => {
    const { holder, contender } = requireFixture();
    const url = deckUrl('keeper_overlap_deck_1');
    const sessionId = importId('keeper_overlap_deck_1');
    const held = heldWriter(holder, (sql: UserCardsSqlTransactor) =>
      createSourceImports({ sql, catalog, decks: deckSource(deckDocument(2)) }),
    );
    const first = held.operations.stageSourceImport(alice, { format: 'moxfield', sessionId, url });
    await waitFor(held.claimed, 'session lock');

    const claim = sessionClaimWatcher();
    const overlapping = createSourceImports({
      sql: contender.transactor({ onStatement: claim.onStatement }),
      catalog,
      decks: deckSource(deckDocument(2)),
    });
    const second = overlapping.stageSourceImport(alice, { format: 'moxfield', sessionId, url });
    await waitFor(claim.reached, 'session lock');
    held.release();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.staged).toBe(1);
    // The second writer of the same import finds the quantity the first one committed and stages
    // nothing, reporting the committed outcome instead of the lines it computed before it waited
    // for the session.
    expect(secondResult.staged).toBe(0);
    expect(secondResult.rows.map((row) => row.outcome)).toEqual(['pending']);
    expect(secondResult.rows[0]?.entryId).toBe(firstResult.rows[0]?.entryId);
    expect(await pendingQuantity(contender, firstResult.session.sessionId)).toBe(2);
    expect(await copyCount(contender)).toBe(0);
  });
});
