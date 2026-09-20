# Application specification

This specification states accepted current behavior and accepted future direction. [REQUIREMENTS.md](REQUIREMENTS.md) owns status and evidence; [USE-CASES.md](USE-CASES.md) owns observable journeys.

## Accounts and private state

Cloud requests derive the owner from a verified JWT. Collection rows, pending imports, receipts, tags, browser snapshots, recent activity, and navigation state are isolated by verified account and environment. Signing out hides private state, cancels/rejects late work, and prevents another account from receiving prior results. Local mode uses a separate loopback database and identity and never substitutes for cloud verification.

## Cards, ownership, and catalog data

Catalog printings are public cached references. An owned row records an exact physical printing, language, finish, condition, and bounded quantity. Paper/digital and printing constraints are validated. A search result, recognizer candidate, deck list, pending row, tag, listing, or recommendation is never proof of ownership.

Tags have stable opaque IDs and editable labels. Location quantities are distinct from owned totals. A shortfall is shown inline and does not block edits or discard assignments. Source contributions and loose inventory remain distinguishable; permanent idempotency prevents a source reimport from duplicating ownership.

## Search, Home, collection, and cards

The shared search accepts English and translated names, returns bounded suggestions, explains translations only when useful, and distinguishes owned/not-owned/loading/unavailable state. Keyboard, mouse, and touch selection open a dedicated card page. Submitted text opens normal results.

Home shows bounded recent cards and tags/decks followed by whole-collection statistics. Collection, catalog, tag/deck, Import, Scan, and card routes do not show that statistics block. Recent activity records real selections, opens, confirmed additions, and tag activity—not typing, highlighting, background loads, or failed additions.

Card details resolve public printing identity separately from private ownership. Back is LIFO/browser history and restores a valid bounded origin state where available. Reload/deep links re-resolve stable identities. Printing/language and tag edits may use small dialogs; primary details and large workflows use pages.

Artwork interactions adapt to actual input. Idle grids remain image-first. Enlarged artwork fits the viewport, preserves the source slot, supports zoom/tilt/tag actions, and returns safely on outside activation, Escape, or Back. Drag actions freeze Add/Remove intent and apply at most once. Reduced-motion and keyboard/touch alternatives remain usable.

## Import and review

Scan, pasted text, catalog actions, and supported URLs create separate saved pending imports. Drafts preserve source provenance, exact reviewed attributes, versions, order, and idempotent operation identity. Unresolved rows remain actionable and block Add until corrected or removed. Failed saves retain visible edits and allow retry.

Add explicitly confirms ownership and applies the reviewed batch atomically. A durable receipt supports lost-response replay without duplicates and removes only confirmed pending content. IMPORT-05 returns from the receipt without waiting for a whole-collection refresh; later collection consumers refresh invalidated state. Bounded backend preparation and the shared pending-card presentation remain accepted future work.

Provider denial preserves the draft and other pending imports. No unsupported identity impersonation, cookie/challenge bypass, or availability promise is permitted.

## Stable interaction and import requirements

These entries are the authoritative detailed criteria for the stable IDs in the requirement ledger. Later entries explicitly supersede earlier presentation/admission rules where stated; superseded rules are historical identifiers, not current behavior.

### Card presentation and interaction

