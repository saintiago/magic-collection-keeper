/**
 * Pending imports, review and the capture admission sequence over real PostgreSQL
 * (docs/user-cards.md#import-and-capture-state). The cases cover the A,A / A,B,A sequence,
 * unresolved readings, idempotent staging, review corrections against late recognition
 * alternatives, bounded pending reads and account isolation; staging and review never create
 * owned copies.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCatalog, type Catalog } from '../../../src/catalog/index.js';
import {
  createUserCards,
  USERCARDS_LIMITS,
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
import { boundedResponses, callerInput, dataApiResponseBytes } from './harness.js';

const alice: TrustedUserContext = { accountId: 'cognito-alice' };
const bob: TrustedUserContext = { accountId: 'cognito-bob' };

const lightningBolt = {
  cardId: 'oracle-lightning-bolt',
  name: 'Lightning Bolt',
  colors: ['R'],
  colorIdentity: ['R'],
  manaValue: 1,
};

const counterspell = {
  cardId: 'oracle-counterspell',
  name: 'Counterspell',
  colors: ['U'],
  colorIdentity: ['U'],
  manaValue: 2,
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

/** Digital-only printing: it cannot carry a physical copy or a pending entry. */
const staPrinting = {
  printingId: 'printing-sta-109-en',
  cardId: lightningBolt.cardId,
  edition: 'STA',
  collectorNumber: '109',
  language: 'en',
  finishes: ['etched'],
  physical: false,
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

/** Counts the account's stored copies, so "pending imports are not ownership" is asserted directly. */
async function countCopies(database: UserCardsTestDatabase, accountId: string): Promise<number> {
  const rows = await database.query(
    'select count(*)::int as count from usercards_private.copy where account_id = $1',
    [accountId],
  );
  return Number(rows[0]?.count);
}

describe('usercards pending imports', () => {
  let database: UserCardsTestDatabase;
  let catalog: Catalog;
  let userCards: UserCards;

  beforeEach(async () => {
    database = await createUserCardsTestDatabase();
    await publishCatalog(database, {
      revisionId: 'revision-1',
      cards: [lightningBolt, counterspell],
      printings: [m11Printing, m10Printing, staPrinting, counterspellPrinting],
    });
    catalog = createCatalog({ sql: database.sql });
    userCards = createUserCards({ sql: database.sql, catalog });
  });

  afterEach(async () => {
    await database.close();
  });

  async function stageCapture(
    sessionId: string,
    captureId: string,
    printingId: string | null,
    context: TrustedUserContext = alice,
  ) {
    return userCards.stageCaptureObservation(context, { sessionId, captureId, printingId });
  }

  function stagedEntry(result: { readonly entry: ImportEntry | null }): ImportEntry {
    if (result.entry === null) {
      throw new Error('Expected an admitted pending entry.');
    }
    return result.entry;
  }

  it('stores an admitted capture as a pending entry without changing ownership', async () => {
    const staged = await stageCapture('session-1', 'capture-1', m11Printing.printingId);

    expect(staged).toMatchObject({
      outcome: 'admitted',
      replayed: false,
      privateRevision: '1',
      entry: {
        entryId: 'capture-1',
        sessionId: 'session-1',
        position: 1,
        state: 'pending',
        printingId: m11Printing.printingId,
        finish: 'nonfoil',
        condition: null,
        quantity: 1,
        candidates: [],
        revision: 1,
      },
      session: {
        sessionId: 'session-1',
        sourceKind: 'capture',
        sourceId: 'session-1',
        state: 'pending',
        pendingEntries: 1,
        confirmedEntries: 0,
        discardedEntries: 0,
        // The session is created empty and admitting its first entry advances its pending set.
        revision: 2,
      },
    });

    expect(await countCopies(database, alice.accountId)).toBe(0);

    const pending = await userCards.listImportSessions(alice);
    expect(pending.sessions.map((session) => session.sessionId)).toEqual(['session-1']);
  });

  it('suppresses a consecutive accepted identity and admits it again after another card', async () => {
    const first = await stageCapture('session-1', 'capture-1', m11Printing.printingId);
    expect(first.outcome).toBe('admitted');

    // A,A admits one entry: another printing of the same card is still the same identity.
    const repeat = await stageCapture('session-1', 'capture-2', m10Printing.printingId);
    expect(repeat).toMatchObject({ outcome: 'suppressed', entry: null, replayed: false });
    expect(repeat.session.pendingEntries).toBe(1);

    const other = await stageCapture('session-1', 'capture-3', counterspellPrinting.printingId);
    expect(other.outcome).toBe('admitted');

    // A,B,A admits all three observations.
    const third = await stageCapture('session-1', 'capture-4', m11Printing.printingId);
    expect(third.outcome).toBe('admitted');
    expect(third.session.pendingEntries).toBe(3);

    const listed = await userCards.listImportEntries(alice, { sessionId: 'session-1' });
    expect(listed.entries.map((entry) => entry.entryId)).toEqual([
      'capture-1',
      'capture-3',
      'capture-4',
    ]);
    expect(listed.entries.map((entry) => entry.position)).toEqual([1, 2, 3]);
  });

  it('leaves unresolved readings out of the sequence and out of the pending entries', async () => {
    const unresolved = await stageCapture('session-1', 'capture-1', null);
    expect(unresolved).toMatchObject({ outcome: 'unresolved', entry: null, replayed: false });
    expect(unresolved.session.pendingEntries).toBe(0);

    const admitted = await stageCapture('session-1', 'capture-2', m11Printing.printingId);
    expect(admitted.outcome).toBe('admitted');

    const late = await stageCapture('session-1', 'capture-3', null);
    expect(late.outcome).toBe('unresolved');
    expect(late.session.pendingEntries).toBe(1);

    // The unresolved readings neither advanced nor reset the accepted identity.
    const repeat = await stageCapture('session-1', 'capture-4', m10Printing.printingId);
    expect(repeat.outcome).toBe('suppressed');
  });

  it('stages a capture once and replays its recorded decision', async () => {
    const first = await stageCapture('session-1', 'capture-1', m11Printing.printingId);
    const suppressed = await stageCapture('session-1', 'capture-2', m10Printing.printingId);

    const admittedRetry = await stageCapture('session-1', 'capture-1', m11Printing.printingId);
    expect(admittedRetry).toMatchObject({
      outcome: 'admitted',
      replayed: true,
      entry: { entryId: 'capture-1', revision: 1 },
      privateRevision: first.privateRevision,
    });
    const suppressedRetry = await stageCapture('session-1', 'capture-2', m10Printing.printingId);
    expect(suppressedRetry).toMatchObject({
      outcome: 'suppressed',
      replayed: true,
      privateRevision: suppressed.privateRevision,
    });

    // Changed content under the same capture identity is refused instead of admitted again.
    const changed = await captureUserCardsError(
      stageCapture('session-1', 'capture-1', counterspellPrinting.printingId),
    );
    expect(changed.code).toBe('conflict');

    const listed = await userCards.listImportEntries(alice, { sessionId: 'session-1' });
    expect(listed.entries).toHaveLength(1);
  });

  it('stages parsed source lines with their source identity, quantities and unresolved rows', async () => {
    const request = {
      sessionId: 'session-text',
      source: { kind: 'text', id: 'pasted-list-1' },
      entries: [
        {
          entryId: 'line-1',
          printingId: m11Printing.printingId,
          finish: 'foil' as const,
          condition: 'LP' as const,
          quantity: 2,
        },
        { entryId: 'line-2', quantity: 1 },
      ],
    };
    const staged = await userCards.stageImportEntries(alice, request);

    expect(staged).toMatchObject({
      staged: 2,
      replayed: false,
      session: {
        sessionId: 'session-text',
        sourceKind: 'text',
        sourceId: 'pasted-list-1',
        state: 'pending',
        pendingEntries: 2,
      },
    });
    expect(
      staged.entries.map((entry) => [
        entry.entryId,
        entry.printingId,
        entry.finish,
        entry.condition,
        entry.quantity,
      ]),
    ).toEqual([
      ['line-1', m11Printing.printingId, 'foil', 'LP', 2],
      ['line-2', null, null, null, 1],
    ]);

    const restaged = await userCards.stageImportEntries(alice, request);
    expect(restaged).toMatchObject({ staged: 0, replayed: true });
    expect(restaged.entries.map((entry) => entry.revision)).toEqual([1, 1]);

    const changed = await captureUserCardsError(
      userCards.stageImportEntries(alice, {
        ...request,
        entries: [
          {
            entryId: 'line-1',
            printingId: m11Printing.printingId,
            finish: 'foil',
            condition: 'LP',
            quantity: 3,
          },
        ],
      }),
    );
    expect(changed.code).toBe('conflict');

    expect(await countCopies(database, alice.accountId)).toBe(0);
  });

  it('stages a bounded batch whose alternatives exceed one write statement', async () => {
    const alternatives = [
      { printingId: m11Printing.printingId, provider: 'browser-onnx', evidence: 'visual' },
      {
        printingId: m10Printing.printingId,
        provider: 'lambda',
        evidence: 'visible-title-ocr',
      },
      {
        printingId: counterspellPrinting.printingId,
        provider: 'bedrock-independent',
        evidence: 'independent-artwork',
      },
      {
        printingId: m11Printing.printingId,
        provider: 'lambda',
        evidence: 'independent-visible-title',
      },
    ];
    const staged = await userCards.stageImportEntries(alice, {
      sessionId: 'session-bulk',
      source: { kind: 'text', id: 'bulk-list' },
      entries: Array.from({ length: 30 }, (_, index) => ({
        entryId: `bulk-line-${index + 1}`,
        printingId: m11Printing.printingId,
        quantity: 1,
        candidates: alternatives,
      })),
    });

    expect(staged).toMatchObject({ staged: 30, replayed: false });
    expect(staged.entries).toHaveLength(30);
    expect(staged.entries.every((entry) => entry.candidates.length === 4)).toBe(true);
    expect(staged.entries[0]?.candidates).toEqual(
      [...alternatives].sort((left, right) =>
        `${left.printingId}\u0000${left.provider}\u0000${left.evidence}`.localeCompare(
          `${right.printingId}\u0000${right.provider}\u0000${right.evidence}`,
        ),
      ),
    );
  });

  it('keeps review corrections against late recognition alternatives', async () => {
    const entry = stagedEntry(await stageCapture('session-1', 'capture-1', m11Printing.printingId));
    const reviewed = await userCards.reviewImportEntry(alice, {
      entryId: entry.entryId,
      expectedRevision: entry.revision,
      printingId: m10Printing.printingId,
      finish: 'nonfoil',
      condition: 'LP',
      quantity: 3,
    });
    expect(reviewed.entry).toMatchObject({
      printingId: m10Printing.printingId,
      finish: 'nonfoil',
      condition: 'LP',
      quantity: 3,
      revision: 2,
    });

    const alternative = {
      printingId: m11Printing.printingId,
      provider: 'browser-onnx',
      evidence: 'visual',
    };
    const attached = await userCards.attachImportCandidates(alice, {
      entryId: entry.entryId,
      candidates: [alternative],
    });
    expect(attached.entry).toMatchObject({
      printingId: m10Printing.printingId,
      finish: 'nonfoil',
      condition: 'LP',
      quantity: 3,
      revision: 2,
    });
    expect(attached.entry.candidates).toEqual([alternative]);

    // Repeating the same alternative stores it once and still leaves the review alone.
    const repeated = await userCards.attachImportCandidates(alice, {
      entryId: entry.entryId,
      candidates: [alternative],
    });
    expect(repeated.entry.candidates).toEqual([alternative]);
    expect(repeated.entry.revision).toBe(2);

    // A review that started from the older revision is refused, and the newer state stands.
    const stale = await captureUserCardsError(
      userCards.reviewImportEntry(alice, {
        entryId: entry.entryId,
        expectedRevision: entry.revision,
        printingId: m11Printing.printingId,
        finish: 'nonfoil',
        condition: null,
        quantity: 1,
      }),
    );
    expect(stale.code).toBe('conflict');
    const stored = await userCards.listImportEntries(alice, { sessionId: 'session-1' });
    expect(stored.entries[0]).toMatchObject({
      printingId: m10Printing.printingId,
      condition: 'LP',
      quantity: 3,
    });
  });

  it('lists pending imports and entries with bounded continuations', async () => {
    await userCards.stageImportEntries(alice, {
      sessionId: 'session-1',
      source: { kind: 'text', id: 'list-1' },
      entries: [
        { entryId: 'line-1', printingId: m11Printing.printingId, quantity: 1 },
        { entryId: 'line-2', printingId: counterspellPrinting.printingId, quantity: 1 },
        { entryId: 'line-3', printingId: m10Printing.printingId, quantity: 1 },
      ],
    });
    await userCards.stageImportEntries(alice, {
      sessionId: 'session-2',
      source: { kind: 'text', id: 'list-2' },
      entries: [{ entryId: 'line-4', printingId: m11Printing.printingId, quantity: 1 }],
    });

    const sessions = await userCards.listImportSessions(alice, { pageSize: 1 });
    expect(sessions.sessions.map((session) => session.sessionId)).toEqual(['session-1']);
    expect(sessions.continuation).not.toBeNull();
    const nextSessions = await userCards.listImportSessions(alice, {
      pageSize: 1,
      continuation: sessions.continuation as string,
    });
    expect(nextSessions.sessions.map((session) => session.sessionId)).toEqual(['session-2']);
    expect(nextSessions.continuation).toBeNull();

    const first = await userCards.listImportEntries(alice, {
      sessionId: 'session-1',
      pageSize: 2,
    });
    expect(first.entries.map((entry) => entry.entryId)).toEqual(['line-1', 'line-2']);
    expect(first.continuation).not.toBeNull();
    const second = await userCards.listImportEntries(alice, {
      sessionId: 'session-1',
      pageSize: 2,
      continuation: first.continuation as string,
    });
    expect(second.entries.map((entry) => entry.entryId)).toEqual(['line-3']);
    expect(second.continuation).toBeNull();

    // A change after the page was read invalidates its continuation instead of skipping rows.
    await userCards.stageImportEntries(alice, {
      sessionId: 'session-1',
      source: { kind: 'text', id: 'list-1' },
      entries: [{ entryId: 'line-5', printingId: m11Printing.printingId, quantity: 1 }],
    });
    const stale = await captureUserCardsError(
      userCards.listImportEntries(alice, {
        sessionId: 'session-1',
        pageSize: 2,
        continuation: first.continuation as string,
      }),
    );
    expect(stale.code).toBe('conflict');
  });

  it('discards one pending entry or a whole import under the revision it started from', async () => {
    await userCards.stageImportEntries(alice, {
      sessionId: 'session-1',
      source: { kind: 'text', id: 'list-1' },
      entries: [
        { entryId: 'line-1', printingId: m11Printing.printingId, quantity: 1 },
        { entryId: 'line-2', printingId: m10Printing.printingId, quantity: 1 },
      ],
    });
    const listed = await userCards.listImportEntries(alice, { sessionId: 'session-1' });
    const [first, second] = listed.entries;

    const conflict = await captureUserCardsError(
      userCards.discardImportEntry(alice, {
        entryId: first?.entryId as string,
        expectedRevision: 9,
      }),
    );
    expect(conflict.code).toBe('conflict');

    const discarded = await userCards.discardImportEntry(alice, {
      entryId: first?.entryId as string,
      expectedRevision: first?.revision as number,
    });
    expect(discarded.entry.state).toBe('discarded');
    expect(discarded.session).toMatchObject({ pendingEntries: 1, discardedEntries: 1 });

    const cleared = await userCards.discardImportSession(alice, {
      sessionId: 'session-1',
      expectedRevision: discarded.session.revision,
    });
    expect(cleared.session).toMatchObject({
      state: 'discarded',
      pendingEntries: 0,
      discardedEntries: 2,
    });

    const empty = await userCards.listImportEntries(alice, { sessionId: 'session-1' });
    expect(empty.entries).toEqual([]);
    expect((await userCards.listImportSessions(alice)).sessions).toEqual([]);
    expect(await countCopies(database, alice.accountId)).toBe(0);
    expect(second?.entryId).toBe('line-2');
  });

  it('refuses a whole-import discard that would drop a newer review or alternative', async () => {
    const staged = await userCards.stageImportEntries(alice, {
      sessionId: 'session-1',
      source: { kind: 'text', id: 'list-1' },
      entries: [{ entryId: 'line-1', printingId: m11Printing.printingId, quantity: 1 }],
    });
    const entry = staged.entries[0];
    if (entry === undefined) {
      throw new Error('Expected a staged pending entry.');
    }

    // A review changes the pending state a whole-import discard removes.
    const reviewed = await userCards.reviewImportEntry(alice, {
      entryId: entry.entryId,
      expectedRevision: entry.revision,
      printingId: m10Printing.printingId,
      finish: 'nonfoil',
      condition: 'LP',
      quantity: 3,
    });
    const staleReview = await captureUserCardsError(
      userCards.discardImportSession(alice, {
        sessionId: 'session-1',
        expectedRevision: staged.session.revision,
      }),
    );
    expect(staleReview.code).toBe('conflict');
    expect(
      (await userCards.listImportEntries(alice, { sessionId: 'session-1' })).entries[0],
    ).toMatchObject({
      printingId: m10Printing.printingId,
      condition: 'LP',
      quantity: 3,
      state: 'pending',
    });

    // A late recognition alternative is part of the same pending state.
    const alternative = {
      printingId: m11Printing.printingId,
      provider: 'browser-onnx',
      evidence: 'visual',
    };
    const attached = await userCards.attachImportCandidates(alice, {
      entryId: entry.entryId,
      candidates: [alternative],
    });
    const staleAlternative = await captureUserCardsError(
      userCards.discardImportSession(alice, {
        sessionId: 'session-1',
        expectedRevision: reviewed.session.revision,
      }),
    );
    expect(staleAlternative.code).toBe('conflict');
    expect(
      (await userCards.listImportEntries(alice, { sessionId: 'session-1' })).entries[0]?.candidates,
    ).toEqual([alternative]);

    // The discard of the reviewed state it read still clears the import.
    const cleared = await userCards.discardImportSession(alice, {
      sessionId: 'session-1',
      expectedRevision: attached.session.revision,
    });
    expect(cleared.session).toMatchObject({ state: 'discarded', pendingEntries: 0 });
  });

  it.each(['界', '\u0001'])(
    'keeps maximum candidate results within transport bounds (%s)',
    async (character) => {
      const printingId = character.repeat(200);
      const sessionId = `session-${character.repeat(192)}`;
      await publishCatalog(database, {
        revisionId: 'large-strings',
        cards: [lightningBolt],
        printings: [{ ...m11Printing, printingId }],
      });
      const bounded = createUserCards({
        sql: boundedResponses(database.sql, 1024 * 1024),
        catalog,
      });
      const candidates = Array.from({ length: 8 }, (_, index) => ({
        printingId,
        provider: `${index}${character.repeat(199)}`,
        evidence: character.repeat(200),
      }));
      const entries = Array.from({ length: 100 }, (_, index) => ({
        entryId: `${String(index).padStart(3, '0')}${character.repeat(197)}`,
        printingId,
        quantity: 1,
        candidates,
      }));
      for (let offset = 0; offset < entries.length; offset += 50) {
        const staged = await bounded.stageImportEntries(alice, {
          sessionId,
          source: { kind: 'text', id: character.repeat(200) },
          entries: entries.slice(offset, offset + 50),
        });
        expect(staged.entries).toHaveLength(50);
        expect(staged.entries.map((entry) => entry.candidates)).toEqual(
          Array.from({ length: 50 }, () => candidates),
        );
      }
      const listed = await bounded.listImportEntries(alice, { sessionId, pageSize: 100 });
      expect(listed.entries.map((entry) => entry.entryId)).toEqual(
        entries.map((entry) => entry.entryId),
      );
      expect(listed.entries.map((entry) => entry.candidates)).toEqual(
        Array.from({ length: 100 }, () => candidates),
      );
      expect(listed.continuation).toBeNull();
      // This fixture exceeds one response even before adding entry/session rows.
      const unbounded = await database.query(`select to_jsonb(candidate)::text as payload
      from (select entry_id, printing_id, provider, evidence from usercards_private.import_candidate) as candidate`);
      expect(dataApiResponseBytes(unbounded)).toBeGreaterThan(1024 * 1024);
      const confirmed = await bounded.confirmImport(alice, {
        operationId: 'large-candidates',
        sessionId,
        entries: entries
          .slice(0, 50)
          .map((entry) => ({ entryId: entry.entryId, expectedRevision: 1 })),
      });
      expect(confirmed.copies).toHaveLength(50);
      expect(
        (await bounded.listImportEntries(alice, { sessionId, pageSize: 100 })).entries,
      ).toHaveLength(50);
    },
  );

  it('discards a large session with a bounded result and preserves other pending work', async () => {
    const bounded = createUserCards({ sql: boundedResponses(database.sql, 1024 * 1024), catalog });
    const staged = await bounded.stageImportEntries(alice, {
      sessionId: 'large-discard',
      source: { kind: 'text', id: 'large-discard' },
      entries: [{ entryId: 'original', quantity: 1 }],
    });
    // Large persisted progress is a fixture; the public discard still performs the whole mutation.
    await database.query(
      `insert into usercards_private.import_entry
      (account_id, session_id, entry_id, position)
      select $1, 'large-discard', lpad(n::text, 200, 'x'), n + 1 from generate_series(1, 5000) as n`,
      [alice.accountId],
    );
    await bounded.stageImportEntries(alice, {
      sessionId: 'untouched',
      source: { kind: 'text', id: 'other' },
      entries: [{ entryId: 'untouched-entry', quantity: 1 }],
    });
    const discarded = await bounded.discardImportSession(alice, {
      sessionId: 'large-discard',
      expectedRevision: staged.session.revision,
    });
    expect(discarded.session).toMatchObject({
      pendingEntries: 0,
      discardedEntries: 5001,
      revision: staged.session.revision + 1,
    });
    expect(
      (await bounded.listImportEntries(alice, { sessionId: 'untouched' })).entries,
    ).toHaveLength(1);
    const repeat = await bounded.discardImportSession(alice, {
      sessionId: 'large-discard',
      expectedRevision: discarded.session.revision,
    });
    expect(repeat).toEqual(discarded);
  });

  it('rejects a pending page that changes between internal transport reads', async () => {
    await userCards.stageImportEntries(alice, {
      sessionId: 'changing-page',
      source: { kind: 'text', id: 'changing' },
      entries: Array.from({ length: 30 }, (_, index) => ({
        entryId: `changing-${index}`,
        quantity: 1,
      })),
    });
    let changed = false;
    const interleaved = createUserCards({
      catalog,
      sql: {
        transaction: (work) => database.sql.transaction(work),
        async query(statement, parameters) {
          const rows = await database.sql.query(statement, parameters);
          if (!changed && parameters?.session_id === 'changing-page' && parameters.offset === 0) {
            changed = true;
            await userCards.reviewImportEntry(alice, {
              entryId: 'changing-0',
              expectedRevision: 1,
              printingId: m11Printing.printingId,
              finish: 'foil',
              condition: 'LP',
              quantity: 2,
            });
          }
          return rows;
        },
      },
    });
    const failed = await captureUserCardsError(
      interleaved.listImportEntries(alice, { sessionId: 'changing-page', pageSize: 30 }),
    );
    expect(failed.code).toBe('conflict');
    const reloaded = await userCards.listImportEntries(alice, {
      sessionId: 'changing-page',
      pageSize: 30,
    });
    expect(reloaded.entries).toHaveLength(30);
    expect(reloaded.entries[0]).toMatchObject({ revision: 2, quantity: 2 });
  });

  it('stages a batch whose references exceed one catalog resolution', async () => {
    const bulkPrintings = Array.from({ length: 104 }, (_, index) => ({
      printingId: `printing-bulk-${index}-en`,
      cardId: `oracle-bulk-${index}`,
      edition: 'BLK',
      collectorNumber: String(index + 1),
      language: 'en',
      finishes: ['nonfoil'],
      physical: true,
    }));
    await publishCatalog(database, {
      revisionId: 'revision-2',
      cards: [
        lightningBolt,
        counterspell,
        ...bulkPrintings.map((printing, index) => ({
          cardId: printing.cardId,
          name: `Bulk ${index}`,
          colors: [],
          colorIdentity: [],
          manaValue: 1,
        })),
      ],
      printings: [m11Printing, m10Printing, staPrinting, counterspellPrinting, ...bulkPrintings],
    });

    // Thirteen lines with eight alternatives each reference 104 distinct printings beside their own.
    const staged = await userCards.stageImportEntries(alice, {
      sessionId: 'session-bulk',
      source: { kind: 'text', id: 'list-bulk' },
      entries: Array.from({ length: 13 }, (_, index) => ({
        entryId: `line-bulk-${index}`,
        printingId: m11Printing.printingId,
        finish: 'nonfoil' as const,
        quantity: 1,
        candidates: bulkPrintings.slice(index * 8, index * 8 + 8).map((printing) => ({
          printingId: printing.printingId,
          provider: 'lambda',
          evidence: 'visual',
        })),
      })),
    });

    expect(staged).toMatchObject({ staged: 13, replayed: false });
    expect(staged.entries).toHaveLength(13);
    expect(staged.entries.every((entry) => entry.candidates.length === 8)).toBe(true);
  });

  it("keeps one account's pending imports, review and discard out of another account", async () => {
    await stageCapture('session-1', 'capture-1', m11Printing.printingId);

    expect((await userCards.listImportSessions(bob)).sessions).toEqual([]);
    const bobRead = await captureUserCardsError(
      userCards.listImportEntries(bob, { sessionId: 'session-1' }),
    );
    expect(bobRead.code).toBe('not-found');

    const bobReview = await captureUserCardsError(
      userCards.reviewImportEntry(bob, {
        entryId: 'capture-1',
        expectedRevision: 1,
        printingId: m11Printing.printingId,
        finish: 'nonfoil',
        condition: null,
        quantity: 1,
      }),
    );
    expect(bobReview.code).toBe('not-found');
    const bobDiscard = await captureUserCardsError(
      userCards.discardImportEntry(bob, { entryId: 'capture-1', expectedRevision: 1 }),
    );
    expect(bobDiscard.code).toBe('not-found');
    const bobDiscardSession = await captureUserCardsError(
      userCards.discardImportSession(bob, { sessionId: 'session-1', expectedRevision: 1 }),
    );
    expect(bobDiscardSession.code).toBe('not-found');

    // The same identities are independent per account.
    const bobStaged = await stageCapture('session-1', 'capture-1', m11Printing.printingId, bob);
    expect(bobStaged).toMatchObject({ outcome: 'admitted', session: { pendingEntries: 1 } });
    expect(
      (await userCards.listImportEntries(alice, { sessionId: 'session-1' })).entries,
    ).toHaveLength(1);
    expect(
      (await userCards.listImportEntries(bob, { sessionId: 'session-1' })).entries,
    ).toHaveLength(1);
  });

  it('rejects malformed pending-import requests and unresolved references', async () => {
    const invalid = async (call: Promise<unknown>) => (await captureUserCardsError(call)).code;

    expect(
      await invalid(
        userCards.stageCaptureObservation(
          alice,
          callerInput({
            sessionId: 'session-1',
            captureId: 'capture-1',
            candidates: [{ printingId: m11Printing.printingId, provider: 'p', evidence: 'e' }],
          }),
        ),
      ),
    ).toBe('invalid-request');
    expect(
      await invalid(
        userCards.stageCaptureObservation(
          alice,
          callerInput({
            sessionId: 'session-1',
            captureId: 'capture-1',
            printingId: null,
            finish: 'foil',
          }),
        ),
      ),
    ).toBe('invalid-request');
    expect(
      await invalid(
        userCards.stageImportEntries(
          alice,
          callerInput({
            sessionId: 'session-1',
            source: { kind: 'text', id: 'list-1' },
            entries: [
              { entryId: 'line-1', printingId: m11Printing.printingId, quantity: 1 },
              { entryId: 'line-1', printingId: m11Printing.printingId, quantity: 1 },
            ],
          }),
        ),
      ),
    ).toBe('invalid-request');
    expect(
      await invalid(
        userCards.stageImportEntries(
          alice,
          callerInput({
            sessionId: 'session-1',
            source: { kind: 'text', id: 'list-1' },
            entries: [{ entryId: 'line-1', quantity: 0 }],
          }),
        ),
      ),
    ).toBe('invalid-request');
    expect(
      await invalid(
        userCards.stageImportEntries(alice, {
          sessionId: 'session-1',
          source: { kind: 'text', id: 'list-1' },
          entries: [
            { entryId: 'line-1', quantity: 1 },
            ...Array.from({ length: USERCARDS_LIMITS.maxStageEntries }, (_, index) => ({
              entryId: `line-${index + 2}`,
              quantity: 1,
            })),
          ],
        }),
      ),
    ).toBe('invalid-request');
    expect(
      await invalid(
        userCards.listImportEntries(alice, callerInput({ sessionId: 'session-1', pageSize: 0 })),
      ),
    ).toBe('invalid-request');
    expect(
      await invalid(userCards.listImportSessions(alice, { continuation: 'not-a-continuation' })),
    ).toBe('invalid-request');
    expect(
      await invalid(userCards.listImportSessions(callerInput(undefined) as TrustedUserContext)),
    ).toBe('invalid-request');

    // A digital-only printing cannot be staged as a physical pending entry.
    const digital = await captureUserCardsError(
      stageCapture('session-1', 'capture-1', staPrinting.printingId),
    );
    expect(digital.code).toBe('invalid-request');
    // A finish the printing does not offer is refused.
    const wrongFinish = await captureUserCardsError(
      userCards.stageCaptureObservation(alice, {
        sessionId: 'session-1',
        captureId: 'capture-1',
        printingId: m10Printing.printingId,
        finish: 'foil',
      }),
    );
    expect(wrongFinish.code).toBe('invalid-request');
    // Alternatives must resolve in the published catalog.
    const unknownCandidate = await captureUserCardsError(
      userCards.attachImportCandidates(alice, {
        entryId: 'capture-1',
        candidates: [{ printingId: 'printing-unknown', provider: 'lambda', evidence: 'visual' }],
      }),
    );
    expect(unknownCandidate.code).toBe('not-found');
  });
});
