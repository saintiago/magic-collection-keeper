import { z } from 'zod';

import { CatalogError } from './errors.js';
import type { CatalogSqlExecutor, CatalogSqlRow, CatalogSqlValue } from './executor.js';
import {
  cardColors,
  CATALOG_LIMITS,
  finishes,
  type CardName,
  type CardRecord,
  type CatalogRevision,
  type PrintingRecord,
} from './model.js';
import type { CardPrintingsData, CatalogReadStore, ResolvedCatalogData } from './store.js';

const identifierLength = CATALOG_LIMITS.maxIdentifierLength;

const revisionColumn = `json_build_object(
    'revision_id', revision.revision_id,
    'source_name', revision.source_name,
    'source_version', revision.source_version,
    'published_at', revision.published_at
  )::text`;

const revisionJsonSchema = z.object({
  revision_id: z.string().min(1).max(identifierLength),
  source_name: z.string().min(1).max(200),
  source_version: z.string().min(1).max(200),
  published_at: z.string().min(1),
});

const cardJsonSchema = z.object({
  card_id: z.string().min(1).max(identifierLength),
  name: z.string().min(1).max(300),
  rules_text: z.string().nullable(),
  type_line: z.string().nullable(),
  colors: z.array(z.enum(cardColors)),
  color_identity: z.array(z.enum(cardColors)),
  mana_value: z.number().nullable(),
});

const cardNameJsonSchema = z.object({
  card_id: z.string().min(1).max(identifierLength),
  language: z.string().min(1).max(20),
  name: z.string().min(1).max(300),
});

const printingJsonSchema = z.object({
  printing_id: z.string().min(1).max(identifierLength),
  card_id: z.string().min(1).max(identifierLength),
  edition: z.string().min(1).max(32),
  collector_number: z.string().min(1).max(32),
  language: z.string().min(1).max(20),
  finishes: z.array(z.enum(finishes)).min(1),
  physical: z.boolean(),
  image_small: z.string().nullable(),
  image_normal: z.string().nullable(),
  image_large: z.string().nullable(),
  image_art_crop: z.string().nullable(),
});

interface NamedPlaceholders {
  readonly list: string;
  readonly parameters: Record<string, string>;
}

/** One placeholder per value; RDS Data API parameters are named and never arrays. */
function placeholdersFor(values: readonly string[], prefix: string): NamedPlaceholders {
  const parameters: Record<string, string> = {};
  const names = values.map((value, index) => {
    parameters[`${prefix}_${index}`] = value;
    return `:${prefix}_${index}`;
  });
  return { list: names.join(', '), parameters };
}

/**
 * One row per record. The deployed executor reaches Aurora through the RDS Data API, which caps a
 * response row at 64 KB, so a read never aggregates a whole batch or page into one row.
 * `row_position` keeps the declared record order inside the statement's single snapshot.
 */
function recordRows(options: {
  readonly kind: string;
  readonly columns: string;
  readonly table: string;
  readonly filter: string;
  readonly orderBy: string;
}): string {
  return `select '${options.kind}' as row_kind,
  (row_number() over (order by ${options.orderBy}))::int as row_position,
  to_jsonb(entry)::text as payload
from (select ${options.columns}
      from ${options.table} where ${options.filter}) as entry`;
}

