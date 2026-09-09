# Scanner comparison and selected hybrid — September 9, 2026

The final scanner prepares browser CollectorVision ONNX models when Scan opens.
If they are still loading after 750 ms, it prepares the Lambda once with a blank
synthetic image. Ready local models handle subsequent cards; Lambda handles
cards while the initial download continues or after a local execution failure.
There is no periodic warm call or provisioned compute. Browser Tesseract and the
SageMaker runtime/route were removed. Every candidate requires explicit printing
choice and final ownership confirmation.

## Actual comparative evidence

The actual Scan photo-upload UI used three frozen public card images listed in
`sources.json`: Adaptive Training Post, Lightning Bolt, and Sol Ring. Each has
clean, blur, reduced resolution, JPEG, perspective, glare and hidden-footer
variants. Blank, noise and a two-card scene complete 24 frames. Two rounds mean
48 readings, 42 identity trials, 36 ordinary positive printing trials and four
negative trials. Repeated images are not independent accuracy samples. These
are desktop browsers and emulated mobile viewports, not physical camera tests.

| Actual path | Top identity found | Correct-candidate p50 / p95 | First UI reading | Report suffix |
| --- | --- | --- | --- | --- |
| Browser OCR baseline | 14/42 | 0.798 / 3.453 s (all attempts) | See retained report | 1788908724987 |
| Browser ONNX, corrected | 40/42 | 0.282 / 1.082 s | 1.338 s | 1788910291205 |
| Lambda, corrected | 40/42 | 0.844 / 1.681 s | 12.154 s, fresh process | 1788910982629 |
| SageMaker, corrected | 40/42 | 1.200 / 2.082 s | 2.771 s after deployment health | 1788911563883 |
| Final hybrid, Chromium | 40/42 | 0.297 / 1.048 s | 1.306 s | 1788913139784 |
| Final hybrid, WebKit mobile viewport | 40/42 | 0.415 / 1.231 s | 1.566 s | 1788913251769 |
| Final hybrid, throttled assets, three rounds | 60/63 | 0.844 / 1.211 s | 8.890 s including preparation | 1788913173034 |

The corrected visual paths supplied the expected printing among candidates for
all 36 ordinary positive trials and rejected all four blank/noise trials.
Hidden-footer Lightning Bolt remained unknown twice; other hidden-footer
results remain printing-ambiguous. The two-card scene can produce a candidate,
which is another reason automatic confirmation stays disabled. All final runs
had zero recognition errors, zero automatic selections and unchanged inventory.
The throttled run used Lambda for 55 readings, then browser ONNX for 17; it
rejected all six negatives and found 54/54 ordinary positive printing IDs.

The first prototype scored only 16/42 because upside-down detector output and a
truncated competing-identity margin were wrong. The retained baseline records
that failure. Both Python and browser preprocessing now conditionally test the
180-degree orientation and compare against the complete reference index.
Cosine scores are not probabilities and thresholds remain research filters.

## Cold starts, memory and transfer

SageMaker's first corrected deployment health preparation took 9.947 seconds;
its first benchmark call followed that health check and is not a cold invocation.
A separate concurrent real API run caused a fresh SageMaker process and took
14.661 seconds, versus 1.843 seconds in the warm process. Subsequent calls were
1.489, 0.925 and 0.843 seconds. The same experiment produced fresh Lambda
processes taking 6.693 and 6.800 seconds; subsequent calls took 0.872, 0.860 and
1.021 seconds. Exported process IDs and startup records establish these labels.
Lambda's first alias-6 UI request had 5.001 seconds AWS INIT plus 5.807 seconds
invocation, 10.809 seconds billed, and 774 MiB maximum RSS; later RSS reached
912 MiB. Earlier alias-4 cold failure took 29.414 seconds (INIT/invocation
timeouts), followed by recovery. Passing warm trials do not erase it.

The browser's initial recognition payload is **56,756,783 bytes (56.76 MB,
54.13 MiB)** plus 76,014 bytes of runtime JavaScript/manifests and normal app,
name-search and card-art requests. It is not a 600 MB browser download:

| Recognition asset | Bytes |
| --- | ---: |
| Card detector ONNX | 4,407,545 |
| Artwork embedding ONNX | 5,191,100 |
| Compressed full 112,049-row reference vectors | 26,217,995 |
| Compressed printing metadata | 6,978,298 |
| CPU WASM runtime | 13,961,845 |
| Runtime JavaScript (two files) | 74,344 |
| Visual and runtime manifests | 1,670 |

The packed reference vectors occupy 28,684,544 bytes after decompression;
metadata, tensors, models, browser workers and other allocations add memory.
Main-page heap readings exclude worker/WASM memory and are not total process
RSS. No browser-wide memory claim is made. The Lambda image includes additional
Python/native/OCR runtime and is a server artifact, not a browser download.

A real byte-stream cap of 1,250,000 bytes/second (10 Mbps ceiling, Windows timer
overhead) yielded 54.988 seconds fresh browser preparation. A new Chromium
worker with retained verified cache prepared in 0.512 seconds with zero model
or WASM download. Final throttled-run reopening took 0.531 seconds preparation,
also zero download. SHA-256 is checked on both downloads and cache reads;
content keys survive release path changes. In this Windows WebKit build,
CacheStorage did not persist between workers: reopening downloaded the assets
again. Session reuse still worked. Real Safari/iPhone cache behavior is unverified.
WebGPU was advertised but requestAdapter returned no adapter; the final runtime
is CPU WASM and makes no GPU-acceleration claim.

## Reproduction and limits

`fixtures.py`, `preview.mjs`, `compare.mjs` and `startup.mjs` retain the
public fixture and actual UI measurement workflow. The preview binds loopback,
allows authenticated inference/catalog reads and rejects inventory writes.
Set PERF_FIXTURES to the generated fixture directory, PERF_CREDENTIALS to the
reserved keeper-e2e credentials file and PERF_URL to the preview. PERF_BROWSER,
PERF_MOBILE and PERF_ROUNDS select bounded browser trials. The preview accepts
PERF_ASSET_BYTES_PER_SECOND for actual streamed transfer limits. Credentials and
downloaded photos stay outside version control. Historical four-mode UI and
SageMaker deployment code are preserved at commit 0d5df87; reproducing its cloud
comparison requires recreating the specifically isolated resources.

`evidence/` retains actual reports and safe numeric cloud logs. UI fixtures for
provider failure, stalled loading, cancellation, unknown results and late
recovery are controlled tests, not accuracy evidence. Chromium synthetic camera
tests separately cover guide cropping and departure/stability. Physical phone
lighting, sleeves, foils, consecutive identical physical cards, audio audibility
and total mobile memory still need real-device acceptance.
