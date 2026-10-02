/**
 * Search-owned projection storage and its published read surface
 * (docs/search.md#internal-design, docs/data-architecture.md#storage-ownership).
 *
 * Search keeps its own logical database: a generation of derived catalog and private facts, the
 * checkpoints it was built and caught up through, and the views a query role reads. A generation
 * is either building or published; the published one is the only generation the read surface
 * exposes, so a rebuild writes a replacement beside the generation queries still read. Every
 * projection row carries the generation it belongs to, and private rows carry the account, so a
 * replacement generation and a foreign account can never leak into another owner's result.
 *
 * The private tables live in `search_private`; the read relations live in `search`. Public facts
 * are shared once per generation, while copies, tags and associations are account-scoped at the
 * database boundary: the `search.account_id` setting selects the account, and a private view
 * returns no rows when no account is bound. `SEARCH_PROJECTION_SURFACE` is the declaration those
 * views satisfy; `tests/integration/search-projection-surface.test.ts` verifies it against the
 * real storage, so a replacement storage maps its data to exactly these relations.
 */

import { finishes, type CardColor } from '../../catalog/index.js';
import { associationTargetLevels, copyConditions, tagKinds } from '../../usercards/index.js';

export const searchPrivateSchema = 'search_private';
export const searchQuerySchema = 'search';

/**
 * Connection setting that carries the trusted account while a private projection view is read. It
 * is bound inside the read transaction and is transaction-local, so releasing the connection also
 * releases the scope.
 */
export const SEARCH_ACCOUNT_SETTING = 'search.account_id';

/** Statement that binds the verified account for one read transaction over the private views. */
export const SEARCH_ACCOUNT_SCOPE_SQL = `select set_config('${SEARCH_ACCOUNT_SETTING}', :account_id, true)`;

/** Column types as consumers read them, not the storage's internal representation. */
export type SearchColumnType = 'text' | 'text-array' | 'boolean' | 'numeric' | 'integer';

export interface SearchRelationColumn {
  readonly name: string;
  readonly type: SearchColumnType;
  readonly nullable: boolean;
  readonly meaning: string;
}

export interface SearchProjectionRelation {
  /** Schema-qualified relation name. Private table names never appear here. */
  readonly name: string;
  /** True when the relation is scoped by the account bound to the read transaction. */
  readonly accountScoped: boolean;
  readonly columns: readonly SearchRelationColumn[];
}

export interface SearchProjectionSurface {
  readonly version: number;
  readonly relations: {
    readonly cards: SearchProjectionRelation;
    readonly cardNames: SearchProjectionRelation;
    readonly printings: SearchProjectionRelation;
    readonly copies: SearchProjectionRelation;
    readonly tags: SearchProjectionRelation;
    readonly associations: SearchProjectionRelation;
    readonly indexState: SearchProjectionRelation;
    readonly accountState: SearchProjectionRelation;
    readonly catalogProgress: SearchProjectionRelation;
    readonly accountProgress: SearchProjectionRelation;
  };
}

const identifierLength = 200;

