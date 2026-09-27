/**
 * Types for the preserved baseline module `hybrid-recognition.js` (src/recognition/baseline.json,
 * docs/recognition.md#engines-and-assets). The module stays byte-identical to the pinned revision;
 * this declaration only lets the rebuilt component hold it to its public pipeline port.
 */

import type { PreservedEnginePort } from '../internal/preserved-pipeline.js';

export function createHybridRecognition(options: {
  readonly local: PreservedEnginePort<HTMLCanvasElement>;
  readonly cloud?: PreservedEnginePort<HTMLCanvasElement> | null;
  readonly onState?: (state: string) => void;
  readonly prepareDelayMs?: number;
  readonly readyTimeoutMs?: number;
  readonly hedgeDelayMs?: number;
}): PreservedEnginePort<HTMLCanvasElement>;
