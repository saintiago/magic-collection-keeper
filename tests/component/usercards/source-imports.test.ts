/**
 * Source imports over real PostgreSQL (docs/user-cards.md#source-imports,
 * docs/user-cards.md#persistence-and-recovery). The cases cover each supported format, unreadable
 * rows and partial parsing failure, unresolved names and printings that stay reviewable, repeated
 * sources, changed quantities, duplicate lines, provenance and the rule that a source change never
 * moves physical ownership on its own.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCatalog, type Catalog } from '../../../src/catalog/index.js';
import {
  createMoxfieldDeckSource,
  createSourceImports,
  createUserCards,
  type ImportReceipt,
  type MoxfieldDeckSource,
  type SourceImportOperations,
  type SourceImportResult,
  type TrustedUserContext,
  type UserCards,
  type UserCardsSqlExecutor,
  type UserCardsSqlTransactor,
} from '../../../src/usercards/index.js';
import { publishCatalog } from '../../support/catalog-database.js';
import {
  captureUserCardsError,
  createUserCardsTestDatabase,
  type UserCardsTestDatabase,
} from '../../support/usercards-database.js';
import { callerInput } from './harness.js';

const alice: TrustedUserContext = { accountId: 'cognito-alice' };
const bob: TrustedUserContext = { accountId: 'cognito-bob' };

/** The largest SQL statement the deployed RDS Data API accepts. */
const dataApiStatementLimit = 65_536;

/**
 * An executor that refuses a statement the deployed write transport would reject, so a local
 * PostgreSQL pass cannot hide an oversized batch (docs/tech-stack.md).
 */
function boundedStatements(statements: UserCardsSqlExecutor): UserCardsSqlExecutor {
  return {
    query(statement, parameters) {
      if (statement.length > dataApiStatementLimit) {
        throw new Error(`The transport rejects a ${statement.length}-character statement.`);
      }
      return statements.query(statement, parameters);
    },
  };
}

/** The test transactor with the deployed transport's statement bound applied to every statement. */
function boundedTransport(sql: UserCardsSqlTransactor): UserCardsSqlTransactor {
  return {
    query: (statement, parameters) => boundedStatements(sql).query(statement, parameters),
    transaction: (work) => sql.transaction((statements) => work(boundedStatements(statements))),
  };
}

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

/** Digital-only printing: it can never carry a physical copy or a pending entry. */
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
  finishes: ['nonfoil', 'foil'],
  physical: true,
};

const deckUrl = 'https://moxfield.com/decks/keeper_test_deck_01';

interface DeckCard {
  readonly name: string;
  readonly scryfall_id?: string;
  readonly set?: string;
  readonly cn?: string;
  readonly lang?: string;
}

interface DeckLine {
  readonly quantity: number;
  readonly finish?: string;
  readonly card: DeckCard;
}

/** A Moxfield deck document with the given boards, in the shape the provider publishes. */
function deckDocument(boards: Readonly<Record<string, readonly DeckLine[]>>): unknown {
  return {
    name: 'Keeper test deck',
    isPrivate: false,
    boards: Object.fromEntries(
      Object.entries(boards).map(([section, lines]) => [
        section,
        { cards: Object.fromEntries(lines.map((line, index) => [`${section}-${index}`, line])) },
      ]),
    ),
  };
}

/** A mainboard Lightning Bolt line of one deck, resolved to the M11 printing by default. */
function boltLine(quantity: number, card: Partial<DeckCard> = {}): DeckLine {
  return {
    quantity,
    finish: 'nonfoil',
    card: {
      name: 'Lightning Bolt',
      scryfall_id: m11Printing.printingId,
      set: 'm11',
      cn: '149',
      lang: 'en',
      ...card,
    },
  };
}

function counterLine(quantity: number, finish = 'nonfoil'): DeckLine {
  return {
    quantity,
    finish,
    card: {
      name: 'Counterspell',
      scryfall_id: counterspellPrinting.printingId,
      set: '7ed',
      cn: '67',
      lang: 'en',
    },
  };
}

