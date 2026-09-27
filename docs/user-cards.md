# UserCards

## Responsibility

Own private physical copies, tags, associations, import state and provenance. Enforce identity,
quantity, confirmation and account-isolation rules for all changes.

## Interface

- Provide UserInterface with private reads, pending entries and operations for editing copies,
  tags, associations and imports. Return the affected records or operation outcome.
- Provide Search with an authorized read contract for private membership, quantities and attributes.
- Use Catalog to resolve card/printing references and validate physical-printing attributes.
- Receive trusted user context from Application. Scope every referenced private record and operation
  to that user, including reads and retries.

### Provided operations

| Capability                        | Input                                                                                         | Result                                                             |
| --------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Read private records              | Trusted user context and record references or a bounded pending-list query.                   | Authorized records, revisions and continuation where applicable.   |
| Edit copies, tags or associations | Trusted context, explicit change and expected revision for existing records.                  | Committed affected records and their revisions, or a conflict.     |
| Stage or review imports           | Trusted context, session/entry identity, candidates or reviewed values and expected revision. | Updated pending state; no ownership change.                        |
| Confirm imports                   | Trusted context, operation ID and reviewed entry revisions.                                   | Receipt identifying the resulting copies and committed outcome.    |
| Recover an operation              | Trusted context and operation ID.                                                             | Recorded outcome or explicit absence; never another user's result. |

Import confirmation carries an operation ID scoped to the account. Replaying identical input returns
its recorded outcome; reuse with different input fails. Other edits use record identity and revision
checks. Validation, missing authorized records, revision conflict and temporary unavailability are
distinct failures. Foreign private references reveal no record contents or existence. No partial
mutation is reported as success.

### Query surface

Expose read-only copies, tags and associations scoped to trusted user context. Copy rows contain
copy ID, printing ID, finish, condition and derived ownership/location membership. Association rows
contain association ID, tag ID, target level, target ID and optional intended quantity. Copy-targeted
associations have no quantity. Pending entries are available only through import reads, excluded
from ordinary query results and ownership totals according to the
[import lifecycle](#import-and-capture-state). Consumers do not add their own pending-entry filters.

Search reads these relations through the public query contract. The PostgreSQL implementation uses
protected views with account scoping enforced at the database boundary. Missing context fails
closed; account context cannot leak between reused connections. Private base tables are inaccessible
through this read contract. Publish a private-data revision for continuation validation.

## Internal design

The public facade assembles focused operations. These are internal units, not separately deployed
components. Public request/result types are independent of the concrete stores. Operations validate
intent and interpret outcomes; stores own SQL, locking, atomic changes and persistence failures.

| Unit                      | Owns                                                                         | State and write boundary                                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Copies                    | Creation and correction of physical records; physical attribute validation.  | Copy and owned membership change atomically.                                                                                       |
| Organization              | Tags, association targets and intended quantities; physical location moves.  | Association changes retain identity; a location move atomically replaces the previous membership.                                  |
| Pending reads             | Bounded session and entry reads, ordering and revision-bound continuation.   | No ownership writes; reject a read assembled from inconsistent revisions.                                                          |
| Staging                   | Manual entry admission, capture sequence and source-line reconciliation.     | Session, entries, candidates and admission receipts change under the session lock.                                                 |
| Review                    | Explicit corrections, late candidate attachment and discard.                 | Revision checks preserve user edits; late evidence cannot rewrite reviewed fields.                                                 |
| Confirmation and recovery | Validate reviewed entries, recognize replay and report the recorded outcome. | One transaction binds acquisition identities, creates copies/owned memberships/provenance, closes entries and records the receipt. |
| Source conversion         | Fetch and parse supported source formats into staging input.                 | Provider data is input to staging; never writes owned copies directly.                                                             |
| Query publication         | Read-only projections and private-data revision.                             | Base storage stays private; scope is transaction-local and missing scope returns no private data.                                  |

The import service composes pending reads, staging, review and confirmation. Its persistence layer has
the same divisions. Shared session access owns session locks, revision reads/advances and bounded entry
hydration. Shared validation owns identifiers and input bounds. Neither becomes a second workflow
coordinator. Copy insertion is reused inside confirmation's transaction, rather than calling a public
copy operation that would start another transaction.

### Import state and identity

A session identifies one import card list and serializes its pending changes. Each new import has
its own stable identity, even when another import has identical cards, quantities or source reference.
Retrying, reopening or reconciling an existing import retains that identity. Contents and source URLs
describe an import; they do not identify it or merge it with another import.

An entry holds reviewed printing, finish, condition, quantity, candidate evidence and revision.
Pending, confirmed and discarded are distinct states governed by the
[import lifecycle](#import-and-capture-state). Session identity groups entries and tracks progress;
it does not independently determine ownership or visibility.

Keep three identities separate:

- Capture or staged-line identity records admission/replay of one input. Consecutive accepted identity
  is session state; unresolved input does not advance it.
- Acquisition identity records which line content and occurrence within an import produced copies.
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

A copy has at most one physical location: a binder, box, physical deck or another location. Moving
it replaces that location association without changing ownership. Planned decks remain independent
card/printing associations and do not reserve or relocate copies.

## Import and capture state

Own both the active session and persisted pending entries, including candidates, user corrections,
quantities, import identity and source provenance. A browser-resident session is part of this component's state;
presentation controls do not maintain a second authoritative import model. Raw frames are transient input.

Staging persists entries with `system:import-pending` membership. These entries are visible only on
the Import page and are excluded from ownership totals, ordinary searches and other lists. Enforce
this distinction in the component's read contracts. Pending entries can lack a resolved printing or
represent several copies; they are not yet individual physical-copy records.

Review and correction retain pending membership. Explicit confirmation validates the reviewed
revision and atomically ends pending membership, creates the corresponding individual copies with
provenance and gives them `system:owned` membership. The copies then become available through ordinary
reads. There is no intermediate `system:ready` state. System memberships express this lifecycle and
are managed by its operations, rather than edited independently.

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

Parse each supported source into pending entries. Unresolved names or printings remain reviewable;
unsupported formats and invalid rows produce explicit errors. Keep provider fetching and parsing
inside this boundary. Source additions or removals alone never change physical ownership.
Replay protection is scoped to the identified import and its acquisitions, including after migration.

## Persistence and recovery

Use atomic changes and revision checks for coupled records. Conflicting edits remain recoverable
instead of overwriting newer state. Preserve import identity so replay cannot add the same acquisition
twice within that import. A source change alone does not prove that physical ownership changed.

Persist pending progress independently of ownership. A successful save does not require returning
the entire collection. Keep account data isolated in browser persistence as well as backend storage.
