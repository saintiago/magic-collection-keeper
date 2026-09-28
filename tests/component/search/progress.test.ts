/**
 * Component scope: the account-scoped browser indexing progress
 * (docs/search.md#freshness). The status read and the check schedule are the dependencies outside
 * the component, so these cases script them: known committed positions accumulate across page
 * changes and stay within one observation request however many commits accumulate, a window
 * measured in elapsed time expires even while a read stalls, a failed check reports unavailable —
 * never completion — a known indexing failure is reported as failed, and disposing a replaced
 * account's tracker releases its private positions and drops late results.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  SEARCH_LIMITS,
  createSearchProgress,
  type SearchIndexingProgress,
  type SearchProgress,
  type SearchProgressRequest,
} from '../../../src/search/index.js';

const alice = 'account-alice';
const bob = 'account-bob';

const indexed = (position: string): SearchProgress => ({
  state: 'incorporated',
  revisions: {
    generation: 'generation-1',
    catalogRevision: 'revision-1',
    catalogPosition: '9',
    privateRevision: position,
  },
});

const indexing = (position: string | null): SearchProgress => ({
  state: 'indexing',
  revisions:
    position === null
      ? null
      : {
          generation: 'generation-1',
          catalogRevision: 'revision-1',
          catalogPosition: '9',
          privateRevision: position,
        },
});

/** One scheduled callback, which a case runs when it decides the observation window advances. */
interface ScheduledCheck {
  readonly delayMs: number;
  /** Virtual time the callback is due at, counted from the start of the case. */
  readonly dueAt: number;
  readonly run: () => void;
  cancelled: boolean;
}

/**
 * The observation's own scheduler over a virtual clock: a case runs the earliest scheduled
 * callback, so an elapsed window deadline and the checks inside it keep the order real timers give
 * them even when the checks depend on how long a read takes.
 */
function createScheduler() {
  const checks: ScheduledCheck[] = [];
  let now = 0;
  return {
    checks,
    schedule(delayMs: number, run: () => void): () => void {
      const check: ScheduledCheck = { delayMs, dueAt: now + delayMs, run, cancelled: false };
      checks.push(check);
      return () => {
        check.cancelled = true;
      };
    },
    /** Advances to the earliest scheduled callback and settles the promise callbacks it starts. */
    async runNext(): Promise<void> {
      const check = checks
        .filter((candidate) => !candidate.cancelled)
        .sort((left, right) => left.dueAt - right.dueAt)[0];
      if (check === undefined) {
        throw new Error('No check was scheduled.');
      }
      now = check.dueAt;
      check.cancelled = true;
      check.run();
      await flush();
    },
  };
}

/** Lets the callbacks of one resolved read run. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) {
    await Promise.resolve();
  }
}

/** One status read of the tracker; Application binds it to the authenticated account. */
type ProgressRead = (
  request: SearchProgressRequest,
  options: { readonly signal: AbortSignal },
) => Promise<SearchProgress>;

/** One scripted status read, whose calls a case inspects. */
type ProgressReadMock = ReturnType<typeof vi.fn<ProgressRead>>;

/** The positions each check required, oldest first. */
function positionRequests(
  read: ProgressReadMock,
): readonly (readonly string[] | null | undefined)[] {
  return read.mock.calls.map(([request]) => request.positions);
}

function progressOver(
  read: ProgressRead,
  scheduler: ReturnType<typeof createScheduler>,
  accountId = alice,
): SearchIndexingProgress {
  return createSearchProgress({
    accountId,
    read,
    intervalMs: 100,
    windowMs: 300,
    schedule: scheduler.schedule,
  });
}

