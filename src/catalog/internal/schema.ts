/**
 * Catalog's own published read relations (docs/catalog.md#public-query-semantics).
 *
 * Private tables live in `catalog_private`; the read service reads only provider-owned views and
 * never the base tables. Current query membership and historical resolution are separate views so
 * a provider removal cannot strand a saved reference. The declaration below describes the current
 * query relations; consumers receive typed records rather than this storage layout.
 */

import { CATALOG_LIMITS } from './model.js';

export const catalogQuerySchema = 'catalog';
export const catalogPrivateSchema = 'catalog_private';
const catalogResolutionSchema = 'catalog_resolution';

const identifierLength = CATALOG_LIMITS.maxIdentifierLength;

/** Column types of the current query relations, not the storage's internal representation. */
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
          meaning: 'Available physical finishes; may be empty for a nonphysical printing.',
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
create schema if not exists ${catalogResolutionSchema};

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
  current boolean not null default true,
  candidate boolean not null default false,
  check (colors <@ array['W', 'U', 'B', 'R', 'G']::text[] and cardinality(colors) <= 5),
  check (color_identity <@ array['W', 'U', 'B', 'R', 'G']::text[] and cardinality(color_identity) <= 5)
);

alter table ${catalogPrivateSchema}.card
  add column if not exists current boolean not null default true;
alter table ${catalogPrivateSchema}.card
  add column if not exists candidate boolean not null default false;

create table if not exists ${catalogPrivateSchema}.card_name (
  card_id text not null references ${catalogPrivateSchema}.card (card_id) on delete cascade,
  language text not null check (length(language) between 1 and 20),
  name text not null check (length(name) between 1 and 300),
  current boolean not null default true,
  candidate boolean not null default false,
  primary key (card_id, language, name)
);

alter table ${catalogPrivateSchema}.card_name
  add column if not exists current boolean not null default true;
alter table ${catalogPrivateSchema}.card_name
  add column if not exists candidate boolean not null default false;

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
  current boolean not null default true,
  candidate boolean not null default false,
  constraint printing_finishes_check check (
    finishes <@ array['nonfoil', 'foil', 'etched']::text[]
    and (not physical or cardinality(finishes) >= 1)
  )
);

alter table ${catalogPrivateSchema}.printing
  add column if not exists current boolean not null default true;
alter table ${catalogPrivateSchema}.printing
  add column if not exists candidate boolean not null default false;

-- Upgrade storage created by the previous schema, whose finish constraint rejected every empty
-- list. Existing records and publication history stay in place while the constraint is replaced.
alter table ${catalogPrivateSchema}.printing
  drop constraint if exists printing_finishes_check;
alter table ${catalogPrivateSchema}.printing
  add constraint printing_finishes_check check (
    finishes <@ array['nonfoil', 'foil', 'etched']::text[]
    and (not physical or cardinality(finishes) >= 1)
  );

create index if not exists printing_card_order_index
  on ${catalogPrivateSchema}.printing (card_id, edition, collector_number, language, printing_id);
create index if not exists printing_identity_index
  on ${catalogPrivateSchema}.printing (edition, collector_number, language);
create index if not exists current_card_name_lower_name_index
  on ${catalogPrivateSchema}.card_name (lower(name)) where current;
create index if not exists current_printing_card_order_index
  on ${catalogPrivateSchema}.printing (card_id, edition, collector_number, language, printing_id)
  where current;

