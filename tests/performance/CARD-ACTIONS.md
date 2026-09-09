# Catalogue interaction observations

September 9, 2026. `tests/ui/card-actions.spec.js` renders 1,000 controlled catalogue cards with local SVG artwork. Desktop-host observations were 84 ms in Chromium and 199 ms in WebKit from search submission to the expected DOM count; these are individual fixture samples, not percentile estimates or provider/image-download timings. Subsequent regression samples vary.

The test counts requestAnimationFrame callbacks during idle windows and after hover departure: no continuing callbacks. Computed styles confirm no per-card `will-change`. Hover and active drag use a single preview/ghost; the artwork viewer promotes only its active image. The grid itself still renders all returned cards and is not virtualized.

Phone-sized Chromium/WebKit tests inspect the bounded wheel and native tap, plus controlled pointer-event pinch, scroll cancellation and long press. Screenshots are attached to test output. This does not verify physical iPhone gestures, frame rate, memory pressure or GPU behavior. Deployed LIVE-17/18 separately verify genuine JWT/Dynamo transactions and review persistence, with a controlled lost-response delivery check.


## Shared tile correction and bounded renderer comparison

The corrected shared tile is image-only in owned/deck/tag/catalogue/Home views. Native Chromium/WebKit clicks and phone-sized taps open the same-route 300% inspector. The 200% hover's visible inner artwork has distinct corner/center transform matrices while its outer hit rectangle stays unchanged; 200ms dwell resets on early leave. Both zoom reveals use a finite damped spring with overshoot/settle and no reduced-motion animation. Full-size translucent direct pickup is tested at all four edges of 1280×720, 390×844, 320×568 and 844×390 viewports. Labels are measured, wrapped and fitted once; screenshots verify readable targets. The inspector's phone panels and desktop left/right positions are checked, alongside quantity failure/retry/reload and account-change rejection.

`node tests/performance/compare-card-renderers.mjs` reproduces a bounded rendering prototype. September 9 results are saved in `card-renderer-results.json`; screenshots are generated in `data/card-renderers`. Each engine/backend runs 240 animation callbacks: 80 at 200%, 80 at 300%, then 80 with a translucent dragged copy. All variants use the same 1,000-card DOM background, active artwork, pointer path, six readable DOM action targets and metadata content. CSS keeps the active text in DOM; Canvas/WebGL rasterize it into a 488×680 texture. Canvas 2D approximates perspective with an 8×8 triangle mesh; WebGL draws a textured projective quad. This prototype compares the compositor, not full application behavior: action persistence, hit testing, navigation and accessibility are separately covered by production E2E tests.

| Engine | Renderer | Frame interval p50 / p95 (ms) | Synthetic input → rAF p50 / p95 (ms) | JS submit p95 (ms) | Estimated missed 60Hz slots | Drawing layers |
| --- | --- | --- | --- | --- | --- | --- |
| chromium | css | 16.7 / 16.8 | 7.3 / 15.1 | 0.1 | 0 | 10 |
| chromium | canvas2d | 16.7 / 16.8 | 7 / 12.1 | 0.4 | 0 | 10 |
| chromium | webgl | 16.7 / 16.7 | 7.2 / 11.6 | 0.1 | 0 | 10 |
| webkit | css | 16 / 16 | 15 / 17 | 0 | 0 | Unavailable |
| webkit | canvas2d | 14 / 22 | 10 / 13 | 1 | 0 | Unavailable |
| webkit | webgl | 8 / 17 | 8 / 16 | 1 | 0 | Unavailable |

These are individual controlled runs, not confidence intervals. Timers and scheduling differ across engines; WebKit's shorter median is not evidence that its prototype runs faster on a phone. The input metric measures synthetic event handling to animation callback, not physical input-to-photon latency. Missed slots are rounded estimates from callback intervals, not compositor frame-drop telemetry. Layer counts come from Chromium's LayerTree; GPU memory and WebKit layer counts were unavailable. Chromium WebGL reported SwiftShader; WebKit reported “Apple GPU.” Neither identifies verified physical user hardware.

Visual inspection found Canvas 2D mesh seams and resampling artifacts. WebGL's textured text remains raster content, while the CSS version preserves selectable, accessible DOM text. Chromium's frame intervals and layer counts were effectively tied; Canvas 2D submitted more JS work, and WebGL supplied no demonstrated advantage sufficient to replace the existing DOM controls. Retain CSS transforms and active-only animation. This conclusion does not claim CSS is unaccelerated or rule out a different result on actual hardware. The production grid still renders all returned cards; it is not virtualized.
