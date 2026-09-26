# Recognition

## Responsibility

Interpret card images and return candidates with evidence and uncertainty. Preserve the existing
recognition engines, model artifacts and matching policies across API and deployment changes.

## Interface

- Provide UserInterface with preparation, image recognition, optional later candidate updates and
  cancellation. Results retain capture/attempt identity so stale updates can be rejected.
- Use Catalog to validate candidate identities and resolve canonical printings. The inference
  dataset is a versioned model asset, not a second authoritative public catalog.
- Receive runtime settings and authenticated service access through Application. The component
  can execute in the browser and a separate backend runtime.
- Return unknown or possible matches, candidate identities, printing evidence, disagreement,
  engine versions and timings. A suggested printing remains editable and distinguishable from
  an evidence-supported printing. Results never confer ownership or physical condition.

### Provided operations

| Operation | Input | Result |
| --- | --- | --- |
| Prepare | Session identity, enabled engines and cancellation. | Ready state or preparation failure. |
| Recognize | Image, session/capture/attempt identity and cancellation. | Initial reading and completion; optional later readings retain the same identity. |
| Dispose | Session identity. | Releases local resources and prevents further delivery for that session. |

A reading identifies status, ordered candidates, optional suggestion, printing evidence, provisional
state, disagreement, engine versions and timings. A suggestion must belong to the candidate set.
Unknown means no usable identity; it is distinct from invalid input, busy, cancellation or unavailable
inference. Completion means no further reading updates for that attempt.

Catalog resolution can enrich an engine result but cannot turn a representative printing into
evidence of the observed edition. Preserve raw engine outcomes behind the mapping boundary.
Transport paths and envelopes can change while these guarantees and engine behavior remain stable.

## Engines and assets

Retain browser ONNX recognition and the Python visual/OCR pipeline: CollectorVision geometry and
artwork matching, Paddle-based OCR, bounded Nova Lite title fallback and the independent Nova Pro
identity path. Keep model/catalog manifests, checksums and compatible preprocessing together.

Preserve multilingual full-title checks, footer evidence and orientation handling. Similarity
scores and model self-confidence are not calibrated probabilities. Whole-title corroboration takes
precedence over visual-only similarity; incompatible provider scores are not compared directly.
Matching thresholds belong to engine policy and are not retuned as part of boundary changes.

## Execution

Preparation is demand-driven. Keep inference concurrency, image size and model calls bounded.
The hybrid path can return an early candidate and a later comparison; retain disagreement and
evidence rather than silently presenting competing identities as certain.

Independent identity checks retain their session call limit and at most one independent request
in flight. No-card, multiple-card and ambiguous geometry do not become successful identities.
Cancellation suppresses later output and releases local work; it does not guarantee cancellation
of an already submitted remote model call.

Validate authenticated requests and image inputs before inference. Busy, unavailable and unresolved
outcomes remain distinguishable. Reuse prepared engines safely without mixing request state.

## Privacy and preservation

Do not retain raw frames or expose image data, raw OCR or credentials in diagnostics. Preserve
model provenance, bundled notices and the corresponding-source download with deployed versions.

Boundary changes must pass the retained engine fixtures and comparison cases without changing
matching outcomes. Evaluate model accuracy and latency separately from transport compatibility;
record physical-device evidence separately from image-fixture results.
