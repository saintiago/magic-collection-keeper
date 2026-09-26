import { z } from 'zod';

import { finishes } from '../../catalog/index.js';
import type { UserCardsSqlRow } from './executor.js';
import {
  USERCARDS_LIMITS,
  associationTargetLevels,
  copyConditions,
  tagKinds,
  type Association,
  type PhysicalCopy,
  type Tag,
} from './model.js';
import { parsePayload } from './sql.js';

/**
 * Private record payloads. Each stored record is returned as one JSON payload in its own row, so a
 * batch read never mixes records and never aggregates a whole batch into one transport row; the
 * schemas reject stored data that does not match the declared read contract.
 */

const identifierLength = USERCARDS_LIMITS.maxIdentifierLength;
const quantitySchema = z
  .number()
  .int()
  .min(1)
  .max(USERCARDS_LIMITS.maxAssociationQuantity)
  .nullable();

export const copyJsonSchema = z.object({
  copy_id: z.string().min(1).max(identifierLength),
  printing_id: z.string().min(1).max(identifierLength),
  finish: z.enum(finishes),
  condition: z.enum(copyConditions).nullable(),
  revision: z.number().int().min(1),
});

export const copyPayloadSql = `json_build_object(
    'copy_id', copy_id,
    'printing_id', printing_id,
    'finish', finish,
    'condition', condition,
    'revision', revision
  )::text`;

type CopyJson = z.infer<typeof copyJsonSchema>;

function copyFromJson(json: CopyJson): PhysicalCopy {
  return {
    copyId: json.copy_id,
    printingId: json.printing_id,
    finish: json.finish,
    condition: json.condition,
    revision: json.revision,
  };
}

export function copyFromRow(row: UserCardsSqlRow | undefined): PhysicalCopy {
  return copyFromJson(parsePayload(copyJsonSchema, row?.payload));
}

export function copiesFromRows(rows: readonly UserCardsSqlRow[]): PhysicalCopy[] {
  return rows
    .map((row) => copyFromJson(parsePayload(copyJsonSchema, row.payload)))
    .sort((left, right) => left.copyId.localeCompare(right.copyId));
}

export const tagJsonSchema = z.object({
  tag_id: z.string().min(1).max(identifierLength),
  kind: z.enum(tagKinds),
  label: z.string().min(1).max(identifierLength),
  system: z.boolean(),
  revision: z.number().int().min(1),
});

export const tagPayloadSql = `json_build_object(
    'tag_id', tag_id,
    'kind', kind,
    'label', label,
    'system', system,
    'revision', revision
  )::text`;

type TagJson = z.infer<typeof tagJsonSchema>;

function tagFromJson(json: TagJson): Tag {
  return {
    tagId: json.tag_id,
    kind: json.kind,
    label: json.label,
    system: json.system,
    revision: json.revision,
  };
}

export function tagFromRow(row: UserCardsSqlRow | undefined): Tag {
  return tagFromJson(parsePayload(tagJsonSchema, row?.payload));
}

export function tagsFromRows(rows: readonly UserCardsSqlRow[]): Tag[] {
  return rows
    .map((row) => tagFromJson(parsePayload(tagJsonSchema, row.payload)))
    .sort((left, right) => left.tagId.localeCompare(right.tagId));
}

export const associationJsonSchema = z.object({
  association_id: z.string().min(1).max(identifierLength),
  tag_id: z.string().min(1).max(identifierLength),
  target_level: z.enum(associationTargetLevels),
  target_id: z.string().min(1).max(identifierLength),
  quantity: quantitySchema,
  revision: z.number().int().min(1),
});

export const associationPayloadSql = `json_build_object(
    'association_id', association_id,
    'tag_id', tag_id,
    'target_level', target_level,
    'target_id', target_id,
    'quantity', quantity,
    'revision', revision
  )::text`;

type AssociationJson = z.infer<typeof associationJsonSchema>;

function associationFromJson(json: AssociationJson): Association {
  return {
    associationId: json.association_id,
    tagId: json.tag_id,
    targetLevel: json.target_level,
    targetId: json.target_id,
    quantity: json.quantity,
    revision: json.revision,
  };
}

export function associationFromRow(row: UserCardsSqlRow | undefined): Association {
  return associationFromJson(parsePayload(associationJsonSchema, row?.payload));
}

export function associationsFromRows(rows: readonly UserCardsSqlRow[]): Association[] {
  return rows
    .map((row) => associationFromJson(parsePayload(associationJsonSchema, row.payload)))
    .sort((left, right) => left.associationId.localeCompare(right.associationId));
}
