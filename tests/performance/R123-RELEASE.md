# r123 scanner release verification

**SCAN-08 and DEPLOY-06 are deployed and verified** in r123-a2 / 0.1.0+deploy.123.2, main `b82f3581ae87b90d9953d0a373ec82bb6bbdb560`, on September 11, 2026. [Successful main deployment](https://github.com/saintiago/magic-collection-keeper/actions/runs/34581369109/attempts/2).

## Scanner correction

The previous latch required an empty guide after every attempted card, so sliding directly to another card could stall scanning. Fresh stable single-card geometry can now rearm after visually different cropped artwork persists across 600 ms of fresh observations. Normalized patches tolerate brightness/contrast and small position changes. Stationary cards, stale results, gaps and multiple/overlapping cards retain their protection. Identical-looking copies still require observable departure. Fresh single-card geometry clears an outdated multiple/ambiguous warning.

The supplied The Arkenstone screenshot replayed as single with the actual geometry worker in Chromium and WebKit using the full guide. A tighter crop was ambiguous. No geometry threshold or model was relaxed, and the private screenshot stayed local.

## Verification

| Check | Result |
| --- | --- |
| Unit | 137 passed, including five artifact-cleanup safety cases |
| Chromium application | 139 passed |
| Required WebKit application | 103 passed; one existing unsupported-stream skip |
| Visual prototypes in both engines | 56 passed |
| Actual deployed desktop | 12 passed |
| Actual deployed mobile emulation | 8 passed |
| Independent public/API/source/config/asset identities | Passed |
| Reserved temporary inventory and drafts after cleanup | Empty |

LIVE-04 passed in 28.9 seconds against the actual deployed app. It captures two identical public cards with observable departure, then a different public Lightning Bolt without a blank interval. The stationary third card adds no extra row. Three reviewed rows resolve to the expected identities, explicit Add saves four copies after the quantity edit, and ownership survives reload. Reserved-profile cleanup succeeds. These are synthetic camera frames with real recognition and persistence, **not physical-device camera verification**. Audio, reflections and physical consecutive-copy behavior still need device testing.

## Corresponding source and retention

Attempt 1 passed all application tests but stopped before API/site publication because retention added two tracked CI files and changed five workflows. The earlier local 124-file check preceded that commit and did not cover those changes. The guard was preserved. [Isolated source/image verification](https://github.com/saintiago/magic-collection-keeper/actions/runs/34582973845) and [exact-image publisher](https://github.com/saintiago/magic-collection-keeper/actions/runs/34583570989) passed. All 386 applicable tracked files match; the refreshed guard verifies 126 private/runtime/build files.

Recognition version 18 serves matching source SHA-256 `a54121d9a92ebef46e4944a26223268bb6dc07d6123cd778bfbd7c34b69b7cd3` (3,987,289 bytes). Only Function, Version and Alias changed. Memory remains 3008 MB, timeout 20 seconds, both routes JWT-protected, with no provisioned/reserved concurrency or model image/text logging. Actual primary/independent public-card, source, authorization, invalid-input, size-bound and multiple/overlap checks passed without ownership writes. Recognition runtime/models were unchanged.

The failed deploy job resumed with the already-passed application tests. [Automatic cleanup](https://github.com/saintiago/magic-collection-keeper/actions/runs/34584731470) succeeded after live verification, deleting only `keeper-build` 10192232154 and `keeper-release-plan` 10191733946 from that run. Its remaining artifact count is zero. Disposable uploads retain one day; recognition cross-run source/image handoffs retain the documented seven-day exception. Durable S3/ECR/source and local audit copies remain outside cleanup. See [consumer audit](../../docs/OPERATIONS.md#github-artifact-retention).

Independent verification at 09:33 UTC confirmed the published commit/version, authenticated API identity, recognition version/source, source overlay and configuration hashes, with the temporary test profile empty. API code SHA-256 is `JCcV9WzdykbDbBtIA6DKOoNWWo8lz062zY3tt66xlzg=`. The frontend source overlay is 336,705 bytes, SHA-256 `faf76724a45470bea362cde478aece8a2790fe64379d5dbbd1d4b7bfc3d8dee3`. Vendor/config hashes are unchanged from r114. Full read-only JSON evidence and logs remain in ignored `data/recognition-evaluation/phone-feedback`.

Only the scoped scanner fix and retention recovery were advanced. Other feature backlog remains paused.
