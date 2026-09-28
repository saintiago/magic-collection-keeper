# Recognition component

Interpret card images and return candidates with evidence and uncertainty. [docs/recognition.md](../../docs/recognition.md)
owns the behavior; this file records how the retained baseline is packaged.

## Layout

- `index.ts` is the component's provider-owned public entry point (docs/recognition.md#interface,
  docs/recognition.md#execution): the Prepare/Recognize/Dispose session lifecycle, the reading and
  candidate model, the failure contract, the engine-pipeline port and the factory that composes the
  preserved engines behind it. `internal/` holds the lifecycle service, the mapping boundary that
  validates candidate identities against Catalog and the adapter that translates preserved engine
  readings into the pipeline port's outcome.
- `python/` is the preserved visual/OCR pipeline (CollectorVision geometry and artwork matching,
  Paddle-based OCR, bounded Nova Lite title fallback and the independent Nova Pro identity path)
  with its policies, preparation scripts, model/catalog manifests, public fixtures, notices and
  regressions. Its prepared model/catalog/OCR bytes, the browser assets and the
  corresponding-source download stay out of git and are produced by the retained preparation
  scripts (docs/operations.md#recognition-packaging).
- `browser/` is the preserved browser ONNX recognition: dewarping geometry, preprocessing and
  lighting variants, catalog search, verified asset loading, camera admission, candidate
  combination, the hybrid/independent paths, the inference worker and the card geometry check with
  its worker. It also carries the camera capture and overlay mapping modules the preserved
  admission regressions import; no pages, views or navigation are restored. Its `*.d.ts` files
  only type the modules the adapter imports; the
  engine modules themselves stay byte-identical to the pinned revision.
- `baseline.json` pins reference revision `128c903ff109868acc854f0ff239c8c0f925d803` and records the
  digest of every retained file together with every relocated or harness-adapted file and its
  reason.
- `browser-runtime.json` pins the ONNX Runtime Web files of the locked `onnxruntime-web` dependency
  the preserved browser modules resolve beside themselves under `browser/vendor/ort/`.

The Python regressions live in `python/tests`; the public-art manifests their scripts and fixture
check use (`sources.json` for `prepare.py`, `phone-sources.json` for `replay_public.py`) and the
retained browser regressions live in [tests/recognition](../../tests/recognition). The component's
internals stay private; other components import `index.ts` only (`.dependency-cruiser.mjs`).

## Public contract

`createRecognition` owns the session lifecycle around a run-time engine pipeline that Application
supplies: preparation is demand-driven for the enabled engines, one capture attempt runs at a time
per session, requests and frame bounds are validated before inference, and disposal releases the
session's local work. An attempt returns its initial reading and completion; later readings of the
same attempt, for example the later comparison of the hybrid path, arrive through the request's
callback and keep the session/capture/attempt identity. Cancellation suppresses later readings and
lets the pipeline release local work without promising to cancel an already submitted remote model
call.

Every reading is mapped at one boundary: candidate identities are validated against the published
Catalog and enriched with its canonical names, a suggestion always belongs to the candidate set and
stays `representative` unless engine printing evidence corroborates it, and disagreement is explicit
instead of presenting competing identities as certain. No-card, multiple-card and ambiguous
geometry, a possible outcome without a usable candidate and candidates the published Catalog cannot
validate all stay `unknown`; invalid input, a busy session, cancellation and unavailable inference
remain distinct failures, and a reading never carries ownership or physical condition. The
supplied pipeline keeps engine behaviour: the preserved browser/Python engines, their matching
policies, the hybrid early/later comparison, the independent identity session call limit and at
most one independent request in flight.

`createBrowserRecognitionPipeline` is the component-owned composition of those preserved engines:
it builds the browser ONNX port, the remote visual/OCR port, the hybrid early/later comparison and
the independent identity path exactly as the pinned revision composed them, and translates their
readings — candidate `id`/`oracle_id`, whole-title and geometry evidence, versions and timings, and
the early reading beside its later comparison — into the engine outcome the lifecycle maps.
It composes the preserved browser card geometry check beside them, so every attempted frame's
single-card geometry is established before the engines read it and a runtime whose engines report no
card count still presents that geometry with its reading. A check that cannot report a card state
leaves the frame without geometry, which admits no candidate, while an engine that reports the
frame's geometry itself keeps working.
Application still supplies the authenticated request contract the engines call and chooses whether
the session runs with the remote comparison and the independent path; transport assembly stays with
its own task. The compiled pipeline imports those preserved modules, so the delivery build places
them beside the compiled component together with the prepared browser assets.

The factory fixes the enabled engine set. With the default `cloudEnabled: true`, Prepare accepts
`browser-onnx`, `python-ocr` and `independent-identity`; with `cloudEnabled: false`, it accepts only
`browser-onnx`. A mismatched set fails as `invalid-request` before engine preparation or inference.
The adapter follows the retained completion promise for provisional state, including pending
comparisons after an independent unknown result. Only `exactPrintingId` becomes printing evidence;
`printingReferenceId` remains a translation lookup aid, so hydrated suggestions without an exact
identity remain editable representatives even when the requested translation is found.

## Checks

`npm run test:python` runs the preserved Python suite (27 regressions). The runner installs the
pinned `python/requirements-tests.txt` (NumPy, Pillow, OpenCV as pinned in the baseline
`requirements-linux.txt`) into the ignored `.recognition-python/` environment once and reuses it;
when those requirements are missing from `KEEPER_PYTHON` or cannot be provisioned it fails with an
actionable error, because the complete retained suite must run.

`npm run test:recognition` runs the preserved browser regressions (38 cases). Tests and preserved
sources are excluded from Prettier because they stay byte-identical to the pinned revision.
The browser modules resolve their models, catalog and ONNX runtime next to themselves under
`browser/vendor/` (ignored by git): `python/scripts/browser_assets.py` exports the catalog and model
bytes there, and `npm run prepare:recognition` copies the ONNX Runtime Web files the locked
dependency provides, verified against `browser-runtime.json`. The delivery build copies the prepared
`vendor/` directory into the browser artifact beside the preserved modules.

`npm run prepare:recognition` and `npm run package:recognition` implement the recognition packaging
step (docs/operations.md#recognition-packaging, infra/README.md#recognition-packaging): preparation
runs the retained fetch/convert/export scripts and the corresponding-source bundler, and packaging
verifies every pinned manifest and hash before assembling the image build context: the retained
baseline digests of the shipped engine modules, the model, catalog, OCR and title-name digests, the
pinned upstream CollectorVision revision with the content of every file it ships (generated build
output is excluded, not packaged), the cached catalog feed offline loading reads, the browser
runtime and asset digests with the engine identity the browser manifest reports, and the
corresponding-source download's membership and bytes against the checkout the bundler covers.
`tests/integration/recognition-packaging.test.ts` exercises the packaging command against a
prepared engine package, refusing modified or additional upstream files, incomplete or stale
downloads, a catalog without its cached feed and a browser manifest without the pinned identity,
and checks the pinned browser runtime against the locked dependency; the prepared model bytes
themselves are a build-time input.

`tests/component/recognition` covers the public lifecycle and candidate contract with a controlled
pipeline and Catalog substitute: demand-driven and shared preparation, preparation failure and
retry, invalid requests and frames before inference, busy inference, initial and later readings,
completion, cancellation and disposal, candidate validation and ordering, suggestion and evidence,
geometry, disagreement and the reading shape. The preserved-pipeline case runs the retained browser,
backend, hybrid and independent modules for real behind stubbed browser globals and an authenticated
request stub, so candidate interpretation, the late hybrid comparison, the independent session call
limit and the local-only composition are verified through the public lifecycle.

## Provenance

`python/LICENSE` is AGPL-3.0-only and upstream notices are in `python/notices/`; the
corresponding-source bundle is assembled by `python/scripts/source_bundle.py`
(docs/operations.md#recognition-packaging) and ships in the recognition image beside the notices
and `LICENSE`. Model and catalog versions are pinned in `python/artifact-manifest.json`,
`python/ocr-models.json`, `python/name-catalog.json` and `python/catalog-feed.json`, and the browser
ONNX runtime is pinned in `browser-runtime.json`. Preparation, the built image and rollback are
documented in infra/README.md#recognition-packaging. The three public artwork fixtures are test
data, not licensed application code.

Matching policies, preprocessing, model versions and expected outcomes are unchanged. Authenticated
transport assembly and UI integration remain with KAN-18 and KAN-25.
