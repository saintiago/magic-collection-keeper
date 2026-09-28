/**
 * Component scope: one mutation's publication is atomic for a consumer on another connection
 * (docs/user-cards.md#query-surface). PGlite serves one connection, so this interleaving runs
 * against a real PostgreSQL server: a mutation pauses after every statement and before its commit
 * while a consumer reads the snapshot and the change stream, and the consumer then resumes from
 * the position it read without observing half a mutation or a gap.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Catalog, type PrintingRecord } from '../../../src/catalog/index.js';
import {
  createUserCards,
  createUserCardsPublication,
  usercardsSchemaSql,
  type TrustedUserContext,
  type UserCardsPublication,
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

/** A substitute catalog for the one fixed printing of this check. */
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

describe('usercards publication coherence', () => {
  let server: PostgresServer | undefined;
  let writer: PostgresConnection | undefined;
  let reader: PostgresConnection | undefined;
  let unavailable = '';

  beforeAll(async () => {
    try {
      server = await startPostgresServer(usercardsSchemaSql);
    } catch (cause) {
      unavailable = cause instanceof Error ? cause.message : String(cause);
      return;
    }
    writer = await server.connect();
    reader = await server.connect();
  }, 120_000);

  afterAll(async () => {
    await writer?.close();
    await reader?.close();
    await server?.close();
  }, 120_000);

  it('keeps the previous publication readable until a mutation commits', async (context) => {
    if (unavailable !== '') {
      context.skip(`A real PostgreSQL server is unavailable: ${unavailable}`);
      return;
    }
    if (writer === undefined || reader === undefined) {
      throw new Error('The coherence fixture has no connections.');
    }
    const publication: UserCardsPublication = createUserCardsPublication({
      sql: reader.transactor(),
    });
    const committed = createUserCards({ sql: writer.transactor(), catalog });
    const first = await committed.createCopies(alice, {
      printingId: m11Printing.printingId,
      finish: 'nonfoil',
      condition: null,
      quantity: 1,
    });
    const before = await publication.readSnapshot({ accountId: alice.accountId, pageSize: 10 });
    expect(before.position).toBe(first.publicationPosition);
    expect(before.records.filter((record) => record.kind === 'copy')).toHaveLength(1);

    let reached: () => void = () => {};
    const paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });

    const committing = createUserCards({
      sql: writer.transactor({
        beforeCommit: async () => {
          reached();
          await released;
        },
      }),
      catalog,
    }).createCopies(alice, {
      printingId: m11Printing.printingId,
      finish: 'foil',
      condition: 'LP',
      quantity: 2,
    });
    await within(paused, 'The mutation never reached its commit.');

    // Every statement of the mutation ran, and none of it is visible: the consumer sees the
    // complete previous publication, its position and its empty tail of changes.
    const during = await publication.readSnapshot({ accountId: alice.accountId, pageSize: 10 });
    expect(during).toEqual(before);
    expect(
      await publication.readChanges({
        accountId: alice.accountId,
        position: before.position,
        pageSize: 100,
      }),
    ).toEqual({ accountId: alice.accountId, changes: [], position: before.position });

    release();
    const second = await committing;
    expect(BigInt(second.publicationPosition) > BigInt(before.position)).toBe(true);

    // The position the middle read saw resumes through the committed mutation without a gap: both
    // copies, their owned memberships and the revision that completes them arrive in order.
    const resumed = await publication.readChanges({
      accountId: alice.accountId,
      position: before.position,
      pageSize: 100,
    });
    expect(resumed.changes.map((change) => change.kind)).toEqual([
      'copy',
      'copy',
      'association',
      'association',
      'revision',
    ]);
    expect(resumed.position).toBe(second.publicationPosition);
    expect(resumed.changes.at(-1)).toMatchObject({
      kind: 'revision',
      revision: second.privateRevision,
    });
    const after = await publication.readSnapshot({ accountId: alice.accountId, pageSize: 10 });
    expect(after.position).toBe(second.publicationPosition);
    expect(after.records.filter((record) => record.kind === 'copy')).toHaveLength(3);
  });
});

/** Fails a case whose fixture never reached the point it observes. */
async function within(reached: Promise<void>, message: string): Promise<void> {
  const expired = new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error(message)), 10_000).unref();
  });
  await Promise.race([reached, expired]);
}