- <a id="card-01"></a>**CARD-01:** Idle card grids are image-first, use compact spacing, and retain accessible card names.
- <a id="card-02"></a>**CARD-02:** Mouse movement tilts toward the pointer. Collection/review information is immediately available; a continuous 300 ms hover lifts to 200% of the rendered tile. Leaving at 299 ms cancels it, re-entry restarts the dwell, and tilt remains active while enlarged.
- <a id="card-03"></a>**CARD-03:** Enlargement stays over the visible page and preserves the source slot, filters, scroll, and surroundings. Mouse click targets 300%; touch targets 200% under CARD-15. Shift only as needed to keep the full card and dismissal gutters visible—never center unconditionally.
- <a id="card-04"></a>**CARD-04:** The earlier detached information/action layout is superseded by dedicated pages and CARD-11–17; it must not be recreated.
- <a id="card-05"></a>**CARD-05:** Printed metadata is not repeated over artwork. The earlier overlay content is superseded by tags-only controls and dedicated details; ownership/location semantics remain available in their proper workflows.
- <a id="card-06"></a>**CARD-06:** Controls use restrained translucent glass, fine illuminated edges, subtle action tints, responsive depth, deliberately loaded licensed fonts, and readable fallbacks—never opaque generic panels or shadow blobs.
- <a id="card-07"></a>**CARD-07:** Zoom uses bounded overshoot-and-settle motion with one opaque lifted card. Prevent layout jumps, pointer stutter, native image drag, and accidental text selection only during the active gesture; restore selection afterward.
- <a id="card-08"></a>**CARD-08:** Wheel/pinch adjusts zoom and deliberate enlargement permits bounded pan. Outside activation is consumed, Escape/Back work, reset restores the initial fit, and reduced-motion behavior remains usable.
- <a id="card-09"></a>**CARD-09:** A true double-sided printing exposes a flip composed with zoom/tilt and overshoot-and-settle motion. Rapid input, loading/failure, dismissal, ownership, and reduced motion remain correct; ordinary and split cards never invent a back. The current basic face swap is not full acceptance.
- <a id="card-10"></a>**CARD-10:** Dismissal visibly returns the same lifted image to the current source frame, keeps the source hidden until handoff, consumes the triggering input, and handles scroll/source replacement, interruption, rapid repeats, missing source, focus, and reduced motion without flash or duplicate image.
- <a id="card-11"></a>**CARD-11:** Enlarged artwork contains relevant tags only; quantity/finish/condition, details, zoom buttons, and close controls stay in dedicated workflows. In-page zoom, wheel/pinch, consumed outside dismissal, and CARD-10 return remain.
- <a id="card-12"></a>**CARD-12:** Assigned and unassigned user tags are both reachable with non-color-only state, accessible pressed semantics, keyboard activation, plain labels, and safe overflow. System lifecycle tags are never controls.
- <a id="card-13"></a>**CARD-13:** Tag toggles use stable IDs and exact set/unset intent; preserve location quantities, totals, provenance, and unrelated assignments. Per-tag pending/error/rollback, rapid input, retry/replay, account isolation, and reload are safe.
- <a id="card-14"></a>**CARD-14:** Hover and click/tap enlargement share the same relevant tag registry, assigned state, and direct Add/Remove semantics; only their arrangement differs, and successful changes synchronize every presentation.
- <a id="card-15"></a>**CARD-15:** A real touch tap opens fitted 200% artwork with a radial tag wheel whose Add/Remove targets support tap and drag. Preserve outside dismissal/return, normal scrolling, overflow, and synthetic-mouse suppression.
- <a id="card-16"></a>**CARD-16:** Mouse remains 300 ms hover-to-200% with tilt and click-to-fitted-300% glass tags. Choose the interaction from actual input events/capabilities, not viewport width, so hybrid and narrow desktop devices remain usable.
- <a id="card-17"></a>**CARD-17:** Glass tags remain transparent with visible blur, fine edges, restrained tint, readable selected/unselected states over light/dark art, and a legible no-blur/reduced-motion fallback.

### Drag actions

- <a id="drag-01"></a>**DRAG-01:** Direct card pickup reveals a true-sector radial wheel with an open center and readable unclipped targets; no ellipsis/dropdown trigger is required.
- <a id="drag-02"></a>**DRAG-02:** Recent/relevant tags are easiest to reach and all others remain in More. Target geometry freezes for the gesture and continuous outward motion selects one target.
- <a id="drag-03"></a>**DRAG-03:** The source card remains unmistakable and opaque; a full-size translucent copy follows the pointer and adapts once for viewport edges without hiding labels. Quantity, ownership, and tag identity remain unchanged except for the selected action.
- <a id="drag-04"></a>**DRAG-04:** Wheel targets use the same tag set and freeze explicit `Add [tag]` or `Remove [tag]` intent. Apply once despite intervening saves; preserve location quantity/system restrictions and provide accessible non-drag alternatives with failure recovery.
- <a id="drag-05"></a>**DRAG-05:** Pickup can begin directly from the 200% hover card before, during, or after its reveal. Preserve pointer capture/continuity and consume release so it cannot open zoom or toggle another target; cancellation restores normal input.

### Views and recent activity

