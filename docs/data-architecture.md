# Data architecture

## Storage ownership

Two components own authoritative data and the queries over it. Each owns its schema, storage
access, ordinary database indexes and compatible storage upgrades.

| Owner     | Stored data                                                                                 | Queries                                                                         |
| --------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Catalog   | Cards, names, printings and atomically published catalog revisions.                         | Public card/printing search, reference resolution and printing selection.       |
| UserCards | Copies, tags, associations, imports, provenance, operation receipts and migration archives. | Account-scoped collection/tag lists, private records, ownership and quantities. |

Initially use separate schemas and access roles in one Aurora PostgreSQL cluster. Sharing the
cluster grants no cross-owner SQL access. Queries execute within their owner's storage and public
contract. There is no separately stored Search projection or synchronization job.

Catalog stores shared public facts once. UserCards stores private facts and the stable card/printing
references required for its local queries; it does not duplicate names, rules text or images.
[Catalog](catalog.md) and [UserCards](user-cards.md) own query meaning and pagination.
[CardList](card-list.md) owns acquisition, enrichment and browser caching.

## Reads and writes

A successful write commits to its owner's storage. A new authoritative read after that commit
reflects it; no indexing pass, queue or browser observation is required to make saved data queryable.
Coupled domain changes and their receipt commit atomically. An uncertain response is resolved through
the recorded operation outcome, never by treating a delayed read as permission for another write.

Catalog synchronization builds and validates a candidate revision before publishing it atomically.
Interactive reads continue using the previous complete revision until then; they never fetch or
import external provider data. Ordinary UserCards edits do not start Catalog synchronization.

Owner reads return bounded pages, stable identities and explicit continuation. Membership, grouping,
counts and ordering are evaluated over the complete owner-local result before pagination. A changed
query or relevant data revision invalidates the continuation explicitly. Request batch bounds do not
limit total collection size, quantities or logical selection.

## List composition

A list's description chooses one membership owner:

- Public name/color/type/set/language/finish queries use Catalog.
- Collection, deck, wishlist, location and other private tag queries use UserCards.
- Pending imports use the dedicated UserCards import read contract.

Private list entries carry typed identity and quantity context; CardList resolves their public basic
information in bounded batches. Public lists acquire current ownership, tags and quantities as
independent UserCards fragments for displayed references. Enrichment cannot add, remove, reorder or
regroup source entries. A missing optional fragment is distinct from zero or an empty successful read.

Queries combining public catalog attributes with private membership are deferred. No component
emulates them by post-filtering a fetched page, fetching an entire collection, making cross-owner SQL
joins or storing duplicate catalog attributes. Each owner's query contract rejects unsupported
criteria; controls expose the capabilities of the selected source.

## Refresh and consistency

UserCards emits account-scoped local invalidations after acknowledged or recovered commits.
CardList invalidates affected private sources/fragments and reacquires them. Public list membership
stays unchanged when only private enrichment changes. Keep usable content labelled as refreshing
while reads are pending; a failed refresh remains a read failure, never a failed save or empty result.
Account changes fence late responses and release private cache/subscription state.

Continuation and counts describe the source revision returned by their owner. Public basics and
private fragments have independent lifetimes; no common distributed snapshot is promised. Opening
or explicitly refreshing a list rechecks its data. No cross-device push guarantee is selected.
There is no indexing-progress token, wait capability or indexing notice.

## Access and independent replacement

Use separate owner read/write capabilities and database roles. Components never receive another
owner's private tables or unrestricted connection. End-user identity is verified for every private
read/write and enforced at storage as well as the public interface. Foreign references disclose no
record contents or existence. Pending-import visibility remains enforced by its owning read contract.

Interfaces expose queries, typed records, revisions, continuation and failures rather than SQL or
schema names. Replacement implementations preserve these behaviors and require no consumer edits.
Direct reads do not permit consumers to reconstruct provider membership or authorization rules.

A dedicated UserCards cluster is a later operational choice for independent scaling, restoration
or workload isolation. A separate database inside the same cluster still shares cluster resources.
No shared connection, join or transaction is required by the contracts, so moving an owner changes
composition and resource bindings only. Introduce separate capacity after measuring the need.

## Existing data and removal

Compatible storage upgrades preserve all current copy/tag/association identities, import state,
operation and migration receipts, provenance, quantities, account identity and exact source archives.
Resolve missing stable card references through the supplied reference contract in bounded work;
repeating the upgrade must not create copies, replay imports or rewrite source evidence.

Remove obsolete Search projection storage, indexing/publication workers, credentials, transport,
configuration, progress state and dependent tests. Retain authoritative Catalog revision publication,
domain receipts/replay evidence and local committed-change invalidations. No durable outbox or
cross-owner change stream is required solely for direct queries.

Implementation and deployment are separate. Existing deployed resources/data are not deleted by
source cleanup. An explicit deployment plan must identify obsolete derived resources and preserve
backups and authoritative storage before any narrowly authorized removal.

## Scale

Use ordinary owner-local database indexes and bounded queries. Private access is account-scoped;
private grouping retains exact copy identities and keeps intended quantities distinct from physical
counts. Avoid per-row provider requests and duplicated public facts per account.

The 100,000-account / 10,000-copy scenario is a capacity evaluation, not a capacity claim or product
ceiling. Measure query plans, storage, write/read concurrency, import load and database contention.
Account-based sharding and read replicas are possible behind the owner interfaces when evidence
justifies them. A separate Search copy is not required by account count alone.
