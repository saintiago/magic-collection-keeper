# Local recognition comparison — September 9, 2026

These are measured experiments, not a shipped browser OCR feature or a live iPhone result. Twenty-four original 2880×3840 photographs cover 23 identities, including English and Spanish titles. The first ten were used for diagnosis, the later fourteen were previously frozen validation; further experiments are not fresh held-out evidence. Both actual Windows desktop browser engines ran the frozen models in single-thread WASM. API, backend and Bedrock requests and all external traffic were blocked; verified static assets and private inputs were served only on loopback. Recognition never consulted owner inventory.

## Still photographs

App input is 1500×2000 canvas pixels. Raw input retains 2880×3840. Every positive result below has the correct identity; all other positive photos remain unknown. Similarity is not a probability. Full visual top-ranked identity was correct on all 24 photos even when conservative admission rejected it.

| Engine   | Method       | Correct /24 at app size | Median / p95 ms | Correct /24 raw | Median / p95 ms |
| -------- | ------------ | ----------------------: | --------------: | --------------: | --------------: |
| chromium | original     |                       7 |       425 / 436 |               4 |       427 / 430 |
| chromium | lighting     |                       7 |      765 / 1095 |               6 |      762 / 1089 |
| chromium | ocr          |                      22 |      899 / 1265 |              20 |     1035 / 1238 |
| chromium | footer       |                      22 |     1014 / 1407 |              20 |     1186 / 1457 |
| chromium | ocr-only     |                       4 |       675 / 721 |               7 |       650 / 708 |
| chromium | geometry-ocr |                      17 |       248 / 527 |              16 |       236 / 426 |
| webkit   | original     |                       7 |       615 / 639 |               4 |       632 / 639 |
| webkit   | lighting     |                       7 |     1165 / 1706 |               6 |     1183 / 1704 |
| webkit   | ocr          |                      22 |     1299 / 1899 |              20 |     1560 / 1907 |
| webkit   | footer       |                      22 |     1525 / 2135 |              20 |     1778 / 2220 |
| webkit   | ocr-only     |                       4 |       862 / 957 |               7 |       822 / 916 |
| webkit   | geometry-ocr |                      17 |       324 / 398 |              16 |       299 / 559 |

Methods: **original** is full artwork matching on original pixels; **lighting** adds bounded same-identity lighting corrections; **ocr** adds actual local title OCR and whole-title corroboration of that visual identity; **footer** also reads the footer. **ocr-only** uses text detection/recognition and global exact catalog names, with no card detector, artwork model or reference index. **geometry-ocr** adds only the card-boundary detector before global exact-title matching, without artwork embeddings/index. OCR-only still uses ONNX Runtime for its OCR models; it is not an experiment banning every ONNX model.

The experimental OCR implementation uses the same frozen Paddle PP-OCRv5 weights and Latin dictionary, but axis-aligned connected-component postprocessing differs from RapidOCR's rotated polygon processing. It is not claimed to be a complete or parity-certified OCR port. OCR-only title-region discovery is especially weak in these photographs. Both global-title variants conservatively exclude English identity names shorter than eight normalized characters, so short names and basic lands are not covered. Exact aliases can also represent different Oracle identities, including art-card names; ambiguous joins remain unknown. These limitations mean the result evaluates this implementation, not the theoretical ceiling of OCR-only recognition.

All methods reject blank and seeded-noise negatives. Artwork and geometry methods reject a plain paper card title, but incorrectly accept one card from a two-card frame. OCR-only rejects the two-card sample but incorrectly accepts the plain title. The plain-title negative was added after the first four visual modes and run separately in both engines/sizes. Therefore zero wrong identities on positive photos must not be described as zero false accepts overall.

## Payload, preparation and memory