- <a id="view-01"></a>**VIEW-01:** Add whole-result card-type and deck-oriented ordering with deterministic backend semantics rather than sorting only a loaded page.
- <a id="view-02"></a>**VIEW-02:** Add stable format and commander-role metadata (including Commander and Modern) without treating editable labels as structural keys or legality as selection.
- <a id="view-03"></a>**VIEW-03:** An explicitly qualifying nonempty full Commander result places commander-role cards first with an unmistakable accessible normal-grid treatment; never infer it from legality or one page.
- <a id="view-04"></a>**VIEW-04:** Whole-collection statistics appear only on Home after user content, with honest loading/saved/error state, and are absent from collection, catalogue, deck/tag, Import, Scan, and card routes.
- <a id="recent-01"></a>**RECENT-01:** Record cards actually opened from shared lists/pages and printings successfully added; hover, background recognition/loading, failed/cancelled Add, and mere list appearance do not qualify.
- <a id="recent-02"></a>**RECENT-02:** Order by latest qualifying event, deduplicate by exact printing, and move an existing printing forward without changing ownership, source, or pending state.
- <a id="recent-03"></a>**RECENT-03:** Keep history bounded, durable across reload, and isolated/clearable per verified account. A viewed pending printing may appear but never becomes owned.
- <a id="recent-04"></a>**RECENT-04:** Confirmed autocomplete selection by mouse, touch, or keyboard qualifies once; typing, receiving, or highlighting suggestions does not. Stale page restoration and delayed artwork cannot reorder newer activity.

### Pending imports and confirmation

- <a id="import-01"></a>**IMPORT-01:** Pending imports use the shared image-only card grid selected by non-removable `system:import-pending` lifecycle state. Reuse immediate review information, continuous 300 ms dwell to 200% hover with tilt, fitted in-page click/tap enlargement, responsive glass controls, and consumed outside dismissal instead of always-expanded form rows.
- <a id="import-02"></a>**IMPORT-02:** Pending-only actions review/change suggested printing or recognition alternative, edit quantity/finish/condition/tags, remove a draft row, and explicitly Add. They never call owned-card mutation ports; unresolved/error rows remain actionable without cluttering every tile.
- <a id="import-03"></a>**IMPORT-03:** Order by immutable creation/capture time oldest first with stable ties. Edits and recognizer refinements never reorder rows; date grouping may not reverse the sequence or fabricate legacy timestamps.
- <a id="import-04"></a>**IMPORT-04:** Preserve saved drafts, source provenance, retry identity, reload/Back/filter/scroll, partial-failure recovery, and long-session behavior. Pending stays outside ownership until Add succeeds; `system:import-pending` is lifecycle state, never an ordinary removable user label that bypasses confirmation.
- <a id="import-05"></a>**IMPORT-05:** After a durable Add receipt, remove only confirmed content without initiating or awaiting a full collection refresh. Preserve other drafts/order/scroll, record only receipt-confirmed Recent activity, invalidate collection data for lazy consumers, and retry unknown outcomes with the same operation.
- <a id="import-06"></a>**IMPORT-06:** Measure request, backend preparation/commit, and post-response UI separately. Bound safe reads/lookups to affected state without removing quantity, source, concurrency, or idempotency checks or shifting repeated cost into every scan.
- <a id="import-07"></a>**IMPORT-07:** Verify success without collection I/O, definite failure, lost-response replay, later consumer refresh, concurrent version protection, 50-row and larger sustained/chunked sessions, and actual before/after stage timings in isolated profiles.
- <a id="import-08"></a>**IMPORT-08:** Confirmation reads only affected ownership variants, prior source contributions, and applicable tags/locations; unrelated inventory growth cannot increase scope. Preserve bounds, concurrent edits, loose copies, and permanent source idempotency.
- <a id="import-09"></a>**IMPORT-09:** Reuse trusted staged printing metadata only while applicable; changed/missing dependencies are revalidated and client claims are never authoritative. Preserve exact identity, language, paper, and finish rules and measure lookup counts.
- <a id="import-10"></a>**IMPORT-10:** Shared domain preparation may move reusable work to staging/editing, but ownership-sensitive calculations stay current at Add. One atomic commit writes ownership/tags/locations/source, permanent receipt, and draft removal; staging alone grants no ownership.

## Assisted camera capture

After a user gesture activates camera/audio, normal capture is hands-free. Exactly one stable usable card must be visible. Recognition may combine local visual, private OCR/visual, and independent provider evidence, but every proposal must resolve against canonical catalog data. Images are transient.

The first validated identity creates one pending capture and success cue. Unresolved attempts never cue success. Later alternatives update that capture only. Consecutive identical Oracle identities are suppressed; A,B,A is accepted; quantity handles consecutive physical duplicates. Multiple/ambiguous geometry remains a rejection/wait condition.

Accepted rows persist in bounded batches and capture continues beyond 50. An uncertain save pauses new admission and retries the same operation. Review is the shared Import workflow; only explicit Add changes ownership. Recorded/emulated/model tests do not prove physical-camera accuracy or device thermal/audio behavior.

### Scanner requirements

