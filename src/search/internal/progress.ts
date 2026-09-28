import type { SearchProgress, SearchProgressRequest } from './freshness.js';
import { SEARCH_LIMITS, type SearchRevisions } from './model.js';

/**
 * Account-scoped browser progress of committed changes awaiting indexing
 * (docs/search.md#freshness).
 *
 * Application connects the account's known committed publication positions to this tracker; the
 * shell observes the status it publishes and presents it, and never compares positions or polls
 * itself. One observation window covers every outstanding position: a check that reports
 * incorporation releases exactly the positions it observed, a window that expires reports delayed,
 * a failed read reports unavailable — never completion — and `recheck` observes again. A tracker
 * belongs to one account: replacing the account disposes it, which releases the private positions
 * and stops late results from reaching a later status. Observing never writes anything, so checking
 * a status can never resubmit the mutation that produced the position.
 */

/** Status of one account's committed changes awaiting indexing. */
export interface SearchIndexingStatus {
  /** Account this status belongs to; a tracker never publishes another account's progress. */
  readonly accountId: string;
  /**
   * `idle` before any change is known, `indexing` while an observation window is open,
   * `incorporated` when the observed positions are indexed, `delayed` when a window expires first,
   * `unavailable` when a check cannot answer and `failed` when an indexing failure is known.
   */
  readonly state: 'idle' | 'indexing' | 'incorporated' | 'delayed' | 'unavailable' | 'failed';
  /** Known committed positions still awaiting incorporation, in the order they were reported. */
  readonly outstanding: readonly string[];
  /** Indexed state the last check read; null while nothing is published yet. */
  readonly revisions: SearchRevisions | null;
}

/** Observable progress of one account (docs/search.md#freshness). */
export interface SearchIndexingProgress {
  /** Current status for presentation. */
  status(): SearchIndexingStatus;
  /** Observes status changes; the returned function stops delivery. */
  subscribe(listener: (status: SearchIndexingStatus) => void): () => void;
  /**
   * Records known committed publication positions of this account. A value outside the declared
   * position bounds is no committed position and is ignored rather than observed as progress.
   */
  committed(positions: readonly string[]): void;
  /** Checks outstanding progress again; it repeats no mutation and starts no indexing work. */
  recheck(): void;
  /**
   * Releases the observation: private positions are dropped, an open check is withdrawn and a
   * result that arrives later is never applied to another account's status.
   */
  dispose(): void;
}

export interface SearchIndexingProgressDependencies {
  /** Account this tracker observes; replacement disposes the tracker of the previous account. */
  readonly accountId: string;
  /**
   * Reads the account's current indexed progress without waiting, bound by Application to the
   * authenticated account. A read that fails is reported as unavailable, never as completion.
   */
  readonly read: (
    request: SearchProgressRequest,
    options: { readonly signal: AbortSignal },
  ) => Promise<SearchProgress>;
  /** Interval between two checks of one observation window. */
  readonly intervalMs?: number;
  /** Window one observation waits for incorporation before it reports delayed. */
  readonly windowMs?: number;
  /** Schedules one check; defaults to a real timer. */
  readonly schedule?: (delayMs: number, run: () => void) => () => void;
}

/** Default window one observation waits before reporting delayed. */
export const SEARCH_PROGRESS_DEFAULT_WINDOW_MS = 5_000;

