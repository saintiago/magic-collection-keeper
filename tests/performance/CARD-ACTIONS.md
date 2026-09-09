# Catalogue interaction observations

September 9, 2026. `tests/ui/card-actions.spec.js` renders 1,000 controlled catalogue cards with local SVG artwork. Desktop-host observations were 84 ms in Chromium and 199 ms in WebKit from search submission to the expected DOM count; these are individual fixture samples, not percentile estimates or provider/image-download timings. Subsequent regression samples vary.

The test counts requestAnimationFrame callbacks during idle windows and after hover departure: no continuing callbacks. Computed styles confirm no per-card `will-change`. Hover and active drag use a single preview/ghost; the artwork viewer promotes only its active image. The grid itself still renders all returned cards and is not virtualized.

Phone-sized Chromium/WebKit tests inspect the bounded wheel and native tap, plus controlled pointer-event pinch, scroll cancellation and long press. Screenshots are attached to test output. This does not verify physical iPhone gestures, frame rate, memory pressure or GPU behavior. Deployed LIVE-17/18 separately verify genuine JWT/Dynamo transactions and review persistence, with a controlled lost-response delivery check.
