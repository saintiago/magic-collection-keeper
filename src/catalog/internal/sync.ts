import { randomUUID } from 'node:crypto';

import { CatalogError } from './errors.js';
import type { CatalogSqlTransactor } from './executor.js';
import type { CatalogRevision } from './model.js';
import { readPublishedRevision } from './postgres.js';
import { publishCandidate } from './publication.js';
import { mapProviderRecord, type MappedProviderRecord } from './scryfall.js';
import {
  openSnapshot,
  parseSynchronizationRequest,
  snapshotRecords,
  type CatalogSnapshot,
  type CatalogSnapshotSource,
  type CatalogSynchronizationRequest,
} from './snapshot.js';

/**
 * Catalog synchronization (docs/catalog.md#synchronization). One invocation ingests the requested
 * refresh into a candidate revision and publishes it atomically, or fails and leaves the previous
 * revision published. Reads never depend on the provider: synchronization owns the source, its
 * limits and its recovery.
 */
export interface CatalogSynchronizer {
  /**
   * Ingests the requested refresh and returns the published revision. A snapshot whose source and
   * version are already published is not ingested again. Every failure is a `CatalogError`: the
   * request names no dataset (`invalid-request`), another task holds the publication lock (`busy`),
   * or the snapshot or database could not be used (`unavailable`).
   */
  synchronize(request: CatalogSynchronizationRequest): Promise<CatalogRevision>;
}

export interface CatalogSynchronizationDependencies {
  /**
   * Transaction-capable SQL executor supplied by Application; the deployed catalog task reaches
   * Aurora through the RDS Data API with the same named parameters reads use.
   */
  readonly sql: CatalogSqlTransactor;
  /** Configured snapshot source; Application selects the private data bucket and provider limits. */
  readonly snapshots: CatalogSnapshotSource;
}

export function createCatalogSynchronizer(
  dependencies: CatalogSynchronizationDependencies,
): CatalogSynchronizer {
  const sql: CatalogSqlTransactor | undefined = dependencies?.sql;
  if (typeof sql?.query !== 'function' || typeof sql.transaction !== 'function') {
    throw new TypeError(
      'createCatalogSynchronizer requires a SQL executor with query and transaction methods.',
    );
  }
  const snapshots: CatalogSnapshotSource | undefined = dependencies?.snapshots;
  if (typeof snapshots?.open !== 'function') {
    throw new TypeError(
      'createCatalogSynchronizer requires a snapshot source with an open method.',
    );
  }

  return {
    async synchronize(request: CatalogSynchronizationRequest): Promise<CatalogRevision> {
      const parsedRequest = parseSynchronizationRequest(request);
      const published = await readPublishedRevision(sql);
      const snapshot = await openSnapshot(snapshots, parsedRequest);

      try {
        if (
          published !== null &&
          published.sourceName === snapshot.sourceName &&
          published.sourceVersion === snapshot.sourceVersion
        ) {
          await releaseSnapshot(snapshot);
          return published;
        }
        const revision: CatalogRevision = {
          revisionId: randomUUID(),
          sourceName: snapshot.sourceName,
          sourceVersion: snapshot.sourceVersion,
          publishedAt: new Date().toISOString(),
        };
        await publishCandidate(sql, revision, mappedRecords(snapshot));
        return revision;
      } catch (cause) {
        throw cause instanceof CatalogError
          ? cause
          : new CatalogError(
              'unavailable',
              `The requested ${parsedRequest.dataset} catalog synchronization could not be completed.`,
              { cause },
            );
      }
    },
  };
}

async function* mappedRecords(snapshot: CatalogSnapshot): AsyncGenerator<MappedProviderRecord> {
  for await (const record of snapshotRecords(snapshot)) {
    const mapped = mapProviderRecord(record.value, {
      sourceName: snapshot.sourceName,
      position: record.position,
    });
    if (mapped !== null) {
      yield mapped;
    }
  }
}

/** Cancels a snapshot the catalog decided not to read, so the source releases its transfer. */
async function releaseSnapshot(snapshot: CatalogSnapshot): Promise<void> {
  const iterator = snapshot.text[Symbol.asyncIterator]();
  await iterator.return?.();
}