export function createSearchProgress(
  dependencies: SearchIndexingProgressDependencies,
): SearchIndexingProgress {
  const accountId = dependencies?.accountId;
  if (typeof accountId !== 'string' || accountId.length === 0) {
    throw new TypeError('createSearchProgress requires the account its progress belongs to.');
  }
  if (typeof dependencies?.read !== 'function') {
    throw new TypeError('createSearchProgress requires a read of the account’s indexed progress.');
  }
  const intervalMs = readBound(
    dependencies.intervalMs,
    SEARCH_LIMITS.observationIntervalMs,
    'interval',
  );
  const windowMs = readBound(dependencies.windowMs, SEARCH_PROGRESS_DEFAULT_WINDOW_MS, 'window');
  const checksPerWindow = Math.max(1, Math.ceil(windowMs / intervalMs));
  const schedule =
    dependencies.schedule ??
    ((delayMs: number, run: () => void) => {
      const timer = setTimeout(run, delayMs);
      return () => clearTimeout(timer);
    });

  /** The one open observation: its identity, its positions and how it is withdrawn. */
  let observation: {
    readonly id: number;
    readonly positions: readonly string[];
    /** Stops the open observation: the next scheduled check and a running read. */
    readonly stop: () => void;
  } | null = null;
  let nextObservationId = 0;
  let disposed = false;
  let status: SearchIndexingStatus = {
    accountId,
    state: 'idle',
    outstanding: [],
    revisions: null,
  };
  const listeners = new Set<(status: SearchIndexingStatus) => void>();

  function publish(next: SearchIndexingStatus): void {
    if (sameStatus(status, next)) {
      return;
    }
    status = next;
    for (const listener of [...listeners]) {
      listener(status);
    }
  }

  /** Ends the observation this result belongs to; a result of another observation is stale. */
  function withdraw(id: number): boolean {
    if (observation === null || observation.id !== id) {
      return false;
    }
    observation.stop();
    observation = null;
    return true;
  }

  function finish(id: number, next: SearchIndexingStatus): void {
    if (!withdraw(id)) {
      return;
    }
    publish(next);
  }

  function start(): void {
    if (disposed || observation !== null || status.outstanding.length === 0) {
      return;
    }
    nextObservationId += 1;
    const id = nextObservationId;
    const positions = [...status.outstanding];
    const controller = new AbortController();
    let cancelScheduled: (() => void) | null = null;
    observation = {
      id,
      positions,
      stop: () => {
        cancelScheduled?.();
        cancelScheduled = null;
        controller.abort();
      },
    };
    publish({ ...status, state: 'indexing' });

    let checks = 0;
    const check = (): void => {
      cancelScheduled = null;
      dependencies
        .read({ positions }, { signal: controller.signal })
        .then((result) => {
          if (disposed || observation?.id !== id) {
            return;
          }
          const observed: SearchIndexingStatus = { ...status, revisions: result.revisions };
          if (result.state === 'incorporated') {
            const outstanding = status.outstanding.filter(
              (position) => !positions.includes(position),
            );
            if (outstanding.length === 0) {
              finish(id, { ...observed, state: 'incorporated', outstanding });
              return;
            }
            // Positions committed while this window was open stay outstanding; observe them too.
            withdraw(id);
            publish({ ...observed, outstanding });
            start();
            return;
          }
          if (result.state === 'failed' || result.state === 'delayed') {
            finish(id, { ...observed, state: result.state });
            return;
          }
          publish(observed);
          checks += 1;
          if (checks >= checksPerWindow) {
            finish(id, { ...observed, state: 'delayed' });
            return;
          }
          cancelScheduled = schedule(intervalMs, check);
        })
        .catch(() => {
          // A check that cannot answer never reports completion.
          finish(id, { ...status, state: 'unavailable' });
        });
    };
    check();
  }

  return {
    status: () => status,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    committed(positions) {
      if (disposed || !Array.isArray(positions)) {
        return;
      }
      const added: string[] = [];
      for (const position of positions) {
        if (
          typeof position === 'string' &&
          /^\d{1,20}$/.test(position) &&
          !status.outstanding.includes(position) &&
          !added.includes(position)
        ) {
          added.push(position);
        }
      }
      if (added.length === 0) {
        return;
      }
      // A newly known commit is outstanding progress: observing it resumes a delayed, unavailable
      // or failed status instead of leaving the change untracked.
      publish({ ...status, state: 'indexing', outstanding: [...status.outstanding, ...added] });
      start();
    },
    recheck() {
      if (disposed || observation !== null) {
        return;
      }
      start();
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      // A disposed tracker stops the open check; a result that still arrives is dropped by the
      // identity check in `check`, so it never reaches another account's status.
      observation?.stop();
      observation = null;
      listeners.clear();
      status = { accountId, state: 'idle', outstanding: [], revisions: null };
    },
  };
}

/** One bound of an observation window; a caller cannot widen it past the declared limits. */
function readBound(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < 1 || value > SEARCH_LIMITS.maxObservationTimeoutMs) {
    throw new TypeError(
      `A progress ${name} is a whole number of 1 to ${SEARCH_LIMITS.maxObservationTimeoutMs} milliseconds.`,
    );
  }
  return value;
}

function sameStatus(left: SearchIndexingStatus, right: SearchIndexingStatus): boolean {
  return (
    left.state === right.state &&
    left.revisions?.generation === right.revisions?.generation &&
    left.revisions?.catalogRevision === right.revisions?.catalogRevision &&
    left.revisions?.catalogPosition === right.revisions?.catalogPosition &&
    left.revisions?.privateRevision === right.revisions?.privateRevision &&
    left.outstanding.length === right.outstanding.length &&
    left.outstanding.every((position, index) => position === right.outstanding[index])
  );
}
