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
  oracle_id: z.string().min(1).max(identifierLength).optional(),
  oracle_text: z.string().nullish(),
  type_line: z.string().nullish(),
  colors: z.array(z.enum(cardColors)).optional(),
  cmc: z.number().min(0).nullish(),
  image_uris: imageUrisSchema.nullish(),
});

type CardFace = z.infer<typeof cardFaceSchema>;

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
 * Maps one provider record onto catalog records. Scryfall publishes reversible printings — the
 * same card on both sides — without a card-level identity or card-level attributes; their faces
 * carry the one card the printing depicts, so the faces supply the identity and every field the
 * record omits. A record neither level identifies is not catalog data and maps to null; an
 * unreadable record fails the refresh and leaves the published revision in place.
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
  const faces = record.card_faces ?? [];
  const cardId = record.oracle_id ?? sharedFaceIdentity(faces);
  if (cardId === undefined) {
    return null;
  }
  const name = record.oracle_id === undefined ? faceName(faces) : record.name;
  const finishesForPrinting = availableFinishes(record, context);
  return {
    card: {
      cardId,
      name,
      names: publishedNames(record, faces),
      rulesText: publishedText(record.oracle_text) ?? faceRulesText(faces),
      typeLine: publishedText(record.type_line) ?? faceTypeLines(faces),
      colors: orderedColors(record.colors ?? faces.flatMap((face) => face.colors ?? [])),
      colorIdentity: orderedColors(record.color_identity),
      manaValue: record.cmc ?? faceManaValue(faces),
    },
    printing: {
      printingId: record.id,
      cardId,
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

/**
 * The one playable identity the faces of a printing publish. Scryfall omits the card-level
 * `oracle_id` on reversible printings; a record whose faces do not agree on one identity has no
 * playable identity to own.
 */
function sharedFaceIdentity(faces: readonly CardFace[]): string | undefined {
  const identities = new Set(
    faces
      .map((face) => face.oracle_id)
      .filter((identity): identity is string => identity !== undefined),
  );
  return identities.size === 1 ? identities.values().next().value : undefined;
}

/** Canonical name of a printing whose faces publish the card, joined as the provider joins faces. */
function faceName(faces: readonly CardFace[]): string {
  return [...new Set(faces.map((face) => face.name))].join(' // ');
}

function faceRulesText(faces: readonly CardFace[]): string | null {
  const texts = distinctFaceTexts(faces.map((face) => publishedText(face.oracle_text)));
  return texts.length === 0 ? null : texts.join('\n//\n');
}

/** Type line of a printing whose card-level record omits it; the provider publishes it per face. */
function faceTypeLines(faces: readonly CardFace[]): string | null {
  const lines = distinctFaceTexts(faces.map((face) => publishedText(face.type_line)));
  return lines.length === 0 ? null : lines.join(' // ');
}

/** Mana value the faces publish, or `null` when the provider's faces disagree on one value. */
function faceManaValue(faces: readonly CardFace[]): number | null {
  const values = [...new Set(faces.map((face) => face.cmc ?? null))];
  return values.length === 1 ? (values[0] ?? null) : null;
}

/** Distinct values the faces publish for one card-level text field, in provider order. */
function distinctFaceTexts(values: readonly (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => value !== null))];
}

/** Translated and face names of this printing; the canonical name stays on the card row. */
function publishedNames(record: ScryfallCard, faces: readonly CardFace[]): CardName[] {
  const names: CardName[] = [];
  const seen = new Set<string>();
  const add = (value: string | null): void => {
    if (value === null || seen.has(value)) {
      return;
    }
    seen.add(value);
    names.push({ language: record.lang, name: value });
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
function printingImages(record: ScryfallCard, faces: readonly CardFace[]): PrintingImages {
  const uris = record.image_uris ?? faces[0]?.image_uris ?? {};
  return {
    small: uris.small ?? null,
    normal: uris.normal ?? null,
    large: uris.large ?? null,
    artCrop: uris.art_crop ?? null,
  };
}
