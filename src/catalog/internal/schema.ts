/**
 * The published query surface of Catalog (docs/catalog.md#query-surface).
 *
 * Private tables live in `catalog_private`; consumers read only the views in `catalog`. The
 * declaration below is the provider-owned contract Search depends on: relation names, columns and
 * their meaning. `tests/integration/catalog-query-surface.test.ts` verifies the views against it,
 * so a replacement storage maps its data to exactly these relations and passes the same tests.
 */

import { CATALOG_LIMITS } from './model.js';

export const catalogQuerySchema = 'catalog';
export const catalogPrivateSchema = 'catalog_private';

const identifierLength = CATALOG_LIMITS.maxIdentifierLength;

/** Column types as Search consumes them, not the storage's internal representation. */
export type CatalogColumnType = 'text' | 'text-array' | 'boolean' | 'numeric' | 'timestamp';

export interface CatalogRelationColumn {
  readonly name: string;
  readonly type: CatalogColumnType;
  readonly nullable: boolean;
  readonly meaning: string;
}

export interface CatalogQueryRelation {
  /** Schema-qualified relation name. Private table names never appear here. */
  readonly name: string;
  readonly columns: readonly CatalogRelationColumn[];
}

export interface CatalogQuerySurface {
  readonly version: number;
  readonly relations: {
    readonly cards: CatalogQueryRelation;
    readonly cardNames: CatalogQueryRelation;
    readonly printings: CatalogQueryRelation;
    readonly publishedRevision: CatalogQueryRelation;
  };
}

export const CATALOG_QUERY_SURFACE: CatalogQuerySurface = {
  version: 1,
  relations: {
    cards: {
      name: `${catalogQuerySchema}.cards`,
      columns: [
        {
          name: 'card_id',
          type: 'text',
          nullable: false,
          meaning: 'Playable identity; unique in this relation.',
        },
        {
          name: 'name',
          type: 'text',
          nullable: false,
          meaning: 'Canonical display name of the playable identity.',
        },
        {
          name: 'rules_text',
          type: 'text',
          nullable: true,
          meaning: 'Rules text; null when the provider publishes none.',
        },
        {
          name: 'type_line',
          type: 'text',
          nullable: true,
          meaning: 'Type information: supertypes, types and subtypes.',
        },
        {
          name: 'colors',
          type: 'text-array',
          nullable: false,
          meaning: 'Card colors as W/U/B/R/G characters; empty for colorless.',
        },
        {
          name: 'color_identity',
          type: 'text-array',
          nullable: false,
          meaning: 'Color identity as W/U/B/R/G characters; empty for colorless.',
        },
        {
          name: 'mana_value',
          type: 'numeric',
          nullable: true,
          meaning: 'Mana value; null when the provider publishes none.',
        },
      ],
    },
    cardNames: {
      name: `${catalogQuerySchema}.card_names`,
      columns: [
        {
          name: 'card_id',
          type: 'text',
          nullable: false,
          meaning: 'Card reference; several alias rows may name one card.',
        },
        {
          name: 'language',
          type: 'text',
          nullable: false,
          meaning: 'Provider language code of the name, for example en or es.',
        },
        {
          name: 'name',
          type: 'text',
          nullable: false,
          meaning: 'Translated or face name that resolves to the same playable identity.',
        },
      ],
    },
    printings: {
      name: `${catalogQuerySchema}.printings`,
      columns: [
        {
          name: 'printing_id',
          type: 'text',
          nullable: false,
          meaning: 'Printing identity; unique in this relation.',
        },
        {
          name: 'card_id',
          type: 'text',
          nullable: false,
          meaning: 'Card reference of the printing.',
        },
        {
          name: 'edition',
          type: 'text',
          nullable: false,
          meaning: 'Edition (set) code.',
        },
        {
          name: 'collector_number',
          type: 'text',
          nullable: false,
          meaning: 'Collector number within the edition.',
        },
        {
          name: 'language',
          type: 'text',
          nullable: false,
          meaning: 'Provider language code of the printing.',
        },
        {
          name: 'finishes',
          type: 'text-array',
          nullable: false,
          meaning: 'Available finishes: nonfoil, foil or etched; never empty.',
        },
        {
          name: 'physical',
          type: 'boolean',
          nullable: false,
          meaning: 'Whether the printing is available as a physical card.',
        },
        {
          name: 'image_small',
          type: 'text',
          nullable: true,
          meaning: 'Small card image reference.',
        },
        {
          name: 'image_normal',
          type: 'text',
          nullable: true,
          meaning: 'Normal card image reference.',
        },
        {
          name: 'image_large',
          type: 'text',
          nullable: true,
          meaning: 'Large card image reference.',
        },
        {
          name: 'image_art_crop',
          type: 'text',
          nullable: true,
          meaning: 'Art-crop image reference.',
        },
      ],
    },
    publishedRevision: {
      name: `${catalogQuerySchema}.published_revision`,
      columns: [
        {
          name: 'revision_id',
          type: 'text',
          nullable: false,
          meaning: 'Revision identifier; one row is published at a time.',
        },
        {
          name: 'source_name',
          type: 'text',
          nullable: false,
          meaning: 'Source the revision was ingested from.',
        },
        {
          name: 'source_version',
          type: 'text',
          nullable: false,
          meaning: 'Provider version or snapshot the revision was ingested from.',
        },
        {
          name: 'published_at',
          type: 'timestamp',
          nullable: false,
          meaning: 'Publication instant, in UTC.',
        },
      ],
    },
  },
};