- <a id="scan-01"></a>**SCAN-01:** One physical split card, including supported rotation, resolves as one canonical capture even when printed panels resemble multiple cards.
- <a id="scan-02"></a>**SCAN-02:** Two distinct or overlapping physical cards still wait/reject. Split-card support may not globally weaken the one-card geometry gate; verify split, ordinary, separate, overlap, and rotation fixtures while distinguishing replay from physical evidence.
- <a id="scan-03"></a>**SCAN-03:** The earlier visual-departure rearm rule is superseded by SCAN-10. Its retained safety intent is that one accepted consecutive identity produces at most one row/cue despite reflections, autofocus, transient loss, motion, or late replies.
- <a id="scan-04"></a>**SCAN-04:** The earlier physical-departure/replacement gate and automatic consecutive-identical-copy goal are superseded by SCAN-10. Do not silently delete or name-deduplicate reviewed draft rows.
- <a id="scan-05"></a>**SCAN-05:** No user-facing 50-card session stop. Continuous capture rolls through bounded durable commit batches with explicit later ownership review, retry identity, bounded active work, and visible persistence failure.
- <a id="scan-06"></a>**SCAN-06:** Spatial masks/outlines/transitions represent actual framing, processing, and result geometry without obscuring art. Preserve accessible non-color-only equivalents, reduced motion, and concise recovery text; never invent localization or stages.
- <a id="scan-07"></a>**SCAN-07:** Each queued row identifies actual provider evidence/alternatives/failure with accessible labels. Late evidence updates its capture ID only, never adds a copy/cue, implies false agreement, or overrides manual review.
- <a id="scan-08"></a>**SCAN-08:** The r123 visual-replacement repair is historical and superseded after rejected physical acceptance; it is not current admission behavior.
- <a id="scan-09"></a>**SCAN-09:** The reopened physical “only first card scans” report is historical evidence resolved by the owner-selected SCAN-10 policy; r123 automation alone was not proof.
- <a id="scan-10"></a>**SCAN-10:** Suppress a consecutive match to the last accepted Oracle identity without requiring empty/changed artwork; A,A adds once and A,B,A adds three. Unknown/suppressed results do not cue success or advance order. Keep stability, actual multi-card rejection, bounded requests, capture-correlated late alternatives, exact printing metadata, and explicit Add; quantity handles consecutive identical copies.
- <a id="scan-11"></a>**SCAN-11:** Keep capture/inference/allocation work bounded and measure active/idle rates, buffers, long-session memory, responsiveness, heat, and battery without reintroducing visual replacement. The existing synthetic evidence does not prove phone thermals.
- <a id="scan-12"></a>**SCAN-12:** Support thousands of captures over hours without a fixed session stop. Internal batches roll transparently and persist incrementally with exact retry and last-accepted identity across rollover.
- <a id="scan-13"></a>**SCAN-13:** Active memory/images/history are bounded independently of total captures; release buffers, apply recoverable backpressure, page older saved batches, preserve order, and recover after reload without loading every row/form.
- <a id="scan-14"></a>**SCAN-14:** The engineering benchmark is at least 2,000 accepted simulated captures over two hours with memory/rate/latency/responsiveness/duplicate/recovery evidence. Physical-phone heat/battery/audio acceptance remains separately required.

## Data access direction

The current whole-collection foundation is accepted only as the present implementation. Future ordinary reads use server-enforced bounded private membership, whole-result filter/sort, deterministic cursors, aggregates/existence, and bounded public metadata hydration. General catalog results may render before bounded private enrichment, with honest loading/error state and stale-response rejection.

An explicit full export is a separate paged/streamed workflow. A small UI page backed by a full server scan or complete browser download does not meet SCALE/DATA acceptance.

### Bounded access and data requirements

