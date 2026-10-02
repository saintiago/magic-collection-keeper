/**
 * Atomic publication of one candidate revision (docs/catalog.md#synchronization).
 *
 * Candidate records are upserted in bounded batches inside a single database transaction, so a
 * failed or interrupted ingestion leaves the previous revision and its records exactly as they
 * were, and readers observe either the complete previous revision or the complete candidate one.
 * The same transaction appends the durable publication stream the query publication serves: one
 * change per record this revision inserted, changed or restored, then the revision that completes
 * them and the retention of older publications. Removed records keep their stored facts for
 * historical resolution and transitional consumers; current Catalog queries use separate
 * membership flags.
 */

import { CatalogError } from './errors.js';
import type { CatalogSqlExecutor, CatalogSqlTransactor } from './executor.js';
import type { CatalogRevision } from './model.js';
import { CATALOG_PUBLICATION_LIMITS } from './query-publication.js';
import { readPublishedRevision } from './postgres.js';
import type { MappedProviderRecord } from './scryfall.js';
import { CATALOG_SYNCHRONIZATION_LIMITS } from './snapshot.js';

/** The revision one publication creates; the caller supplies its identity and instant. */
export interface CandidateRevision {
  readonly revisionId: string;
  readonly sourceName: string;
  readonly sourceVersion: string;
  readonly publishedAt: string;
}

/** What one publication attempt left published: the candidate, or the version that got there first. */
export interface PublicationOutcome {
  /** The revision readers observe after the attempt. */
  readonly revision: CatalogRevision;
  /** False when the source and version were already published; nothing was written then. */
  readonly published: boolean;
}

/**
 * Whether the revision readers observe already carries this provider source and version. The
 * pre-read that avoids opening an unchanged snapshot and the publication transaction both use it.
 */
export function alreadyPublished(
  published: CatalogRevision | null,
  source: { readonly sourceName: string; readonly sourceVersion: string },
): published is CatalogRevision {
  return (
    published !== null &&
    published.sourceName === source.sourceName &&
    published.sourceVersion === source.sourceVersion
  );
}

/**
 * One publication lock name. Concurrent synchronization tasks serialize on it: the loser reports
 * `busy` instead of interleaving two candidate revisions into one published state.
 */
const publicationLockStatement = `select case
    when pg_try_advisory_xact_lock(hashtext('catalog_private.synchronization')::bigint) then 'true'
    else 'false'
  end as locked`;

/**
 * One candidate batch writes its records and the change of every record it inserted or changed.
 * The change carries the stored record, so a consumer applies the published facts without reading
 * the catalog's storage; the `where ... is distinct from` clause keeps a repeated record out of
 * the stream, and the conflict clause keeps one change per identity within a revision.
 */
const cardWriteStatement = `with candidate as (
  select card_id, name, rules_text, type_line, colors, color_identity, mana_value
  from jsonb_to_recordset(cast(:card_batch as jsonb)) as entry(
    card_id text,
    name text,
    rules_text text,
    type_line text,
    colors text[],
    color_identity text[],
    mana_value numeric
  )
),
changed as (
  insert into catalog_private.card as stored (
    card_id, name, rules_text, type_line, colors, color_identity, mana_value, current, candidate
  )
  select card_id, name, rules_text, type_line, colors, color_identity, mana_value, true, true
  from candidate
  on conflict (card_id) do update set
    name = excluded.name,
    rules_text = excluded.rules_text,
    type_line = excluded.type_line,
    colors = excluded.colors,
    color_identity = excluded.color_identity,
    mana_value = excluded.mana_value,
    current = true,
    candidate = true
  where not stored.current
     or (stored.name, stored.rules_text, stored.type_line, stored.colors, stored.color_identity,
         stored.mana_value)
     is distinct from
        (excluded.name, excluded.rules_text, excluded.type_line, excluded.colors,
         excluded.color_identity, excluded.mana_value)
  returning card_id, name, rules_text, type_line, colors, color_identity, mana_value
)
insert into catalog_private.publication (
    revision_id, source_name, source_version, published_at, kind, record_identity, removed, record
  )
  select :revision_id, :source_name, :source_version, cast(:published_at as timestamptz),
         'card', published_record.card_id, false, to_jsonb(published_record)
  from changed as published_record
  on conflict (revision_id, kind, record_identity) do update set record = excluded.record`;

