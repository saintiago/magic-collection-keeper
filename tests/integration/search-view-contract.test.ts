/**
 * Integration scope: combined Search queries against a minimal implementation of the published
 * views (docs/search.md#required-query-contracts). The fixture exposes no provider table name, so
 * these cases establish that Search depends on the declared Catalog and UserCards relations only,
 * and that a replacement storage mapping its data to them passes the same behaviour. The real
 * providers' own surfaces are covered beside this file in search-evaluation.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SearchError, createSearch } from '../../src/search/index.js';
import { USERCARDS_ACCOUNT_SETTING } from '../../src/usercards/index.js';
import type { TestDatabase } from '../support/postgres-database.js';
import { createSearchViewDatabase } from '../support/search-views.js';

const alice = { accountId: 'search-alice' };
const bob = { accountId: 'search-bob' };

describe('search over a replacement view fixture', () => {
  let database: TestDatabase;

  beforeEach(async () => {
    database = await createSearchViewDatabase();
    await database.query(
      `insert into search_fixture.legacy_card
         (card_id, name, rules_text, type_line, colors, color_identity, mana_value)
       values ('card-bolt', 'Lightning Bolt', 'Three damage.', 'Instant', '{R}', '{R}', 1),
              ('card-elf', 'Llanowar Elves', null, 'Creature — Elf', '{G}', '{G}', 1)`,
    );
    await database.query(
      `insert into search_fixture.legacy_card_name (card_id, language, name)
       values ('card-bolt', 'de', 'Blitzschlag')`,
    );
    await database.query(
      `insert into search_fixture.legacy_printing
         (printing_id, card_id, edition, collector_number, language, finishes, physical)
       values ('print-bolt', 'card-bolt', 'M11', '149', 'en', '{nonfoil}', true),
              ('print-elf', 'card-elf', 'M11', '179', 'en', '{nonfoil}', true)`,
    );
    await database.query(
      `insert into search_fixture.legacy_revision
         (revision_id, source_name, source_version, published_at)
       values ('fixture-revision', 'fixture', '1', now())`,
    );
    await database.query(
      `insert into search_fixture.legacy_holding
         (account_id, copy_id, printing_id, finish, condition, owned)
       values ('search-alice', 'copy-alice', 'print-bolt', 'nonfoil', 'NM', true),
              ('search-bob', 'copy-bob', 'print-elf', 'nonfoil', 'NM', true)`,
    );
    await database.query(
      `insert into search_fixture.legacy_listing
         (account_id, association_id, tag_id, target_level, target_id, quantity)
       values ('search-alice', 'listing-alice', 'deck-alice', 'copy', 'copy-alice', null)`,
    );
    await database.query(
      `insert into search_fixture.legacy_state (account_id, revision)
       values ('search-alice', 5), ('search-bob', 2)`,
    );
  });

  afterEach(async () => {
    await database.close();
  });

  /** Search wired the way Application wires it, with an option to skip the account binding. */
  function search(database_: TestDatabase, bindAccount = true) {
    return createSearch({
      sql: database_.sql,
      withAccountScope: (accountId, work) =>
        database_.sql.transaction(async (statements) => {
          if (bindAccount) {
            await statements.query('select set_config(:setting, :account_id, true)', {
              setting: USERCARDS_ACCOUNT_SETTING,
              account_id: accountId,
            });
          }
          return work(statements);
        }),
    });
  }

  it('evaluates combined public and private criteria through the declared relations', async () => {
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

    expect(page.totalCount).toBe(1);
    expect(page.revisions).toEqual({ catalogRevision: 'fixture-revision', privateRevision: '5' });
    expect(page.entries[0]?.card).toEqual({
      cardId: 'card-bolt',
      name: 'Lightning Bolt',
      matchedName: 'Blitzschlag',
    });
    expect(page.entries[0]?.quantity).toEqual({ copies: 1, intended: null });
  });

  it('scopes private results to the account the provider binds', async () => {
    const bobPage = await search(database).execute({ resultLevel: 'copy' }, bob);
    const alicePage = await search(database).execute({ resultLevel: 'copy' }, alice);

    expect(bobPage.entries.map((entry) => entry.target)).toEqual([
      { kind: 'copy', copyId: 'copy-bob' },
    ]);
    expect(bobPage.revisions.privateRevision).toBe('2');
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
});
