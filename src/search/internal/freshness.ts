import { z } from 'zod';

import { SearchError } from './errors.js';
import type { SearchSqlRow } from './executor.js';
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
export function progressStatement(): string {
  return `select
  'state' as row_kind,
  state.generation_id as generation,
  state.catalog_revision as catalog_revision,
  state.catalog_position as catalog_position,
  ${privateRevisionSql} as private_revision
from (values (1)) as marker (one)
left join ${projectionRelations.indexState} as state on true`;
}

const stateRowSchema = z.object({
  row_kind: z.literal('state'),
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
export function readSearchProgressRows(rows: readonly SearchSqlRow[]): SearchRevisions | null {
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
    return null;
  }
  return {
    generation,
    catalogRevision: catalog_revision,
    catalogPosition: catalog_position,
    privateRevision: private_revision,
  };
}

/**
 * Whether one indexed state incorporates every required position and revision
 * (docs/search.md#freshness). A missing generation, an account without an indexed position and a
 * different catalog revision are never incorporated; positions grow, so an indexed position at or
 * beyond a required one incorporates it.
 */
export function incorporatedProgress(
  indexed: SearchRevisions | null,
  required: SearchRequiredProgress,
): boolean {
  if (indexed === null) {
    return false;
  }
  if (required.catalogRevision !== null && indexed.catalogRevision !== required.catalogRevision) {
    return false;
  }
  if (required.positions.length === 0) {
    return true;
  }
  if (indexed.privateRevision === null) {
    return false;
  }
  const indexedPosition = BigInt(indexed.privateRevision);
  return required.positions.every((position) => indexedPosition >= BigInt(position));
}

function unreadable(): SearchError {
  return new SearchError('unavailable', 'The indexed progress could not be read.');
}
