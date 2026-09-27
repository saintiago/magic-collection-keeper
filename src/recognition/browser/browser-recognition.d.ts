/**
 * Types for the preserved baseline module `browser-recognition.js` (src/recognition/baseline.json,
 * docs/recognition.md#engines-and-assets). The module stays byte-identical to the pinned revision;
 * this declaration only lets the rebuilt component hold it to its public pipeline port.
 */

import type { PreservedEnginePort, PreservedRequest } from '../internal/preserved-pipeline.js';

export function createBrowserRecognition(options: {
  readonly request: PreservedRequest;
}): PreservedEnginePort<HTMLCanvasElement>;
