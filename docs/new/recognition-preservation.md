# Recognition baseline

The retained source comes from `128c903ff109868acc854f0ff239c8c0f925d803`. A complete independent
reference checkout is at `E:/projects/magic-keeper-old`. Its source is historical reference;
`docs/new/` defines the rebuild.

## Retained files

- `recognition/`: Python engines, policies, transport wrappers, preparation scripts, model/catalog
  manifests, public fixtures, regression tests and notices. Obsolete deployment workflows and
  operational reports are removed.
- `public/`: browser recognition, geometry, camera admission, result combination, asset loading
  and corresponding-source download support. These are retained baseline modules, not a runnable UI.
- `tests/`: the related browser-engine regressions and public-art manifests used by Python scripts.
- `recognition/preserved-files.json`: original Git blob identities for every retained baseline
  source/test/manifest file. Boundary work may replace wrappers; engine changes require separate
  evidence and are not part of the reset.

Paths remain unchanged to preserve imports, workers and preparation-script references. Old HTTP
paths in retained wrappers are reference behavior; KAN-17 replaces that boundary. KAN-16 provides
the new runnable preparation/test harness without retuning matching policies.

Downloaded browser assets under ignored `public/vendor/` are retained locally. Python artifacts
and upstream vendor source are not present in this checkout; their pinned manifests and preparation
scripts are retained. A fresh clone must prepare and verify those artifacts before inference tests.
No full-model, live-provider or physical-camera verification is claimed by preserving source.

Preserve required notices and the corresponding-source offering when packaging the new application.

## Reset verification

Verified on 2026-09-26 under WSL with Node 24.14.1 and the existing Python recognition environment:

- All 94 inventoried source/test/manifest files match their original Git blobs.
- `PYTHON=python3 node --test tests/*.test.js`: 38 passed.
- `PYTHONPATH=recognition /home/aiur/.venvs/magic-keeper/bin/python -m unittest discover -s recognition/tests -v`:
  27 passed. The system Python lacks the required image/numerical packages; use a prepared environment.
- The nine local database/WAL/shared-memory files checked before and after the reset have unchanged
  SHA-256 hashes. This is a preservation check, not a consistent backup or migration rehearsal.

These tests cover retained policy, transport, geometry and fixture behavior. They do not establish
full-model inference accuracy, live AWS/provider correctness or physical-camera performance.
