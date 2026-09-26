import { z } from 'zod';

/**
 * Playable identity and printing identity are separate (docs/catalog.md#identities-and-information).
 * Both identifiers are opaque, provider-stable strings: the provider owns their format, consumers
 * only carry them. The catalog never derives one from the other.
 */
export type CardId = string;
export type PrintingId = string;

/**
 * Provider language code of a name or printing, for example `en`. Case and spelling stay exactly
 * as published; comparisons are the responsibility of the component that consumes them.
 */
export type LanguageCode = string;

export const cardColors = ['W', 'U', 'B', 'R', 'G'] as const;
export type CardColor = (typeof cardColors)[number];

export const finishes = ['nonfoil', 'foil', 'etched'] as const;
export type Finish = (typeof finishes)[number];

/**
 * Bounds that keep public lookups and filtered reads bounded (docs/catalog.md#synchronization).
 * A caller that needs more resolves further batches; the catalog never silently truncates a batch.
 */
export const CATALOG_LIMITS = {
  /** Longest accepted provider identifier, counted in JavaScript string units. */
  maxIdentifierLength: 200,
  maxResolutionReferences: 100,
  defaultPrintingPageSize: 50,
  minPrintingPageSize: 1,
  maxPrintingPageSize: 100,
} as const;

const identifierSchema = z.string().min(1).max(CATALOG_LIMITS.maxIdentifierLength);

/** A request for one playable identity. */
export const cardReferenceSchema = z.object({
  kind: z.literal('card'),
  cardId: identifierSchema,
});
export type CardReference = z.infer<typeof cardReferenceSchema>;

/** A request for one exact printing. */
export const printingReferenceSchema = z.object({
  kind: z.literal('printing'),
  printingId: identifierSchema,
});
export type PrintingReference = z.infer<typeof printingReferenceSchema>;

export const catalogReferenceSchema = z.discriminatedUnion('kind', [
  cardReferenceSchema,
  printingReferenceSchema,
]);
export type CatalogReference = z.infer<typeof catalogReferenceSchema>;

/** One translated or face name that resolves to the card, as published by the provider. */
export interface CardName {
  readonly language: LanguageCode;
  readonly name: string;
}

/**
 * Basic card information needed to identify, render and filter a playable identity without a live
 * provider request. A value the provider does not publish stays `null`; `null` is not an empty
 * string or a substitute value.
 */
export interface CardRecord {
  readonly cardId: CardId;
  /** Canonical display name; the provider's name for the playable identity. */
  readonly name: string;
  /** Translated and face-name aliases that resolve to this same identity. */
  readonly names: readonly CardName[];
  readonly rulesText: string | null;
  readonly typeLine: string | null;
  readonly colors: readonly CardColor[];
  readonly colorIdentity: readonly CardColor[];
  readonly manaValue: number | null;
}

/** Image references, not image data or loading behaviour. */
export interface PrintingImages {
  readonly small: string | null;
  readonly normal: string | null;
  readonly large: string | null;
  readonly artCrop: string | null;
}

/**
 * One published version of a card. Finish options and physical-printing eligibility are printing
 * facts; ownership and condition belong to UserCards and are never catalog data.
 */
export interface PrintingRecord {
  readonly printingId: PrintingId;
  readonly cardId: CardId;
  /** Edition (set) code of the printing. */
  readonly edition: string;
  readonly collectorNumber: string;
  readonly language: LanguageCode;
  readonly finishes: readonly Finish[];
  /** Whether the printing is available as a physical card. */
  readonly physical: boolean;
  readonly images: PrintingImages;
}

/** The published catalog revision a read observed, with its source version and freshness. */
export interface CatalogRevision {
  readonly revisionId: string;
  readonly sourceName: string;
  readonly sourceVersion: string;
  /** Publication time as an ISO-8601 UTC timestamp. */
  readonly publishedAt: string;
}
