/**
 * The provider snapshot boundary of catalog synchronization (docs/catalog.md#synchronization).
 *
 * Application supplies the configured source; the source only locates a snapshot and streams its
 * decoded text. Catalog splits that text into JSON Lines records and interprets them, so external
 * provider formats stay inside this boundary.
 */

import { z } from 'zod';

import { CatalogError } from './errors.js';
import { CATALOG_LIMITS } from './model.js';

/**
 * Bounds synchronization keeps inside the deployed write transport and task memory. The RDS Data
 * API rejects oversized statements, so a batch never exceeds these limits however large the
 * snapshot is.
 */
export const CATALOG_SYNCHRONIZATION_LIMITS = {
  /** Most records one write statement carries. */
  maxRecordsPerStatement: 100,
  /** Most bytes of JSON one write statement parameter carries. */
  maxStatementBytes: 128 * 1024,
  /** Longest single snapshot record the reader buffers, in JavaScript string units. */
  maxRecordLength: 384 * 1024,
} as const;

/** Identifies the refresh one synchronization invocation requests from the configured source. */
export interface CatalogSynchronizationRequest {
  /**
   * Provider dataset to ingest, for example Scryfall's `default_cards` bulk data. The source maps it
   * to one concrete snapshot; Catalog never guesses a snapshot.
   */
  readonly dataset: string;
}

/**
 * One bulk snapshot of external provider data. Catalog republishes only when a snapshot reports a
 * version other than the published revision's, so the version identifies the snapshot content of
 * the configured source.
 */
export interface CatalogSnapshot {
  /** Source that produced the snapshot, for example `scryfall`. */
  readonly sourceName: string;
  /** Provider version of the snapshot, for example Scryfall's bulk `updated_at` instant. */
  readonly sourceVersion: string;
  /**
   * Decoded snapshot text, streamed in arbitrary chunks. Reading it starts the source's transfer;
   * ending or cancelling iteration releases that transfer.
   */
  readonly text: AsyncIterable<string>;
}

/** Configured provider snapshot source; Application supplies the private-bucket implementation. */
export interface CatalogSnapshotSource {
  /**
   * Opens the snapshot the request identifies. Source configuration (location, credentials,
   * provider limits) is fixed at construction; the invocation only names the refresh.
   */
  open(request: CatalogSynchronizationRequest): Promise<CatalogSnapshot>;
}

const requestSchema = z
  .object({
    dataset: z.string().min(1).max(CATALOG_LIMITS.maxIdentifierLength),
  })
  .strict();

const snapshotSchema = z.object({
  sourceName: z.string().min(1).max(CATALOG_LIMITS.maxIdentifierLength),
  sourceVersion: z.string().min(1).max(CATALOG_LIMITS.maxIdentifierLength),
  text: z.custom<AsyncIterable<string>>(
    (value) =>
      typeof value === 'object' &&
      value !== null &&
      typeof Reflect.get(value, Symbol.asyncIterator) === 'function',
    'A catalog snapshot streams its text as an async iterable.',
  ),
});

/** Validates one synchronization request before any source or database work starts. */
export function parseSynchronizationRequest(value: unknown): CatalogSynchronizationRequest {
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) {
    throw new CatalogError(
      'invalid-request',
      'A catalog synchronization request names the dataset to ingest, from 1 to ' +
        `${CATALOG_LIMITS.maxIdentifierLength} characters.`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

/** Opens the requested snapshot, reporting an unusable source or snapshot as `unavailable`. */
export async function openSnapshot(
  source: CatalogSnapshotSource,
  request: CatalogSynchronizationRequest,
): Promise<CatalogSnapshot> {
  let opened: unknown;
  try {
    opened = await source.open(request);
  } catch (cause) {
    throw new CatalogError(
      'unavailable',
      `The requested ${request.dataset} catalog snapshot could not be opened.`,
      { cause },
    );
  }
  const snapshot = snapshotSchema.safeParse(opened);
  if (!snapshot.success) {
    throw new CatalogError(
      'unavailable',
      `The requested ${request.dataset} catalog snapshot is not readable.`,
      { cause: snapshot.error },
    );
  }
  return snapshot.data;
}

/** One provider record with its one-based position, used in failure messages. */
export interface CatalogSnapshotRecord {
  readonly position: number;
  readonly value: unknown;
}

/**
 * Reads the snapshot's JSON Lines records. The reader accepts any chunking, ignores blank lines and
 * rejects unreadable records; the previous revision stays published because nothing is written yet.
 */
export async function* snapshotRecords(
  snapshot: CatalogSnapshot,
): AsyncGenerator<CatalogSnapshotRecord> {
  let buffered = '';
  let position = 0;
  for await (const chunk of snapshot.text) {
    if (typeof chunk !== 'string') {
      throw new CatalogError(
        'unavailable',
        `The ${snapshot.sourceName} snapshot produced text that is not readable.`,
      );
    }
    buffered += chunk;
    let newline = buffered.indexOf('\n');
    while (newline !== -1) {
      const record = readRecordLine(snapshot, buffered.slice(0, newline), position + 1);
      buffered = buffered.slice(newline + 1);
      if (record !== undefined) {
        position += 1;
        yield { position, value: record };
      }
      newline = buffered.indexOf('\n');
    }
    if (buffered.length > CATALOG_SYNCHRONIZATION_LIMITS.maxRecordLength) {
      throw new CatalogError(
        'unavailable',
        `A record of the ${snapshot.sourceName} snapshot exceeds the readable bound.`,
      );
    }
  }
  const trailing = readRecordLine(snapshot, buffered, position + 1);
  if (trailing !== undefined) {
    position += 1;
    yield { position, value: trailing };
  }
}

function readRecordLine(
  snapshot: CatalogSnapshot,
  line: string,
  position: number,
): unknown | undefined {
  const text = line.trim();
  if (text === '') {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new CatalogError(
      'unavailable',
      `Record ${position} of the ${snapshot.sourceName} snapshot is not readable JSON.`,
      { cause },
    );
  }
}
