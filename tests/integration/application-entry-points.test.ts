/**
 * Integration scope: the assembled Application over real PostgreSQL (docs/application.md#interface,
 * docs/application.md#configuration-and-lifecycle). Catalog is published through the finite job
 * entry point and read through the interactive transport; private copies are written and read for
 * two accounts; Search evaluates private criteria inside the scope Application binds from the
 * verified identity. The transport wire format is the contract the browser client consumes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createPostgresApplication, type Application } from '../../src/application/backend.js';
import { catalogSchemaSql } from '../../src/catalog/index.js';
import { SEARCH_ACCOUNT_SCOPE_SQL, searchSchemaSql } from '../../src/search/index.js';
import { usercardsSchemaSql } from '../../src/usercards/index.js';
import { claimsFor, testConfiguration, testIdentityVerifier } from '../support/application.js';
import { createSnapshotSource } from '../support/catalog-snapshot.js';
import { createTestDatabase, type TestDatabase } from '../support/postgres-database.js';

const bolt = {
  object: 'card',
  id: 'printing-tle-32-en',
  oracle_id: 'oracle-lightning-bolt',
  name: 'Lightning Bolt',
  lang: 'en',
  set: 'tle',
  collector_number: '32',
  finishes: ['nonfoil', 'foil'],
  nonfoil: true,
  foil: true,
  etched: false,
  digital: false,
  oracle_text: 'Lightning Bolt deals 3 damage to any target.',
  type_line: 'Instant',
  colors: ['R'],
  color_identity: ['R'],
  cmc: 1,
  image_uris: {
    small: 'https://images.example.test/tle-32-small.jpg',
    normal: 'https://images.example.test/tle-32-normal.jpg',
    large: 'https://images.example.test/tle-32-large.jpg',
    art_crop: 'https://images.example.test/tle-32-art.jpg',
  },
};

const translatedBolt = {
  ...bolt,
  id: 'printing-tle-32-es',
  printed_name: 'Relámpago',
  lang: 'es',
};

const counterspell = {
  object: 'card',
  id: 'printing-tle-33-en',
  oracle_id: 'oracle-counterspell',
  name: 'Counterspell',
  lang: 'en',
  set: 'tle',
  collector_number: '33',
  finishes: ['nonfoil'],
  nonfoil: true,
  foil: false,
  etched: false,
  digital: false,
  oracle_text: 'Counter target spell.',
  type_line: 'Instant',
  colors: ['U'],
  color_identity: ['U'],
  cmc: 2,
  image_uris: {
    small: 'https://images.example.test/tle-33-small.jpg',
    normal: 'https://images.example.test/tle-33-normal.jpg',
    large: 'https://images.example.test/tle-33-large.jpg',
    art_crop: 'https://images.example.test/tle-33-art.jpg',
  },
};

const sourceVersion = '2026-09-01T00:00:00.000Z';

describe('application entry points', () => {
  let database: TestDatabase;
  let application: Application;

  beforeEach(async () => {
    database = await createTestDatabase(
      `${catalogSchemaSql}\n\n${usercardsSchemaSql}\n\n${searchSchemaSql}`,
    );
    application = createPostgresApplication({
      configuration: testConfiguration(),
      identity: testIdentityVerifier(),
      resources: {
        readSql: database.sql,
        searchSql: database.sql,
        writeSql: database.sql,
        catalogSynchronization: {
          sql: database.sql,
          snapshots: createSnapshotSource({
            default_cards: { sourceVersion, records: [bolt, translatedBolt, counterspell] },
          }),
        },
        searchIndexing: {
          sql: database.sql,
          catalogPublicationSql: database.sql,
          userCardsPublicationSql: database.sql,
        },
        deckSource: null,
      },
    });
  });

  afterEach(async () => {
    await database.close();
  });

  async function call(request: {
    readonly method: string;
    readonly path: string;
    readonly query?: Readonly<Record<string, string>>;
    readonly accountId?: string;
    readonly claims?: Readonly<Record<string, unknown>>;
    readonly body?: unknown;
  }): Promise<{ readonly status: number; readonly payload: unknown }> {
    const response = await application.handle({
      method: request.method,
      path: request.path,
      ...(request.query === undefined ? {} : { query: request.query }),
      ...(request.claims === undefined
        ? request.accountId === undefined
          ? {}
          : { authentication: { claims: claimsFor(request.accountId) } }
        : { authentication: { claims: request.claims } }),
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      requestId: 'integration-request',
    });
    return { status: response.status, payload: JSON.parse(response.body) as unknown };
  }

  /** Publishes the fixture through the finite job entry point, as the deployed task does. */
  async function publishCatalog(): Promise<void> {
    await application.synchronizeCatalog({ dataset: 'default_cards' });
  }

  it('publishes the catalog through the job entry point and reads it through the transport', async () => {
    const revision = await application.synchronizeCatalog({ dataset: 'default_cards' });
    expect(revision.sourceVersion).toBe(sourceVersion);

    const resolved = await call({
      method: 'POST',
      path: '/api/catalog/resolve',
      body: {
        references: [
          { kind: 'card', cardId: 'oracle-lightning-bolt' },
          { kind: 'printing', printingId: 'printing-tle-32-es' },
        ],
      },
    });

    expect(resolved.status).toBe(200);
    const resolution = resolved.payload as {
      readonly revision: { readonly revisionId: string };
      readonly cards: readonly { readonly cardId: string }[];
      readonly printings: readonly { readonly printingId: string }[];
      readonly missing: readonly unknown[];
    };
    expect(resolution.revision.revisionId).toBe(revision.revisionId);
    expect(resolution.cards.map((card) => card.cardId)).toEqual(['oracle-lightning-bolt']);
    expect(resolution.printings.map((printing) => printing.printingId)).toEqual([
      'printing-tle-32-es',
    ]);
    expect(resolution.missing).toEqual([]);

    const printings = await call({
      method: 'GET',
      path: '/api/catalog/cards/oracle-lightning-bolt/printings',
    });
    expect(printings.status).toBe(200);
    expect(
      (printings.payload as { readonly printings: readonly unknown[] }).printings,
    ).toHaveLength(2);
  });

  it('answers the preserved recognition envelopes from the published catalog', async () => {
    await publishCatalog();

    const hydrated = await call({
      method: 'GET',
      path: '/api/card',
      query: { printing: 'printing-tle-32-en', oracle: 'oracle-lightning-bolt' },
    });
    expect(hydrated.status).toBe(200);
    expect((hydrated.payload as { readonly cards: readonly unknown[] }).cards).toEqual([
      {
        id: 'printing-tle-32-en',
        oracle_id: 'oracle-lightning-bolt',
        name: 'Lightning Bolt',
        set: 'tle',
        collector_number: '32',
        lang: 'en',
        finishes: ['nonfoil', 'foil'],
      },
    ]);

    const translated = await call({
      method: 'GET',
      path: '/api/search',
      query: { q: 'oracleid:oracle-lightning-bolt set:tle cn:32 lang:es' },
    });
    expect(translated.status).toBe(200);
    expect(
      (translated.payload as { readonly cards: readonly { readonly lang: string }[] }).cards,
    ).toEqual([
      expect.objectContaining({
        id: 'printing-tle-32-es',
        oracle_id: 'oracle-lightning-bolt',
        set: 'tle',
        collector_number: '32',
        lang: 'es',
      }),
    ]);

    const unsupported = await call({
      method: 'GET',
      path: '/api/search',
      query: { q: 'name:lightning' },
    });
    expect(unsupported.status).toBe(400);
    expect((unsupported.payload as { readonly error: { readonly code: string } }).error.code).toBe(
      'unsupported-query',
    );
  });

  it('stores private copies for the verified account and keeps another account out', async () => {
    await publishCatalog();

    const created = await call({
      method: 'POST',
      path: '/api/collection/copies',
      accountId: 'cognito-alice',
      // A caller-supplied owner never decides the account.
      body: {
        printingId: 'printing-tle-32-en',
        finish: 'nonfoil',
        condition: 'NM',
        quantity: 2,
        ownerId: 'cognito-bob',
      },
    });
    expect(created.status).toBe(200);
    const copyIds = (
      created.payload as { readonly copies: readonly { readonly copyId: string }[] }
    ).copies.map((copy) => copy.copyId);
    expect(copyIds).toHaveLength(2);

    const alice = await call({
      method: 'POST',
      path: '/api/collection/copies/read',
      accountId: 'cognito-alice',
      body: { copyIds },
    });
    expect(alice.status).toBe(200);
    expect((alice.payload as { readonly copies: readonly unknown[] }).copies).toHaveLength(2);

    const bob = await call({
      method: 'POST',
      path: '/api/collection/copies/read',
      accountId: 'cognito-bob',
      body: { copyIds },
    });
    expect(bob.status).toBe(200);
    expect((bob.payload as { readonly copies: readonly unknown[] }).copies).toEqual([]);
    expect((bob.payload as { readonly missing: readonly string[] }).missing).toEqual(copyIds);

    const withoutIdentity = await call({
      method: 'POST',
      path: '/api/collection/copies/read',
      body: { copyIds },
    });
    expect(withoutIdentity.status).toBe(401);
  });

  it('evaluates a private search inside the scope of the verified account', async () => {
    await publishCatalog();
    await call({
      method: 'POST',
      path: '/api/collection/copies',
      accountId: 'cognito-alice',
      body: {
        printingId: 'printing-tle-32-en',
        finish: 'foil',
        condition: null,
        quantity: 3,
      },
    });
    // Search answers from its own projection; the write becomes visible through its job entry point.
    await application.indexSearch({ accounts: ['cognito-alice', 'cognito-bob'] });
    const ownedQuery = { resultLevel: 'card', criteria: [{ kind: 'owned' }] };

    const alice = await call({
      method: 'POST',
      path: '/api/search',
      accountId: 'cognito-alice',
      body: ownedQuery,
    });
    expect(alice.status).toBe(200);
    const alicePage = alice.payload as {
      readonly entries: readonly {
        readonly card: { readonly cardId: string };
        readonly quantity: { readonly copies: number | null } | null;
      }[];
    };
    expect(alicePage.entries).toHaveLength(1);
    expect(alicePage.entries[0]?.card.cardId).toBe('oracle-lightning-bolt');
    expect(alicePage.entries[0]?.quantity?.copies).toBe(3);

    const bob = await call({
      method: 'POST',
      path: '/api/search',
      accountId: 'cognito-bob',
      body: ownedQuery,
    });
    expect(bob.status).toBe(200);
    expect((bob.payload as { readonly entries: readonly unknown[] }).entries).toEqual([]);

    const anonymous = await call({ method: 'POST', path: '/api/search', body: ownedQuery });
    expect(anonymous.status).toBe(401);
  });

  it('indexes Search through its job entry point over the published component contracts', async () => {
    await publishCatalog();
    await call({
      method: 'POST',
      path: '/api/collection/copies',
      accountId: 'cognito-alice',
      body: {
        printingId: 'printing-tle-32-en',
        finish: 'nonfoil',
        condition: 'NM',
        quantity: 2,
      },
    });

    const result = await application.indexSearch({ accounts: ['cognito-alice'] });

    expect(result).toMatchObject({
      published: true,
      rebuilt: true,
      caughtUp: true,
      unresolvedReferences: 0,
    });
    expect(await database.query('select card_id from search.cards order by card_id')).toEqual([
      { card_id: 'oracle-counterspell' },
      { card_id: 'oracle-lightning-bolt' },
    ]);
    expect(
      await database.query('select account_id, position from search_private.account_checkpoint'),
    ).toEqual([{ account_id: 'cognito-alice', position: expect.any(String) }]);
    // The private projection is bound to the account, as the query surface is.
    const copies = await database.sql.transaction(async (statements) => {
      await statements.query(SEARCH_ACCOUNT_SCOPE_SQL, { account_id: 'cognito-alice' });
      return await statements.query('select copy_id from search.copies');
    });
    expect(copies).toHaveLength(2);
  });

  it('rejects an identity of another environment before any private write', async () => {
    await publishCatalog();
    const before = await call({
      method: 'POST',
      path: '/api/collection/copies/read',
      accountId: 'cognito-alice',
      body: { copyIds: ['copy-1'] },
    });

    const rejected = await call({
      method: 'POST',
      path: '/api/collection/copies',
      claims: claimsFor('cognito-alice', {
        iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_production',
      }),
      body: {
        printingId: 'printing-tle-32-en',
        finish: 'nonfoil',
        condition: null,
        quantity: 1,
      },
    });

    expect(rejected.status).toBe(401);
    const after = await call({
      method: 'POST',
      path: '/api/collection/copies/read',
      accountId: 'cognito-alice',
      body: { copyIds: ['copy-1'] },
    });
    expect(after.payload).toEqual(before.payload);
  });

  it('reports a missing printing reference as a missing record', async () => {
    await publishCatalog();

    const response = await call({
      method: 'POST',
      path: '/api/collection/copies',
      accountId: 'cognito-alice',
      body: {
        printingId: 'printing-not-published',
        finish: 'nonfoil',
        condition: null,
        quantity: 1,
      },
    });

    expect(response.status).toBe(404);
    expect((response.payload as { readonly error: { readonly code: string } }).error.code).toBe(
      'not-found',
    );
  });

  it('reports a revision conflict when a correction quotes a stale revision', async () => {
    await publishCatalog();
    const created = await call({
      method: 'POST',
      path: '/api/collection/copies',
      accountId: 'cognito-alice',
      body: {
        printingId: 'printing-tle-32-en',
        finish: 'nonfoil',
        condition: null,
        quantity: 1,
      },
    });
    const copy = (
      created.payload as {
        readonly copies: readonly { readonly copyId: string; readonly revision: number }[];
      }
    ).copies[0];
    expect(copy).toBeDefined();
    const correction = {
      expectedRevision: copy?.revision,
      printingId: 'printing-tle-32-es',
      finish: 'foil',
      condition: 'NM',
    };

    const corrected = await call({
      method: 'POST',
      path: `/api/collection/copies/${copy?.copyId}/corrections`,
      accountId: 'cognito-alice',
      body: correction,
    });
    expect(corrected.status).toBe(200);

    const conflicted = await call({
      method: 'POST',
      path: `/api/collection/copies/${copy?.copyId}/corrections`,
      accountId: 'cognito-alice',
      body: correction,
    });

    expect(conflicted.status).toBe(409);
    expect((conflicted.payload as { readonly error: { readonly code: string } }).error.code).toBe(
      'conflict',
    );
  });

  it('requires restarting a search whose continuation became stale', async () => {
    await publishCatalog();
    for (const printingId of ['printing-tle-32-en', 'printing-tle-33-en']) {
      await call({
        method: 'POST',
        path: '/api/collection/copies',
        accountId: 'cognito-alice',
        body: { printingId, finish: 'nonfoil', condition: null, quantity: 1 },
      });
    }
    await application.indexSearch({ accounts: ['cognito-alice'] });
    const query = {
      resultLevel: 'card',
      criteria: [{ kind: 'owned' }],
      pageSize: 1,
    };
    const first = await call({
      method: 'POST',
      path: '/api/search',
      accountId: 'cognito-alice',
      body: query,
    });
    expect(first.status).toBe(200);
    const continuation = (first.payload as { readonly continuation: string | null }).continuation;
    expect(continuation).toBeTruthy();

    await call({
      method: 'POST',
      path: '/api/collection/copies',
      accountId: 'cognito-alice',
      body: {
        printingId: 'printing-tle-33-en',
        finish: 'nonfoil',
        condition: null,
        quantity: 1,
      },
    });
    await application.indexSearch({ accounts: ['cognito-alice'] });

    const resumed = await call({
      method: 'POST',
      path: '/api/search',
      accountId: 'cognito-alice',
      body: { ...query, continuation },
    });

    expect(resumed.status).toBe(409);
    expect((resumed.payload as { readonly error: { readonly code: string } }).error.code).toBe(
      'stale-continuation',
    );
  });

  it('parses a pasted source through the transport and keeps its import identity', async () => {
    interface SourcePayload {
      readonly session: {
        readonly sessionId: string;
        readonly sourceKind: string;
        readonly pendingEntries: number;
      };
      readonly rows: readonly { readonly outcome: string; readonly problem: string | null }[];
      readonly staged: number;
    }

    // The browser identifies the import it composes, so the same identity stages the same list
    // again and a new identity stages another one (docs/user-cards.md#import-state-and-identity).
    const text = '2 Lightning Bolt (TLE) 32\nnot a line';
    const first = await call({
      method: 'POST',
      path: '/api/collection/imports/sources',
      accountId: 'cognito-alice',
      body: { format: 'pasted-list', sessionId: 'wishlist-paste', text },
    });

    expect(first.status).toBe(200);
    const staged = first.payload as SourcePayload;
    expect(staged.session).toMatchObject({
      sessionId: 'wishlist-paste',
      sourceKind: 'pasted-list',
      pendingEntries: 1,
    });
    expect(staged.staged).toBe(1);
    expect(staged.rows.map((row) => row.outcome)).toEqual(['staged', 'invalid']);
    expect(staged.rows[1]?.problem).toBe(
      'Use “quantity card name”, optionally followed by “(SET) number”.',
    );

    const repeated = await call({
      method: 'POST',
      path: '/api/collection/imports/sources',
      accountId: 'cognito-alice',
      body: { format: 'pasted-list', sessionId: 'wishlist-paste', text },
    });

    expect(repeated.status).toBe(200);
    const again = repeated.payload as SourcePayload;
    expect(again.session.sessionId).toBe(staged.session.sessionId);
    expect(again.session.pendingEntries).toBe(1);
    expect(again.staged).toBe(0);
    expect(again.rows.map((row) => row.outcome)).toEqual(['pending', 'invalid']);

    // Another import of the same text is a list of its own instead of merging with this one.
    const other = await call({
      method: 'POST',
      path: '/api/collection/imports/sources',
      accountId: 'cognito-alice',
      body: { format: 'pasted-list', sessionId: 'second-paste', text },
    });

    expect(other.status).toBe(200);
    const another = other.payload as SourcePayload;
    expect(another.session.sessionId).toBe('second-paste');
    expect(another.session.pendingEntries).toBe(1);
    expect(another.staged).toBe(1);
    expect(another.rows.map((row) => row.outcome)).toEqual(['staged', 'invalid']);
  });
});
