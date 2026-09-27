/**
 * Minimal contract-conforming view fixture for Search (docs/search.md#required-query-contracts).
 * Only the published relations exist, backed by tables whose names no consumer knows, and the
 * private views carry the account scope themselves. A provider that maps its storage to the same
 * relations passes the same Search cases without Search knowing its tables.
 */

import { CATALOG_QUERY_SURFACE } from '../../src/catalog/index.js';
import { USERCARDS_ACCOUNT_SETTING, USERCARDS_QUERY_SURFACE } from '../../src/usercards/index.js';
import { createTestDatabase, type TestDatabase } from './postgres-database.js';

const cardColumns = CATALOG_QUERY_SURFACE.relations.cards.columns.map((column) => column.name);
const printingColumns = CATALOG_QUERY_SURFACE.relations.printings.columns.map(
  (column) => column.name,
);
const copyColumns = USERCARDS_QUERY_SURFACE.relations.copies.columns.map((column) => column.name);
const associationColumns = USERCARDS_QUERY_SURFACE.relations.associations.columns.map(
  (column) => column.name,
);

const boundAccount = `nullif(current_setting('${USERCARDS_ACCOUNT_SETTING}', true), '')`;

const relations = {
  cards: CATALOG_QUERY_SURFACE.relations.cards.name,
  cardNames: CATALOG_QUERY_SURFACE.relations.cardNames.name,
  printings: CATALOG_QUERY_SURFACE.relations.printings.name,
  publishedRevision: CATALOG_QUERY_SURFACE.relations.publishedRevision.name,
  copies: USERCARDS_QUERY_SURFACE.relations.copies.name,
  associations: USERCARDS_QUERY_SURFACE.relations.associations.name,
  privateRevision: USERCARDS_QUERY_SURFACE.relations.privateRevision.name,
} as const;

/** Columns of one relation as a select list over a fixture table with the same column names. */
function selectColumns(columns: readonly string[]): string {
  return columns.join(', ');
}

const fixtureSql = `
create schema search_fixture;
create schema catalog;
create schema usercards;

create table search_fixture.legacy_card (
  card_id text, name text, rules_text text, type_line text,
  colors text[], color_identity text[], mana_value numeric
);
create table search_fixture.legacy_card_name (card_id text, language text, name text);
create table search_fixture.legacy_printing (
  printing_id text, card_id text, edition text, collector_number text, language text,
  finishes text[], physical boolean, image_small text, image_normal text, image_large text,
  image_art_crop text
);
create table search_fixture.legacy_revision (
  revision_id text, source_name text, source_version text, published_at timestamptz
);
create table search_fixture.legacy_holding (
  account_id text, copy_id text, printing_id text, finish text, condition text,
  location_id text, owned boolean
);
create table search_fixture.legacy_listing (
  account_id text, association_id text, tag_id text, target_level text, target_id text,
  quantity integer
);
create table search_fixture.legacy_state (account_id text, revision integer);

create view ${relations.cards} as
  select ${selectColumns(cardColumns)} from search_fixture.legacy_card;
create view ${relations.cardNames} as
  select card_id, language, name from search_fixture.legacy_card_name;
create view ${relations.printings} as
  select ${selectColumns(printingColumns)} from search_fixture.legacy_printing;
create view ${relations.publishedRevision} as
  select revision_id, source_name, source_version, published_at
  from search_fixture.legacy_revision;

create view ${relations.copies} with (security_barrier) as
  select ${selectColumns(copyColumns)}
  from search_fixture.legacy_holding where account_id = ${boundAccount};
create view ${relations.associations} with (security_barrier) as
  select ${selectColumns(associationColumns)}
  from search_fixture.legacy_listing where account_id = ${boundAccount};
create view ${relations.privateRevision} as
  select coalesce(state.revision, 0)::text as revision
  from (select ${boundAccount} as account_id) as bound
  left join search_fixture.legacy_state as state on state.account_id = bound.account_id
  where bound.account_id is not null;
`;

export async function createSearchViewDatabase(): Promise<TestDatabase> {
  return createTestDatabase(fixtureSql);
}
