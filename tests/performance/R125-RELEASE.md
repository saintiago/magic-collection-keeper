# r125 consecutive scanner verification

SCAN-10 is published and verified within automated browser/cloud coverage in **r125-a2 / 0.1.0+deploy.125.2**, commit `79c0ced9ca188d483a221d80b9dc67f79c536ce3`, on September 11, 2026. The owner's physical-phone acceptance remains pending.

## Behavior and cause

The owner replaced strict visual departure/artwork checks with consecutive canonical-card suppression. A,A creates one row; A,B creates two; A,B,A creates three. Suggested printing/language/finish changes do not create another copy of the same Oracle ID. Consecutive identical physical copies use quantity. Brief stability, usable single-card geometry, actual multiple-card rejection, bounded requests, explicit ownership confirmation and no duplicate/unresolved success cue remain. Late provider results stay on their original capture without changing the accepted sequence.

SCAN-09 replay reproduced the old artwork comparison blocking distinct real cards despite stable single-card geometry. The new policy removes that latch. The earlier recording replayed locally with actual geometry and primary visual/OCR recognition accepts ten later distinct cards; the partial first card and another briefly shown card did not resolve. No private image left the computer. [Diagnosis, sequence tests and limitations](SCAN10-REPAIR.md).

## Release and verification

[Main attempt 2](https://github.com/saintiago/magic-collection-keeper/actions/runs/34594131957/attempts/2) published the app after all prepublication checks passed. It remains **failed**: an old shared LIVE-14 helper expected two identical photo uploads to create two rows. Eleven desktop cases passed, including the new continuous scanner sequence, but mobile did not run.

[PR #25](https://github.com/saintiago/magic-collection-keeper/pull/25), test commit `c0a4c3eb0b764f9981879fd9f0f9ed162af0a642`, corrected that obsolete expectation. It now requires duplicate suppression, manual quantity three on one row, explicit Add, reload and cleanup. The application was unchanged. The existing [exact-release verification workflow 34597459303](https://github.com/saintiago/magic-collection-keeper/actions/runs/34597459303) then passed against r125-a2 under the publication lock, using only reserved test profiles.

| Check | Result |
| --- | --- |
| Unit | 135 passed |
| Chromium application | 140 passed |
| Required WebKit application | 103 passed; one existing unsupported-stream skip |
| Visual prototypes in both engines | 56 passed |
| Exact-release desktop live | 12 passed |
| Exact-release mobile live | 8 passed |
| Independent served/API/source/config/vendor identity | Passed |
| Reserved temporary inventory and drafts after cleanup | Empty |

LIVE-04 passed in 25.7 seconds: repeated Adaptive Training Post is suppressed, including after an empty guide; quantity becomes two, Lightning Bolt is accepted directly, and Adaptive is accepted again. Three reviewed rows save four copies, survive reload and are cleaned up. Desktop/mobile LIVE-14 pass duplicate-photo suppression and explicit persistence. Mobile LIVE-13 accepts six alternating public-card photos after suppressing a consecutive duplicate, retains unknown/multiple rejection, and completes wheel/review/Clear without ownership writes. These use real deployed recognition and persistence with synthetic camera/photo input, **not physical-device verification**.

The first main attempt had stopped before publication on an unchanged WebKit keyboard-menu case. That exact case passed twice locally and in the single failed-job retry; no unrelated code or check was weakened.

## Source, identity and retention

Independent read-only verification at 12:16 UTC confirmed the exact published frontend/API identities and source/config/vendor hashes. Recognition remains version 18 with source SHA-256 `a54121d9a92ebef46e4944a26223268bb6dc07d6123cd778bfbd7c34b69b7cd3`; the unchanged committed guard verifies all 126 backend/runtime/build files. No backend model, infrastructure or provider policy changed.

API code SHA-256: `gczD57bJQ8w7wb/QItlo+BnW3m/zEUHNfNRzO1pFlrY=`. Frontend source overlay: 336,405 bytes, SHA-256 `9d5d18f928d90f8a83aba9ddd8511c0d077df6366cd675923111a23966e95c14`. Vendor and config hashes match r123. Full JSON and CI logs remain in ignored `data/recognition-evaluation/phone-feedback` as `frontend-verified-r125-a2.json`, `scan10-main-live.log` and `scan10-exact-live.log`.

The originating failed run is ineligible for automatic success cleanup. Its build artifact 10262464164 and plan artifact 10260537812 retain their existing one-day expiry on September 12. The separate live-verification artifact also expires after one day. No cleanup guard was relaxed and no manual deletion was performed. All unrelated backlog remains paused.
