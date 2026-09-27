/**
 * Recognition public entry point (docs/recognition.md#interface).
 *
 * Prepare, Recognize and Dispose are the session lifecycle UserInterface uses: preparation is
 * demand-driven for the enabled engines, one capture attempt runs at a time per session and keeps
 * its capture/attempt identity across later readings, and disposal releases the session's local
 * work. `recognitionEngineNames` names the engines of one runtime capability, so a caller prepares
 * exactly the set the composed pipeline accepts. Readings carry ordered catalog-validated
 * candidates, an editable suggestion that stays distinguishable from evidence-supported printing,
 * provisional state, disagreement, engine versions and timings, and never confer ownership or
 * physical condition
 * (docs/recognition.md#execution). Application supplies the preserved engine pipeline, the Catalog
 * read contract and the runtime frame inspector; the component executes in the browser and a
 * separate backend runtime through that same contract, and `createBrowserRecognitionPipeline`
 * composes the preserved browser engines behind it. Other components import Recognition through
 * this module only; its internal modules stay private to the component
 * (docs/architecture.md, .dependency-cruiser.mjs).
 */

export { RecognitionError, type RecognitionFailureCode } from './internal/errors.js';
export {
  RECOGNITION_LIMITS,
  recognitionCardPresenceStates,
  recognitionImageFormats,
  recognitionStatuses,
  recognitionSuggestionBases,
  type RecognitionCandidate,
  type RecognitionCardPresence,
  type RecognitionCaptureId,
  type RecognitionCatalogPort,
  type RecognitionDisagreement,
  type RecognitionEngineCandidate,
  type RecognitionEngineEvidence,
  type RecognitionEngineName,
  type RecognitionEngineOutcome,
  type RecognitionEvidence,
  type RecognitionFrameFacts,
  type RecognitionIdentity,
  type RecognitionImageFormat,
  type RecognitionPreparation,
  type RecognitionReading,
  type RecognitionSessionId,
  type RecognitionStatus,
  type RecognitionSuggestion,
  type RecognitionSuggestionBasis,
} from './internal/model.js';
export {
  createRecognition,
  type Recognition,
  type RecognitionAttempt,
  type RecognitionDependencies,
  type RecognitionDisposeRequest,
  type RecognitionEnginePipeline,
  type RecognitionEnginePreparation,
  type RecognitionEnginePrepareRequest,
  type RecognitionEngineRecognizeRequest,
  type RecognitionPrepareRequest,
  type RecognitionRecognizeRequest,
} from './internal/service.js';
export {
  createBrowserRecognitionPipeline,
  recognitionEngineNames,
  type BrowserRecognitionPipelineOptions,
  type PreservedRequest,
} from './internal/preserved-pipeline.js';
