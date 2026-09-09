# Frontend deployment evidence

Requirements: DEPLOY-01–05; use case: UC-DEPLOY-FAST. All timestamps are UTC. This is deployment evidence, not physical-camera verification.

## Controlled comparison

The comparison uses main commit `73da726ed014b015af6bcb4090b082b326074981` for both runs. The second run explicitly redeploys that compatible frontend through the main workflow's `redeploy_frontend` input. Classification, source, configuration, backend and publication guards remain active.

| Path              | Actions run                                                                                  | Start               | End                 | Total elapsed | Result |
| ----------------- | -------------------------------------------------------------------------------------------- | ------------------- | ------------------- | ------------- | ------ |
| Full bootstrap    | [34410604244](https://github.com/saintiago/magic-collection-keeper/actions/runs/34410604244) | 2026-09-09 22:07:42 | 2026-09-09 22:26:00 | 18m 18s       | Passed |
| Separate frontend | [34412220135](https://github.com/saintiago/magic-collection-keeper/actions/runs/34412220135) | 2026-09-09 22:26:27 | 2026-09-09 22:39:27 | 13m 00s       | Passed |

Total elapsed uses the Actions run's creation and final update timestamps, including runner setup, checks, publication and deployed verification. The frontend run saved **5m 18s (29.0%)**. The separately verified recognition image bootstrap is excluded from this comparison. One pair of runs is an observed comparison, not a fixed latency guarantee; runner queues, package installation and network/provider timings can vary.

## Verified full-release baseline

- Frontend/API: `r90-a1`, version `0.1.0+deploy.90.1`, main commit above.
- API code SHA-256 (base64): `neY5u4T07hi4Pkko7+2IXPfQvpeLjSCmPqiOtbQGERQ=`; Lambda last modified `2026-09-09T22:19:14.000+0000`.
- Vendor asset release: `r90-a1`; manifest SHA-256 `8043dde8ed15a9a00c4e192b1124b22d93dbe66dd44783a81e3403b7e0e1243f`.
- Recognition version: `15`; source SHA-256 `415ca102f414237bb93a7c6263789ee5dcb3385b40cf4a4ed2d012e3d9e2cad2`.
- Exact frontend source overlay: 321,855 bytes, SHA-256 `56c576dc49fb746597aba53c76b40d63831a9aaf5bc357fde6d3821fd3f5781a`.

Full main checks: 117 unit tests, build, 103 Chromium application tests, 69 WebKit tests plus one unsupported canvas-stream skip, 38 prototype checks, 11 deployed desktop tests and seven deployed mobile tests. The read-only post-run verifier checked actual release/API identities, API code hash, recognition alias/version, source/configuration/overlay/asset-manifest hashes and empty reserved `keeper-e2e` inventory/drafts.

The source bootstrap passed [recognition verification 34409580180](https://github.com/saintiago/magic-collection-keeper/actions/runs/34409580180) and [trusted publisher 34410106878](https://github.com/saintiago/magic-collection-keeper/actions/runs/34410106878). The audited archive contains 500 entries and 3,530,907 bytes; all 118 backend/runtime/build files match the committed source, with no private-data paths or credential-pattern matches. Only the recognition Function/Version/Alias changed. Actual authenticated image, invalid-input, two-card/overlap and matching-source checks passed using a generated public-art fixture. No provisioned concurrency, periodic warm compute, model image/text logging, owner-data writes or CI-role expansion was introduced.

## Verified frontend release

Frontend `r91-a1` is version `0.1.0+deploy.91.1`, while the API remains `0.1.0+deploy.90.1`. The post-run read-only verifier confirmed that the API code hash and last-modified timestamp, recognition alias revision/version, source digest, configuration hash and vendor asset identity all exactly match the full baseline. Served worker modules reference `/releases/r90-a1/vendor/`; the new frontend prefix contains no copied vendor bundle. Its exact public-source overlay is 321,855 bytes with SHA-256 `3817fcefc78daa724d4c26f5e53f518b502dce79964a05ce6c743aa538f26293`.

The actual separate reusable workflow passed 117 unit tests, 91 Chromium application checks, 60 WebKit checks, 38 prototype checks, four deployed desktop checks and two deployed mobile checks. The normal full test/deploy jobs were skipped. The new footer identity, independent API headers and combined source were verified from production; reserved `keeper-e2e` inventory and pending drafts were empty afterward. Production rollback was not intentionally triggered; its stale-release/backend, invalidation-failure and newer-release protection paths have local regression coverage.

## Regression coverage

`tests/release-plan.test.js` covers presentation eligibility, unknown/full inputs, incomplete identities and guarded redeploy. `tests/release-assets.test.js` verifies every reused byte and rejects malformed, corrupt, missing or incomplete assets. `tests/publish-frontend.test.js` covers stale frontend/backend/metadata rejection, a backend change during upload, rollback after invalidation failure and refusal to overwrite a newer release.

`tests/frontend-source.test.js` checks committed public-source membership, removed files and exclusion of generated/private data. `tests/source-package.test.js` independently decodes the TAR with Python and rejects corrupt, oversized, missing and aborted source responses. `tests/ui/frontend-release.spec.js` starts real packaged geometry and visual workers using the previous vendor prefix in Chromium/WebKit, and checks source retry and cancellation. LIVE-05 checks the actual independent deployed identities and combined source; LIVE-14 also validates the downloaded combined source during full recognition verification.

The frontend workflow restores verified vendor assets, runs unit/frontend/browser/prototype checks, and performs four desktop and two mobile live checks using reserved profiles. Its publication step has no API, model-image or catalog update command. Unknown inputs and incompatible or incomplete identities still require the full path; checksum, source or publication-guard failures stop the run. Scanner, touch/tag overlays, Import and Recent requests remain separate work and are not claimed as delivered by this deployment change.
