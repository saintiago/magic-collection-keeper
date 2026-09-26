/**
 * Confirmation, provenance and operation recovery over real PostgreSQL
 * (docs/user-cards.md#import-and-capture-state, docs/user-cards.md#persistence-and-recovery).
 * Confirmation validates the reviewed revisions, creates the individual copies with their source
 * provenance in one transaction, records a permanent receipt, and returns that recorded outcome
 * for an identical retry; changed input under the same operation identity is refused.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCatalog, type Catalog } from '../../../src/catalog/index.js';
import {
  createUserCards,
  type ImportEntry,
  type TrustedUserContext,
  type UserCards,
} from '../../../src/usercards/index.js';
import { publishCatalog } from '../../support/catalog-database.js';
import {
  captureUserCardsError,
  createUserCardsTestDatabase,
  type UserCardsTestDatabase,
} from '../../support/usercards-database.js';
import { failRevisionStatements } from './harness.js';

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

/** Counts the account's stored copies, so "staging is not ownership" is asserted directly. */
async function countCopies(database: UserCardsTestDatabase, accountId: string): Promise<number> {
  const rows = await database.query(
    'select count(*)::int as count from usercards_private.copy where account_id = $1',
    [accountId],
  );
  return Number(rows[0]?.count);
}

describe('usercards import confirmation', () => {
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

  /** One parsed deck line: two M11 foils in LP, plus one unresolved line. */
  async function stageDeck(context: TrustedUserContext = alice) {
    return userCards.stageImportEntries(context, {
      sessionId: 'session-deck',
      source: { kind: 'moxfield', id: 'deck-1' },
      entries: [
        {
          entryId: 'line-1',
          printingId: m11Printing.printingId,
          finish: 'foil',
          condition: 'LP',
          quantity: 2,
        },
        { entryId: 'line-2', quantity: 1 },
      ],
    });
  }

  async function reviewUnresolvedLine(): Promise<ImportEntry> {
    const reviewed = await userCards.reviewImportEntry(alice, {
      entryId: 'line-2',
      expectedRevision: 1,
      printingId: m10Printing.printingId,
      finish: 'nonfoil',
      condition: 'NM',
      quantity: 1,
    });
    return reviewed.entry;
  }

  it('creates individual copies with provenance and a recorded receipt', async () => {
    await stageDeck();
    const reviewed = await reviewUnresolvedLine();
    const confirmed = await userCards.confirmImport(alice, {
      operationId: 'operation-1',
      sessionId: 'session-deck',
      entries: [
        { entryId: 'line-1', expectedRevision: 1 },
        { entryId: 'line-2', expectedRevision: reviewed.revision },
      ],
    });

    expect(confirmed).toMatchObject({
      operationId: 'operation-1',
      sessionId: 'session-deck',
      sourceKind: 'moxfield',
      sourceId: 'deck-1',
      replayed: false,
    });
    expect(confirmed.copies).toHaveLength(3);
    expect(new Set(confirmed.copies.map((copy) => copy.copyId)).size).toBe(3);
    expect(confirmed.copies.map((copy) => [copy.printingId, copy.finish, copy.condition])).toEqual(
      expect.arrayContaining([
        [m11Printing.printingId, 'foil', 'LP'],
        [m11Printing.printingId, 'foil', 'LP'],
        [m10Printing.printingId, 'nonfoil', 'NM'],
      ]),
    );

    // The confirmed copies are owned physical copies through the normal copy read.
    const read = await userCards.readCopies(
      alice,
      confirmed.copies.map((copy) => copy.copyId),
    );
    expect(read.missing).toEqual([]);
    expect(read.copies.size).toBe(3);
    expect(read.privateRevision).toBe(confirmed.privateRevision);

    // Only the confirmed content left the pending list; the import is no longer pending.
    const entries = await userCards.listImportEntries(alice, { sessionId: 'session-deck' });
    expect(entries.entries).toEqual([]);
    expect(entries.session).toMatchObject({
      state: 'confirmed',
      pendingEntries: 0,
      confirmedEntries: 2,
    });
    expect((await userCards.listImportSessions(alice)).sessions).toEqual([]);

    // Provenance keeps the source identity and the entry each copy came from.
    const provenance = await database.query(
      `select provenance.copy_id, provenance.entry_id, acquisition.source_kind,
              acquisition.source_id
         from usercards_private.copy_provenance as provenance
         join usercards_private.import_acquisition as acquisition
           on acquisition.acquisition_id = provenance.acquisition_id
        where provenance.account_id = $1
        order by provenance.copy_id`,
      [alice.accountId],
    );
    expect(provenance).toHaveLength(3);
    expect(new Set(provenance.map((row) => row.entry_id))).toEqual(new Set(['line-1', 'line-2']));
    expect(provenance.every((row) => row.source_kind === 'moxfield')).toBe(true);
    expect(provenance.every((row) => row.source_id === 'deck-1')).toBe(true);

    const receipts = await database.query(
      `select operation_id, session_id
         from usercards_private.import_receipt
        where account_id = $1`,
      [alice.accountId],
    );
    expect(receipts).toEqual([{ operation_id: 'operation-1', session_id: 'session-deck' }]);
  });

  it('returns the recorded outcome for an identical retry and refuses a changed request', async () => {
    await stageDeck();
    const reviewed = await reviewUnresolvedLine();
    const request = {
      operationId: 'operation-1',
      sessionId: 'session-deck',
      entries: [
        { entryId: 'line-1', expectedRevision: 1 },
        { entryId: 'line-2', expectedRevision: reviewed.revision },
      ],
    };
    const confirmed = await userCards.confirmImport(alice, request);

    const retry = await userCards.confirmImport(alice, request);
    expect(retry.replayed).toBe(true);
    expect(retry.copies.map((copy) => copy.copyId).sort()).toEqual(
      confirmed.copies.map((copy) => copy.copyId).sort(),
    );
    const read = await userCards.readCopies(
      alice,
      confirmed.copies.map((copy) => copy.copyId),
    );
    expect(read.copies.size).toBe(3);

    // Reusing the operation identity for different reviewed content is refused.
    const changed = await captureUserCardsError(
      userCards.confirmImport(alice, {
        operationId: 'operation-1',
        sessionId: 'session-deck',
        entries: [{ entryId: 'line-1', expectedRevision: 1 }],
      }),
    );
    expect(changed.code).toBe('conflict');
    expect(changed.message).toContain('different input');
  });

  it('refuses stale revisions, discarded entries and unresolved entries', async () => {
    await stageDeck();

    const stale = await captureUserCardsError(
      userCards.confirmImport(alice, {
        operationId: 'operation-2',
        sessionId: 'session-deck',
        entries: [{ entryId: 'line-1', expectedRevision: 2 }],
      }),
    );
    expect(stale.code).toBe('conflict');

    const unresolved = await captureUserCardsError(
      userCards.confirmImport(alice, {
        operationId: 'operation-3',
        sessionId: 'session-deck',
        entries: [
          { entryId: 'line-1', expectedRevision: 1 },
          { entryId: 'line-2', expectedRevision: 1 },
        ],
      }),
    );
    expect(unresolved.code).toBe('invalid-request');

    const discarded = await userCards.discardImportEntry(alice, {
      entryId: 'line-2',
      expectedRevision: 1,
    });
    expect(discarded.entry.state).toBe('discarded');
    const afterDiscard = await captureUserCardsError(
      userCards.confirmImport(alice, {
        operationId: 'operation-4',
        sessionId: 'session-deck',
        entries: [
          { entryId: 'line-1', expectedRevision: 1 },
          { entryId: 'line-2', expectedRevision: 1 },
        ],
      }),
    );
    expect(afterDiscard.code).toBe('conflict');

    // A foreign or unknown import is reported as missing, never confirmed.
    const foreignSession = await captureUserCardsError(
      userCards.confirmImport(bob, {
        operationId: 'operation-5',
        sessionId: 'session-deck',
        entries: [{ entryId: 'line-1', expectedRevision: 1 }],
      }),
    );
    expect(foreignSession.code).toBe('not-found');
    const unknownEntry = await captureUserCardsError(
      userCards.confirmImport(alice, {
        operationId: 'operation-6',
        sessionId: 'session-deck',
        entries: [{ entryId: 'line-unknown', expectedRevision: 1 }],
      }),
    );
    expect(unknownEntry.code).toBe('not-found');

    // Nothing was committed by the failures.
    expect(await countCopies(database, alice.accountId)).toBe(0);
    const entries = await userCards.listImportEntries(alice, { sessionId: 'session-deck' });
    expect(entries.entries.map((entry) => entry.entryId)).toEqual(['line-1']);
  });

  it('adds one acquisition of a source once and replays it for a repeated import', async () => {
    const content = {
      printingId: m11Printing.printingId,
      finish: 'foil' as const,
      condition: 'LP' as const,
      quantity: 2,
    };
    await userCards.stageImportEntries(alice, {
      sessionId: 'session-1',
      source: { kind: 'moxfield', id: 'deck-1' },
      entries: [{ entryId: 'line-1', ...content }],
    });
    const first = await userCards.confirmImport(alice, {
      operationId: 'operation-1',
      sessionId: 'session-1',
      entries: [{ entryId: 'line-1', expectedRevision: 1 }],
    });
    expect(first.replayed).toBe(false);
    expect(first.copies).toHaveLength(2);

    // A repeated import of the same source with the same content adds nothing.
    await userCards.stageImportEntries(alice, {
      sessionId: 'session-2',
      source: { kind: 'moxfield', id: 'deck-1' },
      entries: [{ entryId: 'line-2', ...content }],
    });
    const repeated = await userCards.confirmImport(alice, {
      operationId: 'operation-2',
      sessionId: 'session-2',
      entries: [{ entryId: 'line-2', expectedRevision: 1 }],
    });
    expect(repeated.replayed).toBe(true);
    expect(repeated.copies.map((copy) => copy.copyId).sort()).toEqual(
      first.copies.map((copy) => copy.copyId).sort(),
    );
    const repeatedSession = await userCards.listImportEntries(alice, {
      sessionId: 'session-2',
    });
    expect(repeatedSession.entries).toEqual([]);
    expect(repeatedSession.session).toMatchObject({
      state: 'confirmed',
      confirmedEntries: 1,
    });

    // Different confirmed content is a separate acquisition and creates its own copies.
    await userCards.stageImportEntries(alice, {
      sessionId: 'session-3',
      source: { kind: 'moxfield', id: 'deck-1' },
      entries: [{ entryId: 'line-3', ...content, quantity: 3 }],
    });
    const changed = await userCards.confirmImport(alice, {
      operationId: 'operation-3',
      sessionId: 'session-3',
      entries: [{ entryId: 'line-3', expectedRevision: 1 }],
    });
    expect(changed.replayed).toBe(false);
    expect(changed.copies).toHaveLength(3);

    const allCopies = await userCards.readCopies(
      alice,
      [...first.copies, ...changed.copies].map((copy) => copy.copyId),
    );
    expect(allCopies.copies.size).toBe(5);
    expect(await countCopies(database, alice.accountId)).toBe(5);
  });

  it('recovers a recorded outcome and reports its absence without revealing another account', async () => {
    await stageDeck();
    const confirmed = await userCards.confirmImport(alice, {
      operationId: 'operation-1',
      sessionId: 'session-deck',
      entries: [{ entryId: 'line-1', expectedRevision: 1 }],
    });

    const recovered = await userCards.recoverImportOperation(alice, 'operation-1');
    expect(recovered).toMatchObject({
      outcome: 'recorded',
      receipt: {
        operationId: 'operation-1',
        sessionId: 'session-deck',
        sourceKind: 'moxfield',
        sourceId: 'deck-1',
      },
    });
    if (recovered.outcome === 'recorded') {
      expect(recovered.receipt.copies.map((copy) => copy.copyId).sort()).toEqual(
        confirmed.copies.map((copy) => copy.copyId).sort(),
      );
    }

    expect(await userCards.recoverImportOperation(alice, 'operation-unknown')).toEqual({
      outcome: 'absent',
    });
    expect(await userCards.recoverImportOperation(bob, 'operation-1')).toEqual({
      outcome: 'absent',
    });
  });

  it('removes only the confirmed entries and keeps the rest reviewable', async () => {
    await stageDeck();
    const first = await userCards.confirmImport(alice, {
      operationId: 'operation-1',
      sessionId: 'session-deck',
      entries: [{ entryId: 'line-1', expectedRevision: 1 }],
    });
    expect(first.copies).toHaveLength(2);

    const remaining = await userCards.listImportEntries(alice, { sessionId: 'session-deck' });
    expect(remaining.entries.map((entry) => entry.entryId)).toEqual(['line-2']);
    expect(remaining.session).toMatchObject({
      state: 'pending',
      pendingEntries: 1,
      confirmedEntries: 1,
    });
    expect((await userCards.listImportSessions(alice)).sessions.map((s) => s.sessionId)).toEqual([
      'session-deck',
    ]);

    const reviewed = await reviewUnresolvedLine();
    const second = await userCards.confirmImport(alice, {
      operationId: 'operation-2',
      sessionId: 'session-deck',
      entries: [{ entryId: 'line-2', expectedRevision: reviewed.revision }],
    });
    expect(second.copies).toHaveLength(1);
    const closed = await userCards.listImportEntries(alice, { sessionId: 'session-deck' });
    expect(closed.entries).toEqual([]);
    expect(closed.session).toMatchObject({
      state: 'confirmed',
      pendingEntries: 0,
      confirmedEntries: 2,
    });
    expect(await countCopies(database, alice.accountId)).toBe(3);
  });

  it('confirms reviewed quantities larger than one write batch', async () => {
    await userCards.stageImportEntries(alice, {
      sessionId: 'session-bulk',
      source: { kind: 'text', id: 'bulk-1' },
      entries: [
        {
          entryId: 'bulk-1',
          printingId: m11Printing.printingId,
          finish: 'nonfoil',
          condition: 'NM',
          quantity: 50,
        },
        {
          entryId: 'bulk-2',
          printingId: m11Printing.printingId,
          finish: 'foil',
          condition: 'LP',
          quantity: 50,
        },
        {
          entryId: 'bulk-3',
          printingId: m10Printing.printingId,
          finish: 'nonfoil',
          condition: null,
          quantity: 50,
        },
      ],
    });

    const confirmed = await userCards.confirmImport(alice, {
      operationId: 'operation-bulk',
      sessionId: 'session-bulk',
      entries: [
        { entryId: 'bulk-1', expectedRevision: 1 },
        { entryId: 'bulk-2', expectedRevision: 1 },
        { entryId: 'bulk-3', expectedRevision: 1 },
      ],
    });
    expect(confirmed.copies).toHaveLength(150);
    expect(new Set(confirmed.copies.map((copy) => copy.copyId)).size).toBe(150);
    expect(await countCopies(database, alice.accountId)).toBe(150);
    const provenance = await database.query(
      `select count(*)::int as count
         from usercards_private.copy_provenance
        where account_id = $1`,
      [alice.accountId],
    );
    expect(Number(provenance[0]?.count)).toBe(150);
  });

  it('rolls back a confirmation that cannot be committed', async () => {
    await stageDeck();
    const failing = createUserCards({
      sql: failRevisionStatements(database.sql),
      catalog,
    });

    const failed = await captureUserCardsError(
      failing.confirmImport(alice, {
        operationId: 'operation-1',
        sessionId: 'session-deck',
        entries: [{ entryId: 'line-1', expectedRevision: 1 }],
      }),
    );
    expect(failed.code).toBe('unavailable');

    // No copy, no receipt and no confirmed entry survived the failed transaction.
    expect(await countCopies(database, alice.accountId)).toBe(0);
    const entries = await userCards.listImportEntries(alice, { sessionId: 'session-deck' });
    expect(entries.session.pendingEntries).toBe(2);
    expect(entries.entries.map((entry) => entry.state)).toEqual(['pending', 'pending']);
    expect(await userCards.recoverImportOperation(alice, 'operation-1')).toEqual({
      outcome: 'absent',
    });
  });
});
