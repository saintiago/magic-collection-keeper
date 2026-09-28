/**
 * Component scope: two indexing runs over one projection storage
 * (docs/data-architecture.md#asynchronous-synchronization, docs/testing.md#search). PGlite serves
 * a single connection, so these interleavings run against a real PostgreSQL server: a run is held
 * while it read an older position or the generation state, a later run applies newer changes or
 * replaces that generation, and the older run then finishes. It must not overwrite newer data,
 * move a checkpoint backwards, or write into a generation that is no longer current.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type {
  CatalogChange,
  CatalogPublication,
  CatalogPublishedRecord,
  CatalogRevision,
} from '../../../src/catalog/index.js';
import {
  createSearchIndexer,
  SEARCH_ACCOUNT_SCOPE_SQL,
  searchSchemaSql,
  type SearchIndexer,
} from '../../../src/search/index.js';
import type {
  UserCardsChange,
  UserCardsPublication,
  UserCardsPublishedRecord,
  UserCardsSqlTransactor,
} from '../../../src/usercards/index.js';
import {
  createCatalogPublicationFixture,
  createUserCardsPublicationFixture,
  type CatalogPublicationFixture,
  type UserCardsPublicationFixture,
} from '../../support/search-publications.js';
import {
  startPostgresServer,
  type PostgresConnection,
  type PostgresServer,
} from '../../support/postgres-server.js';

const accountId = 'cognito-alice';

function revision(revisionId: string): CatalogRevision {
  return {
    revisionId,
    sourceName: 'scryfall',
    sourceVersion: `snapshot-${revisionId}`,
    publishedAt: '2026-09-28T10:00:00.000Z',
  };
}

function boltCard(name: string): CatalogPublishedRecord {
  return {
    kind: 'card',
    card: {
      cardId: 'oracle-bolt',
      name,
      rulesText: 'Lightning Bolt deals 3 damage to any target.',
      typeLine: 'Instant',
      colors: ['R'],
      colorIdentity: ['R'],
      manaValue: 1,
    },
  };
}

const boltName: CatalogPublishedRecord = {
  kind: 'card-name',
  name: { cardId: 'oracle-bolt', language: 'en', name: 'Lightning Bolt' },
};

const m11Printing: CatalogPublishedRecord = {
  kind: 'printing',
  printing: {
    printingId: 'printing-m11-149-en',
    cardId: 'oracle-bolt',
    edition: 'M11',
    collectorNumber: '149',
    language: 'en',
    finishes: ['nonfoil', 'foil'],
    physical: true,
    images: { small: null, normal: null, large: null, artCrop: null },
  },
};

const binderTag: UserCardsPublishedRecord = {
  kind: 'tag',
  tag: { tagId: 'tag-binder', kind: 'location', label: 'Binder', system: false },
};

/** One published copy of the printing, in the location the case names. */
function boltCopy(locationId: string | null): Extract<UserCardsPublishedRecord, { kind: 'copy' }> {
  return {
    kind: 'copy',
    copy: {
      copyId: 'copy-alice-1',
      printingId: 'printing-m11-149-en',
      finish: 'nonfoil',
      condition: 'NM',
      owned: true,
      locationId,
    },
  };
}

/** One catalog change of the single card these cases publish. */
function cardChange(position: string, revisionId: string, name: string): CatalogChange {
  return {
    kind: 'card',
    position,
    revisionId,
    reference: { kind: 'card', cardId: 'oracle-bolt' },
    removed: false,
    record: boltCard(name),
  };
}

function catalogRevisionChange(position: string, revisionId: string): CatalogChange {
  return { kind: 'revision', position, revision: revision(revisionId) };
}

function copyChange(
  position: string,
  accountRevision: string,
  record: UserCardsPublishedRecord,
): UserCardsChange {
  return {
    kind: 'copy',
    position,
    accountId,
    revision: accountRevision,
    reference: { kind: 'copy', copyId: 'copy-alice-1' },
    removed: false,
    record,
  };
}

function accountRevisionChange(position: string, accountRevision: string): UserCardsChange {
  return { kind: 'revision', position, accountId, revision: accountRevision };
}

