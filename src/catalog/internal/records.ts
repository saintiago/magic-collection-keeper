/**
 * Decoding of the published record shapes (docs/catalog.md#query-surface).
 *
 * One published revision, one card, one published name and one printing are each read as a JSON
 * text payload and validated before a consumer sees them. The read service and the query
 * publication share these schemas, so both decode the same published facts and a malformed or
 * incomplete payload is an unavailable read in either path rather than a partially typed record.
 */

import { z } from 'zod';

import { CatalogError } from './errors.js';
import { cardColors, CATALOG_LIMITS, finishes, type CatalogRevision } from './model.js';

const identifierLength = CATALOG_LIMITS.maxIdentifierLength;

/**
 * The published revision as one JSON object. A statement that reads it must alias the published
 * revision row as `revision`.
 */
export const revisionJsonExpression = `json_build_object(
    'revision_id', revision.revision_id,
    'source_name', revision.source_name,
    'source_version', revision.source_version,
    'published_at', revision.published_at
  )::text`;

export const revisionJsonSchema = z.object({
  revision_id: z.string().min(1).max(identifierLength),
  source_name: z.string().min(1).max(200),
  source_version: z.string().min(1).max(200),
  published_at: z.string().min(1),
});

export const cardJsonSchema = z.object({
  card_id: z.string().min(1).max(identifierLength),
  name: z.string().min(1).max(300),
  rules_text: z.string().nullable(),
  type_line: z.string().nullable(),
  colors: z.array(z.enum(cardColors)),
  color_identity: z.array(z.enum(cardColors)),
  mana_value: z.number().nullable(),
});

export const cardNameJsonSchema = z.object({
  card_id: z.string().min(1).max(identifierLength),
  language: z.string().min(1).max(20),
  name: z.string().min(1).max(300),
});

export const printingJsonSchema = z.object({
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

export type RevisionJson = z.infer<typeof revisionJsonSchema>;
export type CardJson = z.infer<typeof cardJsonSchema>;
export type CardNameJson = z.infer<typeof cardNameJsonSchema>;
export type PrintingJson = z.infer<typeof printingJsonSchema>;

/** Parses one payload the storage returned as JSON text, reporting unreadable data as unavailable. */
export function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') {
    throw new CatalogError('unavailable', 'The catalog returned a result that is not readable.');
  }
  try {
    return JSON.parse(value);
  } catch (cause) {
    throw new CatalogError('unavailable', 'The catalog returned unreadable result data.', {
      cause,
    });
  }
}

/** Parses and validates one JSON text payload against the declared record shape. */
export function parseJsonText<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(parseJsonValue(value));
  if (!parsed.success) {
    throw new CatalogError(
      'unavailable',
      'The catalog data does not match its declared read contract.',
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

/** One stored revision as the published revision every read reports, in UTC. */
export function revisionFromJson(json: RevisionJson): CatalogRevision {
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
