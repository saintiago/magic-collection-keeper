# Collection migration

## Required outcome

The rebuild must carry the owner's existing collection into the new model without losing owned
cards, printing attributes, organization or acquisition provenance. Migration is a release
requirement, not an optional import feature. Existing production storage remains intact until the
converted collection is reconciled and accepted.

This document owns the legacy-to-new mapping and the backup, reconciliation and cutover acceptance
the conversion must satisfy. Implementing the conversion, changing live data and cutting over are
separate work that this specification does not authorize. The testing architecture defines how
representative synthetic legacy records verify these rules; the operations document owns release
acceptance.

## Mapping

The pinned previous implementation, revision `128c903ff109868acc854f0ff239c8c0f925d803`, is the
reference for the source shapes in this section. The collection can exist in the production
account, in a local profile and, as pending work, in browser storage; a complete migration input
covers every store that holds owner data. A collection CSV, a repository checkout or a browser
display cache is not a data backup.

### Legacy sources

**Production DynamoDB table `magic-collection-keeper`**, partitioned by the verified Cognito
subject:

- `USER#<subject>` inventory rows, keyed by a digest of printing, language, condition and finish:
  one aggregate quantity per row with its printing reference, embedded printing snapshot and
  timestamps.
- `OPERATIONS#<subject>` single-add receipts with an input fingerprint and a seven-day expiry.
- `REVIEWBATCH#<subject>` reviewed-import `BATCH#` records and permanent per-item `ITEM#` receipts.
- `META#<subject>#<space>` documents in the spaces `tags`, `decks`, `cards`, `assignments`,
  `totals`, `import-drafts`, `scan-drafts`, `scan-batch-index`, `import-stages`, `tag-actions` and
  `locks`.
- `PRINTINGS`, `IDENTITIES`, `SEARCH` and `RATE` records: catalog cache and throttling state, never
  owned cards.

**Local SQLite profile `data/collection.sqlite`**, in WAL mode and owned by the synthetic local
profile:

- `inventory` aggregate rows, unique per printing, language, condition and finish.
- `operations` receipts: single-add entries and `review:<owner>:<kind>:<id>` batch/item entries.
- `documents(owner, space, id, version, value)` records using the same document spaces as above.
- `card_identities`, `printings` and `api_cache`: catalog cache, never owned cards.

**Owner's browser storage**, where only the pending parts are collection data:

- `keeper-review-v1` indexed reviews with their `keeper-review-journal:<account>` mirror: scanned
  batches reviewed but not yet saved to the account.
- `keeper-pending-text:<environment and account key>`: a staged text import.
- `keeper-catalog-tags-v1:<account>` and `keeper-card-action-v1:<account>`: pending catalog
  selections and an unresolved card action, which may already have committed on the server.
- Display snapshots, public catalog and recognition caches, recent searches, home history and
  session tokens are local state, not collection data.

The table maps those record families onto the new model; the conversion rules below apply to every
row.

| Existing information                                                                                                   | New representation                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Owned entry with quantity N (`USER#<subject>` or SQLite `inventory` row)                                               | N stable physical-copy records, each retaining the known printing, language, finish and condition.              |
| Card and printing references (row printing ID, embedded snapshot, `cards` documents)                                   | Canonical Catalog identities with an explicit legacy-to-new mapping. Missing references remain reviewable.      |
| Tags and quantity-bearing assignments (`tags`, `assignments`, deck lots)                                               | Stable tags plus associations; intended card/printing quantities remain distinct from physical-copy membership. |
| Physical location quantities (`assignments` allocations and deck locations)                                            | Associations to individual copies, with at most one location per copy. Conflicts require reconciliation.        |
| Quantity overrides (`totals` deltas)                                                                                   | Effective owned quantities that differ from the stored aggregate; reconciled before conversion.                 |
| Acquisition lots, source identity and receipts (`decks`, `REVIEWBATCH#`, `tag-actions`, `import-stages`, `operations`) | Provenance and durable replay protection; reimport must not duplicate migrated ownership.                       |
| Pending imports and review decisions (`import-drafts`, `scan-drafts`, browser pending keys)                            | Pending UserCards records with their corrections and source identity, never silently promoted to ownership.     |
| Owner identity (verified Cognito `sub` claim)                                                                          | The same verified subject/account mapping, with private records isolated throughout conversion.                 |

Legacy inventory and metadata can describe overlapping records. The migration must identify the
authoritative representation before counting; it must not add cached or derived totals together.
The new individual IDs identify migrated copies, but do not imply historical knowledge of which
indistinguishable physical card occupied a location. Preserve that uncertainty.

### Conversion rules

- **Effective quantity.** A legacy row's owned count comes from its own record plus its recorded
  `totals` override, never from a cached aggregate. Deck lots contribute their owned quantity, not
  only the currently allocated quantity. An unexplained override is reported instead of adopted.
- **Copy identity and determinism.** The migration assigns new copy IDs and keeps the legacy record
  identity in the mapping record so counts, conflicts and receipts stay attributable. Converting
  the same snapshot twice produces the same copies; a rerun adds nothing.
