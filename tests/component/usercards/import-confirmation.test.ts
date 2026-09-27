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
import { boundedResponses, dataApiResponseBytes, failRevisionStatements } from './harness.js';

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

const counterspell = {
  cardId: 'oracle-counterspell',
  name: 'Counterspell',
  colors: ['U'],
  colorIdentity: ['U'],
  manaValue: 2,
};

const counterspellPrinting = {
  printingId: 'printing-7ed-67-en',
  cardId: counterspell.cardId,
  edition: '7ED',
  collectorNumber: '67',
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
      cards: [lightningBolt, counterspell],
      printings: [m11Printing, m10Printing, counterspellPrinting],
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

    // Provenance keeps the source identity of the import and the entry each copy came from.
    const provenance = await database.query(
      `select provenance.copy_id, provenance.entry_id, session.source_kind, session.source_id
         from usercards_private.copy_provenance as provenance
         join usercards_private.import_acquisition as acquisition
           on acquisition.acquisition_id = provenance.acquisition_id
         join usercards_private.import_session as session
           on session.account_id = acquisition.account_id
          and session.session_id = acquisition.session_id
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

  it('records every successful operation identity, including alternate-operation retries', async () => {
    await stageDeck();
    const request = {
      operationId: 'original',
      sessionId: 'session-deck',
      entries: [{ entryId: 'line-1', expectedRevision: 1 }],
    };
    const original = await userCards.confirmImport(alice, request);
    const replay = await userCards.confirmImport(alice, { ...request, operationId: 'replay' });
    expect(replay).toMatchObject({
      operationId: 'replay',
      replayed: true,
      copies: original.copies,
    });
    expect(await userCards.recoverImportOperation(alice, 'replay')).toEqual({
      outcome: 'recorded',
      receipt: {
        operationId: 'replay',
        sessionId: replay.sessionId,
        sourceId: replay.sourceId,
        sourceKind: replay.sourceKind,
        copies: original.copies,
      },
    });
    expect(await userCards.recoverImportOperation(bob, 'replay')).toEqual({ outcome: 'absent' });
    const retry = await userCards.confirmImport(alice, { ...request, operationId: 'replay' });
    expect(retry.copies).toEqual(original.copies);
    await reviewUnresolvedLine();
    const changed = await captureUserCardsError(
      userCards.confirmImport(alice, {
        ...request,
        operationId: 'replay',
        entries: [{ entryId: 'line-2', expectedRevision: 2 }],
      }),
    );
    expect(changed).toMatchObject({ code: 'conflict' });
    expect(await countCopies(database, alice.accountId)).toBe(2);

    const failing = createUserCards({ sql: failRevisionStatements(database.sql), catalog });
    expect(
      await captureUserCardsError(
        failing.confirmImport(alice, {
          ...request,
          operationId: 'failed-replay',
        }),
      ),
    ).toMatchObject({ code: 'unavailable' });
    expect(await userCards.recoverImportOperation(alice, 'failed-replay')).toEqual({
      outcome: 'absent',
    });
  });

  it.each(['capture', 'source'] as const)(
    'keeps distinct %s entries when an earlier review matches a confirmed peer',
    async (kind) => {
      const sessionId = 'review-order';
      const source = { kind: 'text', id: 'review-order-source' };
      for (const [entryId, printingId] of [
        ['earlier', m11Printing.printingId],
        ['later', counterspellPrinting.printingId],
      ] as const) {
        if (kind === 'capture') {
          await userCards.stageCaptureObservation(alice, {
            sessionId,
            captureId: entryId,
            printingId,
          });
        } else {
          await userCards.stageImportEntries(alice, {
            sessionId,
            source,
            entries: [{ entryId: entryId, printingId, quantity: 1 }],
          });
        }
      }
      const later = await userCards.confirmImport(alice, {
        operationId: 'later',
        sessionId,
        entries: [{ entryId: 'later', expectedRevision: 1 }],
      });
      await userCards.reviewImportEntry(alice, {
        entryId: 'earlier',
        expectedRevision: 1,
        printingId: counterspellPrinting.printingId,
        finish: 'nonfoil',
        condition: null,
        quantity: 1,
      });
      const earlier = await userCards.confirmImport(alice, {
        operationId: 'earlier',
        sessionId,
        entries: [{ entryId: 'earlier', expectedRevision: 2 }],
      });
      expect(earlier.replayed).toBe(false);
      expect(new Set([...earlier.copies, ...later.copies].map((copy) => copy.copyId)).size).toBe(2);
      expect(await countCopies(database, alice.accountId)).toBe(2);
      if (kind === 'source') {
        // Another import of the same source content owns its own acquisitions: confirming its
        // entries creates their own copies instead of replaying the first import's.
        await userCards.stageImportEntries(alice, {
          sessionId: 'repeat',
          source,
          entries: ['repeat-1', 'repeat-2'].map((entryId) => ({
            entryId,
            printingId: counterspellPrinting.printingId,
            quantity: 1,
          })),
        });
        const repeatedByEntry = new Map<string, readonly { readonly copyId: string }[]>();
        for (const entryId of ['repeat-2', 'repeat-1']) {
          const repeated = await userCards.confirmImport(alice, {
            operationId: entryId,
            sessionId: 'repeat',
            entries: [{ entryId, expectedRevision: 1 }],
          });
          expect(repeated.replayed).toBe(false);
          repeatedByEntry.set(entryId, repeated.copies);
        }
        const firstRepeat = new Set(repeatedByEntry.get('repeat-1')?.map((copy) => copy.copyId));
        const secondRepeat = new Set(repeatedByEntry.get('repeat-2')?.map((copy) => copy.copyId));
        const original = new Set([...earlier.copies, ...later.copies].map((copy) => copy.copyId));
        expect(firstRepeat.size).toBe(1);
        expect(secondRepeat.size).toBe(1);
        // Two identical source entries of one import are their own acquisitions, and none of them
        // is the acquisition of the other import.
        expect(firstRepeat).not.toEqual(secondRepeat);
        expect(firstRepeat).not.toEqual(original);

        // Retrying one of that import's own confirmations returns its recorded outcome.
        const retried = await userCards.confirmImport(alice, {
          operationId: 'repeat-1-retry',
          sessionId: 'repeat',
          entries: [{ entryId: 'repeat-1', expectedRevision: 1 }],
        });
        expect(retried.replayed).toBe(true);
        expect(retried.copies).toEqual(repeatedByEntry.get('repeat-1'));
        expect(await countCopies(database, alice.accountId)).toBe(4);
      }
    },
  );

  it('keeps each reviewed content its own acquisition after a review separates entries', async () => {
    const source = { kind: 'text', id: 'review-source' };
    await userCards.stageImportEntries(alice, {
      sessionId: 'original',
      source,
      entries: ['first', 'second'].map((entryId) => ({
        entryId,
        printingId: m11Printing.printingId,
        quantity: 1,
      })),
    });
    const second = await userCards.confirmImport(alice, {
      operationId: 'second',
      sessionId: 'original',
      entries: [{ entryId: 'second', expectedRevision: 1 }],
    });
    await userCards.reviewImportEntry(alice, {
      entryId: 'first',
      expectedRevision: 1,
      printingId: counterspellPrinting.printingId,
      finish: 'nonfoil',
      condition: null,
      quantity: 1,
    });
    const first = await userCards.confirmImport(alice, {
      operationId: 'first',
      sessionId: 'original',
      entries: [{ entryId: 'first', expectedRevision: 2 }],
    });
    expect(new Set([...first.copies, ...second.copies].map((copy) => copy.copyId)).size).toBe(2);
    expect(await countCopies(database, alice.accountId)).toBe(2);

    // Another import of the same two reviewed contents owns its own acquisitions: the reviewed
    // content, not the staged order, decides what that import acquired, and it creates its own
    // copies instead of replaying the first import's.
    await userCards.stageImportEntries(alice, {
      sessionId: 'repeat',
      source,
      entries: [
        { entryId: 'repeat-first', printingId: counterspellPrinting.printingId, quantity: 1 },
        { entryId: 'repeat-second', printingId: m11Printing.printingId, quantity: 1 },
      ],
    });
    const repeated = await userCards.confirmImport(alice, {
      operationId: 'repeat',
      sessionId: 'repeat',
      entries: ['repeat-first', 'repeat-second'].map((entryId) => ({
        entryId,
        expectedRevision: 1,
      })),
    });
    expect(repeated.replayed).toBe(false);
    expect(new Set(repeated.copies.map((copy) => copy.copyId)).size).toBe(2);
    expect(new Set(repeated.copies.map((copy) => copy.copyId))).not.toEqual(
      new Set([...first.copies, ...second.copies].map((copy) => copy.copyId)),
    );
    expect(await countCopies(database, alice.accountId)).toBe(4);
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

  it('keeps the acquisitions of another import independent of the first', async () => {
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

    // Another import of the same source content is another list: confirming it creates its own
    // copies instead of replaying the first import's acquisition
    // (docs/user-cards.md#import-state-and-identity).
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
    expect(repeated.replayed).toBe(false);
    expect(repeated.copies).toHaveLength(2);
    expect(new Set(repeated.copies.map((copy) => copy.copyId))).not.toEqual(
      new Set(first.copies.map((copy) => copy.copyId)),
    );
    const repeatedSession = await userCards.listImportEntries(alice, {
      sessionId: 'session-2',
    });
    expect(repeatedSession.entries).toEqual([]);
    expect(repeatedSession.session).toMatchObject({
      state: 'confirmed',
      confirmedEntries: 1,
    });

    // Retrying that import's own confirmation returns its recorded outcome instead of adding its
    // copies twice.
    const retried = await userCards.confirmImport(alice, {
      operationId: 'operation-2-retry',
      sessionId: 'session-2',
      entries: [{ entryId: 'line-2', expectedRevision: 1 }],
    });
    expect(retried.replayed).toBe(true);
    expect(retried.copies.map((copy) => copy.copyId).sort()).toEqual(
      repeated.copies.map((copy) => copy.copyId).sort(),
    );

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
    expect(await countCopies(database, alice.accountId)).toBe(7);
  });

  it('confirms every admitted capture of one session, including a repeat after another card', async () => {
    const admissions = [
      ['capture-1', m11Printing.printingId],
      ['capture-2', counterspellPrinting.printingId],
      ['capture-3', m11Printing.printingId],
    ] as const;
    for (const [captureId, printingId] of admissions) {
      const staged = await userCards.stageCaptureObservation(alice, {
        sessionId: 'capture-session',
        captureId,
        printingId,
      });
      expect(staged.outcome).toBe('admitted');
    }

    // Each admitted capture is its own acquisition, whether or not it repeats a card identity.
    const confirmed = [];
    for (const [captureId] of admissions) {
      confirmed.push(
        await userCards.confirmImport(alice, {
          operationId: `operation-${captureId}`,
          sessionId: 'capture-session',
          entries: [{ entryId: captureId, expectedRevision: 1 }],
        }),
      );
    }
    expect(confirmed.map((result) => result.replayed)).toEqual([false, false, false]);
    expect(confirmed.every((result) => result.copies.length === 1)).toBe(true);
    expect(
      new Set(confirmed.flatMap((result) => result.copies.map((copy) => copy.copyId))).size,
    ).toBe(3);
    expect(await countCopies(database, alice.accountId)).toBe(3);

    const closed = await userCards.listImportEntries(alice, { sessionId: 'capture-session' });
    expect(closed.entries).toEqual([]);
    expect(closed.session).toMatchObject({
      state: 'confirmed',
      pendingEntries: 0,
      confirmedEntries: 3,
    });
  });

  it('adds the acquisitions of each import however confirmations are partitioned', async () => {
    await userCards.stageImportEntries(alice, {
      sessionId: 'session-1',
      source: { kind: 'moxfield', id: 'deck-1' },
      entries: [
        {
          entryId: 'line-1',
          printingId: m11Printing.printingId,
          finish: 'foil',
          condition: 'LP',
          quantity: 1,
        },
        {
          entryId: 'line-2',
          printingId: counterspellPrinting.printingId,
          finish: 'nonfoil',
          condition: 'NM',
          quantity: 1,
        },
      ],
    });
    const together = await userCards.confirmImport(alice, {
      operationId: 'operation-together',
      sessionId: 'session-1',
      entries: [
        { entryId: 'line-1', expectedRevision: 1 },
        { entryId: 'line-2', expectedRevision: 1 },
      ],
    });
    expect(together.copies).toHaveLength(2);

    // The identical source imported as two other lists and confirmed line by line creates one copy
    // for each of those imports: their acquisitions are independent of the first one.
    const reimported = [
      ['session-2', 'line-3', m11Printing.printingId, 'foil', 'LP'],
      ['session-3', 'line-4', counterspellPrinting.printingId, 'nonfoil', 'NM'],
    ] as const;
    for (const [sessionId, entryId, printingId, finish, condition] of reimported) {
      await userCards.stageImportEntries(alice, {
        sessionId,
        source: { kind: 'moxfield', id: 'deck-1' },
        entries: [{ entryId, printingId, finish, condition, quantity: 1 }],
      });
    }
    for (const [sessionId, entryId] of reimported) {
      const repeated = await userCards.confirmImport(alice, {
        operationId: `operation-${entryId}`,
        sessionId,
        entries: [{ entryId, expectedRevision: 1 }],
      });
      expect(repeated.replayed).toBe(false);
      expect(repeated.copies).toHaveLength(1);
    }
    expect(await countCopies(database, alice.accountId)).toBe(4);

    // The source's second copy of a card is a source entry of its own, and only it adds a copy.
    await userCards.stageImportEntries(alice, {
      sessionId: 'session-4',
      source: { kind: 'moxfield', id: 'deck-2' },
      entries: [
        {
          entryId: 'line-5',
          printingId: m11Printing.printingId,
          finish: 'foil',
          condition: 'LP',
          quantity: 1,
        },
        {
          entryId: 'line-6',
          printingId: m11Printing.printingId,
          finish: 'foil',
          condition: 'LP',
          quantity: 1,
        },
      ],
    });
    const firstOfTwo = await userCards.confirmImport(alice, {
      operationId: 'operation-line-5',
      sessionId: 'session-4',
      entries: [{ entryId: 'line-5', expectedRevision: 1 }],
    });
    expect(firstOfTwo.replayed).toBe(false);
    expect(firstOfTwo.copies).toHaveLength(1);
    const secondOfTwo = await userCards.confirmImport(alice, {
      operationId: 'operation-line-6',
      sessionId: 'session-4',
      entries: [{ entryId: 'line-6', expectedRevision: 1 }],
    });
    expect(secondOfTwo.replayed).toBe(false);
    expect(secondOfTwo.copies).toHaveLength(1);
    expect(await countCopies(database, alice.accountId)).toBe(6);

    // Importing that deck as another list with two identical lines owns both of its source entries.
    await userCards.stageImportEntries(alice, {
      sessionId: 'session-5',
      source: { kind: 'moxfield', id: 'deck-2' },
      entries: [7, 8].map((index) => ({
        entryId: `line-${index}`,
        printingId: m11Printing.printingId,
        finish: 'foil' as const,
        condition: 'LP' as const,
        quantity: 1,
      })),
    });
    const repeated = await userCards.confirmImport(alice, {
      operationId: 'operation-deck-2-repeat',
      sessionId: 'session-5',
      entries: [
        { entryId: 'line-7', expectedRevision: 1 },
        { entryId: 'line-8', expectedRevision: 1 },
      ],
    });
    expect(repeated.replayed).toBe(false);
    expect(repeated.copies).toHaveLength(2);
    expect(new Set(repeated.copies.map((copy) => copy.copyId))).not.toEqual(
      new Set([...firstOfTwo.copies, ...secondOfTwo.copies].map((copy) => copy.copyId)),
    );
    expect(await countCopies(database, alice.accountId)).toBe(8);
  });

  it('keeps a recorded outcome unchanged when its copies are corrected later', async () => {
    await userCards.stageImportEntries(alice, {
      sessionId: 'session-review',
      source: { kind: 'text', id: 'list-review' },
      entries: [
        {
          entryId: 'line-1',
          printingId: m11Printing.printingId,
          finish: 'nonfoil',
          condition: null,
          quantity: 1,
        },
      ],
    });
    const request = {
      operationId: 'operation-review',
      sessionId: 'session-review',
      entries: [{ entryId: 'line-1', expectedRevision: 1 }],
    };
    const confirmed = await userCards.confirmImport(alice, request);
    expect(confirmed.copies).toMatchObject([
      {
        printingId: m11Printing.printingId,
        finish: 'nonfoil',
        condition: null,
        revision: 1,
      },
    ]);

    const [copy] = confirmed.copies;
    if (copy === undefined) {
      throw new Error('Expected a confirmed copy.');
    }
    const corrected = await userCards.correctCopy(alice, {
      copyId: copy.copyId,
      expectedRevision: copy.revision,
      printingId: m10Printing.printingId,
      finish: 'nonfoil',
      condition: 'LP',
    });
    expect(corrected.copies[0]).toMatchObject({
      copyId: copy.copyId,
      printingId: m10Printing.printingId,
      condition: 'LP',
      revision: 2,
    });

    // Identical retry and recovery still report what the confirmation committed.
    const retry = await userCards.confirmImport(alice, request);
    expect(retry.replayed).toBe(true);
    expect(retry.copies).toEqual(confirmed.copies);
    const recovered = await userCards.recoverImportOperation(alice, request.operationId);
    expect(recovered).toEqual({
      outcome: 'recorded',
      receipt: {
        operationId: confirmed.operationId,
        sessionId: confirmed.sessionId,
        sourceKind: confirmed.sourceKind,
        sourceId: confirmed.sourceId,
        copies: confirmed.copies,
      },
    });
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

  it('recovers a confirmation larger than one transport response', async () => {
    // The RDS Data API returns at most 1 MiB per statement; the deployed transport rejects more.
    const responseLimit = 1024 * 1024;
    const bounded = createUserCards({
      sql: boundedResponses(database.sql, responseLimit),
      catalog,
    });
    const entries = Array.from({ length: 50 }, (_, index) => ({
      entryId: `bulk-${index}`,
      printingId: index % 2 === 0 ? m11Printing.printingId : counterspellPrinting.printingId,
      finish: 'nonfoil' as const,
      condition: 'NM' as const,
      quantity: 100,
    }));
    await bounded.stageImportEntries(alice, {
      sessionId: 'session-maximum',
      source: { kind: 'text', id: 'list-maximum' },
      entries,
    });
    const confirmed = await bounded.confirmImport(alice, {
      operationId: 'operation-maximum',
      sessionId: 'session-maximum',
      entries: entries.map((entry) => ({ entryId: entry.entryId, expectedRevision: 1 })),
    });
    expect(confirmed.copies).toHaveLength(5000);

    // Reading that outcome in one statement, without the component's paging, does not fit the
    // transport's response bound.
    const unbounded = await database.query(
      `select 'copy' as row_kind,
              (row_number() over (order by provenance.copy_id))::int as row_position,
              to_jsonb(provenance)::text as payload
         from (select provenance.copy_id,
                      provenance.printing_id,
                      provenance.finish,
                      provenance.condition,
                      provenance.revision
                 from usercards_private.import_receipt_acquisition as covered
                 join usercards_private.copy_provenance as provenance
                   on provenance.account_id = covered.account_id
                  and provenance.acquisition_id = covered.acquisition_id
                where covered.account_id = $1
                  and covered.operation_id = $2) as provenance`,
      [alice.accountId, 'operation-maximum'],
    );
    expect(unbounded).toHaveLength(5000);
    expect(dataApiResponseBytes(unbounded)).toBeGreaterThan(responseLimit);

    const recovered = await bounded.recoverImportOperation(alice, 'operation-maximum');
    expect(recovered).toMatchObject({ outcome: 'recorded' });
    if (recovered.outcome !== 'recorded') {
      throw new Error('Expected a recorded outcome.');
    }
    expect(recovered.receipt.copies).toHaveLength(5000);
    expect(recovered.receipt.copies.map((copy) => copy.copyId).sort()).toEqual(
      confirmed.copies.map((copy) => copy.copyId).sort(),
    );

    // An identical retry returns the same complete outcome.
    const retry = await bounded.confirmImport(alice, {
      operationId: 'operation-maximum',
      sessionId: 'session-maximum',
      entries: entries.map((entry) => ({ entryId: entry.entryId, expectedRevision: 1 })),
    });
    expect(retry.replayed).toBe(true);
    expect(retry.copies).toHaveLength(5000);

    // The same content imported as another list owns its own acquisition: its confirmation creates
    // its own copies instead of replaying this import's outcome.
    await bounded.stageImportEntries(alice, {
      sessionId: 'session-maximum-repeat',
      source: { kind: 'text', id: 'list-maximum' },
      entries: [{ ...(entries[0] as (typeof entries)[number]), entryId: 'repeat-0' }],
    });
    const repeated = await bounded.confirmImport(alice, {
      operationId: 'operation-maximum-repeat',
      sessionId: 'session-maximum-repeat',
      entries: [{ entryId: 'repeat-0', expectedRevision: 1 }],
    });
    expect(repeated.replayed).toBe(false);
    expect(repeated.copies).toHaveLength(100);
    expect(await countCopies(database, alice.accountId)).toBe(5100);
  }, 180_000);
});