/**
 * Schema owned by the catalog provider. Applying it is idempotent; one publication updates the
 * candidate records and `catalog_private.revision` in the same atomic transaction, so the views
 * always expose one mutually consistent revision.
 */
export const catalogSchemaSql = `
create schema if not exists ${catalogPrivateSchema};
create schema if not exists ${catalogQuerySchema};

create table if not exists ${catalogPrivateSchema}.revision (
  singleton boolean not null default true primary key check (singleton),
  revision_id text not null check (length(revision_id) between 1 and ${identifierLength}),
  source_name text not null check (length(source_name) between 1 and 200),
  source_version text not null check (length(source_version) between 1 and 200),
  published_at timestamptz not null
);

create table if not exists ${catalogPrivateSchema}.card (
  card_id text primary key check (length(card_id) between 1 and ${identifierLength}),
  name text not null check (length(name) between 1 and 300),
  rules_text text,
  type_line text,
  colors text[] not null,
  color_identity text[] not null,
  mana_value numeric check (mana_value is null or mana_value >= 0),
  check (colors <@ array['W', 'U', 'B', 'R', 'G']::text[] and cardinality(colors) <= 5),
  check (color_identity <@ array['W', 'U', 'B', 'R', 'G']::text[] and cardinality(color_identity) <= 5)
);

create table if not exists ${catalogPrivateSchema}.card_name (
  card_id text not null references ${catalogPrivateSchema}.card (card_id) on delete cascade,
  language text not null check (length(language) between 1 and 20),
  name text not null check (length(name) between 1 and 300),
  primary key (card_id, language, name)
);

create index if not exists card_name_lower_name_index
  on ${catalogPrivateSchema}.card_name (lower(name));

create table if not exists ${catalogPrivateSchema}.printing (
  printing_id text primary key check (length(printing_id) between 1 and ${identifierLength}),
  card_id text not null references ${catalogPrivateSchema}.card (card_id) on delete cascade,
  edition text not null check (length(edition) between 1 and 32),
  collector_number text not null check (length(collector_number) between 1 and 32),
  language text not null check (length(language) between 1 and 20),
  finishes text[] not null,
  physical boolean not null,
  image_small text,
  image_normal text,
  image_large text,
  image_art_crop text,
  check (finishes <@ array['nonfoil', 'foil', 'etched']::text[] and cardinality(finishes) >= 1)
);

create index if not exists printing_card_order_index
  on ${catalogPrivateSchema}.printing (card_id, edition, collector_number, language, printing_id);
create index if not exists printing_identity_index
  on ${catalogPrivateSchema}.printing (edition, collector_number, language);

create or replace view ${catalogQuerySchema}.cards as
  select card_id, name, rules_text, type_line, colors, color_identity, mana_value
  from ${catalogPrivateSchema}.card;

create or replace view ${catalogQuerySchema}.card_names as
  select card_id, language, name
  from ${catalogPrivateSchema}.card_name;

create or replace view ${catalogQuerySchema}.printings as
  select printing_id, card_id, edition, collector_number, language, finishes, physical,
         image_small, image_normal, image_large, image_art_crop
  from ${catalogPrivateSchema}.printing;

create or replace view ${catalogQuerySchema}.published_revision as
  select revision_id, source_name, source_version, published_at
  from ${catalogPrivateSchema}.revision;

revoke all on schema ${catalogPrivateSchema} from public;
`.trim();

const readerRolePattern = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Grants a consumer role read access to the published views and nothing else. The catalog schema
 * owner applies this after `catalogSchemaSql`; base tables stay unreachable for the reader.
 */
export function catalogReaderGrants(readerRole: string): string {
  if (!readerRolePattern.test(readerRole)) {
    throw new TypeError(
      `Catalog reader role must be a lowercase PostgreSQL identifier, received "${readerRole}".`,
    );
  }
  const relations = Object.values(CATALOG_QUERY_SURFACE.relations).map((relation) => relation.name);
  return [
    `grant usage on schema ${catalogQuerySchema} to "${readerRole}";`,
    `grant select on ${relations.join(', ')} to "${readerRole}";`,
  ].join('\n');
}
