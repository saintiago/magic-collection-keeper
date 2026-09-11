# Continuous scanner implementation and validation

September 11, 2026. Implements the owner's authorized scanner priorities SCAN-11-14 while preserving the physically accepted SCAN-10 sequence rule. Current status: locally implemented; full browser checks, final soak and deployment verification pending. Production remains r125-a2 until a recorded release succeeds. The owner's phone heat/battery behavior is not measured here.

## Behavior and bounds

- Fifty accepted captures roll into an atomic pending batch, then the same camera stream continues. No accepted-card/attempt session cutoff remains. Existing per-request/provider quotas still apply.
- One session manifest references immutable ordered batch indices. Capture IDs and permanent stage receipts prevent duplicate staging; Add retains its existing permanent ownership receipt. Capture/stage/Clear never create ownership.
- The browser journal and wheel retain at most50 active plus10 recent saved rows, and one frozen outgoing batch. No captured images are stored. Review fetches one batch at a time using Previous/Next, preserving chronological tombstones after Add/Clear. The current general collection preview/global Import list behavior is unchanged; this is not the queued app-wide SCALE/IMPORT migration.
- Storage/network backpressure pauses new admission, retains the exact operation and exposes Retry saving. Reload recovers the last accepted Oracle ID, so A,A remains one while A,B,A remains three across rollover/resume. Archived quantities are changed in Review.
- Reusable384,000-pixel analysis and24x32 signature buffers replace repeated full-resolution capture. Geometry reuses384x384; high-resolution recognition crops remain up to4MP but are copied only when needed. The120ms stability tick is retained. Geometry has350ms minimum spacing and pauses during recognition/cooldown; repeated/unclear results back off up to3sec with periodic rechecks and motion-based shortening. Stop/background dispose workers and cancel overlay work; idle overlay draws only on state change. Requested camera rate ideal15/max24fps requires actual-device verification.

## Same-clip browser-model replay

One local20.2-second previously recorded private clip, played at0.5x, with actual browser ONNX models, frozen canonical metadata and external requests blocked. CaptureStream comes from a720x1280 canvas on desktop Chromium; this is neither a current phone capture nor cloud-model verification. Images remain in ignored local files. Baseline uses the published r125 scanner. Instrumentation counts unique main-thread canvases, their initial allocated pixel capacity and cumulative getImageData pixels; these are workload proxies, not peak memory or measured CPU/GPU/heat.

| Metric                                 | r125 baseline | Updated scanner |
| -------------------------------------- | ------------: | --------------: |
| Distinct canvas surfaces               |         1,299 |              27 |
| Sum of initial canvas pixel capacities |   169,854,198 |       6,332,038 |
| Cumulative readback pixels             |    33,328,680 |      16,294,266 |
| Geometry checks                        |           160 |              76 |
| Recognition attempts completed         |            12 |              11 |
| Accepted canonical identities          |             4 |               4 |
| Overlay draw frames                    |         1,788 |             227 |

Both accepted Will of the Jeskai, Elsha Threefold Master, Aligned Heart and Frostcliff Siege in that order. Seven other readings were unresolved; this clip does not establish comprehensive recognition accuracy. An earlier700ms geometry/200ms sampling trial missed Elsha and sometimes Aligned Heart. That trial was rejected; restoring120ms cheap sampling and350ms geometry recovered all four identities in both diagnostic and final replays. The first accepted result was later in the final replay (~1.76vs1.30seconds of video time); do not claim a universal latency improvement. Cumulative canvas capacity declined96%, readback51%, geometry52.5%; timing/workload numbers are environment-specific.

Evidence is retained privately in `data/recognition-evaluation/phone-feedback/scan12-resource-before.json`, `scan12-resource-after.json` and diagnostic/initial-trial files. No private image or owner account data is committed. The helper is local `data/recognition-evaluation/scan12-resource-replay.mjs`.

## Persistence and browser acceptance

142 unit tests pass, including2,000 durable captures/40batches, concurrent conditional staging without partial writes, account separation, Add/Clear counters and permanent replay, frozen lost-response recovery, disk failure, corrupted session refusal and coalesced writes. Build passes. Two new browser cases passed61 photo captures and53 simulated-camera captures with automatic rollover, lost-response Retry, same stream continuation, bounded DOM and historical Review. Existing focused recognition/review cases passed13/14 initially; the sole failure was the legacy corruption message wording, restored afterward. The full Chromium run passed141/142 cases; the wheel scroll case exposed a redundant wheel rebuild interrupting smooth scrolling. Wheel updates now preserve unchanged DOM/scroll, and focused retesting is pending. WebKit passed9 cases with one unsupported-stream skip; the new photo rollover case exposed an upload arriving during final persistence. Upload is now disabled during backpressure and the test waits for this user-visible readiness. Historical Add/Clear navigation passed against real local application ports. Final browser results remain pending.

`tests/live/scanner-batches.spec.js` adds LIVE-21 actual cloud105-capture staging as50/50/5, one session summary, bounded acknowledgements, historical Review/reload, explicit Add50, replay, Clear5, account isolation and test cleanup. Not yet deployed/run.

## Paced soak and limitations

`node --expose-gc tests/performance/scan-session-soak.mjs <ignored-directory> 7200 2000` is running against an isolated durable SQLite database and the browser journal engine in Node. It paces simulated accepted rows, reloads the journal every50, checks ordered batch counters and ownership exclusion, and samples post-GC heap. It does not execute browser rendering, models, camera, phone thermal or battery behavior. Final elapsed time,2,000-capture counts, storage bounds and memory trend must be added after completion. The run began with the implemented protocol before later input-validation checks; successful replay of its final journal through the final module is required to verify compatibility.

Physical acceptance remains: scan for an extended session on the owner's phone, check stationary/consecutive suppression, alternating cards, glare/overlap, saved-batch Review, recovery, background/Back shutdown, heat and battery. Local/cloud tests cannot establish acceptable physical temperature or camera/audio behavior.

Source packaging: the initial refreshed local archive exceeded the existing4,000,000-byte bound. The source builder now lists upstream documentation-only pictures in a pinned URL/SHA-256 manifest while retaining all upstream code/notices/examples/tests and every existing application/build source check. The complete pinned upstream checkout is still retrieved by the included installer. The size bound and source verification guards are unchanged.

Final local checks:142 unit tests, build, all11 focused scanner cases after the wheel/upload fixes,10 focused WebKit cases plus one unsupported-stream skip, and56 visual/layout cases passed. The final historical mobile Review screenshots were inspected for navigation and fit. Actual cloud/source-image verification and the paced2h persistence soak remain pending.
