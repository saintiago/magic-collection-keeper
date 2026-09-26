/**
 * Catalog synchronization fixtures: small deterministic provider snapshots streamed as JSON Lines
 * text, cut into chunks that split records like a real download does.
 */

import type {
  CatalogSnapshotSource,
  CatalogSynchronizationRequest,
} from '../../src/catalog/index.js';

export interface SnapshotFixture {
  readonly sourceName?: string;
  readonly sourceVersion: string;
  /** Provider records serialized as one JSON Lines document. */
  readonly records?: readonly unknown[];
  /** Raw snapshot text, used to exercise unreadable snapshots. */
  readonly text?: string;
  /** Characters per streamed chunk; the default splits records like a real download does. */
  readonly chunkSize?: number;
}

/** A source over fixed snapshots, keyed by the dataset a synchronization request names. */
export function createSnapshotSource(
  fixtures: Readonly<Record<string, SnapshotFixture>>,
): CatalogSnapshotSource {
  return {
    async open(request: CatalogSynchronizationRequest) {
      const fixture = fixtures[request.dataset];
      if (fixture === undefined) {
        throw new Error(`No snapshot fixture for dataset "${request.dataset}".`);
      }
      return {
        sourceName: fixture.sourceName ?? 'scryfall',
        sourceVersion: fixture.sourceVersion,
        text: jsonLines(fixture.records ?? [], fixture.text, fixture.chunkSize),
      };
    },
  };
}

async function* jsonLines(
  records: readonly unknown[],
  text: string | undefined,
  chunkSize = 64,
): AsyncGenerator<string> {
  const document =
    text ??
    (records.length === 0 ? '' : `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  for (let start = 0; start < document.length; start += chunkSize) {
    yield document.slice(start, start + chunkSize);
  }
}
