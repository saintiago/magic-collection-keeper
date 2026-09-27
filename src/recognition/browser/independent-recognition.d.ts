/**
 * Types for the preserved baseline module `independent-recognition.js` (src/recognition/baseline.json,
 * docs/recognition.md#engines-and-assets). The module stays byte-identical to the pinned revision;
 * this declaration only lets the rebuilt component hold it to its public pipeline port.
 */

import type { PreservedEnginePort } from '../internal/preserved-pipeline.js';

export function createIndependentRecognition(options: {
  readonly primary: PreservedEnginePort<HTMLCanvasElement>;
  readonly independent: PreservedEnginePort<HTMLCanvasElement>;
  readonly maximumCalls?: number;
}): PreservedEnginePort<HTMLCanvasElement>;
