# One-card admission, live overlay and independent recognition

September 9, 2026. This report describes recorded-input and desktop browser checks. Deployed checks are recorded separately after release. Private media and raw provider outputs are excluded from this repository.

## Exactly one visible card

Final scheduling uses `scan-admission`: cheap visual tracking continues every 120 ms independently of the geometry worker. It credits an existing stable interval and admits only a checked frame from the same uninterrupted scene, at most 450 ms old. A scene change rejects old geometry; the accepted-card anchor survives overlap. A bounded adjacent-frame buffer chooses a sharper snapshot. The selected stability window is 600 ms after comparing 720/600/480 ms on the recorded video, with the same geometry guard. This replaces the earlier serial check plus delay; worker processing does not start a second hold interval.

Before capture admission, a separate browser worker runs the verified Cornelius geometry model on the actual guide crop. It masks the expanded primary quadrilateral and runs geometry again to detect another visible region. Multiple or ambiguous regions quietly reset stability without queuing a copy or playing a cue. Overlap does not rearm the outgoing card; observed departure and subsequent stability are still required for another identical copy. The backend and independent service apply the same geometry policy before artwork/OCR/model work.

The final actual Chromium and Windows WebKit replay admits all 24 original single-card photos, rejects blank, noise and a plain-paper title, and waits on the two-card frame and all four overlapping arrangements. One clean public control is admitted. Typical checks take about 190 ms in Chromium and 230 ms in WebKit, while cheap visual tracking independently runs every 120 ms. The extra worker shares downloaded assets but owns a separate small geometry session. This is not proof that fully hidden cards or every thin overlap can be detected. Thresholds were tuned on these examples; they are not a fresh holdout.

The guarded public full-service replay retains 71/72 correct degraded public frames with no wrong identity and rejects blank/noise. A controlled camera test exercises two cards → one → overlap → the same outgoing card → empty → identical card: exactly two copies, no overlap cue. The identity port in that sequence is controlled; a separate test runs actual geometry and artwork workers.

## Truthful overlay

A transparent, pointer-inert canvas maps detected source regions through the clipped guide and actual video object-fit scaling. Its animation loop reads geometry and stage metadata, without copying camera frames. It shows detected outlines, actual browser artwork work, general remote work, and a brief recognized identity with a printing-review reminder. Capture IDs and visual departure reject stale stage/result events. Navigation, sign-out and page hiding dispose activity. Reduced motion disables pulsing, and visible status changes avoid repeated identical live-region announcements.

The current HTTP backend does not stream internal OCR phases. Therefore the live overlay cannot truthfully show the exact moment or title box of remote OCR, and does not invent it. The title-band renderer accepts only a real OCR stage event; the production remote path uses general activity. No unmeasured glare or focus diagnosis is displayed. Geometry/projection, resize, stale events, reduced motion and teardown have tests; real worker tests collect draw timings. Physical phone frame rate, thermal behavior and audibility remain unverified.

## Native-speed recorded video

Actual Chromium, actual browser geometry/artwork workers and a loopback backend with real Nova Lite/Pro ran the original 20.2-second recording without pausing its timeline. The initial serial geometry implementation queued two cards, or four after removing its extra scheduling delay. That regression was not released. Continuous tracking with bounded checked-frame reuse produces six distinct correct captures at 720 ms and eight at both 600 and 480 ms. The selected 600 ms preserves a longer stability interval with the same measured coverage. All eight selected identities are correct and distinct; no ownership writes occurred. This is not deployed API/Lambda latency or physical-camera verification.

| Card                       | Approximate visible interval | Longest measured raw stable interval at 600 ms setting | Outcome                                                                       |
| -------------------------- | ---------------------------- | -----------------------------------------------------: | ----------------------------------------------------------------------------- |
| Adaptive Training Post     | 0–0.6 s                      |                                                 290 ms | Initial partial card; no eligible single-card window                          |
| Will of the Jeskai         | 0.6–2.6 s                    |                                                1134 ms | Correct capture                                                               |
| Alania, Divergent Storm    | 2.6–4.6 s                    |                                                 676 ms | Correct capture                                                               |
| Melek, Izzet Paragon       | 4.6–6.3 s                    |                                                 935 ms | Correct capture                                                               |
| Mizzix of the Izmagnus     | 6.3–7.9 s                    |                                                 656 ms | Correct capture                                                               |
| Giott, King of the Dwarves | 7.9–9.7 s                    |                                                 955 ms | Correct capture                                                               |
| Balmor, Battlemage Captain | 9.7–11.4 s                   |                                                 957 ms | Correct capture                                                               |
| Shaun, Father of Synths    | 11.4–13.0 s                  |                                                1065 ms | Correct capture                                                               |
| Tempest Technique          | 13.0–15.5 s                  |                                                1056 ms | Clear single physical card, but geometry remains ambiguous: a false rejection |
| Elsha, Threefold Master    | 15.5–18.5 s                  |                                                 282 ms | Motion/stability prevents admission; some geometry checks are ambiguous       |
| Aligned Heart              | 18.5–19.9 s                  |                                                 782 ms | Correct capture                                                               |
| Frostcliff Siege           | 19.9–20.2 s                  |                                                   0 ms | Final partial card; no eligible window                                        |

