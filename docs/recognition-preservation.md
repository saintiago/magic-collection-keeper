# Recognition baseline

Recover the recognition implementation from the independent checkout at
`E:/projects/magic-keeper-old` (WSL: `/mnt/e/projects/magic-keeper-old`), revision
`128c903ff109868acc854f0ff239c8c0f925d803`. Current `docs/` defines the rebuild.

## Reference files

- `recognition/`: Python engines, policies, preparation scripts, model/catalog manifests, fixtures,
  regression tests and licenses.
- `public/`: browser recognition, geometry, camera admission, candidate combination and asset
  loading. Select the recognition modules and their dependencies; do not restore the old UI.
- `tests/`: browser recognition regressions and public-art manifests used by the Python scripts.

Restore the required source and tests into the new component structure during recognition
implementation. Preserve matching policies, preprocessing, model versions and expected outcomes;
API and deployment boundaries may change. Verify artifacts against the pinned manifests and
retain required notices and the corresponding-source offering.

## Local runtime archive

Untracked local files from the rebuild workspace are stored separately at
`E:/projects/magic-keeper-local-backup` (WSL: `/mnt/e/projects/magic-keeper-local-backup`).
It contains local data, credentials, deployment outputs, mockups and downloaded browser assets.
It is outside Git and must not be committed or used as test-account data.

The source checkout contains artifact preparation scripts, not every downloaded model.
Recover compatible cached assets from the local archive or fetch and verify pinned artifacts.
A filesystem archive does not establish which collection database is authoritative or prove a
consistent, restorable production backup. Collection migration requires its own verification.

## Baseline evidence

Before clearing the remaining implementation on 2026-09-26, 94 retained source/test/manifest files
matched their original Git blobs. Under WSL, 38 JavaScript and 27 Python regression tests passed.
The nine checked local database/WAL/shared-memory files were unchanged by the preceding source reset.

This is historical preservation evidence. It does not establish full-model inference accuracy,
live AWS/provider correctness or physical-camera performance, and it does not validate the rebuild.
