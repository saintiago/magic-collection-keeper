# User journeys

These initial journeys describe user outcomes and broad flows. Category IDs refer to
[user categories](user-categories.md). Detailed steps, acceptance criteria and E2E scenarios will
be added iteratively under the same requirement IDs.

## Shared behavior

**REQ-011 — Automatic saving:** Changes save automatically; there are no Save buttons.
Import confirmation remains an explicit action.

## Initial journeys

| ID      | Journey and intended outcome                                                                   | Categories                                                 | Initial flow                                                                                                 |
| ------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| REQ-001 | Explore cards: discover cards of interest and understand their basic information.              | USER-001, USER-002, USER-003                               | Browse or search the catalog → open a card → inspect its information.                                        |
| REQ-002 | Identify a card or printing: find its rules text and distinguish published versions.           | USER-001, USER-002, USER-003, USER-004, USER-005, USER-006 | Find a card → inspect details → inspect its printings.                                                       |
| REQ-003 | Record physical cards: make the collection accurately reflect acquired copies.                 | USER-001, USER-002, USER-003, USER-004, USER-005           | Capture or enter cards → review and correct → explicitly confirm ownership → verify saved copies.            |
| REQ-004 | Check ownership: know which cards and how many copies are already owned.                       | USER-002, USER-003, USER-004, USER-005                     | Find cards in the collection → inspect owned quantities and copy details.                                    |
| REQ-005 | Organize and locate copies: know where physical cards are stored.                              | USER-002, USER-003, USER-004, USER-005                     | Select copies → assign or change their location → inspect the location and its count.                        |
| REQ-006 | Plan a deck: record required cards and quantities while keeping plans distinct from ownership. | USER-001, USER-002                                         | Create a deck or import a list → review and adjust its requirements → inspect required and owned quantities. |
| REQ-007 | Track wanted cards: remember desired cards and quantities for later acquisition.               | USER-001, USER-002, USER-003                               | Find a card or printing → add it to a wishlist → set and revisit the desired quantity.                       |

These journeys describe intended user outcomes, not evidence of implementation or passing E2E suites.

## Future journeys from charter direction

These outlines express product direction; detailed feature requirements remain to be defined.

| ID      | Journey and intended outcome                                                            | Categories                             | Initial flow                                                                 |
| ------- | --------------------------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------- |
| REQ-008 | Discover deck possibilities: find useful ideas or upgrades connected to the collection. | USER-001, USER-002, USER-003           | Explore ideas → understand the suggested cards → decide what to pursue.      |
| REQ-009 | Prepare a trade or sale: use the collection to decide which cards to offer.             | USER-002, USER-003, USER-004, USER-005 | Review owned cards → choose an offer → review the intended exchange or sale. |
| REQ-010 | Discover relevant releases: connect new sets and card reveals to personal interests.    | USER-001, USER-002, USER-003, USER-005 | Browse relevant releases → inspect cards → decide what interests you.        |

The [product charter](../PRODUCT-CHARTER.md#connected-jobs) owns this direction. Store-specific
business journeys and any judging workflows require further definition.
