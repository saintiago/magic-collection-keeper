# SCAN-10 consecutive recognition repair

Status: locally verified; deployment and owner physical acceptance pending. The owner explicitly rejected r123-a2 as fixing their physical workflow, then chose consecutive same-card suppression instead of distinguishing identical physical copies. This supersedes the strict visual departure/artwork requirement.

## Causal diagnosis

Eleven distinct real-card frames from the owner's earlier green-tray recording were replayed locally with actual Cornelius geometry. All eleven were single-card frames. Holding each stationary for 4.8 seconds still produced only four captures under r123 admission. Adaptive Training Post to Will of the Jeskai was blocked because the broad low-resolution patch correlations were 0.57, 0.43, 0.54 and 0.32; the old rule required three below 0.4. Thus this failure was reproduced independently of motion, worker delays or OCR. A detail-comparison candidate was investigated but never deployed; the owner's subsequent simplification explicitly superseded that research.

## Requested behavior

The gate now verifies only a usable stable single-card frame, with stale-result and sampling-gap rejection. It does not compare artwork or require empty-tray departure. Ordered initial recognition results use canonical Scryfall Oracle ID: A,A adds once; A,B adds both; A,B,A adds all three. Suggested printing, language and finish changes do not make another copy. Consecutive identical copies use manual quantity.

Unknown or missing-identity results do not advance the accepted sequence. Duplicate and unresolved results never play success; duplicates do not trigger a draft write. Late provider alternatives stay on their original row and cannot change its accepted identity, append a copy or reorder the sequence; manual review remains authoritative. Camera reads are serialized with one second after completion before another read, a 150-attempt cap and the existing 50-row limit. The independent provider keeps its 50-call limit. Background pause preserves consecutive identity; opening a new scanner resets it.

## Verification and limits

- 135 unit tests pass, including fresh single-card admission, stale/gap/multiple rejection and consecutive Oracle-ID sequences.
- Focused browser checks pass for A,A/B/A with unchanged image pixels, printing jitter, unknown results, success-cue count, late provider identity changes, one read in flight and stopped-camera cancellation.
- Actual geometry cases pass for overlap, empty frames, A after empty still suppressed, B accepted and A accepted again; real browser model, photo fallback, review/persistence staging, background/resume, automatic error recovery and audio cases pass.
- Desktop LIVE-04 and mobile LIVE-13 are updated to verify consecutive duplicate suppression and alternating real recognized public cards, preserving manual quantity and explicit ownership review. Their deployment results are pending.
- The earlier private recording is replayed locally at half speed with real browser geometry/recognition and separately with the actual local primary visual/OCR service, hydrated from the frozen canonical catalog. Later distinct cards are read and accepted, so the first-card latch is no longer present. Not every recorded card resolves; fallible recognition and brief/ambiguous geometry remain distinct limits. No private image leaves the computer, and recorded playback is not physical-device verification.

No backend/model, infrastructure, provider guidance, source guard or unrelated feature changes are included. The main workflow must pass before delivery is recorded.