const nameWriteStatement = `with candidate as (
  select card_id, language, name
  from jsonb_to_recordset(cast(:name_batch as jsonb)) as entry(
    card_id text,
    language text,
    name text
  )
),
changed as (
  insert into catalog_private.card_name (card_id, language, name, current, candidate)
  select card_id, language, name, true, true
  from candidate
  on conflict (card_id, language, name) do update set current = true, candidate = true
  where not catalog_private.card_name.current
  returning card_id, language, name
)
insert into catalog_private.publication (
    revision_id, source_name, source_version, published_at, kind, record_identity, removed, record
  )
  select :revision_id, :source_name, :source_version, cast(:published_at as timestamptz),
         'card-name',
         jsonb_build_array(published_record.card_id, published_record.language,
                           published_record.name)::text,
         false, to_jsonb(published_record)
  from changed as published_record
  on conflict (revision_id, kind, record_identity) do update set record = excluded.record`;

const printingWriteStatement = `with candidate as (
  select printing_id, card_id, edition, collector_number, language, finishes, physical,
         image_small, image_normal, image_large, image_art_crop
  from jsonb_to_recordset(cast(:printing_batch as jsonb)) as entry(
    printing_id text,
    card_id text,
    edition text,
    collector_number text,
    language text,
    finishes text[],
    physical boolean,
    image_small text,
    image_normal text,
    image_large text,
    image_art_crop text
  )
),
changed as (
  insert into catalog_private.printing as stored (
    printing_id, card_id, edition, collector_number, language, finishes, physical,
    image_small, image_normal, image_large, image_art_crop, current, candidate
  )
  select printing_id, card_id, edition, collector_number, language, finishes, physical,
         image_small, image_normal, image_large, image_art_crop, true, true
  from candidate
  on conflict (printing_id) do update set
    card_id = excluded.card_id,
    edition = excluded.edition,
    collector_number = excluded.collector_number,
    language = excluded.language,
    finishes = excluded.finishes,
    physical = excluded.physical,
    image_small = excluded.image_small,
    image_normal = excluded.image_normal,
    image_large = excluded.image_large,
    image_art_crop = excluded.image_art_crop,
    current = true,
    candidate = true
  where not stored.current
     or (stored.card_id, stored.edition, stored.collector_number, stored.language, stored.finishes,
         stored.physical, stored.image_small, stored.image_normal, stored.image_large,
         stored.image_art_crop)
     is distinct from
        (excluded.card_id, excluded.edition, excluded.collector_number, excluded.language,
         excluded.finishes, excluded.physical, excluded.image_small, excluded.image_normal,
         excluded.image_large, excluded.image_art_crop)
  returning printing_id, card_id, edition, collector_number, language, finishes, physical,
            image_small, image_normal, image_large, image_art_crop
)
insert into catalog_private.publication (
    revision_id, source_name, source_version, published_at, kind, record_identity, removed, record
  )
  select :revision_id, :source_name, :source_version, cast(:published_at as timestamptz),
         'printing', published_record.printing_id, false, to_jsonb(published_record)
  from changed as published_record
  on conflict (revision_id, kind, record_identity) do update set record = excluded.record`;

/** Marks unchanged records as members of the candidate without publishing a redundant change. */
const cardMarkStatement = `update catalog_private.card as stored
set candidate = true
from jsonb_to_recordset(cast(:card_batch as jsonb)) as entry(card_id text)
where stored.card_id = entry.card_id and not stored.candidate`;

const nameMarkStatement = `update catalog_private.card_name as stored
set candidate = true
from jsonb_to_recordset(cast(:name_batch as jsonb)) as entry(
  card_id text, language text, name text
)
where stored.card_id = entry.card_id
  and stored.language = entry.language
  and stored.name = entry.name
  and not stored.candidate`;

const printingMarkStatement = `update catalog_private.printing as stored
set candidate = true
from jsonb_to_recordset(cast(:printing_batch as jsonb)) as entry(printing_id text)
where stored.printing_id = entry.printing_id and not stored.candidate`;

/** A provider-stable printing identity may never move to another playable identity. */
const printingRelationshipConflictStatement = `select stored.printing_id
from catalog_private.printing as stored
join jsonb_to_recordset(cast(:printing_batch as jsonb)) as entry(
  printing_id text, card_id text
) on entry.printing_id = stored.printing_id
where entry.card_id <> stored.card_id
limit 1`;

