# Continuous scanner implementation and validation

September 11, 2026. Implements the owner's authorized scanner priorities SCAN-11-14 while preserving the physically accepted SCAN-10 sequence rule. Current status: deployed and production verified within automated browser/cloud coverage in [r127-a1](R127-RELEASE.md). The paced local persistence soak passed 2,000 simulated captures over two hours. The owner's phone heat/battery behavior is not measured here.

## Behavior and bounds

- Fifty accepted captures roll into an atomic pending batch, then the same camera stream continues. No accepted-card/attempt session cutoff remains. Existing per-request/provider quotas still apply.
- One session manifest references immutable ordered batch indices. Capture IDs and permanent stage receipts prevent duplicate staging; Add retains its existing permanent ownership receipt. Capture/stage/Clear never create ownership.
- The browser journal and wheel retain at most 50 active plus ten recent saved rows, and one frozen outgoing batch. No captured images are stored. Review fetches one batch at a time using Previous/Next, preserving chronological tombstones after Add/Clear. The current general collection preview/global Import list behavior is unchanged; this is not the queued app-wide SCALE/IMPORT migration.
- Storage/network backpressure pauses new admission, retains the exact operation and exposes Retry saving. Reload recovers the last accepted Oracle ID, so A,A remains one while A,B,A remains three across rollover/resume. Archived quantities are changed in Review.
- Reusable 384,000-pixel analysis and 24x32 signature buffers replace repeated full-resolution capture. Geometry reuses 384x384; high-resolution recognition crops remain up to 4 MP but are copied only when needed. The 120 ms stability tick is retained. Geometry has 350 ms minimum spacing and pauses during recognition/cooldown; repeated/unclear results back off up to three seconds with periodic rechecks and motion-based shortening. Stop/background dispose workers and cancel overlay work; idle overlay draws only on state change. Requested camera rate ideal 15/max 24 fps requires actual-device verification.

## Same-clip browser-model replay

One local 20.2-second previously recorded private clip, played at 0.5x, with actual browser ONNX models, frozen canonical metadata and external requests blocked. CaptureStream comes from a 720x1280 canvas on desktop Chromium; this is neither a current phone capture nor cloud-model verification. Images remain in ignored local files. Baseline uses the published r125 scanner. Instrumentation counts unique main-thread canvases, their initial allocated pixel capacity and cumulative getImageData pixels; these are workload proxies, not peak memory or measured CPU/GPU/heat.

| Metric                                 | r125 baseline | Updated scanner |
| -------------------------------------- | ------------: | --------------: |
| Distinct canvas surfaces               |         1,299 |              27 |
| Sum of initial canvas pixel capacities |   169,854,198 |       6,332,038 |
| Cumulative readback pixels             |    33,328,680 |      16,294,266 |
| Geometry checks                        |           160 |              76 |
| Recognition attempts completed         |            12 |              11 |
| Accepted canonical identities          |             4 |               4 |
| Overlay draw frames                    |         1,788 |             227 |

Both accepted Will of the Jeskai, Elsha Threefold Master, Aligned Heart and Frostcliff Siege in that order. Seven other readings were unresolved; this clip does not establish comprehensive recognition accuracy. An earlier 700 ms geometry/200 ms sampling trial missed Elsha and sometimes Aligned Heart. That trial was rejected; restoring 120 ms cheap sampling and 350 ms geometry recovered all four identities in both diagnostic and final replays. The first accepted result was later in the final replay (~1.76 versus 1.30 seconds of video time); do not claim a universal latency improvement. Cumulative canvas capacity declined 96%, readback 51%, geometry 52.5%; timing/workload numbers are environment-specific.

Evidence is retained privately in `data/recognition-evaluation/phone-feedback/scan12-resource-before.json`, `scan12-resource-after.json` and diagnostic/initial-trial files. No private image or owner account data is committed. The helper is local `data/recognition-evaluation/scan12-resource-replay.mjs`.

## Persistence and browser acceptance

