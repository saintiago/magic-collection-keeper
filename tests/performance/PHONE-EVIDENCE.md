# Phone scanner evidence — September 9, 2026

Private photographs, video, crops and credentials remain outside git, build assets and the corresponding-source ZIP. These changes have local verification; final image and main-workflow deployment checks remain required.

The latest exactly-one-card gate, truthful live overlay and independent Nova Pro route are measured in [SCANNER-GUARDS.md](SCANNER-GUARDS.md). Earlier raw two-card false acceptance and pre-gate video measurements below remain historical comparison evidence. Final guarded app-size photos are primary 24/24 and independent 21/24 correct, with no wrong accepted identity; five non-card/multiple/partial inputs are rejected by geometry and noisy input by transport size.

## Photo diagnosis and independent local browser comparison

Twenty-four original 2880×3840 photographs represent 23 identities. The first ten were diagnostic and the later fourteen were initially frozen validation. Three identities overlap prior synthetic checks. Subsequent experiments are not fresh held-out evidence.

Baseline main 0680a01 full local service admitted 6/24 raw originals and 7/24 app-like 1500×2000 JPEG86 inputs. Top visual identities were all correct: this sample primarily exposed conservative admission and title-reading gaps, rather than missing catalog coverage. Updated visual/lighting/Paddle admitted 22/24 correctly in both input paths, with different misses. Final app-like replay with actual regional Amazon Nova Lite fallback admitted 24/24 correct; only Rammas Echor and Tempest Technique required model reads. This small recorded sample does not establish general or phone accuracy. Full competing-identity guards remain; no card-specific exception was added.

Nova Lite read all six comparison titles; Nova 2 Lite read five exactly and misspelled Rammas Echor, rejected by exact-title validation. Selected regional amazon.nova-lite-v1:0 reads one bounded perspective card crop only for an unresolved plausible visual identity. It receives no proposed identity, printing IDs, finish or owner information. Strict single-card/uncertain/title fields and exact whole English/translated catalog agreement gate support. Model self-confidence is not compared with visual similarity. Direct model tests returned uncertainty for blank, noise and two-card crops; the full visual pipeline still accepts one card from the two-card negative before model fallback. These are different tests.

The independent actual-browser local-only comparison, including OCR without artwork models, is in [LOCAL-RECOGNITION.md](LOCAL-RECOGNITION.md) and its aggregate JSON. Both desktop engines admit 7/24 visual-only at app size, 7/24 with lighting, 22/24 with local OCR, and 22/24 with footer OCR. OCR-only admits 4/24 and geometry-only plus OCR 17/24. Experimental browser OCR modules are not wired into production. Short-title, ambiguous-alias, card-presence and negative false-accept limitations are recorded explicitly.

## Provider latency, cost and concurrent recognition

Eighteen measured Nova Lite calls cover six crops across three fresh SDK clients. Warm-client samples (15) have median 909.26 ms and p95 1000.94 ms; the three first-client calls have median 1490.19 ms and p95 1713.66 ms. Fresh SDK/TLS clients do not prove cold Lambda or model latency. Provider-reported median is 803 ms. The two final full-service model fallbacks took 1308.34 and 819.18 ms.

The regional AWS price list checked September 9 charges $0.06 per million input tokens and $0.24 per million output tokens. The eighteen recorded calls total $0.00227916; a typical tested crop is about $0.000127, or $0.13 per thousand similar fallback reads. This excludes other experiments, Lambda and API charges and is not account-wide spending. One earlier setup failure occurred after a paid request. One call has a bounded crop and at most 160 output tokens. [AWS Bedrock pricing](https://aws.amazon.com/bedrock/pricing/).

The same six photos were tested with actual Chromium visual inference and a loopback backend using actual regional Bedrock. Sequential first-result times: 1320/1265/1182/294/1238/3293 ms. Immediate concurrent: 414/452/430/314/433/1503 ms. A 350 ms hedge: 739/773/760/292/794/1754 ms. All six identities were correct in each mode. Backend calls were 5/6/5, with one model call per mode. Immediate concurrency is selected, bounded to one backend verification in flight. These timings exclude deployed Lambda/API and cannot predict iPhone latency. Later canonical alternatives update the same capture, preserve user edits and add no copy or cue.

## Public regression and camera controls

Twelve frozen public Scryfall printings cover representative regular, borderless, translated and alternate-frame examples. replay_public.py generates six degradations per source plus blank/noise. Before optional model addition, the full service admitted 71/72 correctly versus 63/72 visual-only and rejected both negatives; a dark frame remained unknown. Degradations are not independent identities. The final image requires a real offline container rerun.

Unit tests cover optional capability rejection, safe diagnostics, canceled late permission, native guide mapping, the four-megapixel bound and best-frame selection excluding departure/stale frames. Browser tests preserve stationary suppression, visible departure for identical copies, audio interruption, cancellation/background behavior and bounded backlog. WebKit now exercises actual large model loading after the Response-stream decompression fix. Windows WebKit, synthetic streams and recorded frames do not establish iPhone focus/exposure/lens choice, sound audibility, thermal behavior or physical duplicate swaps.

## Recorded video

The original clip is 20.2 seconds, 606 frames at 30 fps and 720×1280 after rotation. It contains twelve distinct cards with partial cards at the beginning/end. Earlier native-speed Chromium replay used the actual crop/gate and a local real-model backend, yielding eight queued entries at each tested stream resolution. That older configuration is not the final concurrency path, and a queue count alone is not accuracy. An early replay incorrectly held the final frame after ending; those results are excluded. Instrumented replay paints a blank ending.

The final deterministic local-only comparison uses a 120 ms sampled timeline and the actual independent gate, yielding eight captures. Full visual plus local OCR recognizes 8/8 Chromium and 7/8 WebKit; OCR-only 0/8; geometry plus OCR 5/8 and 4/8. Four of twelve cards do not reach inference. Inference pauses the sampled timeline, so this measures recognition/gating rather than real-time throughput. Details and limitations are in LOCAL-RECOGNITION.md. No whole video was uploaded to a provider.

## Shared Import and release verification

Scan/text batches stage separate account-backed drafts in the same Import page as Moxfield. Local tests exercise fifty duplicates, permanent stage/Add retry after lost responses, no-op timestamps, editable overflow, canonical alternatives, condition editing, same-day separate drafts, Back/reload, one collection refresh and preserved source-removal receipts. Browser tests cover frozen text intent after ambiguous stage, corrupt local capture storage without losing account drafts, double taps and late recognition preserving edited quantity/printing. Add is one atomic source transaction for up to fifty capture lines. The legacy 25-line chunk route exists only to reconcile old submitted local journals.

LIVE-15 targets authenticated DynamoDB stage/Add/idempotency/isolation/timestamps using reserved test profiles. Record actual deployed checks, source hash, owner read-only preservation and immutable image identity after deployment. Local mocks are not cloud evidence. Never test writes on the owner or restore an old baseline over newer additions.
