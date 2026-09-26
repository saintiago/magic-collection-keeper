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

## Pages and navigation

Home, catalog/search, collection, tags, tag views, card details and import are dedicated pages.
Card details can open at any of the three specificity levels. URLs identify the view sufficiently
for reload and direct entry.

Back follows navigation history. Restore relevant query, selection, scroll and focus using bounded,
account-isolated state. Use brief dialogs for small auxiliary actions. Closing a page cancels its
work or prevents late results from changing the new view.

## CardList

Keep each list's query, loaded window, selection and scroll independent. Stable entry keys preserve
interaction during enrichment or refinement. Group equivalent copies for convenient bulk actions
without losing access to individual copies.

Render basic information with initial resolved entries. Images, ownership, tags and tool availability
have separate loading and failure states. Refresh preserves usable content; unavailable data is not
an empty result. Bound loading and rendering to the active working set.

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
