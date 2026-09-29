# Collection migration

## Scope

Prepare the owner's existing collection for the rebuilt service. MIG-001–MIG-004 in
[requirements](requirements.md#collection-migration) define the preservation obligations.
Preparation is offline: interpret the legacy model, produce a conversion plan and verify it with
synthetic data. Owner-data access, backup restoration, AWS deployment and actual migration are
separate authorized steps. No real backup or migrated collection is claimed by this document.

The source reference is `magic-keeper-old` at
`128c903ff109868acc854f0ff239c8c0f925d803`. Its data interpretation is pinned, not its application
architecture. Another source revision needs its mapping checked before conversion.

## Ownership and interfaces

- The offline utility in `scripts/migration/` owns legacy interpretation and conversion evidence.
  It consumes local files and emits local files. It imports only public component contracts.
- Catalog supplies a snapshot of target printing identities, languages, finishes and paper support.
  Conversion does not substitute another printing or call Scryfall to guess one.
- UserCards owns any future target loader, transactional writes, ownership memberships, provenance,
  import lifecycle and durable migration replay records. The utility must not write private tables
  or reproduce those responsibilities through a sequence of ordinary client commands.
- Search receives normal UserCards publications and builds its projection. Reconciliation first
  reads authoritative UserCards state; indexed search is verified separately after catch-up.

The utility produces a plan, not a new service component or a production import endpoint. Its
`prepared` result means conversion found no known blockers. It does not certify a consistent backup,
an applied migration, target compatibility beyond the checks below, or a successful cutover.

## Legacy mapping

| Legacy evidence                                                                             | Prepared representation                                                                                       |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Native inventory plus source lots, including retained lots, adjusted by manual total deltas | Effective ownership grouped by printing, language, finish and condition; one new copy per unit                |
| Assignment overrides and later additive sources                                             | Effective locations and classifications using the pinned legacy aggregation rules                             |
| Printing and language                                                                       | Exact target printing and matching language; unavailable or incompatible printings block preparation          |
| `UNK` condition                                                                             | Explicit unknown condition (`null`), never assumed mint                                                       |
| Legacy location tag with `kind: deck`                                                       | A deck tag; effective allocated quantities become printing-level deck associations independently of ownership |
| Binder, box or other physical location tag                                                  | A location tag and copy memberships; deck allocations do not consume these memberships                        |
| Role/category tag on an inventory group                                                     | An `other` tag associated with that group's copies; labels do not imply wishlist or planned-deck semantics    |
| Pending import draft                                                                        | A distinct pending session and entries; equal contents do not merge different draft identities                |
| Scan session header, batches and indexes                                                    | One pending session with ordered entries; headers are not extra cards; counts and batch indexes must agree    |
| Empty drafts and confirmed import receipts                                                  | Archived lifecycle/replay evidence; do not create ownership again                                             |
| Original lines, lots, timestamps, operation fingerprints and capture indexes                | Retained in the private source archive, linked through legacy group/draft/row identities                      |

Imported source lots and native inventory can overlap in one effective group. Counting only the
native table loses cards; counting receipts as additional acquisitions duplicates them. Planned
deck quantities come from its effective allocations, including assignment overrides and later
additive sources. Sum quantities for the same deck/printing across physical-condition groups.
Preserve stored printing specificity. Deck quantities can exceed ownership and several decks can
reference the same card. They do not create copies or assign a physical location.

Already recorded legacy ownership (`owned_quantity`, native inventory and total deltas) is preserved
separately. This migration obligation does not make new deck imports ownership acquisitions. A
source URL or deck label alone is never evidence for adding owned copies.

`tag-actions` and `draft-tag-actions` are completed edit receipts. Retain them exactly in the archive,
including receipts for closed drafts, without executing their actions again. Batch and capture scan
indexes must point to retained session/batch evidence, including closed tombstones. Pending captured
rows must retain their matching capture indexes; surplus or contradictory indexes block preparation.

Legacy aggregates do not identify individual physical cards. New copy IDs use the source owner,
legacy group ID and ordinal. Physical binder/box allocations select these new ordinals deterministically.
This preserves counts and attributes without claiming historical physical identity. Provenance
remains attached to its original group/source facts; assigning a particular acquisition timestamp
or source lot to an indistinguishable copy would invent evidence.

## Blockers and unresolved mappings

Preparation fails closed for malformed/duplicate identities, unknown document spaces, missing
source printings, orphan overrides, negative totals, incompatible target printings and inconsistent
scan indexes. It reports physical binder/box location totals exceeding ownership and missing tag
references. Deck requirements exceeding ownership are valid and do not block preparation.
An aggregated deck quantity rejected by the current target public contract is a compatibility
blocker until the target implements the intended-quantity contract. Preserve the complete quantity;
do not reinterpret it as ownership, truncate it or split one association silently.

Pending tag/location intentions currently have no corresponding target entry field. Such entries
are preserved but block the plan. Entries exceeding current confirmation limits and candidates
that cannot be represented also block; the converter neither drops nor silently splits them.

Keep the original export immutable. Resolve a blocker by correcting the source before a new
consistent snapshot, or by agreeing and documenting an explicit migration mapping and its tests.
Do not edit the generated plan to bypass checks. A real snapshot may reveal further decisions;
synthetic tests cannot establish that the owner's records contain none of these cases.

## Offline commands

Requires the repository's Node/npm toolchain and installed dependencies. Keep inputs and outputs
in a private directory outside the checkout, with appropriate filesystem permissions. Outputs
contain the collection and its replay evidence. Commands create new files exclusively and do not
overwrite an existing export or plan. Console output contains summary counts, not card records.

Supply a target catalog JSON array of
`{ printingId, cardId, language, finishes, paper }` records, exported from the intended target
Catalog. Supply an explicit source-owner to target-account mapping; never map accounts by email
or display name. Cognito continuity must be verified before actual migration.

```sh
npm run migration:export -- sqlite /private/restored.db SOURCE_OWNER TARGET_ACCOUNT /private/catalog.json SNAPSHOT_ID /private/export.json
# Alternatively: decoded DynamoDB items (ordinary JSON PK/SK fields), from a restored consistent snapshot.
npm run migration:export -- dynamo-json /private/restored-items.json SOURCE_OWNER TARGET_ACCOUNT /private/catalog.json SNAPSHOT_ID /private/export.json
npm run migration:prepare -- /private/export.json /private/plan.json
```

The SQLite reader opens a read-only transaction. Inventory has no owner column, so its profile
mapping must be verified externally; conflicting document owners cause rejection. The DynamoDB
reader selects the named owner's inventory, documents and replay partitions. It does not fetch
AWS data or decode DynamoDB's typed export format. An ordinary live scan is not a consistent backup.

The export envelope contains `format: keeper-legacy-export-v1`, the pinned `legacyRevision`,
`snapshotId`, `accounts` and `catalog`. Each account has `owner`, `accountId`, native `inventory`,
`documents` (`space`, `id`, `version`, `value`) and `operations`. The schemas in
`scripts/migration/legacy.ts` define this file interface. Multiple accounts may be assembled in
one envelope, each with a unique source and target identity.

Preparation exits 0 for a prepared plan, 2 for a written blocked plan, and 1 for invalid input or
file errors. Inspect `issues` in the private plan. The plan includes expected per-account totals,
effective groups, copies, tags, associations, pending sessions/entries and the exact input archive.
Source and plan digests detect accidental changes. `verifyPlan` also repeats conversion from the
archive. Digests are integrity checks, not proof of authenticity or source completeness.

## Rehearsal and execution gates

Before any owner-data migration:

1. Authorize source access. Identify the actual persistence mode and all owner partitions, verify
   Cognito identity continuity, and obtain a consistent private backup including replay evidence.
   Record snapshot time, source revision, file hashes and account mapping. Restore it in isolation
   and verify it can be read. Keep the original backup alongside the normalized export.
2. Prepare against the intended target Catalog; resolve every blocker explicitly. Build a
   UserCards-owned loader for this plan format before attempting target writes. The loader must
   retain legacy evidence durably, create system ownership, publish normal changes and record
   completed batches transactionally. Repeating an identical plan must return the same outcome;
   conflicting input for a recorded migration must fail. Calling `createCopies` repeatedly does
   not provide that guarantee. Stable proposed IDs alone do not make writes repeat-safe.
3. Rehearse in an empty, isolated target. Exercise interruption and repeat runs. Reconcile exact
   copy IDs/attributes, ownership, tags/memberships, pending state, totals and the durable archive.
   `reconcileMigration` compares a provider-contract readback; exclude system tags/memberships
   from its user-tag arrays and supply their owned copy IDs separately. Extra, missing or changed
   records fail even when aggregate counts match. Verify provenance accessibility, replay
   protection and normal account isolation through the loader's contract tests.
4. Let Search catch up and verify ownership/search visibility, pending imports' restricted
   visibility, locations and representative collection workflows in the deployed service.
5. For cutover, obtain approval for the concrete target and reconciliation report. Stop legacy
   writes and create the final consistent snapshot, including every change since rehearsal.
   Re-run conversion and reconciliation before enabling target writes. Do not run both systems
   as independent writers. Retain the old environment and backup.
6. Rehearse rollback before cutover: stop new writes, preserve any target changes, restore the
   verified prior environment and reconcile before reopening it. Once new writes exist, reverting
   traffic alone would lose them; resolving them is part of rollback approval.

The target loader, durable evidence/readback adapter, real backup rehearsal and cutover are still
outstanding. Deployment and migration have separate evidence: a deployable build is not proof of
a migrated collection.

## Preparation verification

Use synthetic data only in repository tests. Cover combined native/imported quantities, retained
lots, total and assignment overrides, additive sources, physical locations, unknown condition,
independent equal-content imports, scan ordering/completeness, preserved receipts, account
isolation, conflicting records, exact readback comparison and artifact tampering. Exercise the
SQLite adapter with a temporary synthetic database and verify it remains unchanged; exercise the
CLI's blocked outcome and refusal to overwrite files.

```sh
npm test -- tests/component/migration/prepare.test.ts tests/integration/migration-export.test.ts
npm run typecheck
```

Passing these tests verifies offline preparation behavior. The execution gates above require
additional loader tests and actual authorized rehearsal evidence.