describe('account indexing progress', () => {
  it('clears known committed positions once the indexed state reaches them', async () => {
    const scheduler = createScheduler();
    const read = vi.fn<ProgressRead>(async () => indexed('12'));
    const progress = progressOver(read, scheduler);
    const observed: string[] = [];
    progress.subscribe((status) => observed.push(status.state));

    progress.committed(['12']);
    await flush();

    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]?.[0]).toEqual({ positions: ['12'] });
    expect(progress.status()).toEqual({
      accountId: alice,
      state: 'incorporated',
      outstanding: [],
      revisions: indexed('12').revisions,
    });
    expect(observed).toEqual(['indexing', 'incorporated']);
  });

  it('keeps positions committed during an open observation outstanding', async () => {
    const scheduler = createScheduler();
    const read = vi.fn<ProgressRead>(async (request) =>
      request.positions?.includes('7') === true ? indexed('7') : indexing('7'),
    );
    const progress = progressOver(read, scheduler);

    progress.committed(['7']);
    progress.committed(['9']);
    await flush();

    // The first window observed only the positions it started with; the later commit stays
    // outstanding and is observed by the window that follows (docs/search.md#freshness).
    expect(progress.status().outstanding).toEqual(['9']);
    expect(read).toHaveBeenLastCalledWith(
      { positions: ['9'] },
      { signal: expect.any(AbortSignal) },
    );
    expect(progress.status().state).toBe('indexing');
  });

  it('keeps committed positions across page changes and clears them together', async () => {
    const scheduler = createScheduler();
    const read = vi.fn<ProgressRead>(async () => indexed('12'));
    const progress = progressOver(read, scheduler);

    progress.committed(['7']);
    await flush();
    // A page change neither disposes nor replaces the account-scoped tracker.
    progress.committed(['12']);
    await flush();

    expect(progress.status().outstanding).toEqual([]);
    expect(progress.status().state).toBe('incorporated');
    expect(read.mock.calls.map(([request]) => request.positions)).toEqual([['7'], ['12']]);
  });

  it('reports delayed when the observation window expires before incorporation', async () => {
    const scheduler = createScheduler();
    const read = vi.fn<ProgressRead>(async () => indexing('4'));
    const progress = progressOver(read, scheduler);

    progress.committed(['9']);
    await flush();
    // Checks at 100 ms and 200 ms stay inside the 300 ms window, whose deadline then ends it.
    await scheduler.runNext();
    await scheduler.runNext();
    await scheduler.runNext();

    expect(read).toHaveBeenCalledTimes(3);
    expect(progress.status()).toEqual({
      accountId: alice,
      state: 'delayed',
      outstanding: ['9'],
      revisions: indexing('4').revisions,
    });
  });

  it('reports delayed when a check’s read stalls past the observation window', async () => {
    const scheduler = createScheduler();
    // The read never answers, so only the elapsed window can end the observation.
    const read = vi.fn<ProgressRead>(() => new Promise<SearchProgress>(() => undefined));
    const progress = progressOver(read, scheduler);

    progress.committed(['9']);
    await flush();
    await scheduler.runNext();

    expect(read).toHaveBeenCalledTimes(1);
    expect(progress.status()).toEqual({
      accountId: alice,
      state: 'delayed',
      outstanding: ['9'],
      revisions: null,
    });
  });

  it('reports an unavailable check as such and resumes on a later observation', async () => {
    const scheduler = createScheduler();
    const read = vi
      .fn<ProgressRead>()
      .mockRejectedValueOnce(new Error('the status read is unavailable'))
      .mockResolvedValue(indexed('9'));
    const progress = progressOver(read, scheduler);

    progress.committed(['9']);
    await flush();
    expect(progress.status().state).toBe('unavailable');
    expect(progress.status().outstanding).toEqual(['9']);

    progress.recheck();
    await flush();
    expect(progress.status().state).toBe('incorporated');
    expect(progress.status().outstanding).toEqual([]);
  });

  it('reports a known indexing failure and recovers through a later observation', async () => {
    const scheduler = createScheduler();
    const read = vi
      .fn<ProgressRead>()
      .mockResolvedValueOnce({ state: 'failed', revisions: null })
      .mockResolvedValue(indexed('9'));
    const progress = progressOver(read, scheduler);

    progress.committed(['9']);
    await flush();
    expect(progress.status().state).toBe('failed');

    progress.recheck();
    await flush();
    expect(progress.status().state).toBe('incorporated');
  });

  it('checks progress without repeating the mutation that produced a position', async () => {
    const scheduler = createScheduler();
    const read = vi.fn<ProgressRead>(async () => indexing('4'));
    const progress = progressOver(read, scheduler);

    progress.committed(['9']);
    await flush();
    await scheduler.runNext();
    await scheduler.runNext();
    await scheduler.runNext();
    expect(progress.status().state).toBe('delayed');

    progress.recheck();
    await flush();

    // Observing only reads: the tracker is given no mutation capability, and every invocation
    // names exactly the positions whose progress it checks.
    expect(read.mock.calls.map(([request]) => request.positions)).toEqual([
      ['9'],
      ['9'],
      ['9'],
      ['9'],
    ]);
    expect(Object.keys(progress).sort()).toEqual([
      'committed',
      'dispose',
      'recheck',
      'status',
      'subscribe',
    ]);
  });

  it('keeps accumulated commits within one observation request and releases them together', async () => {
    const scheduler = createScheduler();
    const read = vi.fn<ProgressRead>(async () => indexed('100'));
    const progress = progressOver(read, scheduler);
    const positions = Array.from({ length: 51 }, (_, index) => String(index + 1));

    progress.committed(positions);
    await flush();

    // Incorporation grows with the indexed position, so the highest committed position answers
    // for every lower one and the request respects the contract's declared bound.
    expect(positionRequests(read)).toEqual([['51']]);
    expect(read.mock.calls[0]?.[0]?.positions?.length).toBeLessThanOrEqual(
      SEARCH_LIMITS.maxRequiredPositions,
    );
    expect(progress.status()).toEqual({
      accountId: alice,
      state: 'incorporated',
      outstanding: [],
      revisions: indexed('100').revisions,
    });
  });

  it('recovers more accumulated commits than one request may carry', async () => {
    const scheduler = createScheduler();
    const read = vi
      .fn<ProgressRead>()
      .mockRejectedValueOnce(new Error('the status read is unavailable'))
      .mockResolvedValue(indexed('51'));
    const progress = progressOver(read, scheduler);
    const positions = Array.from({ length: 51 }, (_, index) => String(index + 1));

    progress.committed(positions);
    await flush();
    expect(progress.status().state).toBe('unavailable');
    expect(progress.status().outstanding).toEqual(positions);

    progress.recheck();
    await flush();
    expect(positionRequests(read)).toEqual([['51'], ['51']]);
    expect(progress.status()).toEqual({
      accountId: alice,
      state: 'incorporated',
      outstanding: [],
      revisions: indexed('51').revisions,
    });
  });

  it('releases private positions on disposal and drops late results', async () => {
    const scheduler = createScheduler();
    let settle: (result: SearchProgress) => void = () => undefined;
    const read = () =>
      new Promise<SearchProgress>((resolve) => {
        settle = resolve;
      });
    const progress = progressOver(read, scheduler);
    const listener = vi.fn();
    progress.subscribe(listener);

    progress.committed(['9']);
    await flush();
    expect(progress.status().outstanding).toEqual(['9']);

    progress.dispose();
    settle(indexed('9'));
    await flush();

    expect(progress.status()).toEqual({
      accountId: alice,
      state: 'idle',
      outstanding: [],
      revisions: null,
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('scopes one tracker to its account and ignores a replaced account’s results', async () => {
    const scheduler = createScheduler();
    let settle: (result: SearchProgress) => void = () => undefined;
    const aliceRead = vi.fn<ProgressRead>(
      () =>
        new Promise<SearchProgress>((resolve) => {
          settle = resolve;
        }),
    );
    const aliceProgress = progressOver(aliceRead, scheduler);
    aliceProgress.committed(['9']);
    await flush();

    // Replacing the account disposes the previous tracker before the new one observes anything.
    aliceProgress.dispose();
    const bobRead = vi.fn<ProgressRead>(async () => indexed('3'));
    const bobProgress = progressOver(bobRead, scheduler, bob);
    bobProgress.committed(['3']);
    await flush();
    settle(indexed('9'));
    await flush();

    expect(bobProgress.status()).toEqual({
      accountId: bob,
      state: 'incorporated',
      outstanding: [],
      revisions: indexed('3').revisions,
    });
    expect(bobRead).toHaveBeenCalledWith({ positions: ['3'] }, { signal: expect.any(AbortSignal) });
    expect(aliceProgress.status().accountId).toBe(alice);
    expect(aliceProgress.status().outstanding).toEqual([]);
  });
});