/**
 * A hold one case places on a run: the run reports that it reached the hold and then waits until
 * the case releases it.
 */
interface Pause {
  readonly reached: Promise<void>;
  wait(): Promise<void>;
  markReached(): void;
  resume(): void;
}

function createPause(): Pause {
  let markReached = (): void => undefined;
  let resume = (): void => undefined;
  const reached = new Promise<void>((resolve) => {
    markReached = resolve;
  });
  const held = new Promise<void>((resolve) => {
    resume = resolve;
  });
  return {
    reached,
    wait: () => held,
    markReached: () => markReached(),
    resume: () => resume(),
  };
}

/** A catalog publication that holds its change read at `position` until the case releases it. */
function pausingCatalog(
  catalog: CatalogPublication,
  position: string,
  pause: Pause,
): CatalogPublication {
  let held = false;
  return {
    readSnapshot: (request) => catalog.readSnapshot(request),
    async readChanges(request) {
      const page = await catalog.readChanges(request);
      if (!held && request.position === position) {
        held = true;
        pause.markReached();
        await pause.wait();
      }
      return page;
    },
  };
}

/** A private publication that holds its change read at `position` until the case releases it. */
function pausingUserCards(
  userCards: UserCardsPublication,
  position: string,
  pause: Pause,
): UserCardsPublication {
  let held = false;
  return {
    readSnapshot: (request) => userCards.readSnapshot(request),
    async readChanges(request) {
      const page = await userCards.readChanges(request);
      if (!held && request.position === position) {
        held = true;
        pause.markReached();
        await pause.wait();
      }
      return page;
    },
  };
}

/**
 * A transactor that holds the first statement containing `marker` until the case releases it,
 * either before or after running that statement.
 */
function pausingTransactor(
  sql: UserCardsSqlTransactor,
  marker: string,
  pause: Pause,
  when: 'before' | 'after',
): UserCardsSqlTransactor {
  let held = false;
  return {
    async query(statement, parameters) {
      if (when === 'before' && !held && statement.includes(marker)) {
        held = true;
        pause.markReached();
        await pause.wait();
      }
      const rows = await sql.query(statement, parameters);
      if (when === 'after' && !held && statement.includes(marker)) {
        held = true;
        pause.markReached();
        await pause.wait();
      }
      return rows;
    },
    transaction: (work) => sql.transaction(work),
  };
}

