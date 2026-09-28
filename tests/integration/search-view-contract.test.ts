/**
 * Integration scope: Search queries and freshness against a minimal implementation of its own
 * published projection (docs/search.md#required-query-contracts, docs/search.md#freshness). The
 * fixture exposes no provider relation that answers a query — the catalog and usercards schemas
 * hold decoy rows — so these cases establish that a replacement storage mapping its data to the
 * declared relations passes the same behaviour and that Search reads no cross-owner query view.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SEARCH_ACCOUNT_SCOPE_SQL,
  SearchError,
  createSearch,
  type Search,
} from '../../src/search/index.js';
import type { TestDatabase } from '../support/postgres-database.js';
import { createSearchViewDatabase } from '../support/search-views.js';

const alice = { accountId: 'search-alice' };
const bob = { accountId: 'search-bob' };

const generation = 'fixture-generation';

describe('a replacement projection implementation', () => {
  let database: TestDatabase;

  beforeEach(async () => {
    database = await createSearchViewDatabase();
    await database.query(
      `insert into search_fixture.replacement_state
         (generation_id, catalog_revision, catalog_position, published)
       values ($1, 'fixture-revision', '7', true)`,
      [generation],
    );
    await database.query(
      `insert into search_fixture.replacement_card
         (generation_id, card_id, name, rules_text, type_line, colors, color_identity, mana_value)
       values ($1, 'card-bolt', 'Lightning Bolt', 'Three damage.', 'Instant', '{R}', '{R}', 1),
              ($1, 'card-elf', 'Llanowar Elves', null, 'Creature — Elf', '{G}', '{G}', 1)`,
      [generation],
    );
    await database.query(
      `insert into search_fixture.replacement_card_name (generation_id, card_id, language, name)
       values ($1, 'card-bolt', 'de', 'Blitzschlag')`,
      [generation],
    );
    await database.query(
      `insert into search_fixture.replacement_printing
         (generation_id, printing_id, card_id, edition, collector_number, language, finishes,
          physical)
       values ($1, 'print-bolt', 'card-bolt', 'M11', '149', 'en', '{nonfoil}', true),
              ($1, 'print-elf', 'card-elf', 'M11', '179', 'en', '{nonfoil}', true)`,
      [generation],
    );
    await database.query(
      `insert into search_fixture.replacement_copy
         (generation_id, account_id, copy_id, printing_id, finish, condition, owned, location_id)
       values ($1, 'search-alice', 'copy-alice', 'print-bolt', 'nonfoil', 'NM', true, null),
              ($1, 'search-bob', 'copy-bob', 'print-elf', 'nonfoil', 'NM', true, null)`,
      [generation],
    );
    await database.query(
      `insert into search_fixture.replacement_association
         (generation_id, account_id, association_id, tag_id, target_level, target_id, quantity)
       values ($1, 'search-alice', 'listing-alice', 'deck-alice', 'copy', 'copy-alice', null)`,
      [generation],
    );
    await database.query(
      `insert into search_fixture.replacement_account_state (account_id, position)
       values ('search-alice', '5'), ('search-bob', '2')`,
    );
    // The decoy cross-owner relations hold a matching card and copy of their own.
    await database.query(
      `insert into catalog.cards
         (card_id, name, rules_text, type_line, colors, color_identity, mana_value)
       values ('card-decoy', 'Lightning Decoy', 'Three damage.', 'Instant', '{R}', '{R}', 1)`,
    );
    await database.query(
      `insert into usercards.copies
         (copy_id, printing_id, finish, condition, owned, location_id)
       values ('copy-decoy', 'print-decoy', 'nonfoil', 'NM', true, null)`,
    );
  });

  afterEach(async () => {
    await database.close();
  });

  /** Search wired the way Application wires it, with an option to skip the account binding. */
  function search(database_: TestDatabase, bindAccount = true): Search {
    return createSearch({
      sql: database_.sql,
      withAccountScope: (accountId, work) =>
        database_.sql.transaction(async (statements) => {
          if (bindAccount) {
            await statements.query(SEARCH_ACCOUNT_SCOPE_SQL, { account_id: accountId });
          }
          return work(statements);
        }),
    });
  }

  it('evaluates combined public and private criteria from the projection alone', async () => {
    const page = await search(database).execute(
      {
        resultLevel: 'card',
        criteria: [
          { kind: 'name', text: 'Blitzschlag' },
          { kind: 'tag', tagId: 'deck-alice' },
        ],
      },
      alice,
    );

    expect(page.status).toBe('ready');
    expect(page.totalCount).toBe(1);
    expect(page.revisions).toEqual({
      generation,
      catalogRevision: 'fixture-revision',
      catalogPosition: '7',
      privateRevision: '5',
    });
    expect(page.entries[0]?.card).toEqual({
      cardId: 'card-bolt',
      name: 'Lightning Bolt',
      matchedName: 'Blitzschlag',
    });
    expect(page.entries[0]?.quantity).toEqual({ copies: 1, intended: null });
  });

  it('scopes private results to the account the projection binds', async () => {
    const bobPage = await search(database).execute({ resultLevel: 'copy' }, bob);
    const alicePage = await search(database).execute({ resultLevel: 'copy' }, alice);

    expect(bobPage.entries.map((entry) => entry.target)).toEqual([
      { kind: 'copy', copyId: 'copy-bob' },
    ]);
    expect(bobPage.revisions?.privateRevision).toBe('2');
    expect(alicePage.entries.map((entry) => entry.target)).toEqual([
      { kind: 'copy', copyId: 'copy-alice' },
    ]);
  });

  it('fails a private query instead of reporting an unscoped empty result', async () => {
    const outcome = await search(database, false)
      .execute({ resultLevel: 'copy' }, alice)
      .then(
        () => undefined,
        (cause: unknown) => cause,
      );

    expect(outcome).toBeInstanceOf(SearchError);
    expect((outcome as SearchError).code).toBe('unavailable');
  });

  it('reads private counts and the indexed position from the projection', async () => {
    const counts = await search(database).counts(
      {
        references: [
          { kind: 'copy', copyId: 'copy-alice' },
          { kind: 'copy', copyId: 'copy-bob' },
        ],
      },
      alice,
    );

    expect(counts.privateRevision).toBe('5');
    expect(counts.counts.get('copy:copy-alice')).toEqual({
      owned: 1,
      locations: 0,
      intended: null,
    });
    expect(counts.counts.get('copy:copy-bob')).toEqual({
      owned: 0,
      locations: 0,
      intended: null,
    });
  });

  it('reports a required position as incorporated only once the projection reaches it', async () => {
    const behind = await search(database).execute(
      { resultLevel: 'copy', requiredPosition: '9' },
      alice,
    );
    await database.query(
      `update search_fixture.replacement_account_state set position = '9'
        where account_id = 'search-alice'`,
    );
    await database.query(
      `insert into search_fixture.account_evidence values ($1, 'search-alice', '9')`,
      [generation],
    );
    const ahead = await search(database).execute(
      { resultLevel: 'copy', requiredPosition: '9' },
      alice,
    );

    expect(behind.status).toBe('updating');
    expect(behind.entries.map((entry) => entry.target)).toEqual([
      { kind: 'copy', copyId: 'copy-alice' },
    ]);
    expect(ahead.status).toBe('ready');
  });

  it('observes incorporation without creating indexing work', async () => {
    const pending = await search(database).observe({ positions: ['9'] }, alice);
    await database.query(
      `update search_fixture.replacement_account_state set position = '9'
        where account_id = 'search-alice'`,
    );
    await database.query(
      `insert into search_fixture.account_evidence values ($1, 'search-alice', '9')`,
      [generation],
    );
    const incorporated = await search(database).observe({ positions: ['9'] }, alice, {
      timeoutMs: 250,
    });

    expect(pending.state).toBe('indexing');
    expect(pending.revisions?.privateRevision).toBe('5');
    expect(incorporated.state).toBe('incorporated');
    expect(incorporated.revisions?.privateRevision).toBe('9');
  });
});
