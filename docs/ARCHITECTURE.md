# Architecture

This document describes the current application boundaries and decisions that changes must preserve. Product behavior belongs in [SPEC.md](SPEC.md), tracked status in [REQUIREMENTS.md](REQUIREMENTS.md), observable journeys in [USE-CASES.md](USE-CASES.md), and commands/release procedures in [OPERATIONS.md](OPERATIONS.md).

## System shape

The application has two composition roots:

- `server.js` composes the loopback HTTP server with SQLite for local development.
- `cloud.mjs` composes API Gateway/Lambda transports with DynamoDB and cloud recognition adapters.

Both create the same application service. Dependencies point inward:

```text
browser / HTTP / AWS adapters -> application services -> domain policies
```

Domain and application modules do not import browser, AWS, SQLite, or Scryfall SDKs. Concrete adapters are assembled only in the composition roots. Plain-object ports are preferred so domain behavior can be tested without infrastructure.

## Domain identity and invariants

- A catalog printing is cached public reference data; it is not an owned inventory row.
- Owned entries preserve printing, language, paper/digital legality, finish, condition, and quantity. Quantity bounds are enforced by the domain service.
- Cloud ownership is derived only from the verified JWT subject. A client-provided owner is never authoritative.
- Tag labels are editable metadata over stable opaque IDs. Duplicate or renamed labels must not change navigation or assignment identity.
- Location quantities and total owned quantities are separate. An allocation shortfall is visible but does not block a save or discard an assignment.
- Pending imports do not increase ownership. Add is an explicit atomic confirmation with permanent idempotency receipts.
- Source imports retain source identity, reviewed lines, contribution history, loose copies, and permanent source-import idempotency.

## Browser responsibilities

`public/app.js` coordinates account state, routes, controllers, and invalidation. Feature modules keep rendering, state transitions, and I/O separate where practical. Growing controllers should be split along these existing seams instead of wrapped in a generic framework.

Substantive workflows use dedicated routes: Home, collection, catalog, Import, Scan, tag/deck views, and card details. Browser history is the Back stack. Bounded account-isolated origin state may preserve filters, query, scroll, and focus. Deep links resolve stable public identities and re-read private ownership under the current verified account. Request generations and aborts reject responses that arrive after navigation, mutation, or account change.

Modals are reserved for brief confirmation or focused auxiliary edits such as printing/language or tag assignment.

## Collection reads and device snapshots

`public/collection-loader.js` owns unknown, loading, updating, ready, and failed states. Only a successful validated response proves a collection is empty. Requests coalesce where appropriate and carry generations so pre-mutation or previous-account replies cannot replace current state.

`public/collection-cache.js` keeps an account/environment/schema-keyed IndexedDB display snapshot. It stores no token or password and is never authorization. Signing out clears visible state and invalidates pending work. Browser storage failure falls back to service reads.

The current implementation still loads the whole owned collection for ordinary consumers. SCALE-01–05 and DATA-01–07 define the accepted bounded-query direction; no frontend slice or small response after a full backend scan counts as its delivery.

## Search and public catalog data

Scryfall detail/search access uses the shared lease, 24-hour cache, and 429 cooldown. Large ingestion uses bulk data. A compact multilingual name index runs in a worker and contains public names only; private owned/pending annotations come from the verified account and are merged only into bounded visible results.

The browser verifies prepared model/runtime assets from the app origin. Frozen source, notices, hashes, and reproducible preparation instructions remain part of the corresponding-source contract.

## Card interaction and navigation

Card grids render artwork at rest. Shared artwork modules own fitted hover/tap enlargement, zoom/pan/tilt, tag controls, drag presentation, safe dismissal, and animated return to the current source tile. State modules own selected/pending/error operations; browser adapters perform I/O. A save retains its original idempotent operation across uncertain delivery.

Dedicated card pages own printing, ownership, quantity, condition, finish, and location workflows. Back restores the most recent origin when it still exists; reload resolves the printing and Oracle identity afresh. CARD-10–17 and DRAG-01–05 are delivered, while QUALITY-01 retains the intermittent return-focus investigation recorded in the r130 evidence.

CARD-09 is intentionally **queued**: a basic detail-page face swap exists, but the requested overshoot-and-settle double-sided flip composed with zoom/tilt has not been established by source, regression, and release evidence.

## Imports and source provenance

Scan, pasted text, catalog selection, and supported URL sources create account-owned pending drafts. Draft edits are versioned and recoverable. Add validates current affected state, applies ownership atomically, writes a permanent receipt, and removes only confirmed pending content. Lost responses replay the same operation without duplicate ownership.

IMPORT-05's receipt-only confirmation and lazy collection invalidation are production verified in [r130-a1](../tests/performance/R130-RELEASE.md). IMPORT-06/08–10 bounded backend preparation and IMPORT-07's broader measurement remain queued. The shared pending-card grid/order work in IMPORT-01–04 also remains queued.

## Camera recognition

Recognition is assisted capture, never ownership. After initial camera/audio activation, ordinary capture is hands-free. Geometry must show one stable usable card. Unresolved results produce no success cue or copy. Candidate review and final Add remain explicit.

`scan-sequence` suppresses consecutive accepted Oracle identities: A,A creates one row; A,B,A creates three. Printing/language/finish jitter does not create another copy, and unresolved readings do not advance the sequence. Consecutive identical physical copies use quantity. This owner-accepted SCAN-10 policy supersedes the earlier artwork-departure rule while preserving independent stability and multiple-card checks.

Accepted captures roll into durable batches of at most 50 without stopping the session. A failed save pauses admission and retains the exact operation for retry. Active/recent UI state is bounded; saved batches are paged. Late provider alternatives update only their original capture. Images are transient and must not enter logs, source archives, or routine artifacts.

Automated model, recorded-frame, emulated-browser, and synthetic soak evidence are distinct from physical-device accuracy, audio, heat, battery, and long-session acceptance.

## Deployment and source identity

The main workflow classifies the exact commit as check-only, compatible frontend, or full release. Only the explicit presentation allowlist may reuse the verified API and immutable model/runtime assets. Unknown inputs or missing compatibility evidence choose the full path.

Release assets are published under immutable run/attempt prefixes before root HTML is replaced. Full and frontend releases expose independent frontend/API identities. A failed post-publication check may mean code is visible but the workflow is failed; a separate manual verifier cannot convert that failed push run into success.

The stable aggregate GitHub check evaluates every selected path. Main publication stays serialized and runs both desktop and mobile verification even when one fails so diagnostics are retained. Durable S3 releases, backend/recognition corresponding source, and ECR images are not disposable CI artifacts.

## Security boundaries

- Escape untrusted text before HTML insertion and allowlist public asset URLs.
- Keep credentials, owner data, authentication state, and live traces out of source and artifacts.
- Use isolated reserved profiles for live tests; local tests never use the owner's account.
- Keep the application stack separate from development tooling and never widen AWS or GitHub permissions incidentally.
- Preserve the AGPL source path for the recognition service and exact source/runtime hash checks.
