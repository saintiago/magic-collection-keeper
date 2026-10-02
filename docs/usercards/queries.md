# UserCards queries

## Responsibility

Own current private list membership, grouping, ordering, pagination and per-reference enrichment.
Read authoritative records under account scope. This is a focused module within UserCards, with
independent query construction and tests; it does not add a service or copied database.

## Interface

Expose focused list and fragment capabilities through the parent public entry point.
[CardList](../card-list.md) consumes them; [Application](../application.md) supplies authenticated
context and transport. Consumers provide intent and explicit references, never SQL or loaded rows.
[Catalog](../catalog.md) supplies reference resolution at recording/upgrade boundaries; it supplies
public display information separately from query membership.

Construct the query/fragment capability with account-scoped read-only storage. It requires neither a
transactional writer nor a reference resolver. Reference preparation belongs to a separately invoked
parent-owned compatible upgrade capability, which uses the supplied resolver before those reads are
enabled. Query and fragment calls never start preparation, write metadata or require another provider
to be available. Incomplete preparation returns explicit unavailability, never a hidden write.

| Capability             | Input                                                                                                                                    | Result                                                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Query collection/tag   | Trusted account, collection or tag scope, card/printing/copy result level, supported private criteria/order, page size and continuation. | Stable entry keys, typed targets, direct/derived quantity context, account revision and continuation or end.                                                 |
| Read private fragments | Trusted account and bounded explicit card/printing/copy references, with optional tag context.                                           | Results keyed to each requested reference: owned-copy count/status, tag associations, distinct physical-location count and intended quantity when requested. |
| Read physical detail   | Trusted account and copy identity.                                                                                                       | Current authorized copy, attributes, memberships and revision, or explicit absence/failure.                                                                  |

Private criteria cover owned membership, tag membership, physical location, finish, condition and
explicit target identities. Result ordering uses supported private fields or stable identity with an
identity tie breaker. Public name/color/type/set/language queries and public-attribute sorting of
private membership are outside this contract. Unsupported criteria/order return explicit failure.
The supplied capability declares supported choices and request bounds so consumers do not invent
limits or post-filter results.

Every read validates its account and foreign references fail closed. Continuation binds account,
normalized request and relevant data revision. Changed criteria, account or relevant revision require
restart; another account's writes do not invalidate the sequence. Unauthorized, absent, invalid,
restart-required and unavailable outcomes remain distinct. Successful absence/count zero requires
successful evaluation, never a timeout or failed lookup.

## Internal design

| Unit           | Owns                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------- |
| Request model  | Supported private scopes, criteria, grouping and ordering.                                   |
| Evaluation     | Complete account-local membership and exact quantity meaning.                                |
| Continuation   | Request/account/revision binding and explicit invalidation.                                  |
| Fragment reads | Batched keyed ownership, association and quantity results.                                   |
| Read storage   | Bounded database queries, owner-local indexes, revision-consistent decoding and permissions. |

The facade composes these units with supplied read storage. Mutation/recovery services and query
construction have independent lifetimes. Query evaluation cannot write records or import private
persistence from another owner. A replacement store preserves behavior; the interface does not
require PostgreSQL, connection settings or a shared database deployment.

## Membership and quantities

Collection membership comes from owned physical copies. Tag lists include direct card/printing
intentions and selected physical-copy memberships, according to the tag type and requested level.
A deck/wishlist can contain card identities with intended quantities and no printing or owned copy.
Grouping can broaden identity for presentation but retains access to original association/copy
references and keeps direct associations distinguishable from derived matches.

Count each physical copy once. Ownership is the count of owned copies; intended quantities come
from card/printing associations; physical deck/location quantities count associated copies. Multiple
matching tags do not multiply entries or owned counts. A copy in several decks still represents one
owned copy and retains its independently managed physical location. Refinement retains association
identity. Pending review is excluded from ordinary membership/counts; dedicated pending reads own
that state.

Use the stored stable card/printing identity relationships to group private facts. Printing/copy
predicates must match the same relevant printing or copy. Evaluate membership, grouping and ordering
before applying a page boundary, across the complete result rather than the loaded window. Request
batch bounds impose no total collection/quantity/selection ceiling.

## Current reads and compatibility

A new read after a successful mutation sees the committed authoritative state. Counts and the entries
in one query describe its returned account revision. Independently loaded fragments may be fresher;
no distributed snapshot with public display information is required.

Compatible storage upgrades resolve missing stable references in bounded, repeat-safe work. Preserve
all existing identities, intended quantities, locations, pending state, immutable receipts/provenance
and exact migration archives. Do not rerun acquisitions, confirmation or migration to populate query
references. Keep source evidence distinct from derived reference metadata.
Resolve both copy and printing-association card relationships. Incomplete or unavailable reference
preparation returns an explicit unavailable query/fragment; never silently omit saved entries or
claim zero ownership. Derived references cannot alter the recorded printing or replay input.

## Replacement evidence

Run the same query/fragment contract cases against alternative supplied implementations. Verify
account isolation, zero versus unavailable, current reads after commits, same-copy predicates,
card/printing refinement, exact counts without duplicates, planned decks without ownership, pending
exclusion, ordering/grouping before pagination and continuation invalidation. Query failures never
change saved state. Storage permission checks reject cross-owner access.
