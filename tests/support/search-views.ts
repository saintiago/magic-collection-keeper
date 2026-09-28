/**
 * Minimal contract-conforming projection fixture for Search (docs/search.md#required-query-
 * contracts). Only Search's declared relations exist, backed by tables whose names no consumer
 * knows and scoped by the generation and the account the projection published: a replacement
 * implementation that maps its data to the same relations passes the same Search cases without
 * Search knowing its storage. The two provider schemas hold decoy records, so a query that read a
 * provider relation instead of the projection would answer with different data — the fixture
 * proves the retirement of the cross-owner query views (docs/data-architecture.md#storage-ownership).
 */

import { SEARCH_ACCOUNT_SETTING, SEARCH_PROJECTION_SURFACE } from '../../src/search/index.js';
import { createTestDatabase, type TestDatabase } from './postgres-database.js';

const relations = {
  cards: SEARCH_PROJECTION_SURFACE.relations.cards.name,
  cardNames: SEARCH_PROJECTION_SURFACE.relations.cardNames.name,
  printings: SEARCH_PROJECTION_SURFACE.relations.printings.name,
  copies: SEARCH_PROJECTION_SURFACE.relations.copies.name,
  tags: SEARCH_PROJECTION_SURFACE.relations.tags.name,
  associations: SEARCH_PROJECTION_SURFACE.relations.associations.name,
  indexState: SEARCH_PROJECTION_SURFACE.relations.indexState.name,
  accountState: SEARCH_PROJECTION_SURFACE.relations.accountState.name,
} as const;

const boundAccount = `nullif(current_setting('${SEARCH_ACCOUNT_SETTING}', true), '')`;
const publishedGeneration = `(select state.generation_id
   from search_fixture.replacement_state as state
  where state.published)`;

const fixtureSql = `
create schema search_fixture;
create schema search;

-- The replacement storage behind the published projection; no consumer names these tables.
create table search_fixture.replacement_card (
  generation_id text, card_id text, name text, rules_text text, type_line text,
  colors text[], color_identity text[], mana_value numeric
);
create table search_fixture.replacement_card_name (
  generation_id text, card_id text, language text, name text
);
create table search_fixture.replacement_printing (
  generation_id text, printing_id text, card_id text, edition text, collector_number text,
  language text, finishes text[], physical boolean
);
create table search_fixture.replacement_copy (
  generation_id text, account_id text, copy_id text, printing_id text, finish text,
  condition text, owned boolean, location_id text
);
create table search_fixture.replacement_tag (
  generation_id text, account_id text, tag_id text, kind text, label text, system boolean
);
create table search_fixture.replacement_association (
  generation_id text, account_id text, association_id text, tag_id text, target_level text,
  target_id text, quantity integer
);
create table search_fixture.replacement_state (
  generation_id text, catalog_revision text, catalog_position text, published boolean
);
create table search_fixture.replacement_account_state (account_id text, position text);

-- Decoys of the retired cross-owner relations: a query reading these would answer differently.
create schema catalog;
create schema usercards;
create table catalog.cards (
  card_id text, name text, rules_text text, type_line text, colors text[], color_identity text[],
  mana_value numeric
);
create table catalog.printings (
  printing_id text, card_id text, edition text, collector_number text, language text,
  finishes text[], physical boolean
);
create table usercards.copies (
  copy_id text, printing_id text, finish text, condition text, owned boolean, location_id text
);

create view ${relations.cards} as
  select card.card_id, card.name, card.rules_text, card.type_line, card.colors,
         card.color_identity, card.mana_value
  from search_fixture.replacement_card as card
  where card.generation_id = ${publishedGeneration};

create view ${relations.cardNames} as
  select name.card_id, name.language, name.name
  from search_fixture.replacement_card_name as name
  where name.generation_id = ${publishedGeneration};

create view ${relations.printings} as
  select printing.printing_id, printing.card_id, printing.edition, printing.collector_number,
         printing.language, printing.finishes, printing.physical
  from search_fixture.replacement_printing as printing
  where printing.generation_id = ${publishedGeneration};

create view ${relations.copies} with (security_barrier) as
  select copy.copy_id, copy.printing_id, copy.finish, copy.condition, copy.owned, copy.location_id
  from search_fixture.replacement_copy as copy
  where copy.generation_id = ${publishedGeneration}
    and copy.account_id = ${boundAccount};

create view ${relations.tags} with (security_barrier) as
  select tag.tag_id, tag.kind, tag.label, tag.system
  from search_fixture.replacement_tag as tag
  where tag.generation_id = ${publishedGeneration}
    and tag.account_id = ${boundAccount};

create view ${relations.associations} with (security_barrier) as
  select association.association_id, association.tag_id, association.target_level,
         association.target_id, association.quantity
  from search_fixture.replacement_association as association
  where association.generation_id = ${publishedGeneration}
    and association.account_id = ${boundAccount};

create view ${relations.indexState} as
  select state.generation_id, state.catalog_revision, state.catalog_position
  from search_fixture.replacement_state as state
  where state.published;

create view ${relations.accountState} with (security_barrier) as
  select state.position
  from search_fixture.replacement_account_state as state
  where state.account_id = ${boundAccount};
`;

/** One fixture database exposing exactly Search's declared projection relations. */
export async function createSearchViewDatabase(): Promise<TestDatabase> {
  return createTestDatabase(fixtureSql);
}