function resolveStatement(
  cardIds: readonly string[],
  printingIds: readonly string[],
): { statement: string; parameters: Record<string, CatalogSqlValue> } {
  const card = placeholdersFor(cardIds, 'card');
  const name = placeholdersFor(cardIds, 'name');
  const printing = placeholdersFor(printingIds, 'printing');
  const branches = [
    `select 'revision' as row_kind,
  0 as row_position,
  ${revisionColumn} as payload
from catalog.published_revision as revision`,
  ];
  if (cardIds.length > 0) {
    branches.push(
      recordRows({
        kind: 'card',
        columns: 'card_id, name, rules_text, type_line, colors, color_identity, mana_value',
        table: 'catalog.cards',
        filter: `card_id in (${card.list})`,
        orderBy: 'card_id',
      }),
      recordRows({
        kind: 'name',
        columns: 'card_id, language, name',
        table: 'catalog.card_names',
        filter: `card_id in (${name.list})`,
        orderBy: 'card_id, language, name',
      }),
    );
  }
  if (printingIds.length > 0) {
    branches.push(
      recordRows({
        kind: 'printing',
        columns: `printing_id, card_id, edition, collector_number, language, finishes, physical,
                   image_small, image_normal, image_large, image_art_crop`,
        table: 'catalog.printings',
        filter: `printing_id in (${printing.list})`,
        orderBy: 'printing_id',
      }),
    );
  }
  const statement = `${branches.join('\nunion all\n')}
order by row_kind, row_position`;
  return {
    statement,
    parameters: { ...card.parameters, ...name.parameters, ...printing.parameters },
  };
}

function listPrintingsStatement(
  cardId: string,
  offset: number,
  limit: number,
): { statement: string; parameters: Record<string, CatalogSqlValue> } {
  const statement = `with page as (
  select printing_id, card_id, edition, collector_number, language, finishes, physical,
         image_small, image_normal, image_large, image_art_crop
  from catalog.printings
  where card_id = :page_card_id
  order by edition, collector_number, language, printing_id
  limit :page_limit offset :page_offset
)
select
  'revision' as row_kind,
  0 as row_position,
  ${revisionColumn} as payload,
  case when exists (select 1 from catalog.cards where card_id = :card_present_id)
       then 'true' else 'false' end as card_exists
from catalog.published_revision as revision
union all
select
  'printing' as row_kind,
  (row_number() over (
     order by page.edition, page.collector_number, page.language, page.printing_id
   ))::int as row_position,
  to_jsonb(page)::text as payload,
  null::text as card_exists
from page
order by row_kind, row_position`;
  return {
    statement,
    parameters: {
      page_card_id: cardId,
      card_present_id: cardId,
      page_limit: limit,
      page_offset: offset,
    },
  };
}

async function readRows(
  sql: CatalogSqlExecutor,
  statement: string,
  parameters: Readonly<Record<string, CatalogSqlValue>>,
): Promise<readonly CatalogSqlRow[]> {
  try {
    return await sql.query(statement, parameters);
  } catch (cause) {
    throw new CatalogError('unavailable', 'The catalog database could not be read.', { cause });
  }
}

