/**
 * Competing confirmations of one import must serialize behind the session and replay the recorded
 * outcome instead of adding the same acquisition twice (docs/user-cards.md#persistence-and-recovery).
 * PGlite serves one connection, so these interleavings run against a real PostgreSQL server: one
 * writer holds the session and one reviewed entry until it commits, while the other writer starts
 * its confirmation of the same import.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Catalog, type PrintingRecord } from '../../../src/catalog/index.js';
import {
  createUserCards,
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

/** A substitute catalog for the two fixed printings of this check. */
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

interface HeldWriter {
  readonly cards: UserCards;
  /** Resolves once the held transaction is waiting to commit. */
  readonly claimed: Promise<void>;
  release(): void;
}

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
    catalog,
  });
  return { cards, claimed, release: () => release() };
}

/** Resolves when the confirmation about to run is the session lock its import serializes on. */
function sessionLockWatcher(): { readonly reached: Promise<void>; onStatement(): void } {
  let announce: () => void = () => {};
  const reached = new Promise<void>((resolve) => {
    announce = resolve;
  });
  return { reached, onStatement: () => announce() };
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
  readonly cards: UserCards;
}

describe('usercards confirmation races', () => {
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
    fixture = {
      holder,
      contender,
      cards: createUserCards({ sql: contender.transactor(), catalog }),
    };
  }, 120_000);

  afterAll(async () => {
    for (const connection of connections) {
      await connection.close();
    }
    await server?.close();
  }, 120_000);

  /** Copies an import produced, read through the provenance of its recorded confirmations. */
  async function sessionCopyCount(
    connection: PostgresConnection,
    sessionId: string,
  ): Promise<number> {
    const rows = await connection.query(
      `select count(distinct provenance.copy_id)::int as count
         from usercards_private.copy_provenance as provenance
         join usercards_private.import_receipt_acquisition as covered
           on covered.account_id = provenance.account_id
          and covered.acquisition_id = provenance.acquisition_id
         join usercards_private.import_receipt as receipt
           on receipt.account_id = covered.account_id
          and receipt.operation_id = covered.operation_id
        where provenance.account_id = $1 and receipt.session_id = $2`,
      [alice.accountId, sessionId],
    );
    return Number(rows[0]?.count);
  }

  /** Acquisitions the session's recorded confirmations covered, one per acquired source entry. */
  async function acquisitionCount(
    connection: PostgresConnection,
    sessionId: string,
  ): Promise<number> {
    const rows = await connection.query(
      `select count(distinct covered.acquisition_id)::int as count
         from usercards_private.import_receipt_acquisition as covered
         join usercards_private.import_receipt as receipt
           on receipt.account_id = covered.account_id
          and receipt.operation_id = covered.operation_id
        where receipt.account_id = $1 and receipt.session_id = $2`,
      [alice.accountId, sessionId],
    );
    return Number(rows[0]?.count);
  }

  it('replays a competing confirmation of the same import instead of adding it twice', async () => {
    if (fixture === undefined) {
      throw new Error(`A local PostgreSQL server is unavailable. ${unavailable}`.trim());
    }
    const { holder, contender, cards } = fixture;
    await cards.stageImportEntries(alice, {
      sessionId: 'session-1',
      source: { kind: 'text', id: 'list-1' },
      entries: [
        {
          entryId: 'line-1',
          printingId: m11Printing.printingId,
          finish: 'foil',
          condition: 'LP',
          quantity: 2,
        },
      ],
    });

    const held = heldWriter(holder);
    const first = held.cards.confirmImport(alice, {
      operationId: 'operation-1',
      sessionId: 'session-1',
      entries: [{ entryId: 'line-1', expectedRevision: 1 }],
    });
    await waitFor(held.claimed, 'session lock');

    const watcher = sessionLockWatcher();
    const contenderCards = createUserCards({
      sql: contender.transactor({ onStatement: watcher.onStatement }),
      catalog,
    });
    const second = contenderCards.confirmImport(alice, {
      operationId: 'operation-2',
      sessionId: 'session-1',
      entries: [{ entryId: 'line-1', expectedRevision: 1 }],
    });
    await waitFor(watcher.reached, 'session lock');
    held.release();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.replayed).toBe(false);
    expect(secondResult.replayed).toBe(true);
    expect(secondResult.copies.map((copy) => copy.copyId).sort()).toEqual(
      firstResult.copies.map((copy) => copy.copyId).sort(),
    );
    expect(await sessionCopyCount(contender, 'session-1')).toBe(2);
    expect(await acquisitionCount(contender, 'session-1')).toBe(1);

    const entries = await cards.listImportEntries(alice, { sessionId: 'session-1' });
    expect(entries.entries).toEqual([]);
    expect(entries.session).toMatchObject({ state: 'confirmed', confirmedEntries: 1 });
  });

  it('keeps a competing confirmation of a smaller reviewed set from doubling an entry', async () => {
    if (fixture === undefined) {
      throw new Error(`A local PostgreSQL server is unavailable. ${unavailable}`.trim());
    }
    const { holder, contender } = fixture;
    const cards = createUserCards({ sql: contender.transactor(), catalog });
    await cards.stageImportEntries(alice, {
      sessionId: 'session-2',
      source: { kind: 'text', id: 'list-2' },
      entries: [
        {
          entryId: 'line-2a',
          printingId: m11Printing.printingId,
          finish: 'foil',
          condition: 'LP',
          quantity: 1,
        },
        {
          entryId: 'line-2b',
          printingId: m11Printing.printingId,
          finish: 'nonfoil',
          condition: 'NM',
          quantity: 1,
        },
      ],
    });

    const held = heldWriter(holder);
    const first = held.cards.confirmImport(alice, {
      operationId: 'operation-3',
      sessionId: 'session-2',
      entries: [
        { entryId: 'line-2a', expectedRevision: 1 },
        { entryId: 'line-2b', expectedRevision: 1 },
      ],
    });
    await waitFor(held.claimed, 'session lock');

    const watcher = sessionLockWatcher();
    const contenderCards = createUserCards({
      sql: contender.transactor({ onStatement: watcher.onStatement }),
      catalog,
    });
    const second = contenderCards.confirmImport(alice, {
      operationId: 'operation-4',
      sessionId: 'session-2',
      entries: [{ entryId: 'line-2a', expectedRevision: 1 }],
    });
    await waitFor(watcher.reached, 'session lock');
    held.release();

    const firstResult = await first;
    expect(firstResult.replayed).toBe(false);
    expect(firstResult.copies).toHaveLength(2);
    // The smaller confirmation covers an entry the first one already confirmed: it is refused
    // instead of creating a second copy of the same pending entry.
    const secondOutcome = await second.then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(secondOutcome).toMatchObject({ code: 'conflict' });
    expect(await sessionCopyCount(contender, 'session-2')).toBe(2);
    // One acquisition per confirmed source entry; the refused confirmation added none.
    expect(await acquisitionCount(contender, 'session-2')).toBe(2);
  });

  it('returns one recorded outcome when the same operation is confirmed concurrently', async () => {
    if (fixture === undefined) {
      throw new Error(`A local PostgreSQL server is unavailable. ${unavailable}`.trim());
    }
    const { holder, contender } = fixture;
    const cards = createUserCards({ sql: contender.transactor(), catalog });
    await cards.stageImportEntries(alice, {
      sessionId: 'session-3',
      source: { kind: 'text', id: 'list-3' },
      entries: [
        {
          entryId: 'line-3',
          printingId: m11Printing.printingId,
          finish: 'nonfoil',
          condition: 'NM',
          quantity: 1,
        },
      ],
    });

    const held = heldWriter(holder);
    const request = {
      operationId: 'operation-5',
      sessionId: 'session-3',
      entries: [{ entryId: 'line-3', expectedRevision: 1 }],
    };
    const first = held.cards.confirmImport(alice, request);
    await waitFor(held.claimed, 'session lock');

    const watcher = sessionLockWatcher();
    const contenderCards = createUserCards({
      sql: contender.transactor({ onStatement: watcher.onStatement }),
      catalog,
    });
    const second = contenderCards.confirmImport(alice, request);
    await waitFor(watcher.reached, 'session lock');
    held.release();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.replayed).toBe(false);
    expect(secondResult.replayed).toBe(true);
    expect(secondResult.copies).toEqual(firstResult.copies);
    expect(await sessionCopyCount(contender, 'session-3')).toBe(1);
    expect(await acquisitionCount(contender, 'session-3')).toBe(1);
  });

  it('commits nothing when two sessions claim one operation identity', async () => {
    if (fixture === undefined) {
      throw new Error(`A local PostgreSQL server is unavailable. ${unavailable}`.trim());
    }
    const { holder, contender } = fixture;
    const cards = createUserCards({ sql: contender.transactor(), catalog });
    for (const [sessionId, entryId, finish] of [
      ['session-4', 'line-4', 'foil'],
      ['session-5', 'line-5', 'nonfoil'],
    ] as const) {
      await cards.stageImportEntries(alice, {
        sessionId,
        source: { kind: 'text', id: `${sessionId}-source` },
        entries: [
          {
            entryId,
            printingId: m11Printing.printingId,
            finish,
            condition: 'NM',
            quantity: 1,
          },
        ],
      });
    }

    const held = heldWriter(holder);
    const winner = held.cards.confirmImport(alice, {
      operationId: 'operation-shared',
      sessionId: 'session-4',
      entries: [{ entryId: 'line-4', expectedRevision: 1 }],
    });
    await waitFor(held.claimed, 'session lock');

    // The contender reserves the same operation identity and waits for the holder's receipt, which
    // keeps the row until it commits.
    const reservation = sessionLockWatcher();
    const contenderCards = createUserCards({
      sql: contender.transactor({
        onStatement: (statement) => {
          if (statement.includes('insert into usercards_private.import_receipt')) {
            reservation.onStatement();
          }
        },
      }),
      catalog,
    });
    const loser = contenderCards.confirmImport(alice, {
      operationId: 'operation-shared',
      sessionId: 'session-5',
      entries: [{ entryId: 'line-5', expectedRevision: 1 }],
    });
    await waitFor(reservation.reached, 'operation reservation');
    held.release();

    const winnerResult = await winner;
    expect(winnerResult.replayed).toBe(false);
    expect(winnerResult.copies).toHaveLength(1);
    const loserOutcome = await loser.then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(loserOutcome).toMatchObject({ code: 'conflict' });

    // The losing confirmation committed nothing: no copy, acquisition or closed entry.
    expect(await sessionCopyCount(contender, 'session-5')).toBe(0);
    expect(await acquisitionCount(contender, 'session-5')).toBe(0);
    const receipts = await contender.query(
      `select operation_id, session_id
         from usercards_private.import_receipt
        where account_id = $1 and session_id in ('session-4', 'session-5')
        order by session_id`,
      [alice.accountId],
    );
    expect(receipts).toEqual([{ operation_id: 'operation-shared', session_id: 'session-4' }]);
    const losing = await cards.listImportEntries(alice, { sessionId: 'session-5' });
    expect(losing.entries.map((entry) => entry.state)).toEqual(['pending']);
    expect(await acquisitionCount(contender, 'session-4')).toBe(1);
  });

  it('refuses a racing alternate-operation replay when another session reserves its ID', async () => {
    if (fixture === undefined) throw new Error('A local PostgreSQL server is unavailable.');
    const { holder, contender, cards } = fixture;
    for (const sessionId of ['alias-original', 'alias-winner']) {
      await cards.stageImportEntries(alice, {
        sessionId,
        source: { kind: 'text', id: sessionId },
        entries: [{ entryId: sessionId, printingId: m11Printing.printingId, quantity: 1 }],
      });
    }
    const original = await cards.confirmImport(alice, {
      operationId: 'alias-original',
      sessionId: 'alias-original',
      entries: [{ entryId: 'alias-original', expectedRevision: 1 }],
    });
    const held = heldWriter(holder);
    const winner = held.cards.confirmImport(alice, {
      operationId: 'alias-shared',
      sessionId: 'alias-winner',
      entries: [{ entryId: 'alias-winner', expectedRevision: 1 }],
    });
    await waitFor(held.claimed, 'winning confirmation');
    const reservation = sessionLockWatcher();
    const racing = createUserCards({
      catalog,
      sql: contender.transactor({
        onStatement(statement) {
          if (statement.includes('insert into usercards_private.import_receipt'))
            reservation.onStatement();
        },
      }),
    });
    const replay = racing
      .confirmImport(alice, {
        operationId: 'alias-shared',
        sessionId: 'alias-original',
        entries: [{ entryId: 'alias-original', expectedRevision: 1 }],
      })
      .then(
        (result) => result,
        (cause: unknown) => cause,
      );
    try {
      await waitFor(reservation.reached, 'replay reservation');
    } finally {
      held.release();
    }
    const committed = await winner;
    expect(await replay).toMatchObject({ code: 'conflict' });
    expect(await cards.recoverImportOperation(alice, 'alias-shared')).toMatchObject({
      outcome: 'recorded',
      receipt: { sessionId: 'alias-winner', copies: committed.copies },
    });
    expect(await cards.recoverImportOperation(alice, 'alias-original')).toMatchObject({
      outcome: 'recorded',
      receipt: { copies: original.copies },
    });
    expect(await sessionCopyCount(contender, 'alias-original')).toBe(1);
    expect(await sessionCopyCount(contender, 'alias-winner')).toBe(1);
  });

  it('keeps a concurrent confirmation of another import independent', async () => {
    if (fixture === undefined) {
      throw new Error(`A local PostgreSQL server is unavailable. ${unavailable}`.trim());
    }
    const { holder, contender } = fixture;
    const cards = createUserCards({ sql: contender.transactor(), catalog });
    const content = {
      printingId: m11Printing.printingId,
      finish: 'foil' as const,
      condition: 'LP' as const,
      quantity: 1,
    };
    for (const [sessionId, entryId] of [
      ['session-6', 'line-6'],
      ['session-7', 'line-7'],
    ] as const) {
      await cards.stageImportEntries(alice, {
        sessionId,
        source: { kind: 'text', id: 'list-race' },
        entries: [{ entryId, ...content }],
      });
    }

    const held = heldWriter(holder);
    const first = held.cards.confirmImport(alice, {
      operationId: 'operation-6',
      sessionId: 'session-6',
      entries: [{ entryId: 'line-6', expectedRevision: 1 }],
    });
    await waitFor(held.claimed, 'session lock');

    // Another import of the same content owns its own acquisition, so its confirmation is not
    // blocked by the held import and creates its own copy
    // (docs/user-cards.md#import-state-and-identity).
    const second = cards.confirmImport(alice, {
      operationId: 'operation-7',
      sessionId: 'session-7',
      entries: [{ entryId: 'line-7', expectedRevision: 1 }],
    });
    held.release();

    const firstResult = await first;
    const secondResult = await second;
    expect(firstResult.replayed).toBe(false);
    expect(secondResult.replayed).toBe(false);
    expect(
      new Set([...firstResult.copies, ...secondResult.copies].map((copy) => copy.copyId)).size,
    ).toBe(2);
    expect(await sessionCopyCount(contender, 'session-6')).toBe(1);
    expect(await sessionCopyCount(contender, 'session-7')).toBe(1);
    expect(await acquisitionCount(contender, 'session-6')).toBe(1);
    expect(await acquisitionCount(contender, 'session-7')).toBe(1);
  });
});
