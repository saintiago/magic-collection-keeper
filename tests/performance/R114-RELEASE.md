# r114 release verification

Release **r114-a1 / 0.1.0+deploy.114.1**, main `5ba64746bbf858cf8072f90a14b3e0869d456624`, is production verified within the automated browser/cloud coverage below. [Normal main workflow 34432477877](https://github.com/saintiago/magic-collection-keeper/actions/runs/34432477877) succeeded on September 10, 2026. [Machine-readable identity and visual results](R114-VERIFICATION.json) preserve the independent checks.

## Delivered behavior

- **RECENT-01–04:** Qualifying opens, confirmed autocomplete choices and successful additions retain exact printings, artwork, action targets and bounded account-isolated order. Hover, typing, failed additions and restored pages do not create false activity. Pending cards remain unowned. Atomic import receipts identify actual additions and preserve that list on replay without adding copies again; unchanged imports and legacy receipts do not create guessed history.
- **VIEW-04:** Whole-collection totals appear below Home content and are hidden on collection, catalogue, tag/deck, Import and card routes. Loading, saved-state failures and account isolation retain their existing semantics.
- **CARD-10–17 / DRAG-04–05:** Shared tags-only enlargements, mouse hover/click and touch radial controls retain atomic tag retry/replay, explicit catalogue Add, quantity/provenance boundaries, fitted artwork, source return and focus. A delayed initial tag refresh now reconnects the hidden source immediately after grid replacement.
- **SCAN-03/04:** The attempted-card latch and sustained visual-departure gate are deployed. Automated and synthetic-stream checks pass; physical-camera acceptance remains outstanding.

## Verification

| Check | Result |
| --- | --- |
| Unit | 131 passed |
| Chromium application | 139 passed |
| Required WebKit application | 103 passed; one existing unsupported camera-stream case skipped |
| Cross-engine visual prototypes | 56 passed |
| Actual deployed desktop | 12 passed |
| Actual deployed mobile WebKit emulation | 8 passed |
| Independent served layouts | Six passed: Chromium/WebKit at 1280×900, 390×844 and 320×568 |

LIVE-17/18 passed actual owned-tag lost-response retry, later replay, pending-tag persistence and explicit ownership confirmation; LIVE-17 also checked rejection of a foreign reserved account's entry. LIVE-19/20 passed actual two-printing receipt replay, pending exclusion, exact Recent artwork and reload order. LIVE-10 passed actual Home totals and placement. These cases use the reserved profiles and preserve their existing fixture boundaries. The independent read-only check subsequently confirmed the temporary test inventory and pending drafts were empty.

Independent served-layout checks used public Animation Module artwork and explicitly synthetic read-only rows. They blocked API writes and recorded no writes or browser errors. All twelve card/Home screenshots were inspected: complete card fit, reachable tags, consumed outside dismissal, source/focus restoration, totals below Home content, absence on collection, and Recent persistence after reload. These visual fixtures are not evidence of real inventory persistence; the live cases above provide that evidence.

The deterministic delayed-tag regression failed before the source-refresh fix and passed afterward in Chromium and WebKit without weakening fit assertions. Earlier r103 verification exposed stale Clear test setup; r107 exposed the actual source replacement bug and two obsolete mobile details selectors. The final r114 run resolves those release blockers. Historical failed runs remain evidence of diagnosis, not successful delivery.

## Independent identities and corresponding source

The served HTML, immutable release metadata, authenticated API headers, actual Lambda code identity, configuration/vendor hashes and matching frontend/backend source archives were independently compared after live cleanup.

- API code SHA-256: `GCACU9li5Eo+3+7A/wKbEkXtVBMnd36dIZP4snMeQU4=`; last modified `2026-09-10T03:29:26Z`.
- Recognition alias `review`: version **17**; source SHA-256 `539e8b27910233ab6a8c87dfb7c47acc1e312e1f6124407707bc75c525aadb70`.
- Corresponding source: 3,971,503 bytes, 524 archive entries, 381 exact tracked files; all 124 private runtime/build files match the released tree. [Source build 34430173372](https://github.com/saintiago/magic-collection-keeper/actions/runs/34430173372) and [reviewed publication 34431031474](https://github.com/saintiago/magic-collection-keeper/actions/runs/34431031474) succeeded; archive and actual ECR image identity audits passed.
- ECR image digest: `sha256:42110f341cef071d8beb0768e27ce50c21d73c7978ff1cea4bd738fc18a299aa`.
- Frontend source: 335,857 bytes, SHA-256 `1e0fdbdbe51cee440943bd11980d21a0a69f0a7c4faff967d8ffa5e204f2bab5`.
- Vendor manifest: `8043dde8ed15a9a00c4e192b1124b22d93dbe66dd44783a81e3403b7e0e1243f`; configuration: `47ebb405ec319d967c451df19e6932eb355a8b9e424aae8e296d24b4833fd93f`.

The recognition source update changed only the existing Function, Version and Alias resources. Both actual authenticated image routes, unauthorized/invalid/body-owner rejection, byte/pixel bounds, multiple-card/overlap handling and source download passed. Memory remains 3008 MB with a 20-second timeout, no provisioned/reserved concurrency and no model image/text logging. The first measured primary image request took 15.426 seconds and the independent route 4.448 seconds; subsequent samples took 1.017 and 1.538 seconds. These are individual measurements, not a latency guarantee or a physical-camera benchmark. No preparation/source request preceded the first measured image request.

## Limits and remaining work

Browser emulation, controlled pointer events, generated streams and public photographs do not verify physical camera accuracy, reflective sleeves, real consecutive identical-card handling, speaker audibility or phone/GPU smoothness. No owner account or owner inventory was used for tests or changed as part of this release.

SCAN-01/02 and SCAN-05–07, IMPORT-01–04, VIEW-01–03 and CARD-09 remain queued under their saved acceptance criteria. In particular, the 50-line capture limit, split-card handling and Import grid/order revision are not completed by r114. Earlier requirement decisions remain recorded; this checkpoint supersedes only the older pending-release statuses for the delivered scope above.