| Pipeline                                             | Verified compressed asset bytes |
| ---------------------------------------------------- | ------------------------------: |
| Visual models/reference + shared WASM                |                      56,756,783 |
| OCR-only + shared WASM + whole-name catalog          |                      32,418,276 |
| Geometry + OCR + shared WASM + whole-name catalog    |                      36,825,821 |
| Full visual + OCR + shared WASM + whole-name catalog |                      75,213,214 |

The OCR weights/dictionary add 12,880,827 bytes; the full-name catalog adds 5,575,604 bytes. Geometry alone adds 4,407,545 bytes. Counts exclude small JavaScript/manifest overhead. Each method initialized before frame timing; the JSON records preparation, runtime and cache/download counters separately. Initial localhost loading is not a real network download test and cannot predict a phone's cold start. Subsequent methods reuse caches where recorded. Frame measurements include worker round-trip and recognition, not model download. Quantiles use linear interpolation across 24 frames, without extra timing repeats. Main-page JS heap excludes worker/WASM/native memory and is unavailable in WebKit; no whole-pipeline RAM or phone thermal estimate is claimed. See [ONNX Runtime performance guidance](https://onnxruntime.ai/docs/tutorials/web/performance-diagnosis.html).

Actual WebKit initialization originally failed while expanding the 26,217,995-byte embedding gzip through Blob.stream with NotReadableError. Using a Response body stream fixed loading in this Windows WebKit test and allowed the full real-model comparison to complete. CI now includes the actual scanner-model test in WebKit. This is not physical Safari/iPhone verification.

## Recorded video

The private 20.2-second clip contains 606 frames at 30 fps and 12 distinct cards, including partial cards at both ends. A deterministic 120 ms sampled timeline uses the actual app guide crop (561×782 from 720×1280), 720 ms stability/200 ms departure gate and three-frame quality selection. The same eight captures are evaluated per mode; inference pauses the sampled timeline to isolate recognition. This measures recognition and gate behavior, not real-time queue throughput. Frames are decoded locally and never sent to a backend.

| Engine   | Method       | Correct /8 gated captures | Median / p95 ms |
| -------- | ------------ | ------------------------: | --------------: |
| chromium | original     |                         2 |       430 / 467 |
| chromium | lighting     |                         2 |      789 / 1103 |
| chromium | ocr          |                         8 |      882 / 1191 |
| chromium | footer       |                         8 |     1109 / 1463 |
| chromium | ocr-only     |                         0 |       254 / 287 |
| chromium | geometry-ocr |                         5 |       191 / 365 |
| webkit   | original     |                         2 |       593 / 638 |
| webkit   | lighting     |                         2 |     1152 / 1700 |
| webkit   | ocr          |                         7 |     1265 / 2053 |
| webkit   | footer       |                         7 |     1588 / 2478 |
| webkit   | ocr-only     |                         0 |       332 / 392 |
| webkit   | geometry-ocr |                         4 |       261 / 650 |

No wrong identity was admitted in these eight captures. The four ungated cards are the initial partial card, Alania, Elsha and the final partial card. Their absence is a temporal-gating miss, not an inference unknown, and eight captures must not be reported as complete recognition of the twelve-card video. Chromium and WebKit agree on capture times; WebKit OCR differs on one small Mizzix title. Sampling phase and native scheduling can change which short stable intervals reach the gate. Earlier native-speed Chromium replay produced eight queued entries, but is a separate run with different timing and backend configuration, not a controlled local-only comparison. The clip contains no verified consecutive identical physical-copy swaps.

## Decision

Retain artwork recognition and the bounded backend fallback for the current release. The frozen OCR-only experiment loses substantial coverage and lacks sufficient card-presence evidence. Geometry plus OCR is substantially smaller and faster and merits further generic OCR-region/alias work, short-title tests and fresh device validation, but currently misses seven of these photographs at app size. Full local OCR improves admission markedly but increases the payload to 75.2 MB and still misses two photographs; its footer stage adds latency without another identity in this sample. Experimental modules under recognition/browser-evaluation are not bundled into the app or published as runtime OCR assets.