function parseJsonText<T>(schema: z.ZodType<T>, value: CatalogSqlValue | undefined): T {
  if (typeof value !== 'string') {
    throw new CatalogError('unavailable', 'The catalog returned a result that is not readable.');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch (cause) {
    throw new CatalogError('unavailable', 'The catalog returned unreadable result data.', {
      cause,
    });
  }
  const parsed = schema.safeParse(decoded);
  if (!parsed.success) {
    throw new CatalogError(
      'unavailable',
      'The catalog data does not match its declared read contract.',
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

type RevisionJson = z.infer<typeof revisionJsonSchema>;
type CardJson = z.infer<typeof cardJsonSchema>;
type CardNameJson = z.infer<typeof cardNameJsonSchema>;
type PrintingJson = z.infer<typeof printingJsonSchema>;

interface GroupedRows {
  readonly revision: readonly CatalogSqlRow[];
  readonly cards: readonly CatalogSqlRow[];
  readonly names: readonly CatalogSqlRow[];
  readonly printings: readonly CatalogSqlRow[];
}

/** Groups the statement's rows by record kind; anything else violates the read contract. */
function groupRows(rows: readonly CatalogSqlRow[]): GroupedRows {
  const grouped: {
    revision: CatalogSqlRow[];
    cards: CatalogSqlRow[];
    names: CatalogSqlRow[];
    printings: CatalogSqlRow[];
  } = { revision: [], cards: [], names: [], printings: [] };
  for (const row of rows) {
    switch (row.row_kind) {
      case 'revision':
        grouped.revision.push(row);
        break;
      case 'card':
        grouped.cards.push(row);
        break;
      case 'name':
        grouped.names.push(row);
        break;
      case 'printing':
        grouped.printings.push(row);
        break;
      default:
        throw new CatalogError(
          'unavailable',
          'The catalog returned a result that is not readable.',
        );
    }
  }
  return grouped;
}

function revisionFromJson(json: RevisionJson): {
  readonly revisionId: string;
  readonly sourceName: string;
  readonly sourceVersion: string;
  readonly publishedAt: string;
} {
  const publishedAt = new Date(json.published_at);
  if (Number.isNaN(publishedAt.getTime())) {
    throw new CatalogError(
      'unavailable',
      'The published catalog revision has an unreadable publication time.',
    );
  }
  return {
    revisionId: json.revision_id,
    sourceName: json.source_name,
    sourceVersion: json.source_version,
    publishedAt: publishedAt.toISOString(),
  };
}

function readRecords<T>(rows: readonly CatalogSqlRow[], schema: z.ZodType<T>): T[] {
  return rows.map((row) => parseJsonText(schema, row.payload));
}

function revisionFromRows(rows: GroupedRows): CatalogRevision {
  const row = rows.revision[0];
  if (row === undefined) {
    throw new CatalogError('unavailable', 'The catalog has no published revision.');
  }
  return revisionFromJson(parseJsonText(revisionJsonSchema, row.payload));
}

function cardRecords(cards: readonly CardJson[], names: readonly CardNameJson[]): CardRecord[] {
  const namesByCard = new Map<string, CardName[]>();
  for (const name of names) {
    const aliases = namesByCard.get(name.card_id) ?? [];
    aliases.push({ language: name.language, name: name.name });
    namesByCard.set(name.card_id, aliases);
  }
  return cards.map((card) => ({
    cardId: card.card_id,
    name: card.name,
    names: namesByCard.get(card.card_id) ?? [],
    rulesText: card.rules_text,
    typeLine: card.type_line,
    colors: card.colors,
    colorIdentity: card.color_identity,
    manaValue: card.mana_value,
  }));
}

function printingRecords(printings: readonly PrintingJson[]): PrintingRecord[] {
  return printings.map((printing) => ({
    printingId: printing.printing_id,
    cardId: printing.card_id,
    edition: printing.edition,
    collectorNumber: printing.collector_number,
    language: printing.language,
    finishes: printing.finishes,
    physical: printing.physical,
    images: {
      small: printing.image_small,
      normal: printing.image_normal,
      large: printing.image_large,
      artCrop: printing.image_art_crop,
    },
  }));
}

/** Reads the published views; every statement observes one published revision. */
export function createPostgresReadStore(sql: CatalogSqlExecutor): CatalogReadStore {
  return {
    async resolve(cardIds, printingIds): Promise<ResolvedCatalogData> {
      const { statement, parameters } = resolveStatement(cardIds, printingIds);
      const rows = groupRows(await readRows(sql, statement, parameters));
      return {
        revision: revisionFromRows(rows),
        cards: cardRecords(
          readRecords(rows.cards, cardJsonSchema),
          readRecords(rows.names, cardNameJsonSchema),
        ),
        printings: printingRecords(readRecords(rows.printings, printingJsonSchema)),
      };
    },

    async listPrintings(cardId, offset, limit): Promise<CardPrintingsData> {
      const { statement, parameters } = listPrintingsStatement(cardId, offset, limit);
      const rows = groupRows(await readRows(sql, statement, parameters));
      const revisionRow = rows.revision[0];
      if (revisionRow === undefined) {
        throw new CatalogError('unavailable', 'The catalog has no published revision.');
      }
      return {
        revision: revisionFromRows(rows),
        cardExists: cardExistsValue(revisionRow.card_exists),
        printings: printingRecords(readRecords(rows.printings, printingJsonSchema)),
      };
    },
  };
}

function cardExistsValue(value: CatalogSqlValue | undefined): boolean {
  if (value === 'true' || value === true) {
    return true;
  }
  if (value === 'false' || value === false) {
    return false;
  }
  throw new CatalogError('unavailable', 'The catalog returned a result that is not readable.');
}
