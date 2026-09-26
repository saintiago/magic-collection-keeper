# Collection migration

## Required outcome

The rebuild must carry the owner's existing collection into the new model without losing owned
cards, printing attributes, organization or acquisition provenance. Migration is a release
requirement, not an optional import feature. Existing production storage remains intact until the
converted collection is reconciled and accepted.

## Mapping

| Existing information                                 | New representation                                                                                              |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Owned entry with quantity N                          | N stable physical-copy records, each retaining the known printing, language, finish and condition.              |
| Card and printing references                         | Canonical Catalog identities with an explicit legacy-to-new mapping. Missing references remain reviewable.      |
| Tags and quantity-bearing assignments                | Stable tags plus associations; intended card/printing quantities remain distinct from physical-copy membership. |
| Physical location quantities                         | Assignments to individual copies, with at most one location per copy. Conflicts require reconciliation.         |
| Acquisition lots, source identity and replay records | Provenance and durable replay protection; reimport must not duplicate migrated ownership.                       |
| Pending imports and review decisions                 | Pending UserCards records, never silently promoted to ownership.                                                |
| Owner identity                                       | The same verified Cognito subject/account mapping, with private records isolated throughout conversion.         |

Legacy inventory and metadata can describe overlapping records. The migration must identify the
authoritative representation before counting; it must not add cached or derived totals together.
The new individual IDs identify migrated copies, but do not imply historical knowledge of which
indistinguishable physical card occupied a location. Preserve that uncertainty.

## Safety and acceptance

1. Inventory the live source shapes using the pinned old implementation as reference. Include
   DynamoDB or SQLite records, metadata documents, source receipts and browser-only pending state
   where present. A collection CSV or Git checkout is not a complete data backup.
2. Produce a private, consistent snapshot/export with checksums and an inventory of included data.
   Verify restoration into isolated storage before attempting conversion. Keep owner/test profiles
   separate and backups out of Git.
3. Convert a snapshot in a dry run. Report owned totals by account, printing, language, finish and
   condition; tag memberships, intended quantities, pending entries and provenance/replay coverage.
4. Report missing references, duplicate source identities, unknown attributes and incompatible
   locations explicitly. Do not invent owned cards, discard assignments or choose an arbitrary
   location to make the totals fit. Retain original values until the owner resolves the conflict.
5. Rehearse a repeat-safe migration and rollback. Define a write freeze or a verified final-delta
   procedure so changes made after the snapshot cannot disappear.
6. Cut over only after backup restoration, reconciliation and explicit production authorization.
   Retain the old storage and identity mapping for recovery. Deleting it requires a separate decision.

## Current evidence

Source inspection confirms aggregate quantities with printing/language/finish/condition, separate
document metadata and replay records in the old implementation. This establishes a feasible mapping,
not proof that the live collection has been backed up or migrated. No live data conversion or
production reconciliation has been performed.
