import { z } from 'zod';

import { SearchError } from './errors.js';
import type { SearchSqlRow, SearchSqlValue } from './executor.js';
import { SEARCH_LIMITS, type SearchRequiredProgress, type SearchRevisions } from './model.js';
import { privateRevisionSql, projectionRelations } from './relations.js';

/**
 * Indexed-position reporting and bounded observation of requested progress
 * (docs/search.md#freshness).
 *
 * A query or an observation may require known committed progress — account-scoped UserCards
 * publication positions and/or a published catalog revision. The read answers exactly whether the
 * published indexed state incorporates it: an unknown position, an account without indexed private
 * state and an unpublished generation are never reported as ready. The capability creates no
 * indexing work and never claims the index holds every current source write.
 */

/** Known committed progress one observation requires incorporated (docs/search.md#freshness). */
export interface SearchProgressRequest {
  /** Account-scoped UserCards publication positions of the authenticated account. */
  readonly positions?: readonly string[] | null;
  /** Published catalog revision that must be incorporated; absent when none is required. */
  readonly catalogRevision?: string | null;
}

/**
 * Status of one bounded observation. `indexing` means the required progress is not incorporated
 * and the observation's bound has not expired, `delayed` that the bound expired first, and
 * `failed` that an indexing failure is known. Reporting `failed` requires that knowledge; an
 * observation that cannot read a failure never reports one, and a read that cannot answer at all
 * fails as unavailable instead of reporting completion (docs/search.md#freshness).
 */
export type SearchProgressState = 'incorporated' | 'indexing' | 'delayed' | 'failed';

/** Result of one bounded observation of required indexing progress. */
export interface SearchProgress {
  readonly state: SearchProgressState;
  /** Indexed state the observation read; null when no generation is published yet. */
  readonly revisions: SearchRevisions | null;
}

export interface SearchObservationOptions {
  /**
   * Longest wait for incorporation, in whole milliseconds, up to
   * {@link SEARCH_LIMITS.maxObservationTimeoutMs}; zero reads the state now. A wait that expires
   * reports delayed, and a wait timeout never turns an acknowledged commit into a failure.
   */
  readonly timeoutMs?: number;
  /** Cancels the observation; a withdrawn wait fails as unavailable instead of completing. */
  readonly signal?: AbortSignal;
}

/**
 * One read of the published indexed state: the generation, its catalog revision and position, and
 * the bound account's indexed position. The state row is returned even when nothing is published,
 * so an absent generation is explicit rather than an unreadable answer.
 */
export function progressStatement(required: SearchRequiredProgress): {
  statement: string;
  parameters: Record<string, SearchSqlValue>;
} {
  const parameters: Record<string, SearchSqlValue> = {};
  const bind = (value: SearchSqlValue): string => {
    const name = `progress_${Object.keys(parameters).length}`;
    parameters[name] = value;
    return `:${name}`;
  };
  const statement = `select
  'state' as row_kind,
  state.generation_id as generation,
  state.catalog_revision as catalog_revision,
  state.catalog_position as catalog_position,
  ${privateRevisionSql} as private_revision,
  ${incorporatedProgressSql(required, bind)} as required_incorporated
from (values (1)) as marker (one)
left join ${projectionRelations.indexState} as state on true`;
  return { statement, parameters };
}

const stateRowSchema = z.object({
  row_kind: z.literal('state'),
  required_incorporated: z.boolean(),
  generation: z.string().min(1).max(SEARCH_LIMITS.maxIdentifierLength).nullable(),
  catalog_revision: z.string().min(1).max(SEARCH_LIMITS.maxIdentifierLength).nullable(),
  catalog_position: z
    .string()
    .min(1)
    .max(SEARCH_LIMITS.maxPositionLength)
    .regex(/^\d+$/)
    .nullable(),
  private_revision: z
    .string()
    .min(1)
    .max(SEARCH_LIMITS.maxPositionLength)
    .regex(/^\d+$/)
    .nullable(),
});

/**
 * Reads the one indexed-state row of a progress read. A missing, repeated or inconsistent row is
 * an unavailable read; no published generation is reported as null, never as an empty generation.
 */
export interface IndexedProgress {
  readonly revisions: SearchRevisions | null;
  readonly incorporated: boolean;
}
export function readSearchProgressRows(rows: readonly SearchSqlRow[]): IndexedProgress {
  if (rows.length !== 1) {
    throw unreadable();
  }
  const parsed = stateRowSchema.safeParse(rows[0]);
  if (!parsed.success) {
    throw unreadable();
  }
  const { generation, catalog_revision, catalog_position, private_revision } = parsed.data;
  if (generation === null || catalog_revision === null || catalog_position === null) {
    if (generation !== null || catalog_revision !== null || catalog_position !== null) {
      throw unreadable();
    }
    return { revisions: null, incorporated: false };
  }
  return {
    incorporated: parsed.data.required_incorporated,
    revisions: {
      generation,
      catalogRevision: catalog_revision,
      catalogPosition: catalog_position,
      privateRevision: private_revision,
    },
  };
}

/** Exact provider-backed incorporation evidence, read in the same snapshot as results. */
export function incorporatedProgressSql(
  required: SearchRequiredProgress,
  bind: (value: SearchSqlValue) => string,
): string {
  const conditions = ['state.generation_id is not null'];
  if (required.catalogRevision !== null) {
    conditions.push(
      `exists (select 1 from ${projectionRelations.catalogProgress} where revision_id = ${bind(required.catalogRevision)})`,
    );
  }
  if (required.positions.length > 0) {
    conditions.push(`${privateRevisionSql} is not null`);
    for (const position of required.positions) {
      conditions.push(
        `exists (select 1 from ${projectionRelations.accountProgress} where position = ${bind(position)})`,
      );
    }
  }
  return conditions.join(' and ');
}

function unreadable(): SearchError {
  return new SearchError('unavailable', 'The indexed progress could not be read.');
}