- <a id="scale-01"></a>**SCALE-01:** No ordinary workflow loads the entire owned collection. Every list endpoint enforces a finite server page, including unfiltered collection, for inventories of at least 30,000 cards.
- <a id="scale-02"></a>**SCALE-02:** Filter/search/sort precedes paging with deterministic ties/cursors. Preserve bounded navigation state and bounded rendered/cache items; incremental loading may not accumulate the entire inventory.
- <a id="scale-03"></a>**SCALE-03:** Home, Recent, ownership indicators, card details, tags/decks, pending imports, and mutation refresh use bounded specific/batched reads. Whole-result totals/summaries/eligibility use aggregates/existence, not a page or hidden full scan.
- <a id="scale-04"></a>**SCALE-04:** Mutations update/invalidate affected rows and visible bounded queries rather than broadly refreshing collection state. Preserve quantities, provenance, assignments, isolation, and explicit paged/streamed export.
- <a id="scale-05"></a>**SCALE-05:** Audit every full-list caller and verify isolated 30,000-card response, read-cost, latency, browser memory/DOM/cache, filtering/sorting/counts, cursors, concurrent changes, navigation/reload, and account isolation. A frontend slice after a full read fails acceptance.
- <a id="data-01"></a>**DATA-01:** Scryfall supplies general catalogue/canonical metadata. Enrich only the bounded result page through a bounded exact-printing owner batch; keep Oracle/printing, language/finish/condition, and pending state distinct.
- <a id="data-02"></a>**DATA-02:** Owned/tag/deck/pending views begin from indexed owner membership with backend filter/sort/page, then hydrate only that page. A global catalogue page can never stand in for complete private membership.
- <a id="data-03"></a>**DATA-03:** Store only the canonical query projection needed for supported private views, with explicit refresh/version policy. It is neither ownership nor a replacement general catalogue, and sorting may not materialize every match.
- <a id="data-04"></a>**DATA-04:** Shared printing cache remains separate from quantities, assignments, pending captures, and provenance. Preserve limiter/cache/cooldown, bounded miss hydration, exact-variant aggregation, completeness, metadata refresh, pagination, and account isolation.
- <a id="data-05"></a>**DATA-05:** Catalogue membership/order can render before private enrichment. Fetch one bounded owner batch and reconcile in place without changing order/layout/focus/hover/zoom/drag or duplicating requests.
- <a id="data-06"></a>**DATA-06:** Unresolved enrichment is explicitly unknown/loading, never zero/unowned. Failure keeps catalogue usable with targeted retry; account/query generations and exact printing reject stale replies and protect newer mutations.
- <a id="data-07"></a>**DATA-07:** Progressive catalogue enrichment cannot drive owned/tag/deck/pending membership or counts. Verify delay/failure/out-of-order replies, paging, rapid query/account changes, active interactions, and concurrent edits.

## Delivery and trust

Node 24 and Python 3.12 are the supported development runtimes. Local setup, unit, Python recognition, build, and browser commands are documented and mirrored in CI. Tests use in-memory/local data or reserved profiles, never the owner's account.

Every PR/main commit receives one stable aggregate CI result. Check-only changes take a cheap documentation path; compatible presentation changes take the guarded frontend path; all other runtime/model/source changes take the full path. Selected coverage, release classification, corresponding-source checks, and serialized publication/live-account safety remain mandatory.

Main publication reports success only when the exact merged commit's applicable checks, publication, and required live verification pass in that push run. A separate manual verification is useful evidence but cannot replace a failed push result.

### Delivery and quality requirements

- <a id="deploy-01"></a>**DEPLOY-01:** Eligible presentation changes use the existing main delivery system to publish versioned frontend assets without rebuilding/updating unchanged API, recognition, or model assets.
- <a id="deploy-02"></a>**DEPLOY-02:** Eligibility is fail-closed from exact current validation inputs plus accumulated unpublished runtime inputs. Backend/API/recognition/infrastructure/unknown inputs use full delivery; a prior test-only commit cannot make a later docs-only change expensive.
- <a id="deploy-03"></a>**DEPLOY-03:** Frontend/backend identities stay independently accurate; HTML publication and rollback/version ordering remain safe; the combined corresponding-source offer exactly matches the deployed combination.
- <a id="deploy-04"></a>**DEPLOY-04:** Retain meaningful unit/build/browser/live compatibility checks, immutable artifact integrity, least privilege, owner-data safety, and measured end-to-end timing for the selected path.
- <a id="deploy-05"></a>**DEPLOY-05:** The separate frontend path reuses trusted main publication and verified backend compatibility, fails closed to full delivery when necessary, and does not discard completed or queued product work.
- <a id="deploy-06"></a>**DEPLOY-06:** Disposable Actions handoffs use bounded retention and are removed only after exact successful protected publication/verification. Failed/PR/check-only/concurrent/source/publication/durable assets remain protected; cleanup is allowlisted and least-privilege.
- <a id="perf-01"></a>**PERF-01:** Compare equivalent real interactions across implementations and report named environment, samples, narrow/landscape/wide/dense/failure scope, and separated backend/render/device attribution. Emulation is never physical-device proof.
- <a id="quality-01"></a>**QUALITY-01:** Inspect real screenshots/motion and trace failures in addition to automated checks. Integrate through the normal protected workflow, preserve unresolved observations, and never turn a passing retry into an unsupported root-cause or production claim.

## Accepted future product scope

Collection-grounded deck building/upgrades, trading/sales lifecycle, useful release/news discovery, and sustainable operation are accepted discovery directions, not implemented features. They require separately accepted testable slices and must preserve the ownership, source, account, accessibility, security, and bounded-data rules above.
