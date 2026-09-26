/**
 * Atomic publication of one candidate revision (docs/catalog.md#synchronization).
 *
 * Candidate records are upserted in bounded batches inside a single database transaction, so a
 * failed or interrupted ingestion leaves the previous revision and its records exactly as they
 * were, and readers observe either the complete previous revision or the complete candidate one.
 * Records the provider no longer publishes keep their published row: existing references stay
 * resolvable.
 */

import { CatalogError } from './errors.js';
import type { CatalogSqlExecutor, CatalogSqlTransactor } from './executor.js';
import type { MappedProviderRecord } from './scryfall.js';
import { CATALOG_SYNCHRONIZATION_LIMITS } from './snapshot.js';

/** The revision one publication creates; the caller supplies its identity and instant. */
export interface CandidateRevision {
  readonly revisionId: string;
  readonly sourceName: string;
  readonly sourceVersion: string;
  readonly publishedAt: string;
}

/**
 * One publication lock name. Concurrent synchronization tasks serialize on it: the loser reports
 * `busy` instead of interleaving two candidate revisions into one published state.
 */
const publicationLockStatement = `select case
    when pg_try_advisory_xact_lock(hashtext('catalog_private.synchronization')::bigint) then 'true'
    else 'false'
  end as locked`;

const cardUpsertStatement = `insert into catalog_private.card (
    card_id, name, rules_text, type_line, colors, color_identity, mana_value
  )
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
  on conflict (card_id) do update set
    name = excluded.name,
    rules_text = excluded.rules_text,
    type_line = excluded.type_line,
    colors = excluded.colors,
    color_identity = excluded.color_identity,
    mana_value = excluded.mana_value`;

const nameUpsertStatement = `insert into catalog_private.card_name (card_id, language, name)
  select card_id, language, name
  from jsonb_to_recordset(cast(:name_batch as jsonb)) as entry(
    card_id text,
    language text,
    name text
  )
  on conflict do nothing`;

const printingUpsertStatement = `insert into catalog_private.printing (
    printing_id, card_id, edition, collector_number, language, finishes, physical,
    image_small, image_normal, image_large, image_art_crop
  )
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
    image_art_crop = excluded.image_art_crop`;

const revisionUpsertStatement = `insert into catalog_private.revision (
    singleton, revision_id, source_name, source_version, published_at
  )
  values (true, :revision_id, :source_name, :source_version, :published_at)
  on conflict (singleton) do update set
    revision_id = excluded.revision_id,
    source_name = excluded.source_name,
    source_version = excluded.source_version,
    published_at = excluded.published_at`;

/** Publishes the candidate revision in one transaction, or leaves the published one untouched. */
export async function publishCandidate(
  sql: CatalogSqlTransactor,
  revision: CandidateRevision,
  records: AsyncIterable<MappedProviderRecord>,
): Promise<void> {
  await sql.transaction(async (statements) => {
    await takePublicationLock(statements);

    let candidate: SerializedRecord[] = [];
    let batched = 0;
    let bytes = 0;

    const flush = async (): Promise<void> => {
      if (candidate.length === 0) {
        return;
      }
      const rows = collapseBatch(candidate);
      candidate = [];
      batched = 0;
      bytes = 0;
      // Cards precede the names and printings that reference them, and one batch never exceeds the
      // declared transport bounds (see serializeRecord).
      await statements.query(cardUpsertStatement, { card_batch: rows.cards });
      await statements.query(nameUpsertStatement, { name_batch: rows.names });
      await statements.query(printingUpsertStatement, { printing_batch: rows.printings });
    };

    let ingested = 0;
    for await (const record of records) {
      const serialized = serializeRecord(record);
      if (
        candidate.length > 0 &&
        (batched >= CATALOG_SYNCHRONIZATION_LIMITS.maxRecordsPerStatement ||
          bytes + serialized.bytes > CATALOG_SYNCHRONIZATION_LIMITS.maxStatementBytes)
      ) {
        await flush();
      }
      if (serialized.bytes > CATALOG_SYNCHRONIZATION_LIMITS.maxStatementBytes) {
        throw new CatalogError(
          'unavailable',
          `The ${revision.sourceName} snapshot contains a record larger than the catalog write bound.`,
        );
      }
      candidate.push(serialized);
      batched += 1;
      bytes += serialized.bytes;
      ingested += 1;
    }
    if (ingested === 0) {
      // An empty candidate is a truncated or wrong source, not an empty catalog: publishing it
      // would only drift the revision away from the records readers can still resolve.
      throw new CatalogError(
        'unavailable',
        `The ${revision.sourceName} snapshot contains no card records.`,
      );
    }
    await flush();
    await statements.query(revisionUpsertStatement, {
      revision_id: revision.revisionId,
      source_name: revision.sourceName,
      source_version: revision.sourceVersion,
      published_at: revision.publishedAt,
    });
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