-- The transitional durable publication stream. One publication writes the
-- changes of its candidate records, then the revision that completes them, in the same
-- transaction. Positions only grow, so a consumer resumes from any delivered position; the
-- revision records the authoritative published revision, and record rows carry the stable identity
-- and the upsert or removal meaning a consumer applies.
create table if not exists ${catalogPrivateSchema}.publication (
  position bigint not null generated always as identity primary key,
  revision_id text not null check (length(revision_id) between 1 and ${identifierLength}),
  source_name text not null check (length(source_name) between 1 and 200),
  source_version text not null check (length(source_version) between 1 and 200),
  published_at timestamptz not null,
  kind text not null check (kind in ('revision', 'card', 'card-name', 'printing')),
  record_identity text,
  removed boolean not null default false,
  record jsonb,
  check (kind <> 'revision' or (record_identity is null and record is null and not removed)),
  check (kind = 'revision' or (record_identity is not null and (removed or record is not null))),
  check (not removed or record is null),
  unique (revision_id, kind, record_identity)
);

-- One completed revision per publication; the snapshot reports this revision's position.
create unique index if not exists publication_revision_index
  on ${catalogPrivateSchema}.publication (revision_id) where kind = 'revision';

create or replace view ${catalogQuerySchema}.cards as
  select card_id, name, rules_text, type_line, colors, color_identity, mana_value
  from ${catalogPrivateSchema}.card
  where current;

create or replace view ${catalogQuerySchema}.card_names as
  select card_id, language, name
  from ${catalogPrivateSchema}.card_name
  where current;

create or replace view ${catalogQuerySchema}.printings as
  select printing_id, card_id, edition, collector_number, language, finishes, physical,
         image_small, image_normal, image_large, image_art_crop
  from ${catalogPrivateSchema}.printing
  where current;

-- Historical records stay available to the provider-owned resolver while current public queries
-- use the three views above. These views are storage details, not consumer query contracts.
create or replace view ${catalogResolutionSchema}.cards as
  select card_id, name, rules_text, type_line, colors, color_identity, mana_value
  from ${catalogPrivateSchema}.card;

create or replace view ${catalogResolutionSchema}.card_names as
  select card_id, language, name
  from ${catalogPrivateSchema}.card_name;

create or replace view ${catalogResolutionSchema}.printings as
  select printing_id, card_id, edition, collector_number, language, finishes, physical,
         image_small, image_normal, image_large, image_art_crop
  from ${catalogPrivateSchema}.printing;

create or replace view ${catalogQuerySchema}.published_revision as
  select revision_id, source_name, source_version, published_at
  from ${catalogPrivateSchema}.revision;

revoke all on schema ${catalogPrivateSchema} from public;
revoke all on schema ${catalogResolutionSchema} from public;
`.trim();

const readerRolePattern = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Grants the Catalog read service access to current-query and historical-resolution views. The
 * schema owner applies this after `catalogSchemaSql`; base tables stay unreachable for the reader.
 */
export function catalogReaderGrants(readerRole: string): string {
  assertRole(readerRole);
  const relations = [
    ...Object.values(CATALOG_QUERY_SURFACE.relations).map((relation) => relation.name),
    `${catalogResolutionSchema}.cards`,
    `${catalogResolutionSchema}.card_names`,
    `${catalogResolutionSchema}.printings`,
  ];
  return [
    `grant usage on schema ${catalogQuerySchema} to "${readerRole}";`,
    `grant usage on schema ${catalogResolutionSchema} to "${readerRole}";`,
    `grant select on ${relations.join(', ')} to "${readerRole}";`,
  ].join('\n');
}

/**
 * Grants trusted indexing access to the publication contract: the published records and the
 * durable change stream, and no mutation. Application supplies this credential to an indexing
 * runtime separately from an end-user read role (docs/data-architecture.md#access-and-deployment);
 * the read service never needs it and never reaches the private schema.
 */
export function catalogPublicationGrants(role: string): string {
  return [
    catalogReaderGrants(role),
    `grant usage on schema ${catalogPrivateSchema} to "${role}";`,
    `grant select on ${catalogPrivateSchema}.publication to "${role}";`,
  ].join('\n');
}

function assertRole(role: string): void {
  if (!readerRolePattern.test(role)) {
    throw new TypeError(
      `Catalog role must be a lowercase PostgreSQL identifier, received "${role}".`,
    );
  }
}
