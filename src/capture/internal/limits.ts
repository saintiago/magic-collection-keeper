/**
 * Bounds and pacing of the Capture component (docs/capture.md#internal-design,
 * docs/capture.md#admission-and-lifecycle).
 *
 * The values keep one session's sampling, in-flight attempts and remembered cues bounded, so a
 * failing camera or a card that never settles cannot grow the session's state or flood its
 * feedback. A deployment may tighten the pacing it supplies; the defaults are the ones the
 * documented acceptance scenarios exercise.
 */
export const CAPTURE_LIMITS = {
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
   * Attempts whose cues are remembered. The session runs one attempt at a time and only its late
   * readings arrive afterwards, so a tiny window bounds the memory a failing sequence holds.
   */
  cueAttempts: 8,
  /**
   * Events one snapshot retains, oldest first. A presentation presents each identity once, so the
   * history only needs to outlive the redraws between two published states.
   */
  eventHistory: 16,
  /** Longest opaque identity the component composes, bounded like every identifier UserCards accepts. */
  maxIdentityLength: 200,
} as const;
