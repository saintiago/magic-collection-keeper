# Recognition component

Interpret card images and return candidates with evidence and uncertainty. [docs/recognition.md](../../docs/recognition.md)
owns the behavior; this file records how the retained baseline is packaged.

## Layout

- `index.ts` is the component's provider-owned public entry point. The lifecycle and candidate
  contract arrives with KAN-17.
- `python/` is the preserved visual/OCR pipeline (CollectorVision geometry and artwork matching,
  Paddle-based OCR, bounded Nova Lite title fallback and the independent Nova Pro identity path)
  with its policies, preparation scripts, model/catalog manifests, public fixtures, notices and
  regressions.
- `browser/` is the preserved browser ONNX recognition: dewarping geometry, preprocessing and
  lighting variants, catalog search, verified asset loading, camera admission, candidate
  combination, the hybrid/independent paths and the inference worker. It also carries the camera
  capture and overlay mapping modules the preserved admission regressions import; no pages, views
  or navigation are restored.
- `baseline.json` pins reference revision `128c903ff109868acc854f0ff239c8c0f925d803` and records the
  digest of every retained file together with every relocated or harness-adapted file and its
  reason.

The Python regressions live in `python/tests`; the public-art manifests their scripts and fixture
check use (`sources.json` for `prepare.py`, `phone-sources.json` for `replay_public.py`) and the
retained browser regressions live in [tests/recognition](../../tests/recognition). The component's
internals stay private; other components import `index.ts` only (`.dependency-cruiser.mjs`).

## Checks

`npm run test:python` runs the preserved Python suite (27 regressions). The runner installs the
pinned `python/requirements-tests.txt` (NumPy, Pillow, OpenCV as pinned in the baseline
`requirements-linux.txt`) into the ignored `.recognition-python/` environment once and reuses it;
when those requirements are missing from `KEEPER_PYTHON` or cannot be provisioned it fails with an
actionable error, because the complete retained suite must run.

`npm run test:recognition` runs the preserved browser regressions (38 cases). Tests and preserved
sources are excluded from Prettier because they stay byte-identical to the pinned revision.
The browser modules resolve their models, catalog and ONNX runtime next to themselves under
`browser/vendor/`; `python/scripts/browser_assets.py` prepares that content (ignored by git) and the
delivery build copies the runtime there (KAN-29).

## Provenance

`python/LICENSE` is AGPL-3.0-only and upstream notices are in `python/notices/`; the
corresponding-source bundle is assembled by `python/scripts/source_bundle.py`
(docs/operations.md#recognition-packaging). Model and catalog versions are pinned in
`python/artifact-manifest.json`, `python/ocr-models.json`, `python/name-catalog.json` and
`python/catalog-feed.json`. The three public artwork fixtures are test data, not licensed
application code.

Matching policies, preprocessing, model versions and expected outcomes are unchanged. Transport
boundaries, browser delivery packaging and UI integration remain with KAN-17, KAN-25 and KAN-29.
