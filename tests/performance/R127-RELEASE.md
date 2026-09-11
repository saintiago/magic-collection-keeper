# r127 continuous scanner verification

SCAN-12/13 batch persistence and the SCAN-11 resource changes are published and verified within automated browser/cloud coverage in **r127-a1 / 0.1.0+deploy.127.1**, commit `5afdb17994d91d475cebe4f84972cb6a3827844b`, on September 11, 2026. The owner had physically accepted the r125 consecutive-card policy. Phone heat/battery behavior after this release remains unverified.

## Delivered behavior

The camera continues after each 50-capture batch is saved. No accepted-card or attempt session cutoff remains. The account-isolated journal retains at most 50 current captures, ten recent saved captures and one frozen outgoing batch. Unknown save responses retain the same operation identity; Retry resumes safely. Earlier batches load through Previous/Next in Review. Capture, staging and Clear do not create ownership; Add explicitly confirms it. Permanent capture and ownership receipts prevent repeat contributions. The last accepted Oracle ID survives rollover and reload: A,A counts once, A,B,A three times; consecutive identical physical copies use quantity.

Analysis canvases are reused, full-resolution crops are copied only when needed, geometry work pauses during recognition/cooldown, and overlays stop when idle or closed. The same local recorded clip retained its four accepted identities while canvas allocations fell from 1,299 to 27 and geometry checks from 160 to 76. These are desktop workload measurements, not physical-phone temperature, peak memory or recognition-accuracy guarantees. [Implementation, rejected slower-cadence trial and measurement scope](SCAN12-CONTINUOUS.md).

## Release checks

[PR #27](https://github.com/saintiago/magic-collection-keeper/pull/27) shipped through the existing [main workflow 34632270262](https://github.com/saintiago/magic-collection-keeper/actions/runs/34632270262), which succeeded on its first deployment attempt.

| Check                                                 | Result                                     |
| ----------------------------------------------------- | ------------------------------------------ |
| Unit                                                  | 142 passed                                 |
| Chromium application                                  | 143 passed                                 |
| Required WebKit application                           | 105 passed; three unsupported-stream skips |
| Visual prototypes in both engines                     | 56 passed                                  |
| Actual desktop live                                   | 13 passed                                  |
| Actual mobile live                                    | 8 passed                                   |
| Independent served/API/source/config/vendor identity  | Passed                                     |
| Reserved temporary inventory and drafts after cleanup | Empty                                      |

LIVE-21 passed in 11.2 seconds using the reserved profiles: 105 rows staged as 50/50/5, one session descriptor, bounded acknowledgements, ordered historical Review and reload, explicit Add of 50, permanent replay, Clear of five, account isolation and cleanup. Other live cases retain actual model recognition, consecutive suppression, quantity review and persistence checks. Camera/photo inputs are synthetic public fixtures, not physical-device verification. Local browser cases additionally passed 61 photo and 53 simulated-camera captures through rollover/lost-response recovery. A wheel-scroll interruption and an upload-during-save race found locally were fixed before the successful full CI run. Phone-sized recovery and Review screenshots were inspected.

An additional local SCAN-10 regression passed after deployment against the unchanged runtime: resuming at attempt 99,998 continued beyond the former session cutoff, request attempts wrapped from 99,999 to 1, and capture IDs continued past 100,000 while preserving A,A suppression and A,B,A acceptance. These extra assertions were not part of the earlier main run.

The separate paced journal and SQLite soak passed **2,000 simulated captures in 7,200.027 seconds**, from 17:32:49 to 19:32:50 UTC. All 40 batches restored correctly; the final journal also passed the deployed module's validation. It retained ten recent rows, peaked at 32,135 serialized bytes and ended at 4,304 bytes, with zero ownership writes. Post-GC heap from capture 650 onward stayed between 10,156,080 and 10,172,792 bytes; the final sample was 10,172,112 bytes. Maximum local stage time was 25.22 ms. [Full synthetic metrics](SCAN12-SOAK.json) and [scope](SCAN12-CONTINUOUS.md#paced-soak-and-limitations). This executes the browser journal engine in Node and real local SQLite storage; it does not exercise browser rendering, recognition models or physical camera hardware.

## Source and deployment identity

The [isolated source/image verification 34630924663](https://github.com/saintiago/magic-collection-keeper/actions/runs/34630924663) and [publisher 34631608031](https://github.com/saintiago/magic-collection-keeper/actions/runs/34631608031) succeeded. The source archive matches 399 tracked files at build commit `4199247ca0bdef6d9ed7339c28702c0db8afee6c`; the unchanged guard verifies all 127 private runtime/build files against the published application. Frontend source is packaged separately.

- Recognition version: **19**, 3,008 MB, 20-second timeout, JWT routes, no provisioned/reserved compute or image/text invocation logging.
- Backend source: **3,202,043 bytes**, SHA-256 `afc2f8fddd1de93e9d72af6efb6a729266bc8c2fc56bb7605e4a3d5384697491`.
- Image ID: `sha256:8cdd068005aebdde5000571a1422c43958bf771eaf6dda0b355930575f36001d`.
- ECR digest: `sha256:3d2a019df1d4e5d835ad181cd910ec6605770bee5a0f077d258b0ce1805e7050`.
- API code SHA-256: `rzB9hBeqScTJjDkT6bx9YLBH3DYsKiqlIOmNUSHFIh8=`.
- Frontend source overlay: **340,523 bytes**, SHA-256 `765b85eaad476440ee7aefe56709e755fe2f1c44550fa490e73a310a7462e7af`.

The existing 4,000,000-byte source limit remains unchanged. Seven upstream documentation pictures are represented by pinned public URLs and SHA-256 in `CollectorVision/DOCUMENTATION_MEDIA.json`; all remaining upstream files, including code/notices/tests/examples, match the prior published archive byte for byte. The complete pinned checkout remains reproducible through the included installer. No source-code verification guard was relaxed.

The scoped CloudFormation update changed only the recognition Function/Version/Alias. Actual authenticated public-fixture recognition, rejected unauthorized/invalid/bounded inputs, multiple/overlap rejection and source download checks passed before the app release. Independent read-only verification at **18:41:20 UTC** confirmed the exact published app/API identities, source/config/vendor hashes and empty reserved profile. Config and public vendor hashes remain unchanged from r125. Logs and audited source/image backups remain in ignored `data/recognition-evaluation` directories; no owner account was used for tests.

## Retention and remaining scope

[Automatic cleanup 34634495784](https://github.com/saintiago/magic-collection-keeper/actions/runs/34634495784) succeeded after the verified main run. It deleted only that run's `keeper-build` artifact 10277367199 and `keeper-release-plan` artifact 10276369458; a subsequent API check returned zero artifacts for the originating run. Recognition/source handoffs retain their existing seven-day retention.

Physical-phone heat, battery, camera settings and sustained hardware behavior require a device check. General collection pagination, Import/Add optimization and catalogue enrichment remain queued under IMPORT/SCALE/DATA; this release does not claim those application-wide improvements.
