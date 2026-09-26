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
associations have no quantity. Pending entries remain outside the owned-copy relation.

Search reads these relations through the public query contract. The PostgreSQL implementation uses
protected views with account scoping enforced at the database boundary. Missing context fails
closed; account context cannot leak between reused connections. Private base tables are inaccessible
through this read contract. Publish a private-data revision for continuation validation.

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
quantities and source identity. A browser-resident session is part of this component's state;
presentation controls do not maintain a second authoritative import model. Raw frames are transient input.

Consecutive accepted scan identities suppress repeated observation: A,A admits one entry; A,B,A
admits all three. Explicit pending quantity represents repeated physical copies. Unresolved readings
and late candidate updates do not advance the accepted sequence or erase user corrections.

Pending entries remain reviewable until explicitly confirmed or discarded. Confirmation validates
the reviewed revision and creates individual copies with provenance. Repeating the same confirmed
operation returns its recorded outcome; changed input under that identity is rejected.

## Source imports

Support pasted card lists, Moxfield decks and reviewed Wizards preconstructed deck lists.
Preserve the source identity and acquisition provenance independently of editable labels and
the resulting physical-copy records. A reviewed Wizards list retains its official source reference;
accepting a list does not imply automatic discovery or scraping of every preconstructed product.

Parse each supported source into pending entries. Unresolved names or printings remain reviewable;
unsupported formats and invalid rows produce explicit errors. Keep provider fetching and parsing
inside this boundary. Source additions or removals alone never change physical ownership.
Replay protection applies to the same acquisition source, including after migration.

## Persistence and recovery

Use atomic changes and revision checks for coupled records. Conflicting edits remain recoverable
instead of overwriting newer state. Preserve import source identity so replay cannot add the same
acquisition twice. A source change alone does not prove that physical ownership changed.

Persist pending progress independently of ownership. A successful save does not require returning
the entire collection. Keep account data isolated in browser persistence as well as backend storage.
