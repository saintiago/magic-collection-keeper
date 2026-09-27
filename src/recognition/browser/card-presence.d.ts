/**
 * Types for the preserved baseline module `card-presence.js` (src/recognition/baseline.json,
 * docs/recognition.md#engines-and-assets). The module stays byte-identical to the pinned revision;
 * this declaration only lets the rebuilt component hold the browser geometry check it drives.
 */

import type { RecognitionCardPresence } from '../internal/model.js';

/** One geometry reading of the preserved browser check: the frame's card count and its detail. */
export interface PreservedCardPresenceResult {
  readonly state: RecognitionCardPresence;
  readonly method: string;
  readonly regions: readonly (readonly (readonly number[])[])[];
  readonly elapsedMs: number;
}

/** The preserved browser geometry check: preparation, one inspection and disposal. */
export interface PreservedCardPresence {
  prepare(): Promise<void>;
  inspect(
    frame: HTMLCanvasElement,
    options?: { readonly signal?: AbortSignal },
  ): Promise<PreservedCardPresenceResult>;
  dispose(): void;
}

export function createCardPresence(): PreservedCardPresence;
