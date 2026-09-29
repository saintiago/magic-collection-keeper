# UserCards

## Responsibility

Own private physical copies, tags, associations, import state and provenance. Enforce identity,
quantity, confirmation and account-isolation rules for all changes.

## Interface

- Provide UserInterface editors with private reads and operations for editing copies, tags,
  associations and imports. Provide CardList with pending lists, private fragments and operation
  availability. Provide Capture with staging and candidate attachment. Return affected records or
  operation outcomes; no consumer reconstructs an import's authoritative state.
- Provide Search with authorized snapshots and durable changes for searchable private facts.
- Use Catalog to resolve card/printing references and validate physical-printing attributes.
- Receive trusted user context from Application. Scope every referenced private record and operation
  to that user, including reads and retries.

### Provided operations

| Capability                        | Input                                                                                         | Result                                                                          |
| --------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Read private records              | Trusted user context and record references or a bounded pending-list query.                   | Authorized records, revisions and continuation where applicable.                |
| Edit copies, tags or associations | Trusted context, explicit change and expected revision for existing records.                  | Committed affected records and their revisions, or a conflict.                  |
| Stage or review imports           | Trusted context, session/entry identity, candidates or reviewed values and expected revision. | Updated pending state; no ownership change.                                     |
| Confirm imports                   | Trusted context, operation ID, explicit destination/change and reviewed entry revisions.      | Receipt identifying the resulting associations or copies and committed outcome. |
| Recover an operation              | Trusted context and operation ID.                                                             | Recorded outcome or explicit absence; never another user's result.              |

Import confirmation carries an operation ID scoped to the account. Replaying identical input returns
its recorded outcome; reuse with different input fails. Other edits use record identity and revision
checks. Validation, missing authorized records, revision conflict and temporary unavailability are
distinct failures. Foreign private references reveal no record contents or existence. No partial
mutation is reported as success.

### Query surface