describe('search indexing over overlapping runs', () => {
  let server: PostgresServer | undefined;
  let first: PostgresConnection | undefined;
  let second: PostgresConnection | undefined;
  let catalog: CatalogPublicationFixture;
  let alice: UserCardsPublicationFixture;
  let unavailable = '';

  beforeAll(async () => {
    try {
      server = await startPostgresServer(searchSchemaSql);
    } catch (cause) {
      unavailable = cause instanceof Error ? cause.message : String(cause);
      return;
    }
    first = await server.connect();
    second = await server.connect();
  }, 120_000);

  afterAll(async () => {
    await first?.close();
    await second?.close();
    await server?.close();
  }, 120_000);

  beforeEach(async () => {
    if (unavailable !== '') {
      return;
    }
    // Every case starts from its own projection; the providers stay supplied fixtures.
    await first?.query(
      'drop schema if exists search_private cascade; drop schema if exists search cascade',
    );
    await first?.query(searchSchemaSql);
    catalog = createCatalogPublicationFixture({
      revision: revision('revision-1'),
      position: '10',
      records: [boltCard('Lightning Bolt'), boltName, m11Printing],
    });
    alice = createUserCardsPublicationFixture({
      accountId,
      position: '4',
      records: [binderTag, boltCopy('tag-binder')],
    });
  });

  /** Indexer over one connection, optionally holding a statement or the publication's reads. */
  function indexerOn(
    connection: PostgresConnection,
    options: {
      readonly catalog?: CatalogPublication;
      readonly userCards?: UserCardsPublication;
      readonly holdStatement?: string;
      /** Whether the hold happens before or after the held statement runs; default after. */
      readonly holdWhen?: 'before' | 'after';
      readonly pause?: Pause;
    } = {},
  ): SearchIndexer {
    const sql =
      options.holdStatement === undefined || options.pause === undefined
        ? connection.transactor()
        : pausingTransactor(
            connection.transactor(),
            options.holdStatement,
            options.pause,
            options.holdWhen ?? 'after',
          );
    return createSearchIndexer({
      sql,
      catalog: options.catalog ?? catalog.publication,
      userCards: options.userCards ?? alice.publication,
    });
  }

  async function scopedCopies(connection: PostgresConnection) {
    return await connection.transactor().transaction(async (statements) => {
      await statements.query(SEARCH_ACCOUNT_SCOPE_SQL, { account_id: accountId });
      return await statements.query(
        'select copy_id, location_id from search.copies order by copy_id',
      );
    });
  }

  it('rejects the delayed older catalog run instead of overwriting newer changes', async (context) => {
    if (unavailable !== '') {
      context.skip(`A real PostgreSQL server is unavailable: ${unavailable}`);
      return;
    }
    if (first === undefined || second === undefined) {
      throw new Error('The two-connection harness was not opened.');
    }
    await indexerOn(first).index({ accounts: [accountId] });

    catalog.publish(
      cardChange('11', 'revision-2', 'Lightning Bolt (r2)'),
      catalogRevisionChange('12', 'revision-2'),
      cardChange('13', 'revision-3', 'Lightning Bolt (r3)'),
      catalogRevisionChange('14', 'revision-3'),
    );

    // The older run reads revision 2 at positions 11–12 and is held there.
    const pause = createPause();
    const older = indexerOn(second, {
      catalog: pausingCatalog(catalog.publication, '10', pause),
      pause,
    });
    // The older run applies one batch and returns, as a budget-limited run does.
    const olderRun = older.index({ accounts: [accountId], pageSize: 1, maxBatches: 1 });
    await pause.reached;

    // A newer run applies revision 3 through position 14 while the older one is held.
    const newer = await indexerOn(first).index({ accounts: [accountId], pageSize: 1 });
    expect(newer.catalog).toEqual({ position: '14', revisionId: 'revision-3', caughtUp: true });

    pause.resume();
    const resumed = await olderRun;

    expect(resumed.catalog).toEqual({ position: '14', revisionId: 'revision-3', caughtUp: true });
    expect(resumed.accounts).toEqual([{ accountId, position: '4', caughtUp: true }]);
    expect(await second.query('select name from search.cards')).toEqual([
      { name: 'Lightning Bolt (r3)' },
    ]);
    expect(
      await second.query('select position, revision_id from search_private.catalog_checkpoint'),
    ).toEqual([{ position: '14', revision_id: 'revision-3' }]);
  });

  it('rejects the delayed older private run instead of overwriting newer changes', async (context) => {
    if (unavailable !== '') {
      context.skip(`A real PostgreSQL server is unavailable: ${unavailable}`);
      return;
    }
    if (first === undefined || second === undefined) {
      throw new Error('The two-connection harness was not opened.');
    }
    await indexerOn(first).index({ accounts: [accountId] });

    alice.publish(
      copyChange('5', '2', boltCopy(null)),
      accountRevisionChange('6', '2'),
      copyChange('7', '3', boltCopy('tag-binder')),
      accountRevisionChange('8', '3'),
    );

    // The older run reads the account's revision 2 at positions 5–6 and is held there.
    const pause = createPause();
    const older = indexerOn(second, {
      userCards: pausingUserCards(alice.publication, '4', pause),
      pause,
    });
    const olderRun = older.index({ accounts: [accountId], pageSize: 1, maxBatches: 1 });
    await pause.reached;

    // A newer run applies the account's revision 3 through position 8 while the older one is held.
    const newer = await indexerOn(first).index({ accounts: [accountId], pageSize: 1 });
    expect(newer.accounts).toEqual([{ accountId, position: '8', caughtUp: true }]);

    pause.resume();
    const resumed = await olderRun;

    expect(resumed.accounts).toEqual([{ accountId, position: '8', caughtUp: true }]);
    expect(await scopedCopies(second)).toEqual([
      { copy_id: 'copy-alice-1', location_id: 'tag-binder' },
    ]);
    expect(
      await first.query('select account_id, position from search_private.account_checkpoint'),
    ).toEqual([{ account_id: accountId, position: '8' }]);
  });

  it.for(['catalog', 'private', 'account bootstrap'] as const)(
    'preserves concurrent served %s progress when publishing a replacement',
    async (kind, context) => {
      if (unavailable !== '') {
        context.skip(`A real PostgreSQL server is unavailable: ${unavailable}`);
        return;
      }
      if (first === undefined || second === undefined) {
        throw new Error('The two-connection harness was not opened.');
      }
      await indexerOn(first).index({ accounts: kind === 'private' ? [accountId] : [] });
      const serving = createPause();
      const rebuilding = createPause();
      const servedRun = indexerOn(first, {
        holdStatement: 'from search_private.generation',
        pause: serving,
      }).index({ accounts: kind === 'catalog' ? [] : [accountId] });
      await serving.reached;
      const rebuildRun = indexerOn(second, {
        holdStatement: ')::int as unresolved',
        pause: rebuilding,
      }).index({ rebuild: true });
      await rebuilding.reached;

      if (kind === 'catalog') {
        catalog.publish(
          cardChange('11', 'revision-2', 'Lightning Bolt (r2)'),
          catalogRevisionChange('12', 'revision-2'),
        );
      } else if (kind === 'private') {
        alice.publish(copyChange('5', '2', boltCopy(null)), accountRevisionChange('6', '2'));
      }
      serving.resume();
      const served = await servedRun.finally(() => rebuilding.resume());
      const replacement = await rebuildRun;

      expect(served).toMatchObject({ published: true, caughtUp: true });
      expect(replacement).toMatchObject({ published: true, caughtUp: true });
      expect(replacement.generation).not.toBe(served.generation);
      expect(replacement.catalog).toEqual(served.catalog);
      expect(replacement.accounts).toEqual(served.accounts);
      if (kind === 'catalog') {
        expect(await second.query('select name from search.cards')).toEqual([
          { name: 'Lightning Bolt (r2)' },
        ]);
      } else {
        expect(await scopedCopies(second)).toEqual([
          { copy_id: 'copy-alice-1', location_id: kind === 'private' ? null : 'tag-binder' },
        ]);
      }
    },
  );

  it('catches up an account another run added to the unfinished replacement', async (context) => {
    if (unavailable !== '') {
      context.skip(`A real PostgreSQL server is unavailable: ${unavailable}`);
      return;
    }
    if (first === undefined || second === undefined) {
      throw new Error('The two-connection harness was not opened.');
    }
    await indexerOn(first).index();
    const pause = createPause();
    const rebuildRun = indexerOn(second, {
      holdStatement: ')::int as unresolved',
      pause,
    }).index({ rebuild: true });
    await pause.reached;
    alice.publish(
      copyChange('5', '2', boltCopy(null)),
      accountRevisionChange('6', '2'),
      copyChange('7', '3', boltCopy('tag-binder')),
      accountRevisionChange('8', '3'),
    );
    const pending = await indexerOn(first)
      .index({ accounts: [accountId], pageSize: 1, maxBatches: 1 })
      .finally(() => pause.resume());
    const replacement = await rebuildRun;
    expect(pending).toMatchObject({ published: false, caughtUp: false });
    expect(pending.accounts).toEqual([{ accountId, position: '6', caughtUp: false }]);
    expect(replacement).toMatchObject({ published: true, caughtUp: true });
    expect(replacement.accounts).toEqual([{ accountId, position: '8', caughtUp: true }]);
    expect(await scopedCopies(second)).toEqual([
      { copy_id: 'copy-alice-1', location_id: 'tag-binder' },
    ]);
  });

  it.for(['incremental', 'snapshot'] as const)(
    'keeps references resolved when a private %s races a catalog removal',
    async (kind, context) => {
      if (unavailable !== '') {
        context.skip(`A real PostgreSQL server is unavailable: ${unavailable}`);
        return;
      }
      if (first === undefined || second === undefined || server === undefined) {
        throw new Error('The two-connection harness was not opened.');
      }
      const retainedPrinting: CatalogPublishedRecord = {
        ...m11Printing,
        printing: { ...m11Printing.printing, printingId: 'printing-retained' },
      };
      catalog.replaceSnapshot({
        revision: revision('revision-1'),
        position: '10',
        records: [boltCard('Lightning Bolt'), boltName, m11Printing, retainedPrinting],
      });
      alice.replaceSnapshot({ position: '0', records: [] });
      await indexerOn(first).index({ accounts: kind === 'incremental' ? [accountId] : [] });
      const inserted = boltCopy(null);
      if (kind === 'incremental') {
        alice.publish(copyChange('1', '1', inserted), accountRevisionChange('2', '1'));
      } else {
        alice.replaceSnapshot({ position: '2', records: [inserted] });
      }
      const pause = createPause();
      let privateWrite = false;
      let held = false;
      const privateIndexer = createSearchIndexer({
        sql: second.transactor({
          onStatement(statement) {
            if (statement.includes('insert into search_private.copy')) privateWrite = true;
          },
          async beforeCommit() {
            if (privateWrite && !held) {
              held = true;
              pause.markReached();
              await pause.wait();
            }
          },
        }),
        catalog: catalog.publication,
        userCards: alice.publication,
      });
      const privateRun = privateIndexer.index({ accounts: [accountId], maxBatches: 1 });
      await pause.reached;
      // The authoritative copy has already moved to a retained printing. The held transaction
      // still carries the earlier publication, so deleting its printing must wait for its commit.
      alice.publish(
        copyChange('3', '2', {
          ...inserted,
          copy: { ...inserted.copy, printingId: 'printing-retained' },
        }),
        accountRevisionChange('4', '2'),
      );
      catalog.publish(
        {
          kind: 'printing',
          position: '11',
          revisionId: 'revision-2',
          reference: { kind: 'printing', printingId: 'printing-m11-149-en' },
          removed: true,
          record: null,
        },
        catalogRevisionChange('12', 'revision-2'),
      );
      const [{ pid } = {}] = await first.query('select pg_backend_pid() as pid');
      const observer = await server.connect();
      let removalFinished = false;
      const removalRun = indexerOn(first)
        .index()
        .finally(() => {
          removalFinished = true;
        });
      try {
        // Observe actual lock contention, or the unsafe commit in the unfixed implementation.
        await expect
          .poll(async () => {
            const rows = await observer.query(
              'select cardinality(pg_blocking_pids($1::int)) > 0 as blocked',
              [pid],
            );
            return removalFinished || rows[0]?.blocked === true;
          })
          .toBe(true);
      } finally {
        pause.resume();
        await observer.close();
      }
      const [removal] = await Promise.all([removalRun, privateRun]);
      expect(removal.catalog).toEqual({
        position: '10',
        revisionId: 'revision-1',
        caughtUp: false,
      });
      expect(removal.unresolvedReferences).toBe(0);
      await indexerOn(first).index({ accounts: [accountId] });
      const complete = await indexerOn(first).index({ accounts: [accountId] });
      expect(complete).toMatchObject({ published: true, caughtUp: true, unresolvedReferences: 0 });
      expect(complete.catalog.position).toBe('12');
      expect(await first.query('select printing_id from search.printings')).toEqual([
        { printing_id: 'printing-retained' },
      ]);
    },
  );

  it('moves a run whose generation was replaced onto the current generation', async (context) => {
    if (unavailable !== '') {
      context.skip(`A real PostgreSQL server is unavailable: ${unavailable}`);
      return;
    }
    if (first === undefined || second === undefined) {
      throw new Error('The two-connection harness was not opened.');
    }
    const published = await indexerOn(first).index({ accounts: [accountId] });

    // The older run reads the generation state and is held there, holding no lock on it.
    const pause = createPause();
    const older = indexerOn(second, {
      holdStatement: 'from search_private.generation',
      holdWhen: 'after',
      pause,
    });
    const olderRun = older.index({ accounts: [accountId] });
    await pause.reached;

    // A newer run rebuilds from fresh snapshots and publishes the replacement generation.
    const replacement = await indexerOn(first).index({ accounts: [accountId], rebuild: true });
    expect(replacement).toMatchObject({ published: true, rebuilt: true, caughtUp: true });
    expect(replacement.generation).not.toBe(published.generation);

    pause.resume();
    const resumed = await olderRun;

    // The older run takes up the generation that replaced the one it read.
    expect(resumed).toMatchObject({
      generation: replacement.generation,
      published: true,
      rebuilt: false,
      caughtUp: true,
    });
    expect(
      await second.query('select count(*)::int as count from search_private.generation'),
    ).toEqual([{ count: 1 }]);
    expect(await scopedCopies(second)).toEqual([
      { copy_id: 'copy-alice-1', location_id: 'tag-binder' },
    ]);
  });

  it('takes up the replacement generation another run opened first', async (context) => {
    if (unavailable !== '') {
      context.skip(`A real PostgreSQL server is unavailable: ${unavailable}`);
      return;
    }
    if (first === undefined || second === undefined) {
      throw new Error('The two-connection harness was not opened.');
    }
    // The first run is held as it opens a generation; the second opens one and is held in turn.
    const opening = createPause();
    const opened = createPause();
    const firstRun = indexerOn(first, {
      holdStatement: 'insert into search_private.generation',
      holdWhen: 'before',
      pause: opening,
    }).index({ accounts: [accountId] });
    await opening.reached;
    const secondRun = indexerOn(second, {
      holdStatement: 'insert into search_private.generation',
      holdWhen: 'after',
      pause: opened,
    }).index({ accounts: [accountId] });
    await opened.reached;

    // The first run's insert now loses the race to the generation the second run opened.
    opening.resume();
    const resumed = await firstRun;
    opened.resume();
    const winner = await secondRun;

    expect(resumed).toMatchObject({
      generation: winner.generation,
      published: true,
      caughtUp: true,
    });
    expect(winner).toMatchObject({ published: true, caughtUp: true });
    expect(
      await first.query('select count(*)::int as count from search_private.generation'),
    ).toEqual([{ count: 1 }]);
    expect(await scopedCopies(second)).toEqual([
      { copy_id: 'copy-alice-1', location_id: 'tag-binder' },
    ]);
  });

  it('does not publish a replacement whose account scope another run replaced', async (context) => {
    if (unavailable !== '') {
      context.skip(`A real PostgreSQL server is unavailable: ${unavailable}`);
      return;
    }
    if (first === undefined || second === undefined) {
      throw new Error('The two-connection harness was not opened.');
    }
    await indexerOn(first).index({ accounts: [accountId] });

    // The older rebuild reads the generation state and is held there.
    const pause = createPause();
    const older = indexerOn(second, {
      holdStatement: 'from search_private.generation',
      holdWhen: 'after',
      pause,
    });
    // The rebuild names no account: its scope comes from the generation it read.
    const olderRun = older.index({ rebuild: true });
    await pause.reached;

    // A newer rebuild from fresh snapshots publishes its own replacement while the older is held.
    const replacement = await indexerOn(first).index({ accounts: [accountId], rebuild: true });
    expect(replacement).toMatchObject({ published: true, rebuilt: true, caughtUp: true });

    pause.resume();
    const resumed = await olderRun;

    // The held rebuild takes up the served generation instead of publishing one that would drop
    // the account the replaced generation covered.
    expect(resumed).toMatchObject({ published: true, caughtUp: true });
    expect(resumed.accounts).toEqual([{ accountId, position: '4', caughtUp: true }]);
    expect(
      await second.query('select count(*)::int as count from search_private.generation'),
    ).toEqual([{ count: 1 }]);
    expect(await scopedCopies(second)).toEqual([
      { copy_id: 'copy-alice-1', location_id: 'tag-binder' },
    ]);
  });
});