const resetCandidateStatements = [
  `update catalog_private.card set candidate = false where candidate`,
  `update catalog_private.card_name set candidate = false where candidate`,
  `update catalog_private.printing set candidate = false where candidate`,
] as const;

const finishMembershipStatements = [
  `update catalog_private.card set current = candidate`,
  `update catalog_private.card_name set current = candidate`,
  `update catalog_private.printing set current = candidate`,
] as const;

/**
 * The revision that completes the candidate. It is written after every record change of the
 * revision, so its position is the snapshot position and a consumer that applied it holds the
 * complete revision.
 */
const revisionChangeStatement = `insert into catalog_private.publication (
    revision_id, source_name, source_version, published_at, kind, record_identity, removed, record
  )
  values (
    :revision_id, :source_name, :source_version, cast(:published_at as timestamptz),
    'revision', null, false, null
  )`;

/** Retains the declared number of newest publications; older positions expire explicitly. */
const retentionStatement = `delete from catalog_private.publication
where position < (
  select marker.position
  from (
    select position, row_number() over (order by position desc) as marker_rank
    from catalog_private.publication
    where kind = 'revision'
  ) as marker
  where marker.marker_rank = :retained_publications
)`;

const revisionUpsertStatement = `insert into catalog_private.revision (
    singleton, revision_id, source_name, source_version, published_at
  )
  values (true, :revision_id, :source_name, :source_version, cast(:published_at as timestamptz))
  on conflict (singleton) do update set
    revision_id = excluded.revision_id,
    source_name = excluded.source_name,
    source_version = excluded.source_version,
    published_at = excluded.published_at`;

/**
 * Publishes the candidate revision in one transaction, or leaves the published one untouched.
 * The decision to publish happens under the publication lock: when an overlapping invocation
 * published the same provider source and version while this one opened its snapshot, the existing
 * revision is returned without writing anything.
 */
export async function publishCandidate(
  sql: CatalogSqlTransactor,
  candidate: CandidateRevision,
  records: AsyncIterable<MappedProviderRecord>,
): Promise<PublicationOutcome> {
  return await sql.transaction(async (statements) => {
    await takePublicationLock(statements);
    const published = await readPublishedRevision(statements);
    if (alreadyPublished(published, candidate)) {
      return { revision: published, published: false };
    }

    for (const statement of resetCandidateStatements) {
      await statements.query(statement);
    }

    let buffered: SerializedRecord[] = [];
    let batched = 0;
    let bytes = 0;
    const printingCards = new Map<string, string>();
    const revision = {
      revision_id: candidate.revisionId,
      source_name: candidate.sourceName,
      source_version: candidate.sourceVersion,
      published_at: candidate.publishedAt,
    };

    const flush = async (): Promise<void> => {
      if (buffered.length === 0) {
        return;
      }
      const rows = collapseBatch(buffered);
      buffered = [];
      batched = 0;
      bytes = 0;
      // Cards precede the names and printings that reference them, and one batch never exceeds the
      // declared transport bounds (see serializeRecord).
      await statements.query(cardWriteStatement, { card_batch: rows.cards, ...revision });
      await statements.query(cardMarkStatement, { card_batch: rows.cards });
      await statements.query(nameWriteStatement, { name_batch: rows.names, ...revision });
      await statements.query(nameMarkStatement, { name_batch: rows.names });
      const conflicts = await statements.query(printingRelationshipConflictStatement, {
        printing_batch: rows.printings,
      });
      if (conflicts.length > 0) {
        throw new CatalogError(
          'unavailable',
          `The ${candidate.sourceName} snapshot changes a printing’s playable identity.`,
        );
      }
      await statements.query(printingWriteStatement, {
        printing_batch: rows.printings,
        ...revision,
      });
      await statements.query(printingMarkStatement, { printing_batch: rows.printings });
    };

    let ingested = 0;
    for await (const record of records) {
      const serialized = serializeRecord(record);
      const knownCard = printingCards.get(serialized.printingId);
      if (knownCard !== undefined && knownCard !== serialized.cardId) {
        throw new CatalogError(
          'unavailable',
          `The ${candidate.sourceName} snapshot assigns one printing identity to several cards.`,
        );
      }
      printingCards.set(serialized.printingId, serialized.cardId);
      if (
        buffered.length > 0 &&
        (batched >= CATALOG_SYNCHRONIZATION_LIMITS.maxRecordsPerStatement ||
          bytes + serialized.bytes > CATALOG_SYNCHRONIZATION_LIMITS.maxStatementBytes)
      ) {
        await flush();
      }
      if (serialized.bytes > CATALOG_SYNCHRONIZATION_LIMITS.maxStatementBytes) {
        throw new CatalogError(
          'unavailable',
          `The ${candidate.sourceName} snapshot contains a record larger than the catalog write bound.`,
        );
      }
      buffered.push(serialized);
      batched += 1;
      bytes += serialized.bytes;
      ingested += 1;
    }
    if (ingested === 0) {
      // An empty candidate is a truncated or wrong source, not an empty catalog: publishing it
      // would only drift the revision away from the records readers can still resolve.
      throw new CatalogError(
        'unavailable',
        `The ${candidate.sourceName} snapshot contains no card records.`,
      );
    }
    await flush();
    for (const statement of finishMembershipStatements) {
      await statements.query(statement);
    }
    // The revision that completes the candidate is the last position of this publication: the
    // snapshot reports it, and a consumer that applied it holds every record the revision changed.
    await statements.query(revisionChangeStatement, revision);
    await statements.query(revisionUpsertStatement, revision);
    await statements.query(retentionStatement, {
      retained_publications: CATALOG_PUBLICATION_LIMITS.retainedPublications,
    });
    return { revision: candidate, published: true };
  });
}