- **Reference resolution and attributes.** Resolve printing references against Catalog, which owns
  the card/printing model; confirm copy finish, condition and language against the resolved
  printing. Unknown or missing attributes stay explicit. An unresolved printing becomes a
  reviewable entry, never a dropped or invented copy.
- **Tags and associations.** Preserve legacy tag IDs through an explicit mapping and recompute
  reference counts instead of copying them. Card/printing intentions become quantity-bearing
  associations; allocated copies become copy associations that survive label edits. Keep the
  distinction between intended quantities and physical copies described in
  [UserCards](user-cards.md#records-and-associations).
- **Locations.** Allocation quantity per legacy row maps onto individual copies of that row, and
  each copy ends with at most one location. An allocation larger than its row, a copy claimed by
  two locations, or a source allocation that only exists implicitly is a conflict for owner
  review; nothing is discarded or chosen arbitrarily.
- **Provenance and replay.** Keep source identity, acquisition provenance and excluded or pending
  source lines with the copies and pending entries they produced. Reviewed-import item receipts
  and source fingerprints become permanent receipts; expiring single-add receipts are not durable
  proof. Reimporting the same source must add no copies.
- **Pending entries.** Preserve reviewed rows, corrections, quantities and revisions as pending
  entries, with staging receipts so the same capture cannot be staged twice. Confirmation creates
  copies with the mapped provenance; unresolved readings stay unresolved.
- **Excluded data.** Caches, cached printing and card identities, search results, throttling state,
  display snapshots, history and session tokens are not migrated. The verified subject remains the
  isolation key for every private record.

## Safety and acceptance

The production migration runs once, from a verified backup, in isolated storage, and only after the
owner authorizes cutover. Each numbered step produces evidence; a step that cannot be completed
leaves the migration unfinished.

1. Inventory the live source shapes using the pinned old implementation as reference. Include
   every DynamoDB partition and document space, the SQLite profile with any `-wal`/`-shm` files,
   source receipts and the browser-only pending keys above. Record which record kinds are present
   and their counts; a live shape that differs from the reference is reported, not guessed.
2. Produce a private, consistent snapshot/export with checksums and an inventory of included data.
   Use point-in-time recovery or an on-demand backup for DynamoDB and restore it into a separate
   table; stop the local server and copy the checkpointed SQLite file or `VACUUM INTO` a new one;
   export the browser pending keys, which clearing site data would destroy. Verify the restore into
   isolated storage by comparing item and table counts and digests. Keep owner and test profiles
   separate, and keep snapshots and checksums out of Git.
3. Convert a restored snapshot in a dry run that writes nothing to production. Report owned totals
   by account, printing, language, finish and condition; tag memberships, intended quantities,
   pending entries, provenance and replay coverage; and the source record behind every converted
   copy.
4. Report missing references, duplicate source identities, unknown attributes, quantity overrides,
   orphaned assignments or receipts, and incompatible locations explicitly. Do not invent owned
   cards, discard assignments or choose an arbitrary location to make the totals fit. Retain
   original values until the owner resolves the conflict.
5. Rehearse a repeat-safe migration and rollback. Reruns over the same snapshot must produce the
   same counts and no additional copies. Define a write freeze or a verified final-delta procedure
   so changes made after the snapshot cannot disappear, and rehearse rollback by serving the
   previous version against the untouched legacy storage.
6. Cut over only after backup restoration, reconciliation and explicit production authorization.
   Retain the old storage, the legacy-to-new identity mapping and the previous deployment for
   recovery. Deleting legacy storage requires a separate decision.

### Acceptance before cutover

- A private snapshot covering every store that holds owner data is restored and verified in
  isolation, and its checksums and contents inventory are recorded.
- The dry-run report accounts for every legacy owned quantity exactly once per account and
  printing/language/finish/condition, and keeps intended quantities, locations and pending entries
  distinct from ownership.
- Every missing reference, unknown attribute, duplicate identity and conflicting allocation is
  listed for owner review, with no arbitrary resolution and no dropped legacy value.
- A repeated conversion produces no additional copies and the same reconciliation result, and a
  repeated source import adds nothing.
- Rollback has been rehearsed against the untouched legacy storage and the previous deployment.
- Production cutover has explicit owner authorization, and the backup and legacy storage remain
  available for recovery.

## Current evidence

Source inspection of the pinned reference revision confirms aggregate quantities with
printing/language/finish/condition in the DynamoDB inventory rows and the SQLite `inventory` table,
per-owner document spaces for tags, decks, assignments, quantity overrides, printing snapshots and
pending drafts, expiring single-add receipts beside permanent reviewed-import item receipts, and
the browser-only pending keys listed above. The inspection covered the reference storage adapters
and database schema, the services that produce and consume the document spaces, and the browser
pending-state modules. This establishes a feasible mapping, not proof that the live collection has
been backed up or migrated.

The inspection reads the reference implementation, not the owner's data: no snapshot was taken, no
restore was verified and no conversion was performed by specifying this mapping. Live contents,
their reconciliation status and the production cutover remain unknown until the procedure above is
executed and its evidence recorded.
