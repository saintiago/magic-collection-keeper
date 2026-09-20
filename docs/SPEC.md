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

## Assisted camera capture

After a user gesture activates camera/audio, normal capture is hands-free. Exactly one stable usable card must be visible. Recognition may combine local visual, private OCR/visual, and independent provider evidence, but every proposal must resolve against canonical catalog data. Images are transient.

The first validated identity creates one pending capture and success cue. Unresolved attempts never cue success. Later alternatives update that capture only. Consecutive identical Oracle identities are suppressed; A,B,A is accepted; quantity handles consecutive physical duplicates. Multiple/ambiguous geometry remains a rejection/wait condition.

Accepted rows persist in bounded batches and capture continues beyond 50. An uncertain save pauses new admission and retries the same operation. Review is the shared Import workflow; only explicit Add changes ownership. Recorded/emulated/model tests do not prove physical-camera accuracy or device thermal/audio behavior.

## Data access direction

The current whole-collection foundation is accepted only as the present implementation. Future ordinary reads use server-enforced bounded private membership, whole-result filter/sort, deterministic cursors, aggregates/existence, and bounded public metadata hydration. General catalog results may render before bounded private enrichment, with honest loading/error state and stale-response rejection.

An explicit full export is a separate paged/streamed workflow. A small UI page backed by a full server scan or complete browser download does not meet SCALE/DATA acceptance.

## Delivery and trust

Node 24 and Python 3.12 are the supported development runtimes. Local setup, unit, Python recognition, build, and browser commands are documented and mirrored in CI. Tests use in-memory/local data or reserved profiles, never the owner's account.

Every PR/main commit receives one stable aggregate CI result. Check-only changes take a cheap documentation path; compatible presentation changes take the guarded frontend path; all other runtime/model/source changes take the full path. Selected coverage, release classification, corresponding-source checks, and serialized publication/live-account safety remain mandatory.

Main publication reports success only when the exact merged commit's applicable checks, publication, and required live verification pass in that push run. A separate manual verification is useful evidence but cannot replace a failed push result.

## Accepted future product scope

Collection-grounded deck building/upgrades, trading/sales lifecycle, useful release/news discovery, and sustainable operation are accepted discovery directions, not implemented features. They require separately accepted testable slices and must preserve the ownership, source, account, accessibility, security, and bounded-data rules above.
