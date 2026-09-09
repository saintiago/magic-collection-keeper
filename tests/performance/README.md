# Actual scanner measurement

See [measured comparison and limits](EVIDENCE.md). The final UI has no mode selector; historical four-mode code is preserved at commit 0d5df87.

1. Prepare the pinned visual assets and app as in the root README.
2. Run `python tests/performance/fixtures.py --help` for the public fixture recipe. Sources and SHA-256 are in sources.json. Keep generated photos/reports in an ignored evaluation folder.
3. Run `node tests/performance/preview.mjs` with PORT (default 3200). It binds loopback, bridges real authenticated API inference/catalog reads and rejects inventory writes. Optional PERF_ASSET_BYTES_PER_SECOND caps actual streamed asset delivery.
4. Run `node tests/performance/compare.mjs` with PERF_FIXTURES, PERF_CREDENTIALS (keeper-e2e only), PERF_URL, optional PERF_BROWSER=webkit, PERF_MOBILE=true and PERF_ROUNDS=1..4. It uses the actual Scan upload UI, real models and canonical reads, rejects a mode selector, records cache/network/outcome timing and checks inventory unchanged.
5. `startup.mjs` measures real worker preparation and cache reuse separately, without images or cloud requests. It uses PERF_URL and writes its report to PERF_OUTPUT.

Do not call these three-card synthetic trials general accuracy or physical-device verification. Controlled browser tests in tests/ui cover failure/cancellation behavior separately. Use the existing main workflow for application releases and reserved profiles for deployed persistence checks.
