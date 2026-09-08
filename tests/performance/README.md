# Recognition comparison

Temporary four-mode controls live inside the real scanner when the local comparison
configuration is enabled. `preview.mjs` serves this checkout on loopback and forwards
real authenticated reads/inference to the deployed AWS API. It rejects ownership
writes. This is a local browser UI with real cloud calls, not a deployed-frontend
measurement or mocked inference. Normal production configuration is unchanged.

Public image IDs, source URLs and hashes are fixed in `sources.json`. Put those
verified downloads and a copy of sources.json in an ignored output directory, then
run `python tests/performance/fixtures.py <directory>` to generate 24 deterministic
frames: three identities with clean/blur/downscale/JPEG/perspective/glare variants,
footer-hidden printing ambiguity, blank/noise negatives and a two-card scene.
These transformations are synthetic and never establish physical-camera accuracy.

Build normal assets with `npm run build` and export the complete frozen visual
models/reference index with `python recognition/scripts/browser_assets.py` after
the public recognition artifacts are prepared. The export contains all 112,049
rows and preserves model/index hashes and row order; no owner inventory is used.
Its models plus compressed reference files total 42,794,938 bytes, excluding ORT
and OCR runtime assets. Browser weights/index stay on this device and are verified
before use or caching. WebAssembly runs in one worker/thread; WebGPU is experimental
and must be measured separately. No mobile hardware result is implied.

Start `node tests/performance/preview.mjs`. Run `compare.mjs` with PERF_FIXTURES set
to the ignored fixture directory and PERF_CREDENTIALS to the ignored reserved
keeper-e2e credentials file. Other usernames and nonempty inventories are rejected.
PERF_MODES selects comma-separated ocr,lambda,sagemaker,browser-onnx;
PERF_ROUNDS is bounded 1–4 (default 2), PERF_BROWSER chromium/webkit and
PERF_MOBILE=true emulate an iPhone-sized viewport. The test signs in through the
app, opens Scan, selects each mode and uploads the same frames through its control.
It inspects real candidate outcomes, rejects unsafe unresolved selections and
verifies the empty test inventory remains unchanged. No data is automatically
cleaned or seeded by this benchmark.

Reports retain every attempt, timeout/error, top-1 Oracle correctness, candidate
printing presence where the fixture is unambiguous, negative rejection and safe
unresolved status. Repeats measure latency variability, not independent accuracy
samples. Percentiles use nearest rank and include failures in all-attempt latency;
unknown results must not be described as fast successful recognition. Browser
preparation/download/cache/session timings and provider inference/canonical lookup
times are separate. Playwright reports encoded request/response body+header bytes,
excluding TLS; main JS heap measurements exclude worker/WASM/GPU memory. Cloud
cold/recovery/warm labels require matching deployment and structured process logs.

Initial targets, set before trials: cached readiness ≤3 s, median candidate display
≤1.5 s, p95 ≤3 s. Cold downloads/preparation are reported separately. No automatic
ML printing confirmation is enabled. Preserve baseline evidence before optimizing
or removing comparison controls and unused runtime paths after final selection.
