# CardList

## Responsibility

Own one card list's asynchronous contents, enrichment, selection, working window and restoration.
Provide a presentation model independent of a DOM, page, transport or storage implementation.

## Interface

### Provided interface

Provide [UserInterface](ui/architecture.md) with independently constructed list instances. A list
description identifies an activity: query results, a set/tag/collection, a typed detail target, an
import's pending entries or recent cards. Query criteria use [Search](search.md)'s public vocabulary;
private references use [UserCards](user-cards.md)'s contracts. Descriptions contain intent, not fetched
rows, cache choices or continuation tokens. Import identity remains the identity of the same list
when reopened; two imports with identical contents remain separate.

| Capability                   | Input                                                                     | Observable result                                                               |
| ---------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Observe                      | Subscription and current lifetime.                                        | Current snapshot, then updates; unsubscribe stops delivery.                     |
| Change description / refresh | New intent or explicit refresh.                                           | A new result generation, with distinct loading/failure/empty states.            |
| Viewport demand              | Visible range/keys and requested fragment kinds.                          | Bounded content/enrichment work and an updated window.                          |
| Select / expand / activate   | Explicit stable entry keys and user intent.                               | Selection/group state or typed target/action context.                           |
| Retry                        | Failed region or fragment identity.                                       | Recovery of that region without resetting unrelated state.                      |
| Retain / restore / release   | Opaque state handle scoped to this instance type and account.             | Restored context, completed/interrupted status and released retained resources. |
| Report position              | Visible anchor, offset and focus key; applied/interrupted acknowledgment. | Updated logical position or completion of a restoration request.                |
| Dispose                      | Instance lifetime.                                                        | Cancel reads, unsubscribe and suppress obsolete delivery.                       |

Snapshots contain stable entry keys, typed targets, basic information or unresolved state, group
descriptors, selection and independent fragment statuses. Targets can be card, printing, physical
copy or pending-entry references; a pending entry need not have a resolved card identity. Distinguish
pending, ready, absent and failed fragments. Action context carries explicit references and revisions
when needed; visible rows are not a substitute for the selection. No mutable internal store, raw
continuation or DOM object is exposed.

A typed detail target is a description of one entry: its snapshot carries the level's basic
presentation, the images fragment of the presented printing and, at the copy level, the account's
private record the detail level presents. A source whose read is already authoritative for that
record reports it as current; a target the provider does not publish is the entry's explicit
absence, never a failed read.

Snapshots also expose whether results are waiting for known committed changes to be indexed. This
state is distinct from fetching a page, an empty result and a failed read.

Also provide account-local recent-activity access: record an explicitly opened typed target and
construct its recent-list source. Application supplies the same account-scoped source to interested
instances. Pages records a visit on explicit details entry, not on each render. This capability owns
only local browsing history and does not create a saved business card list.

### Required interfaces and source bindings

- [Search](search.md) supplies complete query membership, ordering, grouping, continuation and counts.
  Its freshness contract reports indexed positions and incorporation of known committed changes.
- [Catalog](catalog.md) supplies batched basic information, printing choices and image references.
- [UserCards](user-cards.md) supplies pending-entry lists, tags, operation availability and private
  data changes. Pending visibility, intended quantities and ownership remain provider decisions.
- [Application](application.md) supplies account-scoped clients and lifecycle. No authenticated
  client or concrete provider is constructed by a list.

Bindings inside this component translate provider results into the list's own source/fragment
protocol. They are replaceable separately from window/selection behavior. A source read accepts a
description, bounded page size, opaque continuation and cancellation. It returns ordered entries,
context and end/continuation. Failures distinguish retryable read, restart-required sequence and
invalid description. Fragment reads accept explicit keys/references and return keyed independent
results. Provider adapters do not call pages to repair a list.

Bindings consume provider-owned contracts. Providers never import presentation types. List-level
contracts describe loading and interaction; they neither redefine search semantics nor create a
shared import-workflow contract. Tool availability is advisory provider information; invoking a tool
still uses its provider's current validation. A list supplies action context, not mutation execution.

When a UserCards notification supplies a publication position, query-source bindings pass it to
Search and use its bounded freshness observation. Pending-import and direct-record sources continue
using their authoritative reads. Pages and renderers do not poll Search or synthesize updated rows.

## Internal design

| Unit                   | Responsibility and owned state                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| Source bindings        | Convert descriptions and provider reads; preserve source identity, ordering and failure semantics. |
| Working window         | Acquire bounded sequences, fence generations and schedule required reads.                          |
| Enrichment             | Batch demand, reuse valid available values and track each fragment independently.                  |
| Selection              | Explicit targets, group/member interaction and selection outside the mounted window.               |
| Restoration            | Retained description, selection and logical position; completion/interruption.                     |
| Recent activity source | Account-local visited-card history and its ordering; no server or cross-device history is implied. |

Each unit has a focused interface and keeps its state private. The instance composes them; it does
not introduce a general state-management framework. The recent source records explicit open-card
activity through its public capability. Loading, scrolling or revisiting a cached row alone does not
add an activity entry. Bound this history independently of active selection and clear it on sign-out.

## Loading and recovery

Resolved entries include basic information in the initial read. Display available basics immediately;
do not wait for images, ownership, tags or tools. Enrichment failure cannot hide basic content or
change membership. Grouping and counts come from the source; grouping a partially loaded window is
not a complete result. Keep access to individual copy references when presenting groups.

Acquire only the active working set and needed fragments. Reuse data when its scope and freshness
are valid; a cache is optional and owned here. Private reuse is partitioned by account. Avoid a
request per row when the provider supports batching. Bound in-flight work and release unused data
without truncating logical selection. A read batch size is not a maximum list size.

Temporary read failure retries the failed position. An invalidated sequence restarts without its
rejected continuation. Preserve usable content and selection until the replacement arrives; never
append a new sequence to the old one. A failed restart remains explicitly retryable without an
automatic retry loop. The same rules apply during restoration.

Track generation and account for every asynchronous read. Obsolete responses cannot populate the
active window, replace a newer edit or leak private values into another account. Local committed
change notifications mark affected data stale; reacquire it through its source. Recheck on opening
or explicit refresh as well. No real-time cross-device delivery is promised.

Keep usable results labelled as updating until the source incorporates the required publication
position. Observe progress through the supplied capability, then refresh the relevant generation.
Delayed or failed indexing is explicit and recoverable; it cannot trigger another business write or
clear the view into a successful empty result. Changes arriving during the wait extend the required
progress without losing selection or overwriting drafts.

## Selection and restoration

Selection is independent of loaded and rendered windows. Keep explicit identity through enrichment
and level refinement; never silently substitute a different copy. A disappeared or changed target
must be represented as unavailable/stale for an action rather than acting on a replacement row.

Retained state preserves intended context while data is unavailable. Partial loading cannot overwrite
that intention. Explicit user changes supersede the affected restored state; interrupted automatic
positioning must not disable future capture of user changes. Report restore completion or interruption
without waiting for every optional fragment. No 100-card selection cap is implied by history storage.

## Replacement evidence

Run the same headless contract cases against a replacement: out-of-order reads, partial enrichment,
retry/restart, two independent instances, explicit selection outside the window, account changes,
retention and interrupted restoration. A presentation-only replacement must not alter these outcomes.
