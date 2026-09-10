# Shared tag and stationary-card revision

Status: locally verified working revision; production release and physical-device verification are pending.

The revision implements SCAN-03/04's conservative departure latch, CARD-10's same-image return and CARD-11–17/DRAG-04–05's shared tag controls. Mouse hover uses a fitted 200% target, mouse click a fitted 300% target, and touch tap a fitted 200% target with radial tags. A tag gesture freezes its Add/Remove intent. It preserves owned totals and unrelated assignments, and keeps catalogue/pending cards unowned until explicit Add.

Local verification on September 10, 2026:

- 128 unit tests and the application build passed.
- The complete Chromium application suite passed 124 cases. A subsequently added native-touch menu/quantity-page case passed separately in Chromium and WebKit.
- The current required WebKit selection passed 89 cases, with one existing unsupported camera-stream case skipped. This includes the additional touch menu case and the final radial-label contrast styling.
- All 54 visual prototype cases passed in Chromium and WebKit after the final contrast change: fit, typography, glass interaction, rendering fallback and all return-animation cases.
- Six focused cases passed in each engine for enlarged touch drag, outside-link frozen Remove, pointer-capture loss, resize, second-finger pinch handoff and sign-out.

Public artwork review used White Sun's Twilight (ONE #377) and Animation Module (KLD #194) in mouse and 390×844 emulated-touch views. Labels were checked over light rules boxes and darker artwork. A soft radial backing was added to touch labels after inspecting the first captures. The no-blur comparison explicitly enabled the existing fallback rules and disabled backdrop filters; it does not establish behavior on a particular unsupported browser. Captures used the loopback prototype, without accounts or API writes. They are not physical-phone evidence.

The local evidence is reproducible through `tests/ui/card-tags.spec.js`, `tests/ui/card-tag-retry.spec.js`, the complete application suite and `tests/prototype`. `tests/prototype/capture.mjs` follows the current tag/outside-dismiss controls. Both full and frontend CI selections include the new WebKit tag suites.

Hosted Linux return diagnosis exposed early paint stalls of 96–243 ms: the unchanged repeated baseline failed 14/40 cases; preparing the moving layers alone still failed 5/40. The final correction also limits spring progress after a delayed paint, with a bounded wall-time fallback and unchanged opening transforms. The same shrinking-frame and exact-handoff assertions remain. A controlled 180 ms main-thread stall was added. [Corrected Linux run 34424372478](https://github.com/saintiago/magic-collection-keeper/actions/runs/34424372478) passed all 45 WebKit cases (nine cases repeated five times); 18 local cross-engine return cases, 128 unit cases and build also pass. These results do not establish physical-phone smoothness.

The deployed checks have been migrated to the current menu and dedicated quantity page. LIVE-17/18 additionally verify explicit owned-tag intent, exact replay after a later opposite operation, targeted pending-tag persistence and explicit ownership confirmation against actual JWT/Dynamo state. Those checks must pass through the existing deployment workflow using only reserved profiles before this revision can be marked production verified.

Split-card recognition, sessions beyond the current 50-row bound, recognition-provider badges, the Import grid/order revision and exact-printing Recent history remain separately queued. No local test establishes optical accuracy, speaker audibility, real provider correctness or an unobservable swap of identical physical cards.

Published r107 verification [34430152131](https://github.com/saintiago/magic-collection-keeper/actions/runs/34430152131) passed 10/11 desktop and 6/7 mobile cases. LIVE-18 passed real cloud owned-tag retry, pending replay and explicit Add. LIVE-17 exposed a late initial tag response replacing the hidden catalogue source while artwork remained open. A deterministic delayed-response regression fails before the fix and passes after general grid renders reconnect the lifted source by stable key. Fit, exact return, focus and unchanged ownership assertions remain. LIVE-12 also retained two old inspector-details selectors and now follows the shared source-menu helper.

The source-refresh repair passes the complete local LIVE-17/18 core rehearsal in Chromium and WebKit, the delayed-response regression in both engines, all 44 selected WebKit card-action/tag/page cases, 128 unit cases and build. These are local checks; the repaired runtime still requires a new normal-main publication and complete deployed verification. Repeating verification against unchanged r107 cannot deliver this runtime correction.

Production completion: r114-a1/main5ba64746bbf858cf8072f90a14b3e0869d456624 passed all 12 desktop and eight mobile live cases, including both complete card-action scenarios. Independent source/API identity and cleanup checks passed. Six actual served-layout cases and twelve inspected card/Home screenshots retain full fit, tags-only controls, hidden/recovered source, consumed dismissal and focus. This supersedes earlier pending-release notes in this report. [Final evidence](R114-RELEASE.md). Physical-device behavior remains unverified; the other queued scanner/Import/view/flip requirements are not closed by this release.
