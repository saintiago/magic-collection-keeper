# Architecture

The composition roots are `server.js` (local HTTP + SQLite) and `cloud.mjs` (API Gateway + Lambda). Both create the same application service. Dependency direction is **transport → application → domain**. Adapters implement plain object ports supplied by the composition root. Domain and application code import no browser, AWS, or Scryfall SDK.

## Modules and contracts

| Module                             | Responsibility / replacement contract                                                                                                                                  |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `domain/inventory.js`              | Application errors, quantity/condition/finish/search invariants; no I/O.                                                                                               |
| `application/collection.js`        | List, search, add, set quantity, remove. Receives `repository` and `catalog`; owner identity is mandatory at cloud transport boundary.                                 |
| `adapters/scryfall.js`             | `catalog.search(query,page) → {cards,total,hasMore}`. Injected cache, limiter and fetch. Replace here to use another card data provider.                               |
| `adapters/dynamo.js`               | Cloud inventory repository, printing/search cache and distributed Scryfall lease. Conditional writes enforce existence and quantity limits.                            |
| `adapters/sqlite.js`, `db.js`      | Local repository/cache and schema. Same use cases, one local owner. SQLite enforces foreign keys and uniqueness.                                                       |
| `public/api.js`                    | Browser transport. Adds authentication and reports service failures.                                                                                                   |
| `public/auth.js`                   | Cognito adapter, invitation/password challenge, session storage, refresh and sign-out.                                                                                 |
| `public/app.js`                    | Collection/catalog screen state and event composition; a request generation prevents late search results replacing another screen.                                     |
| `public/card-detail.js`, `view.js` | Card review/edit interaction and shared escaped view helpers.                                                                                                          |
| `public/images.js`                 | `cardImage(printing,face) → URL`. Replace or wrap with an image cache without changing inventory.                                                                      |
| `public/import.js`                 | Pure pasted text parser. Produces rows including quantity, name, optional printing markers, finish and unresolved-line errors. No network.                             |
| `public/catalog-query.js`          | Scryfall query translation for parsed text and OCR. Replace alongside the catalog adapter if the query language changes.                                               |
| `public/camera.js`                 | Camera permission/stream lifecycle, frame capture, thumbnail signatures and motion difference.                                                                         |
| `public/recognition.js`            | Local Tesseract adapter and OCR text parsing. `recognizeCard(canvas,onProgress) → {text,name,exact,confidence}`; exact is optional `{set,number,language}`. No writes. |
| `public/batch.js`, `batch-view.js` | Import/scan review workflow and separate rendering. Resolves candidates, tracks saved rows and confirms ownership before writes.                                       |

The printing DTO currently retains Scryfall field names (`id`, `oracle_id`, `set`, `collector_number`, `lang`, `finishes`, `card_faces`, image URLs and card rules). This is an explicit compatibility contract, not a claim that arbitrary providers plug in without translation. A replacement catalog adapter must normalize its results to that shape and preserve stable provider IDs. A future multi-provider catalog should introduce a provider namespace and migration before switching identity keys.

Repository port: `list(owner)`, `getPrinting(id)`, `add(owner,input,printing)`, `setQuantity(owner,id,quantity)`, `remove(owner,id)`. Cache port: `get(key)` returns a fresh result or null, and `put(key,result)` stores canonical printings with the search. Limiter port: `acquire()` and `pause(milliseconds)`.

## Inventory identity and invariants

1. A gameplay identity uses `oracle_id`; an exact language-specific printing uses Scryfall `id`. An identity can have many printings.
2. Owned inventory is separate from the catalog. Searching/caching never creates ownership.
3. Entries merge only for the same printing, language, condition and finish. Quantities are integers from 1 to 100,000, including the merged total.
4. Language comes from the canonical printing, never from an arbitrary write payload. Finishes must occur in that printing's supported finishes. Conditions are NM, LP, MP, HP or DMG.
5. Cloud ownership comes only from the verified JWT `sub`. A request body cannot select another owner. Each query/write is scoped to `USER#sub`.
6. Retrying an add with the same operation UUID and identical input is idempotent. SQLite records the operation in the same transaction. DynamoDB transacts the quantity change and a seven-day operation marker. Changed input with a reused UUID is rejected. Reopen the card or start a new batch after such a rejection.
7. Batch saves are per-entry, not a transaction spanning the whole batch. Already saved rows are retained as saved when a later entry fails, and a retry skips them. The server's operation marker protects a retry after an ambiguous network response.

SQLite tables: `card_identities`, `printings`, `inventory`, `api_cache`, `operations`. Cloud DynamoDB partitions: `USER#sub` for owned records (printing metadata snapshot included), `PRINTINGS`, `IDENTITIES`, `SEARCH`, `RATE`, and `OPERATIONS#sub`. Search data expires after one day; cached printing data after 30 days; owned inventory never expires. Snapshot metadata ensures previously owned cards remain browsable after cache expiration.

## Security and deliberate tradeoffs

CloudFront uses an origin access control to a non-public S3 bucket. API Gateway validates Cognito JWTs; only OPTIONS is unauthenticated, for CORS. Self-signup is disabled. The Lambda role accesses only the app's table and log group. The GitHub role trusts only this repository's `main` branch and can deploy only this app's function/site and invalidate its distribution. No long-lived AWS keys are stored in GitHub.

Tokens live in session storage, not URLs or committed configuration. This avoids persistent cross-session login but still requires preventing XSS; view interpolation is escaped and a restrictive CSP disallows arbitrary scripts and framing. OCR model/worker/WASM are same-origin assets. Camera photos are not sent to AWS; recognized search text is sent to the catalog backend and Scryfall. Collection and images remain private/public respectively according to their source, rather than pretending public card art is private data.

The UI is a small vanilla DOM app. Screen state is owned by its controllers; it is not a full component framework. Batch orchestration is the largest controller and the first candidate for further splitting as workflows grow. No dependency injection framework or generic repository hierarchy is needed for these two adapters. Local SQLite and cloud DynamoDB are intentionally separate stores, with no automatic migration/sync. E2E coverage must continue to exercise both because their expression/transaction behavior differs.
