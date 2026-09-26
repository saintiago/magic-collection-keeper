/**
 * Scryfall bulk record mapping. Provider formats stay inside the Catalog boundary
 * (docs/catalog.md#synchronization): callers hand over one parsed snapshot record and receive the
 * card, name and printing records the catalog publishes, or an explicit failure.
 */

import { z } from 'zod';

import { CatalogError } from './errors.js';
import {
  cardColors,
  CATALOG_LIMITS,
  finishes,
  type CardColor,
  type CardName,
  type CardRecord,
  type Finish,
  type PrintingImages,
  type PrintingRecord,
} from './model.js';

/** The catalog records one provider record maps onto. */
export interface MappedProviderRecord {
  readonly card: CardRecord;
  readonly printing: PrintingRecord;
}

/** Where a failing record came from, for diagnostics that stay free of record contents. */
export interface ProviderRecordContext {
  readonly sourceName: string;
  readonly position: number;
}

const identifierLength = CATALOG_LIMITS.maxIdentifierLength;

const imageUrisSchema = z.object({
  small: z.string().min(1).nullish(),
  normal: z.string().min(1).nullish(),
  large: z.string().min(1).nullish(),
  art_crop: z.string().min(1).nullish(),
});

const cardFaceSchema = z.object({
  name: z.string().min(1).max(300),
  printed_name: z.string().min(1).max(300).nullish(),
  oracle_text: z.string().nullish(),
  colors: z.array(z.enum(cardColors)).optional(),
  image_uris: imageUrisSchema.nullish(),
});

/**
 * The published fields of a Scryfall card object the catalog needs. Scryfall publishes many more
 * fields; they stay unread, and provider additions do not force catalog changes.
 */
const scryfallCardSchema = z.object({
  object: z.literal('card'),
  id: z.string().min(1).max(identifierLength),
  oracle_id: z.string().min(1).max(identifierLength).optional(),
  name: z.string().min(1).max(300),
  printed_name: z.string().min(1).max(300).nullish(),
  lang: z.string().min(1).max(20),
  set: z.string().min(1).max(32),
  collector_number: z.string().min(1).max(32),
  finishes: z.array(z.string()).optional(),
  nonfoil: z.boolean().optional(),
  foil: z.boolean().optional(),
  etched: z.boolean().optional(),
  digital: z.boolean(),
  oracle_text: z.string().nullish(),
  type_line: z.string().nullish(),
  colors: z.array(z.enum(cardColors)).optional(),
  color_identity: z.array(z.enum(cardColors)),
  cmc: z.number().min(0).nullish(),
  image_uris: imageUrisSchema.nullish(),
  card_faces: z.array(cardFaceSchema).min(1).optional(),
});

type ScryfallCard = z.infer<typeof scryfallCardSchema>;

/**
 * Maps one provider record onto catalog records. A record the provider publishes without a card
 * identity (Scryfall's reversible promo cards) has no playable identity to own, so it is not
 * catalog data and maps to null; an unreadable record fails the refresh and leaves the published
 * revision in place.
 */
export function mapProviderRecord(
  value: unknown,
  context: ProviderRecordContext,
): MappedProviderRecord | null {
  const parsed = scryfallCardSchema.safeParse(value);
  if (!parsed.success) {
    throw new CatalogError(
      'unavailable',
      `Record ${context.position} of the ${context.sourceName} snapshot is not a readable card.`,
      { cause: parsed.error },
    );
  }
  const record = parsed.data;
  if (record.oracle_id === undefined) {
    return null;
  }
  const faces = record.card_faces ?? [];
  const finishesForPrinting = availableFinishes(record, context);
  return {
    card: {
      cardId: record.oracle_id,
      name: record.name,
      names: publishedNames(record, faces),
      rulesText: publishedText(record.oracle_text) ?? faceRulesText(faces),
      typeLine: publishedText(record.type_line),
      colors: orderedColors(record.colors ?? faces.flatMap((face) => face.colors ?? [])),
      colorIdentity: orderedColors(record.color_identity),
      manaValue: record.cmc ?? null,
    },
    printing: {
      printingId: record.id,
      cardId: record.oracle_id,
      edition: record.set,
      collectorNumber: record.collector_number,
      language: record.lang,
      finishes: finishesForPrinting,
      physical: !record.digital,
      images: printingImages(record, faces),
    },
  };
}

function publishedText(value: string | null | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function faceRulesText(faces: readonly z.infer<typeof cardFaceSchema>[]): string | null {
  const texts = faces
    .map((face) => publishedText(face.oracle_text))
    .filter((text): text is string => text !== null);
  return texts.length === 0 ? null : texts.join('\n//\n');
}

/** Translated and face names of this printing; the canonical name stays on the card row. */
function publishedNames(
  record: ScryfallCard,
  faces: readonly z.infer<typeof cardFaceSchema>[],
): CardName[] {
  const names: CardName[] = [];
  const seen = new Set<string>();
  const add = (name: string | null): void => {
    if (name === null || seen.has(name)) {
      return;
    }
    seen.add(name);
    names.push({ language: record.lang, name });
  };
  add(publishedText(record.printed_name) ?? record.name);
  for (const face of faces) {
    add(publishedText(face.printed_name) ?? face.name);
  }
  return names;
}

/** Provider order is not part of the contract; published colors keep the documented WUBRG order. */
function orderedColors(values: readonly CardColor[]): CardColor[] {
  const published = new Set(values);
  return cardColors.filter((color) => published.has(color));
}

/**
 * Scryfall publishes finish flags and a newer `finishes` list. Unknown finishes are not catalog
 * data, so only the declared values count; a printing without any of them cannot be published.
 */
function availableFinishes(record: ScryfallCard, context: ProviderRecordContext): Finish[] {
  const declared = new Set((record.finishes ?? []).filter((finish) => isFinish(finish)));
  const available: Finish[] = finishes.filter((finish) => declared.has(finish));
  if (available.length > 0) {
    return available;
  }
  const flags: readonly (readonly [Finish, boolean | undefined])[] = [
    ['nonfoil', record.nonfoil],
    ['foil', record.foil],
    ['etched', record.etched],
  ];
  const derived = finishes.filter((finish) => flags.some(([name, set]) => name === finish && set));
  if (derived.length === 0) {
    throw new CatalogError(
      'unavailable',
      `Record ${context.position} of the ${context.sourceName} snapshot publishes no supported finish.`,
    );
  }
  return [...derived];
}

function isFinish(value: string): value is Finish {
  return (finishes as readonly string[]).includes(value);
}

/** Multi-faced cards publish their images per face; the front face is the printing's image. */
function printingImages(
  record: ScryfallCard,
  faces: readonly z.infer<typeof cardFaceSchema>[],
): PrintingImages {
  const uris = record.image_uris ?? faces[0]?.image_uris ?? {};
  return {
    small: uris.small ?? null,
    normal: uris.normal ?? null,
    large: uris.large ?? null,
    artCrop: uris.art_crop ?? null,
  };
}
