# UserInterface

## Responsibility

Own pages, navigation, device controls and presentation. Compose CardList and card tools around
the user's current activity.

## Interface

- Use Search for query results and Catalog for card/printing information.
- Use UserCards for private changes and both transient and saved import state. Treat returned
  operation outcomes as authoritative.
- Use Recognition to prepare image analysis and obtain candidates for captured frames. Pass
  candidates and review actions into UserCards.
- Receive public configuration, authentication and component access from Application.
- Provide CardList with a source, presentation and tools. Sources supply entries and continuation;
  tools invoke the owning component's operations.

### List boundary

A source accepts query context, page size, continuation and cancellation. It returns entries with
stable keys, typed targets, basic information or explicit unresolved state, and an end/continuation
indicator. Search pages and UserCards pending entries are adapted to this presentation contract;
their providers do not import UI types.

Fragment requests identify entry keys and requested information. Results distinguish ready, absent
and failed information. Tools accept explicit target references and selection context and return
an operation outcome. Cancellation or an old page response cannot replace the active view.

Construct the UI with supplied source, tool, identity and device capabilities. Tests can replace
these boundaries while exercising real navigation and presentation behavior.

## Internal design

| Unit                     | Owns                                                                             |
| ------------------------ | -------------------------------------------------------------------------------- |
| Shell and navigation     | Routes, page lifetime, account changes and bounded restoration.                  |
| Pages                    | Activity-specific composition of sources, lists, details and tools.              |
| CardList state           | One list's query generation, loaded window, fragment states and selection.       |
| Source and tool bindings | Conversion from supplied public operations to presentation inputs/actions.       |
| Rendering                | Accessible visible state and bounded DOM; no authoritative membership decisions. |
| Device interaction       | Permissions, frame acquisition, geometry admission and cleanup.                  |

A page creates and disposes its lists and device work. A list owns its asynchronous request generation;
late responses may not mutate a replacement query, disposed page or another account. Sources own
membership and continuation. Rendering never reconstructs them from enrichment or selection state.
Pending import records and operation receipts are read through supplied operations, not independently
maintained in page state. Local unsaved form input remains presentation state until accepted.

## Pages and navigation

Home, catalog/search, collection, tags, tag views, card details and import are dedicated pages.
Card details can open at any of the three specificity levels. URLs identify the view sufficiently
for reload and direct entry.

Prefer a separate page over a modal window whenever the interaction can be presented as a page.
Reserve dialogs for brief confirmations and small auxiliary actions.

Back follows navigation history. Restore relevant query, selection, scroll and focus using bounded,
account-isolated state. Closing a page cancels its work or prevents late results from changing the
new view. A page whose restored content arrives asynchronously reports when it presented the entry,
so the shell restores that entry's scroll and focus over the presented content. An interrupted
restoration keeps the context the entry had instead of capturing the partially presented view: the
page's captured state stays live beside the entry's scroll offset, focus and visible position, which
are kept until the page presents its content and subsequent explicit user input takes them over.
Input during loading cancels automatic scroll and focus restoration while preserving the saved
context if loading is interrupted. It must not prevent later input from replacing that context once
the content is presented.

## CardList

Keep each list's query, loaded window, selection and scroll independent. Stable entry keys preserve
interaction during enrichment or refinement. Group equivalent copies for convenient bulk actions
without losing access to individual copies.

Render basic information with initial resolved entries. Images, ownership, tags and tool availability
have separate loading and failure states. Refresh preserves usable content; unavailable data is not
an empty result. Bound loading and rendering to the active working set.

## Browsing and organization

Home presents bounded, account-isolated recent card activity. Catalog and set views share search
and CardList behavior. Collection and detail views expose card, printing and physical-copy levels,
with straightforward navigation between them and individually selectable copies inside groups.

Show owned, intended and physical-location counts distinctly. Provide copy corrections for printing,
language, finish and condition, and bulk tools acting on explicit selected copy identities. Tag views
support editable labels, intended quantities, card/printing refinement and physical-location moves
through the supplied operations. Required deck counts and physical counts remain distinct.

Preserve unsaved input after a conflict or failed edit so the user can review and retry. Display a
saved outcome only after the operation reports it committed; a lost response remains recoverable.

## Capture and review

Own camera permission, frame acquisition, capture controls and feedback. Admit stable single-card
frames using geometry independently of identity matching. Keep ordinary capture hands-free after
initial activation; release device resources when the session ends.

Show provisional candidates, disagreement and uncertainty. A success cue means a candidate was
accepted into review, never that ownership was confirmed. Unresolved captures receive no success
cue; repeated error cues are bounded per attempt. Review exposes printing, finish, condition and
quantity before confirmation.

Render external text safely and support keyboard and touch interaction. Sign-out removes private
presentation state and invalidates outstanding responses.

## Source imports

Expose the supported source methods on the Import page. Show progress, row-level errors and
unresolved entries; successful parsing is not ownership confirmation. Imported rows use the same
pending review and explicit confirmation interaction as manual entry and scanning.

Show relevant provenance and explain replay/reconciliation outcomes where the user makes a decision.
Keep progress recoverable, protect user corrections during asynchronous updates, and recover a lost
confirmation response through the recorded operation outcome. Avoid exposing credentials or
retaining source data that the workflow does not need.
