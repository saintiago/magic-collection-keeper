/**
 * Admission and feedback of the capture view (docs/user-interface.md#capture-and-review).
 *
 * The capture view samples the camera frame continuously and admits a capture only from a frame
 * that has held still, so a moving card, a hand or an empty frame never starts an attempt. The
 * reading itself decides geometry and identity: only a frame the runtime reports as holding one
 * card may be admitted, and an attempt whose reading names no usable identity is unresolved. A cue
 * means exactly what the attempt decided — an admitted candidate is the success cue, a suppressed
 * repeat is not — and an attempt never repeats its success or error cue however many readings it
 * delivers, so a failing capture cannot flood the feedback.
 *
 * This unit owns only that policy: it reads frame signatures and outcomes and reports what the view
 * should present. It touches no DOM, camera or recognition state, so the policy runs under the
 * component test scope and the capture view holds the browser work around it.
 */

/** Bounds and pacing the capture view applies to sampling, admission and feedback. */
export const UI_CAPTURE = {
  /** Milliseconds between sampled frames while the camera runs. */
  sampleMs: 120,
  /** Milliseconds one frame must be unchanged before an attempt may start. */
  settleMs: 600,
  /** Longest pause between samples that keeps a stability window alive, for example a hidden tab. */
  sampleGapMs: 500,
  /**
   * Largest mean brightness difference between two samples that still counts as the same scene.
   * Like the preserved camera admission this is a visual gate, never an identity decision.
   */
  stableDifference: 5,
  /** Edge length of the sampled brightness signature, so one sample stays bounded. */
  signature: 24,
  /** Milliseconds before the next attempt after each outcome; a new scene clears the wait. */
  retryMs: {
    accepted: 1000,
    repeat: 1000,
    unresolved: 900,
    unavailable: 1200,
    guidance: 400,
  },
  /**
   * Attempts whose cues are remembered. The capture view runs one attempt at a time and only its
   * late readings arrive afterwards, so a tiny window bounds the memory a failing sequence holds.
   */
  cueAttempts: 8,
} as const;

/**
 * What one capture attempt decided: an admitted candidate, a repeat of the accepted identity, a
 * single-card frame without a usable identity, an attempt recognition could not run, or geometry
 * that does not hold exactly one card.
 */
export const uiCaptureOutcomes = [
  'accepted',
  'repeat',
  'unresolved',
  'unavailable',
  'guidance',
] as const;
export type UiCaptureOutcome = (typeof uiCaptureOutcomes)[number];

/**
 * Feedback of one settled attempt: `accepted` is the success cue, `repeat` reports a suppressed
 * repeat, and `error` reports an unresolved or unavailable attempt. Geometry guidance has no cue,
 * so the view only tells the owner what to do.
 */
export const uiCaptureCues = ['accepted', 'repeat', 'error'] as const;
export type UiCaptureCue = (typeof uiCaptureCues)[number];

export interface UiCaptureAdmission {
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
  settled(attempt: number, outcome: UiCaptureOutcome, now: number): UiCaptureCue | null;
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

/** The admission policy of one capture session; a new session starts a new admission. */
export function createCaptureAdmission(
  options: {
    readonly settleMs?: number;
    readonly stableDifference?: number;
    readonly retryMs?: Partial<Record<UiCaptureOutcome, number>>;
  } = {},
): UiCaptureAdmission {
  const settleMs = options.settleMs ?? UI_CAPTURE.settleMs;
  const stableDifference = options.stableDifference ?? UI_CAPTURE.stableDifference;
  const retryMs = { ...UI_CAPTURE.retryMs, ...options.retryMs };
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
        now - latestAt <= UI_CAPTURE.sampleGapMs &&
        frameDifference(candidate, signature) <= stableDifference;
      if (!stable) {
        candidate = signature;
        stableSince = now;
      }
      latestAt = now;
      // A different scene than the one the last attempt read is due as soon as it settles,
      // whatever retry the previous outcome asked for (docs/user-interface.md#capture-and-review).
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
      while (cued.size > UI_CAPTURE.cueAttempts) {
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