142 unit tests pass, including 2,000 durable captures across 40 batches, concurrent conditional staging without partial writes, account separation, Add/Clear counters and permanent replay, frozen lost-response recovery, disk failure, corrupted session refusal and coalesced writes. Build passes. Two new browser cases passed 61 photo captures and 53 simulated-camera captures with automatic rollover, lost-response Retry, same stream continuation, bounded DOM and historical Review. Existing focused recognition/review cases passed 13/14 initially; the sole failure was the legacy corruption message wording, restored afterward. The full Chromium run passed 141/142 cases; the wheel scroll case exposed a redundant wheel rebuild interrupting smooth scrolling. Wheel updates now preserve unchanged DOM/scroll, and all focused retests passed. WebKit passed nine cases with one unsupported-stream skip; the new photo rollover case exposed an upload arriving during final persistence. Upload is now disabled during backpressure and the test waits for this user-visible readiness. Historical Add/Clear navigation passed against real local application ports. The corrected application passed the full main CI run: 143 Chromium, 105 WebKit (three unsupported-stream skips), 56 visual, 13 desktop live and eight mobile live cases. See the release evidence above.

`tests/live/scanner-batches.spec.js` adds LIVE-21 actual cloud 105-capture staging as 50/50/5, one session summary, bounded acknowledgements, historical Review/reload, explicit Add 50, replay, Clear five, account isolation and test cleanup. Passed against actual cloud storage in the r127-a1 main deployment (11.2 seconds for the complete LIVE-21 scenario).

## Paced soak and limitations

`node --expose-gc tests/performance/scan-session-soak.mjs <ignored-directory> 7200 2000` completed successfully against an isolated durable SQLite database and the browser journal engine in Node. It paced simulated accepted rows from 17:32:49.489 to 19:32:50.196 UTC, reloaded the journal every 50, checked ordered batch counters and confirmed zero ownership writes. [All 40 samples and final metrics](SCAN12-SOAK.json).

| Measurement                                |                      Result |
| ------------------------------------------ | --------------------------: |
| Accepted captures / durable batches        |                  2,000 / 40 |
| Elapsed seconds                            |                   7,200.027 |
| Retained recent rows after completion      |                          10 |
| Peak / final serialized journal bytes      |              32,135 / 4,304 |
| First / final post-GC heap bytes           |      9,818,664 / 10,172,112 |
| Post-GC heap range from capture 650 onward | 10,156,080-10,172,792 bytes |
| Maximum local batch stage time             |                    25.22 ms |
| 50-capture sample interval range           |     179.981-180.031 seconds |
| Ownership writes                           |                           0 |

The late sampled heap range spans only 16,712 bytes while another 1,350 captures accumulate durably. The paced batch intervals show no cumulative scheduling drift in this run; they are not recognition latency or UI responsiveness measurements. Sampling post-GC Node heap does not establish browser peak RSS, CPU/GPU cost, camera behavior, phone heat or battery use. The run began before later defensive input-validation checks; its final journal was successfully loaded through the deployed module afterward, preserving the session ID, 2,000 archived captures, batch index 40, last Oracle identity, ten recent rows and empty active/outgoing buffers. The same successful protocol was exercised throughout; no two-hour recognition/model or physical-camera test is claimed.

Physical acceptance remains: scan for an extended session on the owner's phone, check stationary/consecutive suppression, alternating cards, glare/overlap, saved-batch Review, recovery, background/Back shutdown, heat and battery. Local/cloud tests cannot establish acceptable physical temperature or camera/audio behavior.

Source packaging: the initial refreshed local archive exceeded the existing 4,000,000-byte bound. The source builder now lists upstream documentation-only pictures in a pinned URL/SHA-256 manifest while retaining all upstream code/notices/examples/tests and every existing application/build source check. The complete pinned upstream checkout is still retrieved by the included installer. The size bound and source verification guards are unchanged.

Final local checks: 142 unit tests, build, all 11 focused scanner cases after the wheel/upload fixes, ten focused WebKit cases plus one unsupported-stream skip, and 56 visual/layout cases passed. The final historical mobile Review screenshots were inspected for navigation and fit. Actual cloud/source-image verification subsequently passed; the paced two-hour persistence soak and final-module journal compatibility check also passed.