async function takePublicationLock(statements: CatalogSqlExecutor): Promise<void> {
  const rows = await statements.query(publicationLockStatement);
  const locked = rows[0]?.locked;
  if (locked === 'false' || locked === false) {
    throw new CatalogError('busy', 'Another catalog synchronization is publishing a revision.');
  }
  if (locked !== 'true' && locked !== true) {
    throw new CatalogError(
      'unavailable',
      'The catalog database did not answer the synchronization lock.',
    );
  }
}

interface SerializedRecord {
  readonly cardId: string;
  readonly card: string;
  readonly names: readonly string[];
  readonly printingId: string;
  readonly printing: string;
  /** Bytes this record adds to its batch, including the JSON array separators. */
  readonly bytes: number;
}

interface CollapsedBatch {
  readonly cards: string;
  readonly names: string;
  readonly printings: string;
}

/**
 * One candidate batch writes one row per identity, so a snapshot that publishes the same identity
 * several times (every translated printing of a card shares its card row) stays one statement.
 * PostgreSQL rejects a single upsert statement that touches the same constrained row twice; the
 * last record of an identity in a batch wins, exactly as a later batch would overwrite it.
 */
function collapseBatch(records: readonly SerializedRecord[]): CollapsedBatch {
  const cards = new Map<string, string>();
  const names = new Set<string>();
  const printings = new Map<string, string>();
  for (const record of records) {
    cards.set(record.cardId, record.card);
    for (const name of record.names) {
      names.add(name);
    }
    printings.set(record.printingId, record.printing);
  }
  return {
    cards: `[${[...cards.values()].join(',')}]`,
    names: `[${[...names].join(',')}]`,
    printings: `[${[...printings.values()].join(',')}]`,
  };
}

/** Serializes the published columns of one record; the storage mapping has one home here. */
function serializeRecord(record: MappedProviderRecord): SerializedRecord {
  const card = JSON.stringify({
    card_id: record.card.cardId,
    name: record.card.name,
    rules_text: record.card.rulesText,
    type_line: record.card.typeLine,
    colors: record.card.colors,
    color_identity: record.card.colorIdentity,
    mana_value: record.card.manaValue,
  });
  const names = record.card.names.map((name) =>
    JSON.stringify({ card_id: record.card.cardId, language: name.language, name: name.name }),
  );
  const printing = JSON.stringify({
    printing_id: record.printing.printingId,
    card_id: record.printing.cardId,
    edition: record.printing.edition,
    collector_number: record.printing.collectorNumber,
    language: record.printing.language,
    finishes: record.printing.finishes,
    physical: record.printing.physical,
    image_small: record.printing.images.small,
    image_normal: record.printing.images.normal,
    image_large: record.printing.images.large,
    image_art_crop: record.printing.images.artCrop,
  });
  const bytes =
    byteLength(card) +
    names.reduce((total, name) => total + byteLength(name), 0) +
    byteLength(printing) +
    names.length +
    3;
  return {
    cardId: record.card.cardId,
    card,
    names,
    printingId: record.printing.printingId,
    printing,
    bytes,
  };
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}
