/**
 * Frame scheduler of the Capture component (docs/capture.md#internal-design,
 * docs/capture.md#admission-and-lifecycle).
 *
 * The scheduler decides when a sampled frame is due for one attempt and which cue that attempt
 * earns. It reads a frame signature and an attempt outcome and nothing else: only a frame that has
 * held still starts an attempt, an attempt is due again after the retry its outcome asks for, and
 * a new scene releases that wait. The admission decision itself — affirmative geometry plus a
 * usable candidate for the same frame — belongs to the session, because it needs the reading.
 *
 * This unit touches no DOM, camera or recognition state, so the policy runs under the component
 * test scope while the session holds the device work around it.
 */

import { CAPTURE_LIMITS } from './limits.js';

/** Outcome of one settled attempt, as the scheduler paces and cues it. */
export const captureAttemptOutcomes = [
  'accepted',
  'repeat',
  'unresolved',
  'unavailable',
  'guidance',
] as const;

export type CaptureAttemptOutcome = (typeof captureAttemptOutcomes)[number];

export interface CaptureAdmission {
  /** Records one sampled frame; a changed frame restarts the stability window. */
  observe(signature: readonly number[], now: number): void;
  /** Whether the settled frame is due for one attempt at `now`. */
  ready(now: number): boolean;
  /** Records that an attempt started at `now` from the settled frame. */
  started(now: number): void;
  /**
   * Settles one attempt. Returns the cue to present, or null when the attempt only guides the
   * owner or already reported the same kind of cue; a success cue and an error cue are each
   * delivered at most once per attempt.
   */
  settled(
    attempt: number,
    outcome: CaptureAttemptOutcome,
    now: number,
  ): 'accepted' | 'repeat' | 'error' | null;
}

/** Mean brightness difference between two sampled frames; incomparable frames differ infinitely. */
export function frameDifference(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) {
    return Number.POSITIVE_INFINITY;
  }
  let total = 0;
  for (let index = 0; index < a.length; index += 1) {
    total += Math.abs((a[index] ?? 0) - (b[index] ?? 0));
  }
  return total / a.length;
}

/** The frame scheduler of one capture session; a new session starts a new admission. */
export function createCaptureAdmission(
  options: {
    readonly settleMs?: number;
    readonly stableDifference?: number;
    readonly retryMs?: Partial<Record<CaptureAttemptOutcome, number>>;
  } = {},
): CaptureAdmission {
  const settleMs = options.settleMs ?? CAPTURE_LIMITS.settleMs;
  const stableDifference = options.stableDifference ?? CAPTURE_LIMITS.stableDifference;
  const retryMs = { ...CAPTURE_LIMITS.retryMs, ...options.retryMs };
  /** Frame the current stability window holds, or null before the first sample. */
  let candidate: readonly number[] | null = null;
  let stableSince = 0;
  let latestAt = Number.NEGATIVE_INFINITY;
  /** Frame the last attempt started from, so a new scene releases the retry wait. */
  let startedFrom: readonly number[] | null = null;
  let retryAt = Number.NEGATIVE_INFINITY;
  const cued = new Map<number, { accepted: boolean; error: boolean }>();

  return {
    observe(signature, now) {
      const stable =
        candidate !== null &&
        now - latestAt <= CAPTURE_LIMITS.sampleGapMs &&
        frameDifference(candidate, signature) <= stableDifference;
      if (!stable) {
        candidate = signature;
        stableSince = now;
      }
      latestAt = now;
      // A different scene than the one the last attempt read is due as soon as it settles,
      // whatever retry the previous outcome asked for (docs/capture.md#admission-and-lifecycle).
      if (startedFrom !== null && frameDifference(startedFrom, signature) > stableDifference) {
        retryAt = Number.NEGATIVE_INFINITY;
      }
    },

    ready(now) {
      return candidate !== null && now - stableSince >= settleMs && now >= retryAt;
    },

    started(now) {
      startedFrom = candidate;
      retryAt = Number.POSITIVE_INFINITY;
      latestAt = now;
    },

    settled(attempt, outcome, now) {
      retryAt = now + retryMs[outcome];
      if (outcome !== 'accepted' && outcome !== 'unresolved' && outcome !== 'unavailable') {
        return outcome === 'repeat' ? 'repeat' : null;
      }
      const record = cued.get(attempt) ?? { accepted: false, error: false };
      cued.delete(attempt);
      cued.set(attempt, record);
      while (cued.size > CAPTURE_LIMITS.cueAttempts) {
        const oldest = cued.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        cued.delete(oldest);
      }
      if (outcome === 'accepted') {
        if (record.accepted) {
          return null;
        }
        record.accepted = true;
        return 'accepted';
      }
      if (record.error) {
        return null;
      }
      record.error = true;
      return 'error';
    },
  };
}