These are manually annotated approximate visibility boundaries and sampled stability measurements, not precise physical ground truth. Eight of ten substantially visible cards are captured; eight of eight geometry/stability-admitted windows succeed. Reporting only the latter denominator would hide Tempest's geometry failure. The old pre-guard eight-card replay included Tempest but missed Alania; equal totals do not mean identical coverage. No identical physical-card swap occurs in this video; separate controlled overlap/empty/identical-copy tests cover that state behavior. Overlay drawing averages about 0.03 ms, maximum 0.5 ms on this desktop while real workers run; this is canvas draw cost, not end-to-end input latency.

## Independent image-model comparison

The independent reader receives the full bounded card image and a fixed prompt, without artwork candidates, a proposed title, or owner data. Exact unique canonical identity/whole native-title lookup validates proposals. A conflicting visible title, ambiguous alias, uncertain response, invalid count or unavailable provider cannot add a copy. Catalog validation limits model output; it does not prove visual correctness or printing/finish/ownership.

Actual available Amazon models were compared on 24 original photos and five provider-reached negatives, with a sixth noisy input rejected by the 512 KB encoding bound. There were 87 completed provider calls, not 90. No third-party Marketplace subscription or model agreement was created. Availability and first-use agreement behavior were checked against [AWS model access documentation](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html).

| Model       | Correct photos / 24 | Wrong accepted photo identities | Raw negative false accepts before geometry | Measured call median / p95 | Recorded 29-call token cost |
| ----------- | ------------------: | ------------------------------: | ------------------------------------------ | -------------------------: | --------------------------: |
| Nova Lite   |                  21 |                               0 | Overlap, partial card                      |             1081 / 1323 ms |                 $0.00399558 |
| Nova 2 Lite |                  21 |                               0 | Partial card                               |             1509 / 2149 ms |                 $0.01234651 |
| Nova Pro    |                  22 |                               0 | Partial card                               |             1260 / 1519 ms |                 $0.05232720 |

These are reused-image SDK wall times including transport, with linear-interpolated p95. They are neither fresh Lambda nor physical-phone measurements. Validation was re-evaluated from retained responses after fixing a Windows text-decoding error and adding exact native-title resolution; there was no paid rerun for that correction. Prices checked in the official regional AWS Price List: Lite $0.06/$0.24, Nova 2 Lite $0.33/$2.75, Pro $0.80/$3.20 per million input/output tokens. [AWS Bedrock pricing](https://aws.amazon.com/bedrock/pricing/). Costs exclude other experiments, Lambda/API and taxes.

Nova Pro is the selected independent port, based on this small comparison. It runs alongside existing Nova Lite OCR corroboration, which remains a separate bounded fallback inside the primary visual/OCR service. The final actual guarded replay uses the app's 2000-pixel, JPEG86 preparation: primary 24/24 correct, independent Pro 21/24 correct, zero wrong accepted identities. All five provider-sized negatives are rejected before model invocation, and noise is rejected at transport size. The difference from 22/24 above demonstrates encoding/model variability; do not promote the small sample into a general accuracy claim.

The browser permits one independent request in flight and up to 50 per scanner session. Similar Pro requests average about $0.00180 each in the comparison (roughly $0.09 for fifty); input token usage varies and this is an estimate, not a billing cap. Cancellation may not cancel provider billing. The primary path continues when the independent slot/budget is exhausted. No periodic or provisioned warm compute is introduced. IAM is limited to InvokeModel on the regional Nova Lite and Nova Pro foundation-model ARNs.

First validated identity appears immediately. Late results merge into the same capture with all supported alternatives and provenance, without another copy or sound. Whole-title OCR/corroboration ranks ahead of independent visible-title evidence, then artwork alone; unrelated model confidence scales are never compared. Existing user edits remain authoritative, and Import still requires explicit Add to establish ownership.