export const SEARCH_PROJECTION_SURFACE: SearchProjectionSurface = {
  version: 1,
  relations: {
    catalogProgress: {
      name: `${searchQuerySchema}.catalog_progress`,
      accountScoped: false,
      columns: [
        {
          name: 'revision_id',
          type: 'text',
          nullable: false,
          meaning: 'Known incorporated catalog revision.',
        },
      ],
    },
    accountProgress: {
      name: `${searchQuerySchema}.account_progress`,
      accountScoped: true,
      columns: [
        {
          name: 'position',
          type: 'text',
          nullable: false,
          meaning: 'Known incorporated committed position of the bound account.',
        },
      ],
    },
    cards: {
      name: `${searchQuerySchema}.cards`,
      accountScoped: false,
      columns: [
        {
          name: 'card_id',
          type: 'text',
          nullable: false,
          meaning: 'Playable identity; unique within the published generation.',
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
          meaning: 'Rules text; null when the published catalog record has none.',
        },
        {
          name: 'type_line',
          type: 'text',
          nullable: true,
          meaning: 'Type information; null when the published catalog record has none.',
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
          meaning: 'Mana value; null when the published catalog record has none.',
        },
      ],
    },
    cardNames: {
      name: `${searchQuerySchema}.card_names`,
      accountScoped: false,
      columns: [
        {
          name: 'card_id',
          type: 'text',
          nullable: false,
          meaning: 'Card reference; several name rows may resolve to one card.',
        },
        {
          name: 'language',
          type: 'text',
          nullable: false,
          meaning: 'Language code of the name, for example en or es.',
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
      name: `${searchQuerySchema}.printings`,
      accountScoped: false,
      columns: [
        {
          name: 'printing_id',
          type: 'text',
          nullable: false,
          meaning: 'Printing identity; unique within the published generation.',
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
          meaning: 'Language code of the printing.',
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
      ],
    },
    copies: {
      name: `${searchQuerySchema}.copies`,
      accountScoped: true,
      columns: [
        {
          name: 'copy_id',
          type: 'text',
          nullable: false,
          meaning: 'Physical-copy identity of the bound account.',
        },
        {
          name: 'printing_id',
          type: 'text',
          nullable: false,
          meaning: 'Published printing reference of the copy.',
        },
        {
          name: 'finish',
          type: 'text',
          nullable: false,
          meaning: 'Physical finish of the copy: nonfoil, foil or etched.',
        },
        {
          name: 'condition',
          type: 'text',
          nullable: true,
          meaning: 'Physical condition code; null while the condition is unknown.',
        },
        {
          name: 'owned',
          type: 'boolean',
          nullable: false,
          meaning: 'Whether the copy carries the account’s system owned association.',
        },
        {
          name: 'location_id',
          type: 'text',
          nullable: true,
          meaning: 'Tag identity of the copy’s single physical location; null while it has none.',
        },
      ],
    },
    tags: {
      name: `${searchQuerySchema}.tags`,
      accountScoped: true,
      columns: [
        {
          name: 'tag_id',
          type: 'text',
          nullable: false,
          meaning: 'Tag identity of the bound account; stable across label edits.',
        },
        {
          name: 'kind',
          type: 'text',
          nullable: false,
          meaning: 'Tag kind: deck, wishlist, location, other or the system owned tag.',
        },
        {
          name: 'label',
          type: 'text',
          nullable: false,
          meaning: 'Editable display label.',
        },
        {
          name: 'system',
          type: 'boolean',
          nullable: false,
          meaning: 'Whether the tag is system-managed.',
        },
      ],
    },
    associations: {
      name: `${searchQuerySchema}.associations`,
      accountScoped: true,
      columns: [
        {
          name: 'association_id',
          type: 'text',
          nullable: false,
          meaning: 'Association identity of the bound account.',
        },
        {
          name: 'tag_id',
          type: 'text',
          nullable: false,
          meaning: 'Tag the association belongs to.',
        },
        {
          name: 'target_level',
          type: 'text',
          nullable: false,
          meaning: 'Associated level: card, printing or copy.',
        },
        {
          name: 'target_id',
          type: 'text',
          nullable: false,
          meaning: 'Card, printing or copy identity at the associated level.',
        },
        {
          name: 'quantity',
          type: 'integer',
          nullable: true,
          meaning: 'Intended quantity of a card or printing association; null for copy membership.',
        },
      ],
    },
    indexState: {
      name: `${searchQuerySchema}.index_state`,
      accountScoped: false,
      columns: [
        {
          name: 'generation_id',
          type: 'text',
          nullable: false,
          meaning: 'Published generation these facts were indexed into.',
        },
        {
          name: 'catalog_revision',
          type: 'text',
          nullable: false,
          meaning: 'Catalog revision whose records this generation holds.',
        },
        {
          name: 'catalog_position',
          type: 'text',
          nullable: false,
          meaning: 'Catalog publication position this generation applied through.',
        },
      ],
    },
    accountState: {
      name: `${searchQuerySchema}.account_state`,
      accountScoped: true,
      columns: [
        {
          name: 'position',
          type: 'text',
          nullable: false,
          meaning:
            'Private publication position this generation applied through; the account-scoped freshness currency.',
        },
      ],
    },
  },
};

const colorValues = (['W', 'U', 'B', 'R', 'G'] satisfies readonly CardColor[])
  .map((color) => `'${color}'`)
  .join(', ');
const finishValues = finishes.map((finish) => `'${finish}'`).join(', ');
const conditionValues = copyConditions.map((condition) => `'${condition}'`).join(', ');
const tagKindValues = tagKinds.map((kind) => `'${kind}'`).join(', ');
const targetLevelValues = associationTargetLevels.map((level) => `'${level}'`).join(', ');

/**
 * The generation the read surface exposes. A rebuild writes its replacement beside this one, so
 * reads continue over the complete previous generation until the replacement is published.
 */
const publishedGenerationSql = `(select generation.generation_id
   from ${searchPrivateSchema}.generation as generation
  where generation.state = 'published')`;

/** The account bound to the connection, or null when none is bound or the setting was cleared. */
const boundAccountSql = `nullif(current_setting('${SEARCH_ACCOUNT_SETTING}', true), '')`;

/**
 * Schema owned by Search. Applying it is idempotent. One generation carries the catalog facts and
 * every account's private facts it indexed, with the checkpoint of each source it applied; the
 * published relation views expose the published generation only, and the private ones additionally
 * require the account bound to the read transaction.
 */
export const searchSchemaSql = `
create schema if not exists ${searchPrivateSchema};
create schema if not exists ${searchQuerySchema};

create table if not exists ${searchPrivateSchema}.generation (
  generation_id bigint not null generated always as identity primary key,
  state text not null default 'building' check (state in ('building', 'published')),
  started_at timestamptz not null default now(),
  published_at timestamptz,
  check ((state = 'published') = (published_at is not null))
);

-- One generation may be building while another is published; anything else is a lost update.
create unique index if not exists generation_building_index
  on ${searchPrivateSchema}.generation (state) where state = 'building';
create unique index if not exists generation_published_index
  on ${searchPrivateSchema}.generation (state) where state = 'published';

create table if not exists ${searchPrivateSchema}.catalog_checkpoint (
  generation_id bigint not null
    references ${searchPrivateSchema}.generation (generation_id) on delete cascade,
  position text not null check (length(position) between 1 and 20),
  revision_id text not null check (length(revision_id) between 1 and ${identifierLength}),
  primary key (generation_id)
);

create table if not exists ${searchPrivateSchema}.account_checkpoint (
  generation_id bigint not null
    references ${searchPrivateSchema}.generation (generation_id) on delete cascade,
  account_id text not null check (length(account_id) between 1 and ${identifierLength}),
  position text not null check (length(position) between 1 and 20),
  primary key (generation_id, account_id)
);

-- Durable, non-queryable snapshot progress. The continuation is provider-owned and opaque; the
-- offset resumes a payload-sized slice of the same provider page without advancing prematurely.
create table if not exists ${searchPrivateSchema}.snapshot_progress (
  generation_id bigint not null
    references ${searchPrivateSchema}.generation (generation_id) on delete cascade,
  source text not null check (source in ('catalog', 'account')),
  account_id text not null default '',
  phase text not null default 'snapshot' check (phase = 'snapshot'),
  continuation text,
  record_offset integer not null default 0 check (record_offset >= 0),
  source_position text not null check (length(source_position) between 1 and 20),
  revision_id text,
  primary key (generation_id, source, account_id),
  check ((source = 'catalog' and account_id = '' and revision_id is not null)
      or (source = 'account' and account_id <> '' and revision_id is null))
);

create table if not exists ${searchPrivateSchema}.catalog_progress (
  generation_id bigint not null references ${searchPrivateSchema}.generation on delete cascade,
  revision_id text not null,
  primary key (generation_id, revision_id)
);
create table if not exists ${searchPrivateSchema}.account_progress (
  generation_id bigint not null references ${searchPrivateSchema}.generation on delete cascade,
  account_id text not null,
  position text not null,
  primary key (generation_id, account_id, position)
);

create table if not exists ${searchPrivateSchema}.card (
  generation_id bigint not null
    references ${searchPrivateSchema}.generation (generation_id) on delete cascade,
  card_id text not null check (length(card_id) between 1 and ${identifierLength}),
  name text not null check (length(name) between 1 and 300),
  rules_text text,
  type_line text,
  colors text[] not null,
  color_identity text[] not null,
  mana_value numeric check (mana_value is null or mana_value >= 0),
  check (colors <@ array[${colorValues}]::text[] and cardinality(colors) <= 5),
  check (color_identity <@ array[${colorValues}]::text[] and cardinality(color_identity) <= 5),
  primary key (generation_id, card_id)
);

create table if not exists ${searchPrivateSchema}.card_name (
  generation_id bigint not null
    references ${searchPrivateSchema}.generation (generation_id) on delete cascade,
  card_id text not null check (length(card_id) between 1 and ${identifierLength}),
  language text not null check (length(language) between 1 and 20),
  name text not null check (length(name) between 1 and 300),
  primary key (generation_id, card_id, language, name)
);

create index if not exists card_name_lower_name_index
  on ${searchPrivateSchema}.card_name (generation_id, lower(name));

create table if not exists ${searchPrivateSchema}.printing (
  generation_id bigint not null
    references ${searchPrivateSchema}.generation (generation_id) on delete cascade,
  printing_id text not null check (length(printing_id) between 1 and ${identifierLength}),
  card_id text not null check (length(card_id) between 1 and ${identifierLength}),
  edition text not null check (length(edition) between 1 and 32),
  collector_number text not null check (length(collector_number) between 1 and 32),
  language text not null check (length(language) between 1 and 20),
  finishes text[] not null,
  physical boolean not null,
  constraint printing_finishes_check check (
    finishes <@ array[${finishValues}]::text[]
    and (not physical or cardinality(finishes) >= 1)
  ),
  primary key (generation_id, printing_id)
);

-- Upgrade an existing projection without rebuilding or discarding its published generation.
alter table ${searchPrivateSchema}.printing
  drop constraint if exists printing_finishes_check;
alter table ${searchPrivateSchema}.printing
  add constraint printing_finishes_check check (
    finishes <@ array[${finishValues}]::text[]
    and (not physical or cardinality(finishes) >= 1)
  );

create index if not exists printing_card_order_index
  on ${searchPrivateSchema}.printing (generation_id, card_id, edition, collector_number, language);

create table if not exists ${searchPrivateSchema}.copy (
  generation_id bigint not null
    references ${searchPrivateSchema}.generation (generation_id) on delete cascade,
  account_id text not null check (length(account_id) between 1 and ${identifierLength}),
  copy_id text not null check (length(copy_id) between 1 and ${identifierLength}),
  printing_id text not null check (length(printing_id) between 1 and ${identifierLength}),
  finish text not null check (finish in (${finishValues})),
  condition text check (condition in (${conditionValues})),
  owned boolean not null,
  location_id text check (location_id is null or length(location_id) between 1 and ${identifierLength}),
  primary key (generation_id, account_id, copy_id)
);

create index if not exists copy_printing_index
  on ${searchPrivateSchema}.copy (generation_id, account_id, printing_id);

create table if not exists ${searchPrivateSchema}.tag (
  generation_id bigint not null
    references ${searchPrivateSchema}.generation (generation_id) on delete cascade,
  account_id text not null check (length(account_id) between 1 and ${identifierLength}),
  tag_id text not null check (length(tag_id) between 1 and ${identifierLength}),
  kind text not null check (kind in (${tagKindValues})),
  label text not null check (length(label) between 1 and ${identifierLength}),
  system boolean not null,
  primary key (generation_id, account_id, tag_id)
);

create table if not exists ${searchPrivateSchema}.association (
  generation_id bigint not null
    references ${searchPrivateSchema}.generation (generation_id) on delete cascade,
  account_id text not null check (length(account_id) between 1 and ${identifierLength}),
  association_id text not null check (length(association_id) between 1 and ${identifierLength}),
  tag_id text not null check (length(tag_id) between 1 and ${identifierLength}),
  target_level text not null check (target_level in (${targetLevelValues})),
  target_id text not null check (length(target_id) between 1 and ${identifierLength}),
  quantity integer check (quantity is null or quantity >= 1),
  primary key (generation_id, account_id, association_id)
);

create index if not exists association_tag_index
  on ${searchPrivateSchema}.association (generation_id, account_id, tag_id);
create index if not exists association_target_index
  on ${searchPrivateSchema}.association (generation_id, account_id, target_level, target_id);

create or replace view ${searchQuerySchema}.cards as
  select card.card_id, card.name, card.rules_text, card.type_line, card.colors,
         card.color_identity, card.mana_value
  from ${searchPrivateSchema}.card as card
  where card.generation_id = ${publishedGenerationSql};

create or replace view ${searchQuerySchema}.card_names as
  select name.card_id, name.language, name.name
  from ${searchPrivateSchema}.card_name as name
  where name.generation_id = ${publishedGenerationSql};

create or replace view ${searchQuerySchema}.printings as
  select printing.printing_id, printing.card_id, printing.edition, printing.collector_number,
         printing.language, printing.finishes, printing.physical
  from ${searchPrivateSchema}.printing as printing
  where printing.generation_id = ${publishedGenerationSql};

create or replace view ${searchQuerySchema}.copies with (security_barrier) as
  select copy.copy_id, copy.printing_id, copy.finish, copy.condition, copy.owned, copy.location_id
  from ${searchPrivateSchema}.copy as copy
  where copy.generation_id = ${publishedGenerationSql}
    and copy.account_id = ${boundAccountSql};

create or replace view ${searchQuerySchema}.tags with (security_barrier) as
  select tag.tag_id, tag.kind, tag.label, tag.system
  from ${searchPrivateSchema}.tag as tag
  where tag.generation_id = ${publishedGenerationSql}
    and tag.account_id = ${boundAccountSql};

create or replace view ${searchQuerySchema}.associations with (security_barrier) as
  select association.association_id, association.tag_id, association.target_level,
         association.target_id, association.quantity
  from ${searchPrivateSchema}.association as association
  where association.generation_id = ${publishedGenerationSql}
    and association.account_id = ${boundAccountSql};

create or replace view ${searchQuerySchema}.index_state as
  select generation.generation_id::text as generation_id,
         checkpoint.revision_id as catalog_revision,
         checkpoint.position as catalog_position
  from ${searchPrivateSchema}.generation as generation
  join ${searchPrivateSchema}.catalog_checkpoint as checkpoint
    on checkpoint.generation_id = generation.generation_id
  where generation.state = 'published';

create or replace view ${searchQuerySchema}.account_state with (security_barrier) as
  select checkpoint.position
  from ${searchPrivateSchema}.account_checkpoint as checkpoint
  where checkpoint.generation_id = ${publishedGenerationSql}
    and checkpoint.account_id = ${boundAccountSql};

create or replace view ${searchQuerySchema}.catalog_progress as
  select revision_id from ${searchPrivateSchema}.catalog_progress
  where generation_id = ${publishedGenerationSql};
create or replace view ${searchQuerySchema}.account_progress with (security_barrier) as
  select position from ${searchPrivateSchema}.account_progress
  where generation_id = ${publishedGenerationSql} and account_id = ${boundAccountSql};

revoke all on schema ${searchPrivateSchema} from public;
`.trim();

/** Private tables the indexing role maintains; the read surface is views over the same state. */
const privateTables = [
  `${searchPrivateSchema}.catalog_progress`,
  `${searchPrivateSchema}.account_progress`,
  `${searchPrivateSchema}.generation`,
  `${searchPrivateSchema}.catalog_checkpoint`,
  `${searchPrivateSchema}.account_checkpoint`,
  `${searchPrivateSchema}.snapshot_progress`,
  `${searchPrivateSchema}.card`,
  `${searchPrivateSchema}.card_name`,
  `${searchPrivateSchema}.printing`,
  `${searchPrivateSchema}.copy`,
  `${searchPrivateSchema}.tag`,
  `${searchPrivateSchema}.association`,
] as const;

const rolePattern = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Grants the indexing role maintenance of the projection and nothing else: Search's own tables,
 * never a provider's relations (docs/data-architecture.md#access-and-deployment). Application
 * supplies this credential to the background indexing runtime, separately from the query role.
 */
export function searchIndexingGrants(role: string): string {
  assertRole(role);
  return [
    `grant usage on schema ${searchPrivateSchema} to "${role}";`,
    `grant select, insert, update, delete on ${privateTables.join(', ')} to "${role}";`,
    `grant usage, select on sequence ${searchPrivateSchema}.generation_generation_id_seq to "${role}";`,
  ].join('\n');
}

/**
 * Grants the query role read access to the published projection and nothing else: the declared
 * relations of the published generation, with the private ones scoped by the account bound to the
 * read transaction. The private tables stay unreachable.
 */
export function searchReaderGrants(role: string): string {
  assertRole(role);
  const relations = Object.values(SEARCH_PROJECTION_SURFACE.relations).map(
    (relation) => relation.name,
  );
  return [
    `grant usage on schema ${searchQuerySchema} to "${role}";`,
    `grant select on ${relations.join(', ')} to "${role}";`,
  ].join('\n');
}

function assertRole(role: string): void {
  if (!rolePattern.test(role)) {
    throw new TypeError(
      `Search role must be a lowercase PostgreSQL identifier, received "${role}".`,
    );
  }
}