/** Counts the account's stored copies, so "a source change is not ownership" is asserted directly. */
async function countCopies(database: UserCardsTestDatabase, accountId: string): Promise<number> {
  const rows = await database.query(
    'select count(*)::int as count from usercards_private.copy where account_id = $1',
    [accountId],
  );
  return Number(rows[0]?.count);
}

describe('usercards source imports', () => {
  let database: UserCardsTestDatabase;
  let catalog: Catalog;
  let userCards: UserCards;
  let sourceImports: SourceImportOperations;
  let deckDocumentValue: unknown;
  let deckFailure: Error | null;

  beforeEach(async () => {
    database = await createUserCardsTestDatabase();
    await publishCatalog(database, {
      revisionId: 'revision-1',
      cards: [lightningBolt, counterspell],
      printings: [m11Printing, m10Printing, staPrinting, counterspellPrinting],
    });
    catalog = createCatalog({ sql: database.sql });
    userCards = createUserCards({ sql: database.sql, catalog });
    deckDocumentValue = deckDocument({ mainboard: [boltLine(1)] });
    deckFailure = null;
    const decks: MoxfieldDeckSource = {
      async readDeck() {
        if (deckFailure !== null) {
          throw deckFailure;
        }
        return deckDocumentValue;
      },
    };
    sourceImports = createSourceImports({ sql: database.sql, catalog, decks });
  });

  afterEach(async () => {
    await database.close();
  });

  it('requires a SQL executor and a catalog and validates a supplied deck source', () => {
    expect(() => createSourceImports(callerInput({ catalog }))).toThrow(TypeError);
    expect(() =>
      createSourceImports(callerInput({ sql: database.sql, catalog, decks: { readDeck: 'x' } })),
    ).toThrow(TypeError);
    // The Moxfield source is optional: the component reads the public API itself when none is given.
    expect(() => createSourceImports({ sql: database.sql, catalog })).not.toThrow();
  });

  it('reads a public Moxfield deck through its own request and maps provider failures', async () => {
    const requested: string[] = [];
    const fetcher = async (input: string | URL | Request): Promise<Response> => {
      requested.push(String(input));
      return new Response(JSON.stringify(deckDocument({ mainboard: [boltLine(1)] })), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    };
    const reading = createSourceImports({
      sql: database.sql,
      catalog,
      decks: createMoxfieldDeckSource({ fetcher: fetcher as typeof fetch }),
    });
    const result = await reading.stageSourceImport(alice, { format: 'moxfield', url: deckUrl });
    expect(result.staged).toBe(1);
    expect(requested).toEqual(['https://api2.moxfield.com/v3/decks/all/keeper_test_deck_01']);

    const missing = createMoxfieldDeckSource({
      fetcher: (async () => new Response('', { status: 404 })) as typeof fetch,
    });
    expect((await captureUserCardsError(missing.readDeck('keeper_test_deck_01'))).code).toBe(
      'not-found',
    );

    const denied = createMoxfieldDeckSource({
      fetcher: (async () => new Response('', { status: 403 })) as typeof fetch,
    });
    expect((await captureUserCardsError(denied.readDeck('keeper_test_deck_01'))).code).toBe(
      'invalid-request',
    );

    const unreadable = createMoxfieldDeckSource({
      fetcher: (async () =>
        new Response('<html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })) as typeof fetch,
    });
    expect((await captureUserCardsError(unreadable.readDeck('keeper_test_deck_01'))).code).toBe(
      'unavailable',
    );

    // The import operation keeps the classification the source published, so a caller can offer
    // the recovery each failure implies instead of a single temporary unavailability.
    const throughImport = (decks: MoxfieldDeckSource) =>
      createSourceImports({ sql: database.sql, catalog, decks });
    expect(
      (
        await captureUserCardsError(
          throughImport(missing).stageSourceImport(alice, { format: 'moxfield', url: deckUrl }),
        )
      ).code,
    ).toBe('not-found');
    expect(
      (
        await captureUserCardsError(
          throughImport(denied).stageSourceImport(alice, { format: 'moxfield', url: deckUrl }),
        )
      ).code,
    ).toBe('invalid-request');
    expect(
      (
        await captureUserCardsError(
          throughImport(unreadable).stageSourceImport(alice, { format: 'moxfield', url: deckUrl }),
        )
      ).code,
    ).toBe('unavailable');
    // The source's own response bound is a validation failure, not a temporary outage.
    const oversized = createMoxfieldDeckSource({
      fetcher: (async () =>
        new Response(`[${'x'.repeat(2 * 1024 * 1024 + 1)}]`, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch,
    });
    const oversizedOutcome = await captureUserCardsError(
      throughImport(oversized).stageSourceImport(alice, { format: 'moxfield', url: deckUrl }),
    );
    expect(oversizedOutcome.code).toBe('invalid-request');
    expect(oversizedOutcome.message).toContain('larger than one import reads');
    expect(await countCopies(database, alice.accountId)).toBe(0);
  });

  /** Reads one deck through the import and returns its result. */
  async function stageDeck(
    boards: Readonly<Record<string, readonly DeckLine[]>> = { mainboard: [boltLine(1)] },
    context: TrustedUserContext = alice,
  ): Promise<SourceImportResult> {
    deckDocumentValue = deckDocument(boards);
    return sourceImports.stageSourceImport(context, { format: 'moxfield', url: deckUrl });
  }

  /** Confirms every pending entry of one session under one operation identity. */
  async function confirmSession(sessionId: string, operationId: string): Promise<ImportReceipt> {
    const pending = await userCards.listImportEntries(alice, { sessionId });
    return userCards.confirmImport(alice, {
      operationId,
      sessionId,
      entries: pending.entries.map((entry) => ({
        entryId: entry.entryId,
        expectedRevision: entry.revision,
      })),
    });
  }

  it('parses a pasted card list into reviewable pending entries without ownership', async () => {
    const result = await sourceImports.stageSourceImport(alice, {
      format: 'pasted-list',
      sourceId: 'wishlist-paste',
      text: ['Deck', '4 Lightning Bolt (M11) 149', '2x Counterspell', '# note', 'not a line'].join(
        '\n',
      ),
    });

    expect(result.session).toMatchObject({
      sourceKind: 'pasted-list',
      sourceId: 'wishlist-paste',
      sourceReference: null,
      pendingEntries: 2,
    });
    expect(result.staged).toBe(2);
    expect(result.rows).toMatchObject([
      {
        position: 2,
        outcome: 'staged',
        sessionId: result.session.sessionId,
        line: {
          name: 'Lightning Bolt',
          section: 'deck',
          set: 'M11',
          collectorNumber: '149',
          finish: null,
          declaredQuantity: 4,
          problem: 'The source named no printing; choose one during review.',
        },
      },
      {
        position: 3,
        outcome: 'staged',
        sessionId: result.session.sessionId,
        line: { name: 'Counterspell', section: 'deck', declaredQuantity: 2 },
      },
      {
        position: 5,
        outcome: 'invalid',
        line: null,
        entryId: null,
        sessionId: null,
        problem: 'Use “quantity card name”, optionally followed by “(SET) number”.',
      },
    ]);
    expect(await countCopies(database, alice.accountId)).toBe(0);

    const pending = await userCards.listImportEntries(alice, {
      sessionId: result.session.sessionId,
    });
    expect(pending.entries.map((entry) => entry.sourceLine?.name)).toEqual([
      'Lightning Bolt',
      'Counterspell',
    ]);
    expect(pending.entries.map((entry) => entry.quantity)).toEqual([4, 2]);
    expect(pending.entries.every((entry) => entry.printingId === null)).toBe(true);
  });

  it('resolves published Moxfield printings and keeps the rest reviewable', async () => {
    const result = await stageDeck({
      mainboard: [
        boltLine(2),
        boltLine(1, { scryfall_id: 'printing-not-published' }),
        {
          quantity: 1,
          finish: 'etched',
          card: { name: 'Lightning Bolt', scryfall_id: m11Printing.printingId },
        },
        { quantity: 1, card: { name: 'Lightning Bolt', scryfall_id: staPrinting.printingId } },
        { quantity: 0, card: { name: 'Lightning Bolt' } },
      ],
      commanders: [counterLine(1, 'foil')],
      sideboard: [boltLine(3, { scryfall_id: m10Printing.printingId })],
    });

    expect(result.session).toMatchObject({
      sourceKind: 'moxfield',
      sourceId: 'keeper_test_deck_01',
      sourceReference: deckUrl,
    });
    expect(result.staged).toBe(6);
    expect(result.rows.map((row) => row.outcome)).toEqual([
      'staged',
      'staged',
      'staged',
      'staged',
      'invalid',
      'staged',
      'staged',
    ]);
    expect(result.rows[1]).toMatchObject({
      line: { problem: 'The catalog does not publish this printing; choose one during review.' },
    });
    expect(result.rows[2]).toMatchObject({
      line: { problem: 'The printing is not available in the etched finish.' },
    });
    expect(result.rows[3]).toMatchObject({
      line: { problem: 'The printing is not available as a physical card.' },
    });
    expect(result.rows[5]).toMatchObject({ line: { section: 'commanders', finish: 'foil' } });
    expect(result.rows[6]).toMatchObject({
      line: { section: 'sideboard', declaredQuantity: 3 },
    });

    const pending = await userCards.listImportEntries(alice, {
      sessionId: result.session.sessionId,
    });
    expect(pending.entries.map((entry) => entry.printingId)).toEqual([
      m11Printing.printingId,
      null,
      null,
      null,
      counterspellPrinting.printingId,
      m10Printing.printingId,
    ]);
    expect(pending.entries[0]?.finish).toBe('nonfoil');
    // Every board the deck publishes stays reviewable; only a confirmation changes ownership, so
    // the sideboard is not withheld from review.
    expect(pending.entries.map((entry) => entry.sourceLine?.section)).toEqual([
      'mainboard',
      'mainboard',
      'mainboard',
      'mainboard',
      'commanders',
      'sideboard',
    ]);
    expect(await countCopies(database, alice.accountId)).toBe(0);
  });

  it('stages every board a deck publishes, including a sideboard, for review', async () => {
    const result = await stageDeck({
      mainboard: [boltLine(1)],
      sideboard: [counterLine(1)],
      maybeboard: [boltLine(1, { scryfall_id: m10Printing.printingId })],
    });

    expect(result.rows.map((row) => row.line?.section)).toEqual([
      'mainboard',
      'sideboard',
      'maybeboard',
    ]);
    expect(result.staged).toBe(3);
    expect(result.session).toMatchObject({ pendingEntries: 3 });
    // Staging a board is not a declaration of ownership; only a confirmation creates copies.
    expect(await countCopies(database, alice.accountId)).toBe(0);
  });

  it('normalizes empty provider attributes instead of failing the readable rows', async () => {
    const result = await stageDeck({
      mainboard: [
        boltLine(1, { set: '' }),
        { quantity: 2, card: { name: 'Lightning Bolt', set: 'm11', cn: '', lang: '' } },
        counterLine(1),
      ],
    });

    expect(result.rows.map((row) => row.outcome)).toEqual(['staged', 'staged', 'staged']);
    expect(result.staged).toBe(3);
    const pending = await userCards.listImportEntries(alice, {
      sessionId: result.session.sessionId,
    });
    expect(pending.entries.map((entry) => entry.sourceLine?.set)).toEqual([null, 'm11', '7ed']);
    expect(pending.entries[1]?.sourceLine).toMatchObject({
      collectorNumber: null,
      language: null,
    });
    expect(pending.entries.map((entry) => entry.quantity)).toEqual([1, 2, 1]);
    expect(await countCopies(database, alice.accountId)).toBe(0);
  });

  it('reports an unsupported declared finish instead of storing it as nonfoil', async () => {
    const result = await stageDeck({
      mainboard: [
        boltLine(1),
        { ...boltLine(1), finish: 'glossy' },
        {
          quantity: 2,
          card: { name: 'Counterspell', scryfall_id: counterspellPrinting.printingId },
        },
      ],
    });

    expect(result.rows.map((row) => row.outcome)).toEqual(['staged', 'invalid', 'staged']);
    expect(result.rows[1]).toMatchObject({
      line: null,
      entryId: null,
      sessionId: null,
      problem: expect.stringContaining('glossy'),
    });
    expect(result.staged).toBe(2);
    const pending = await userCards.listImportEntries(alice, {
      sessionId: result.session.sessionId,
    });
    // An absent finish still resolves to the printing's default; an unsupported one never does.
    expect(pending.entries.map((entry) => entry.finish)).toEqual(['nonfoil', 'nonfoil']);
  });

  it('reports a malformed published board instead of silently dropping its cards', async () => {
    deckDocumentValue = {
      name: 'Keeper test deck',
      isPrivate: false,
      boards: {
        mainboard: { count: 3 },
        commanders: { cards: { 'commander-0': counterLine(1) } },
      },
    };
    const result = await sourceImports.stageSourceImport(alice, {
      format: 'moxfield',
      url: deckUrl,
    });

    expect(result.rows.map((row) => row.outcome)).toEqual(['invalid', 'staged']);
    expect(result.rows[0]).toMatchObject({
      line: null,
      entryId: null,
      problem: expect.stringContaining('mainboard'),
    });
    expect(result.rows[1]).toMatchObject({ line: { section: 'commanders' } });
    expect(result.staged).toBe(1);
  });

  it('reads top-level boards and reports an unreadable one', async () => {
    deckDocumentValue = {
      name: 'Keeper test deck',
      mainboard: ['not a board'],
      commanders: { cards: { 'commander-0': counterLine(1) } },
    };
    const result = await sourceImports.stageSourceImport(alice, {
      format: 'moxfield',
      url: deckUrl,
    });

    expect(result.rows.map((row) => row.outcome)).toEqual(['invalid', 'staged']);
    expect(result.rows[0]?.problem).toContain('mainboard');
    expect(result.staged).toBe(1);
  });

  it('keeps a reviewed Wizards list with its official source reference', async () => {
    const reference = 'https://magic.wizards.com/en/news/feature/deadly-disguise-decklist';
    const result = await sourceImports.stageSourceImport(alice, {
      format: 'wizards-precon',
      sourceId: 'wizards:mkm:deadly-disguise:regular:en',
      reference,
      entries: [
        { name: 'Kadena, Slinking Sorcerer', quantity: 1, section: 'commanders', finish: 'foil' },
        { name: 'Forest', quantity: 10, set: 'mkm', collectorNumber: '278' },
        { name: '', quantity: 1 },
      ],
    });

    expect(result.session).toMatchObject({
      sourceKind: 'wizards-precon',
      sourceId: 'wizards:mkm:deadly-disguise:regular:en',
      sourceReference: reference,
    });
    expect(result.rows.map((row) => row.outcome)).toEqual(['staged', 'staged', 'invalid']);
    expect(result.rows[0]?.line).toMatchObject({
      section: 'commanders',
      finish: 'foil',
      declaredQuantity: 1,
      problem: 'The source named no printing; choose one during review.',
    });
    expect(result.rows[1]?.line).toMatchObject({ set: 'mkm', collectorNumber: '278' });
    expect(result.staged).toBe(2);
  });

  it('reports unsupported input and unreadable sources as explicit failures', async () => {
    const unsupported = await captureUserCardsError(
      sourceImports.stageSourceImport(alice, callerInput({ format: 'archidekt', url: deckUrl })),
    );
    expect(unsupported.code).toBe('invalid-request');

    const unreadablePaste = await captureUserCardsError(
      sourceImports.stageSourceImport(alice, {
        format: 'pasted-list',
        sourceId: 'paste-1',
        text: 'this is not a card list',
      }),
    );
    expect(unreadablePaste.code).toBe('invalid-request');

    const nonOfficialReference = await captureUserCardsError(
      sourceImports.stageSourceImport(alice, {
        format: 'wizards-precon',
        sourceId: 'wizards:mkm:deadly-disguise:regular:en',
        reference: 'https://example.com/decklist',
        entries: [{ name: 'Forest', quantity: 1 }],
      }),
    );
    expect(nonOfficialReference.code).toBe('invalid-request');

    const oversized = await captureUserCardsError(
      sourceImports.stageSourceImport(alice, {
        format: 'pasted-list',
        sourceId: 'paste-1',
        text: Array.from({ length: 501 }, () => '1 Forest').join('\n'),
      }),
    );
    expect(oversized.code).toBe('invalid-request');

    deckFailure = new Error('moxfield is unavailable');
    const unavailable = await captureUserCardsError(stageDeck());
    expect(unavailable.code).toBe('unavailable');
    expect(await countCopies(database, alice.accountId)).toBe(0);
  });

  it('stages nothing when a source is imported again and adds nothing twice', async () => {
    const first = await stageDeck({ mainboard: [boltLine(2), counterLine(1)] });
    expect(first.staged).toBe(2);

    // A re-import of the same source while its lines are pending adds no second pending entry.
    const pendingAgain = await stageDeck({ mainboard: [boltLine(2), counterLine(1)] });
    expect(pendingAgain.session.sessionId).toBe(first.session.sessionId);
    expect(pendingAgain.staged).toBe(0);
    expect(pendingAgain.rows.map((row) => row.outcome)).toEqual(['pending', 'pending']);
    expect(pendingAgain.rows[0]?.entryId).toBe(first.rows[0]?.entryId);

    await confirmSession(first.session.sessionId, 'operation-1');
    expect(await countCopies(database, alice.accountId)).toBe(3);

    const acquiredAgain = await stageDeck({ mainboard: [boltLine(2), counterLine(1)] });
    expect(acquiredAgain.staged).toBe(0);
    expect(acquiredAgain.rows.map((row) => row.outcome)).toEqual(['acquired', 'acquired']);
    expect(acquiredAgain.session).toMatchObject({ confirmedEntries: 2, pendingEntries: 0 });
    expect(await countCopies(database, alice.accountId)).toBe(3);
  });

  it('stages only the unacquired difference when a source line quantity grows', async () => {
    const first = await stageDeck({ mainboard: [boltLine(2)] });
    await confirmSession(first.session.sessionId, 'operation-1');
    expect(await countCopies(database, alice.accountId)).toBe(2);

    const grown = await stageDeck({ mainboard: [boltLine(4)] });
    expect(grown.session.sessionId).toBe(first.session.sessionId);
    expect(grown.staged).toBe(1);
    expect(grown.rows[0]).toMatchObject({
      outcome: 'staged',
      line: { declaredQuantity: 4 },
      sessionId: first.session.sessionId,
    });

    const pending = await userCards.listImportEntries(alice, {
      sessionId: first.session.sessionId,
    });
    expect(pending.entries.map((entry) => entry.quantity)).toEqual([2]);
    await confirmSession(first.session.sessionId, 'operation-2');
    expect(await countCopies(database, alice.accountId)).toBe(4);

    const unchanged = await stageDeck({ mainboard: [boltLine(4)] });
    expect(unchanged.staged).toBe(0);
    expect(unchanged.rows.map((row) => row.outcome)).toEqual(['acquired']);
    expect(await countCopies(database, alice.accountId)).toBe(4);
  });

  it('never removes or reduces ownership when the source loses or shrinks a line', async () => {
    const first = await stageDeck({ mainboard: [boltLine(2), counterLine(1)] });
    await confirmSession(first.session.sessionId, 'operation-1');
    expect(await countCopies(database, alice.accountId)).toBe(3);

    // The source now asks for fewer Lightning Bolts and no longer lists the Counterspell at all.
    const reduced = await stageDeck({ mainboard: [boltLine(1)] });
    expect(reduced.staged).toBe(0);
    expect(reduced.rows.map((row) => row.outcome)).toEqual(['acquired']);
    expect(await countCopies(database, alice.accountId)).toBe(3);
  });

  it('keeps duplicate lines of one source distinct across repeated imports', async () => {
    const first = await stageDeck({ mainboard: [boltLine(1), boltLine(1)] });
    await confirmSession(first.session.sessionId, 'operation-1');
    expect(await countCopies(database, alice.accountId)).toBe(2);

    const repeated = await stageDeck({ mainboard: [boltLine(1), boltLine(1)] });
    expect(repeated.staged).toBe(0);
    expect(repeated.rows.map((row) => row.outcome)).toEqual(['acquired', 'acquired']);
    expect(await countCopies(database, alice.accountId)).toBe(2);
  });

  it('reconciles equal-content rows together when their order changes or a row is removed', async () => {
    const first = await stageDeck({ mainboard: [boltLine(1), boltLine(3)] });
    expect(first.staged).toBe(2);
    expect(first.rows.map((row) => row.outcome)).toEqual(['staged', 'staged']);
    expect(
      (
        await userCards.listImportEntries(alice, { sessionId: first.session.sessionId })
      ).entries.map((entry) => entry.quantity),
    ).toEqual([1, 3]);

    // The same two rows in the other order stage nothing while their quantities are pending.
    const reorderedPending = await stageDeck({ mainboard: [boltLine(3), boltLine(1)] });
    expect(reorderedPending.staged).toBe(0);
    expect(reorderedPending.rows.map((row) => row.outcome)).toEqual(['pending', 'pending']);

    await confirmSession(first.session.sessionId, 'operation-1');
    expect(await countCopies(database, alice.accountId)).toBe(4);

    // Reordering an unchanged source adds no acquisition, and removing the earlier row does not
    // hand the quantity it covered to the remaining row.
    const reordered = await stageDeck({ mainboard: [boltLine(3), boltLine(1)] });
    expect(reordered.staged).toBe(0);
    expect(reordered.rows.map((row) => row.outcome)).toEqual(['acquired', 'acquired']);
    const removed = await stageDeck({ mainboard: [boltLine(3)] });
    expect(removed.staged).toBe(0);
    expect(removed.rows.map((row) => row.outcome)).toEqual(['acquired']);
    expect(await countCopies(database, alice.accountId)).toBe(4);
  });

  it('keeps a pasted list with unequal duplicate lines stable when it is reordered or trimmed', async () => {
    const paste = (lines: readonly string[]) => ({
      format: 'pasted-list' as const,
      sourceId: 'paste-duplicates',
      text: lines.join('\n'),
    });
    const first = await sourceImports.stageSourceImport(
      alice,
      paste(['1 Lightning Bolt', '3 Lightning Bolt']),
    );
    expect(first.staged).toBe(2);

    const reordered = await sourceImports.stageSourceImport(
      alice,
      paste(['3 Lightning Bolt', '1 Lightning Bolt']),
    );
    expect(reordered.staged).toBe(0);
    expect(reordered.rows.map((row) => row.outcome)).toEqual(['pending', 'pending']);

    // A pasted line names no printing, so it is reviewed before it can become copies.
    const stagedLines = await userCards.listImportEntries(alice, {
      sessionId: first.session.sessionId,
    });
    for (const entry of stagedLines.entries) {
      await userCards.reviewImportEntry(alice, {
        entryId: entry.entryId,
        expectedRevision: entry.revision,
        printingId: m11Printing.printingId,
        finish: 'nonfoil',
        condition: null,
        quantity: entry.quantity,
      });
    }
    await confirmSession(first.session.sessionId, 'operation-1');
    expect(await countCopies(database, alice.accountId)).toBe(4);

    const trimmed = await sourceImports.stageSourceImport(alice, paste(['3 Lightning Bolt']));
    expect(trimmed.staged).toBe(0);
    expect(trimmed.rows.map((row) => row.outcome)).toEqual(['acquired']);
    expect(await countCopies(database, alice.accountId)).toBe(4);
  });

  it('stages only the uncovered quantity of a duplicate group when one row is discarded', async () => {
    const first = await stageDeck({ mainboard: [boltLine(1), boltLine(3)] });
    const discarded = first.rows[1]?.entryId as string;
    await userCards.discardImportEntry(alice, { entryId: discarded, expectedRevision: 1 });

    const again = await stageDeck({ mainboard: [boltLine(1), boltLine(3)] });
    expect(again.rows.map((row) => row.outcome)).toEqual(['pending', 'staged']);
    expect(again.staged).toBe(1);
    expect(again.rows[1]?.entryId).not.toBe(discarded);
    expect(
      (
        await userCards.listImportEntries(alice, { sessionId: first.session.sessionId })
      ).entries.map((entry) => entry.quantity),
    ).toEqual([1, 3]);
  });

  it('recognizes an unresolved line after review resolved and confirmed it', async () => {
    const staged = await sourceImports.stageSourceImport(alice, {
      format: 'pasted-list',
      sourceId: 'paste-1',
      text: '4 Lightning Bolt',
    });
    const entryId = staged.rows[0]?.entryId;
    expect(entryId).not.toBeNull();

    await userCards.reviewImportEntry(alice, {
      entryId: entryId as string,
      expectedRevision: 1,
      printingId: m11Printing.printingId,
      finish: 'foil',
      condition: 'LP',
      quantity: 4,
    });
    // The reviewed values replace the entry's copy data; the published source line stays beside them.
    const reviewed = await userCards.listImportEntries(alice, {
      sessionId: staged.session.sessionId,
    });
    expect(reviewed.entries[0]).toMatchObject({
      printingId: m11Printing.printingId,
      finish: 'foil',
      condition: 'LP',
      quantity: 4,
      sourceLine: { name: 'Lightning Bolt', declaredQuantity: 4, problem: expect.any(String) },
    });

    const confirmation = await confirmSession(staged.session.sessionId, 'operation-1');
    expect(confirmation.copies).toHaveLength(4);
    expect(confirmation.sourceKind).toBe('pasted-list');
    expect(confirmation.sourceId).toBe('paste-1');

    const repeated = await sourceImports.stageSourceImport(alice, {
      format: 'pasted-list',
      sourceId: 'paste-1',
      text: '4 Lightning Bolt',
    });
    expect(repeated.session.sessionId).toBe(staged.session.sessionId);
    expect(repeated.staged).toBe(0);
    expect(repeated.rows.map((row) => row.outcome)).toEqual(['acquired']);
    expect(await countCopies(database, alice.accountId)).toBe(4);
  });

  it('stages a discarded line again so a repeated import stays recoverable', async () => {
    const first = await stageDeck({ mainboard: [boltLine(2)] });
    const entryId = first.rows[0]?.entryId as string;
    await userCards.discardImportEntry(alice, { entryId, expectedRevision: 1 });

    const again = await stageDeck({ mainboard: [boltLine(2)] });
    expect(again.staged).toBe(1);
    expect(again.rows.map((row) => row.outcome)).toEqual(['staged']);
    expect(again.rows[0]?.entryId).not.toBe(entryId);
  });

  it('stages the largest supported source within the deployed statement bound', async () => {
    const bounded = createSourceImports({ sql: boundedTransport(database.sql), catalog });
    const text = Array.from(
      { length: 500 },
      (_, index) => `1 Lightning Bolt (M11) ${index + 1}`,
    ).join('\n');

    const result = await bounded.stageSourceImport(alice, {
      format: 'pasted-list',
      sourceId: 'paste-maximum',
      text,
    });
    expect(result.staged).toBe(500);
    expect(result.session).toMatchObject({ pendingEntries: 500 });

    // The maximum source reconciles a second time without staging any line again.
    const repeated = await bounded.stageSourceImport(alice, {
      format: 'pasted-list',
      sourceId: 'paste-maximum',
      text,
    });
    expect(repeated.staged).toBe(0);
    expect(repeated.rows.every((row) => row.outcome === 'pending')).toBe(true);
    expect(await countCopies(database, alice.accountId)).toBe(0);
  });

  it('keeps one account’s source lines out of another account’s reconciliation', async () => {
    const mine = await stageDeck({ mainboard: [boltLine(2)] });
    await confirmSession(mine.session.sessionId, 'operation-1');

    const otherAccount = await stageDeck({ mainboard: [boltLine(2)] }, bob);
    expect(otherAccount.session.sessionId).toBe(mine.session.sessionId);
    expect(otherAccount.staged).toBe(1);
    expect(otherAccount.rows.map((row) => row.outcome)).toEqual(['staged']);
    expect(await countCopies(database, bob.accountId)).toBe(0);
    expect(await countCopies(database, alice.accountId)).toBe(2);
  });
});
