# r130 Import receipt reconciliation

IMPORT-05 is published as **r130-a1 / 0.1.0+deploy.130.1**, commit `a6454c02dab48b11c288012aea758350e8e313ef`, and passed exact-release desktop/mobile verification on September 12, 2026. The first main run remains failed because of one intermittent artwork-return focus assertion; its cause is unresolved and is retained as a QUALITY-01 follow-up below.

## Delivered scope and provenance

After the durable Add receipt, Import removes only confirmed pending content and records receipt-derived Recent activity without initiating or awaiting collection/tag reads. Collection consumers refresh stale data lazily. Unrelated draft order, current scroll, delayed navigation and retry identity remain protected. This does not implement backend read-scope/lookup optimization, whole-collection pagination or a statistically measured production speedup.

[PR #29](https://github.com/saintiago/magic-collection-keeper/pull/29) was implemented at `14312e5` and `0a735fc`. Review requested scroll/order coverage; the exact-head recheck for `0a735fca855a806238413d8c9809fbafdf5d0f7a` passed with no findings. The merged runtime tree is identical to that reviewed head.

## Verification

- [PR CI 34699249952](https://github.com/saintiago/magic-collection-keeper/actions/runs/34699249952): passed. 143 units, build, 148 Chromium cases, 105 WebKit cases (three unsupported-stream skips), 56 visual cases.
- [Main release 34700135435](https://github.com/saintiago/magic-collection-keeper/actions/runs/34700135435): all prepublication checks and the unchanged 127-file corresponding-source guard passed. API/site publication succeeded. Desktop LIVE-02 passed the zero-collection-read confirmation assertion, lazy consumer refresh, reload persistence and cleanup. Twelve of thirteen desktop cases passed; LIVE-17 failed its return-focus assertion before the Import operation. Mobile was skipped by the existing shell failure behavior. The run lasted 23m 04s to its failed conclusion and must not be reported as successful.
- Six unchanged local repetitions of the shared card-action scenario passed (three mouse, three touch). No speculative code or weakened assertion was introduced.
- [Exact-release verification 34701362285](https://github.com/saintiago/magic-collection-keeper/actions/runs/34701362285): passed against the same r130-a1 commit, without redeployment. **13 desktop and 8 mobile cases passed**, including LIVE-02 and LIVE-17. This took 7m 00s. Existing source/identity/account-isolation checks and scenario cleanup passed; no separate authenticated post-suite inventory audit was performed.
- An independent public read at **15:16:36 UTC** verified the release marker/commit/version, no-store HTML, immutable metadata, config/source-overlay/vendor-manifest hashes and byte-for-byte equality of all five changed JavaScript files with the merged source. This check needs no credentials.

Recognition remains version **19**, backend source SHA-256 `afc2f8fddd1de93e9d72af6efb6a729266bc8c2fc56bb7605e4a3d5384697491`. API code SHA-256 is `4PxOWIOMjP2SnQUSLbKoKHwfEv+noy/XgWaQpngTwuU=`. Frontend source overlay is 341,109 bytes, SHA-256 `9f16afa35f2998f95123f51fa8527ab210bd07969ee58088392168b354b00b61`. Runtime/model infrastructure and permissions were unchanged.

## Open evidence and quality work

The original LIVE-17 failure expected focus on `.card-open` or a Home card after dismissing the inspector, but found no focused source. An unchanged cloud recheck and six local repeats passed; this establishes intermittency, not root cause or resolution. QUALITY-01 follow-up must capture active-element, source connection and redraw timing on recurrence, reproduce the race before choosing a repair, and retain focus assertions. No new feature or automatic development priority is inferred.

IMPORT-07 remains partially verified: existing failure/idempotency/50-row and larger saved-batch tests pass, but this release does not supply a repeated production before/after timing study or larger-session resource measurement. [Controlled local timing and limits](IMPORT05-VALIDATION.md) remain the only before/after comparison. IMPORT-06/08–10 backend work stays queued.

Because the originating main run failed, success-only artifact cleanup is not eligible. Its build and plan artifacts retained their existing one-day expiry (September 13, approximately 15:01 and 14:44 UTC). A successful separate verification does not relabel the main run or override that policy. No retention/CI behavior was changed. Physical-device behavior remains unverified.
