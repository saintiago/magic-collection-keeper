# CardViews

## Responsibility

Render cards and lists, translate direct input and report the visible viewport. Own physical DOM,
measurements, accessibility and the application of scroll/focus instructions.

## Interface

Receive a [CardList](../card-list.md) public factory and list description. Create one instance per
mounted view through that factory and dispose it with the view. Expose mount, retain/restore
delegation and dispose. Observe immutable presentation snapshots and
send viewport, select, activate, expand, change-query and retry intents through that instance's
contract. Report whether a requested visual position was applied or interrupted by user input.

Provide [Pages](pages.md) and [Editors](editors.md) with card/list/detail and picker views. Emit
open-target and action intents carrying the instance's explicit target context. Retained list state
passes through untouched. Returning a selection does not mean selecting everything in a query.

## Internal design

- **Window renderer:** reconcile stable visible keys with a bounded set of mounted elements.
- **Card presentation:** render basic information and independent fragment states, including unresolved entries.
- **Input mapping:** translate pointer, keyboard and touch into intents with explicit entry keys.
- **Viewport:** measure visibility and apply requested position/focus without owning logical restoration.

Render group descriptors and member references as supplied. Do not group fetched rows, sum quantities,
filter membership or decide which copies belong to a bulk action. Show direct and derived values as
labelled data, with distinct owned, intended and location counts. Unavailable information is not zero.

Only visible demand and user intent can initiate requests through the supplied capability. Rendering
does not fetch data, choose a cache, follow continuations, discover tools or maintain a selected-ID set.
Re-rendering a snapshot must not repeat an action. Preserve the usable visual content of independent
regions while their refresh is pending or fails.

## Replacement evidence

The same instance can drive a different layout without changes to its data or selection behavior.
Test visible states, safe external text, keyboard/touch actions, bounded DOM, measured viewport and
interrupted focus/scroll application using supplied snapshots. Do not duplicate data-loading tests.