Publish copies, tags and associations through an authorized, versioned data interface. Copy records contain
copy ID, printing ID, finish, condition and derived ownership/location membership. Association rows
contain association ID, tag ID, target level, target ID and optional intended quantity. Copy-targeted
associations have no quantity. Pending entries are available only through import reads, excluded
from ordinary query results and ownership totals according to the
[import lifecycle](#import-and-capture-state). Consumers do not add their own pending-entry filters.

Provide a consistent, paginated snapshot per account and a resumable change position. Changes carry
account, stable change identity, account-scoped revision and explicit upserts/removals. A logical
mutation's publication is complete, including coupled ownership/location changes. Snapshot and change
handoff leaves no gap; expired positions require a new snapshot. Foreign or missing authorization
fails closed. Trusted indexing access is granted separately from an end-user's read access.
Also publish the register of accounts that hold published data — identities only, paginated in a
stable order — so a trusted indexing run covers every account whose changes it has to apply without
an operator naming each account and without reading private tables.
Snapshot pages also identify the account's completed mutation positions within retained publication
history that the snapshot incorporates. This metadata is bounded by the provider's retention window;
position identities are opaque and numeric order alone never establishes account membership.

Commit the authoritative change and durable publication atomically. Search consumes this contract
and owns its resulting projection; it has no access to private tables or SQL views. Source replacement
preserves publication semantics rather than a database layout. Query-visible mutations return their
publication position with their committed outcome, including recovery of that outcome. Operations
affecting only pending review need not publish ordinary searchable ownership data.

### Browser operation lifecycle

The client facade is part of this component. Provide UserInterface and Capture with begin/resume,
observe, recover and supported retry capabilities for a user operation. An operation handle exposes
pending, committed, rejected or unknown outcome and relevant authoritative records/errors. Closing
an observer is not cancellation of a server commit. Resume retains the original account, import and
operation identity; it never infers a new import from matching contents or source URLs.

Own the minimum account-scoped attempt state needed for the existing import/recovery guarantees,
including reload. Receipts and pending records remain server-authoritative. Confirmation uses its
recorded receipt; other operations use their documented identity/revision semantics. Do not turn all
writes into blind automatic retries or introduce a general persistent offline command queue. An
unrecoverable outcome stays explicit until authoritative reads or user reconciliation resolve it.

Expose local committed-change invalidations to CardList: affected record/import/tag references and
the scope whose membership or quantities may have changed and its publication position when indexing
is affected. An invalidation requests a read; it is
not a second copy of authoritative data. A lost response emits no speculative committed event.
Recovered commits produce the same invalidation as acknowledged commits. Subscribers may coalesce
or repeat hints safely. No cross-device push or distributed event infrastructure is required.

Operation availability and input constraints belong to this public contract. They may guide controls
but never replace server validation. Distinguish request batch bounds from a product quantity or
selection limit; consumers must not invent or duplicate limits to match incidental storage choices.

## Internal design

The public facade assembles focused operations. These are internal units, not separately deployed
components. Public request/result types are independent of the concrete stores. Operations validate
intent and interpret outcomes; stores own SQL, locking, atomic changes and persistence failures.

| Unit                      | Owns                                                                                                  | State and write boundary                                                                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Copies                    | Creation and correction of physical records; physical attribute validation.                           | Copy and owned membership change atomically.                                                                                                                            |
| Organization              | Tags, association targets and intended quantities; physical location moves.                           | Association changes retain identity; a location move atomically replaces the previous membership.                                                                       |
| Pending reads             | Bounded session and entry reads, ordering and revision-bound continuation.                            | No ownership writes; reject a read assembled from inconsistent revisions.                                                                                               |
| Staging                   | Manual entry admission, capture sequence and source-line reconciliation.                              | Session, entries, candidates and admission receipts change under the session lock.                                                                                      |
| Review                    | Explicit corrections, late candidate attachment and discard.                                          | Revision checks preserve user edits; late evidence cannot rewrite reviewed fields.                                                                                      |
| Confirmation and recovery | Validate reviewed entries and explicit destination, recognize replay and report the recorded outcome. | One transaction applies destination changes, retains source evidence, closes entries and records the receipt; only an ownership action creates copies and acquisitions. |
| Source conversion         | Fetch and parse supported source formats into staging input.                                          | Provider data is input to staging; never writes owned copies directly.                                                                                                  |
| Query publication         | Account-scoped snapshots and durable searchable changes.                                              | Authoritative changes and publication commit together; private storage remains inaccessible to consumers.                                                               |
| Client operations         | Account-scoped attempt handles, recovery and local committed-change signals.                          | Retain only client attempt context; authoritative writes and receipts remain behind server operations.                                                                  |

The import service composes pending reads, staging, review and confirmation. Its persistence layer has
the same divisions. Shared session access owns session locks, revision reads/advances and bounded entry
hydration. Shared validation owns identifiers and input bounds. Neither becomes a second workflow
coordinator. Destination operations are reused inside confirmation's transaction, rather than calling
public operations that would start another transaction.

### Import state and identity

A session identifies one import card list and serializes its pending changes. Each new import has
its own stable identity, even when another import has identical cards, quantities or source reference.
Retrying, reopening or reconciling an existing import retains that identity. Contents and source URLs
describe an import; they do not identify it or merge it with another import.

An entry holds reviewed card identity, optional printing specificity, quantity, candidate evidence
and revision. Physical attributes are relevant when the chosen action creates physical copies.
Pending, confirmed and discarded are distinct states governed by the
[import lifecycle](#import-and-capture-state). Session identity groups entries and tracks progress;
it does not independently determine ownership or visibility.

Keep three identities separate:

- Capture or staged-line identity records admission/replay of one input. Consecutive accepted identity
  is session state; unresolved input does not advance it.
- Acquisition identity applies only to an ownership action and records which line content and occurrence within an import produced copies.
  Replay within that import reuses its outcome; another import has independent acquisitions even
  when its contents are identical.
- Operation identity records one confirmation request and its immutable result. Changed input under
  the same identity conflicts. Recovery reads this result, even after the copies are later edited.

A source replay reconciles stored source lines with current pending state under the session lock.
It does not overwrite user corrections or infer ownership changes from source additions/removals.
Discarded entries stay historical; an explicit repeated source import can stage uncovered content
again for review. A failed confirmation leaves all coupled records unchanged.
Transaction boundaries stay intact when these units are reorganized.

## Records and associations

Each physical copy has a stable ID, one printing reference and its physical attributes. Corrections
retain its identity. Unknown condition stays explicit until supplied; a suggestion cannot establish
physical condition.

Tags have stable IDs and editable labels. Associations target cards, printings or individual copies.
Card/printing quantities express intent; physical quantities are counts of copies. Refining an
association preserves its identity. System tags are managed through their lifecycle operations.

Physical membership and card/printing intentions remain separate. Simple comparisons use identity
and printing constraints; no stored copy-to-requirement allocation is required.

A deck is a deck tag, not a location. It may contain only card-level associations, printing-specific
associations or selected copy memberships. One copy can be associated with several decks. Deck
quantities can exceed ownership; deck changes do not create, reserve or relocate copies.

A copy's current physical location, such as a binder or box, is a separate fact. Moving it changes
that location association without removing deck memberships or changing ownership. Deck membership
alone never establishes a current physical location.

## Import and capture state

Own both the active session and persisted pending entries, including candidates, user corrections,
quantities, import identity and source provenance. A browser-resident session is part of this component's state;
presentation controls do not maintain a second authoritative import model. Raw frames are transient input.

Staging persists entries with `system:import-pending` membership. These entries are visible only on
the Import page and are excluded from ownership totals, ordinary searches and other lists. Enforce
this distinction in the component's read contracts. Pending entries can represent card identities,
optional printings or unresolved names. Their quantity has the meaning of the selected destination;
they are not yet individual physical-copy records.

Review and correction retain pending membership. Explicit confirmation validates the reviewed
revision and atomically applies an explicit destination and change, ends pending membership and
records the outcome and source evidence. Import does not imply ownership:

- A deck or other tag destination creates or updates the reviewed card/printing associations and
  their intended quantities. Resolving a card name is sufficient for a card-level deck entry.
  Printing, finish, condition and owned-copy availability are not prerequisites for that entry.
- Only an explicit add-to-ownership action creates individual physical copies, acquisition
  provenance and `system:owned` memberships. That action requires valid printing and physical
  attributes. Unknown condition remains explicit.

Destination identity and the requested changes are part of confirmation's replay input. A retry
cannot change them under the same operation identity. The source's provider, title or URL cannot
choose ownership implicitly. Selecting a deck does not also add cards to the collection.

Accepted destination records become available through ordinary reads. There is no intermediate
`system:ready` state. System memberships express the review lifecycle and are managed by its
operations, rather than edited independently.

Consecutive accepted scan identities suppress repeated observation: A,A admits one entry; A,B,A
admits all three. Explicit pending quantity represents repeated physical copies. Unresolved readings
and late candidate updates do not advance the accepted sequence or erase user corrections.

Pending entries remain reviewable until explicitly confirmed or discarded. Discard ends pending
membership without creating owned copies. Repeating the same confirmed operation returns its recorded
outcome; changed input under that identity is rejected.

## Source imports

Support pasted card lists, Moxfield decks and reviewed Wizards preconstructed deck lists.
Preserve the import identity and source provenance independently of editable labels and
the resulting physical-copy records. A reviewed Wizards list retains its official source reference;
accepting a list does not imply automatic discovery or scraping of every preconstructed product.

Parse each supported source into pending entries. Preserve card names and quantities without
requiring a printing. Resolve names to playable card identities for card-level associations; retain
explicit printing choices when the user wants that specificity. Unresolved names or printings remain reviewable;
unsupported formats and invalid rows produce explicit errors. Keep provider fetching and parsing
inside this boundary. Source additions or removals alone never change physical ownership.
Replay protection is scoped to the identified import and its accepted changes, including after
migration; acquisition replay applies only when copies were actually created.

## Persistence and recovery

Use atomic changes and revision checks for coupled records. Conflicting edits remain recoverable
instead of overwriting newer state. Preserve import identity so replay cannot add the same acquisition
twice within that import. A source change alone does not prove that physical ownership changed.

Persist pending progress independently of ownership. A successful save does not require returning
the entire collection. Keep account data isolated in browser persistence as well as backend storage.
