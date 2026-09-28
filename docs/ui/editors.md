# Editors

## Responsibility

Own unsaved input and the presentation of a user-requested action. Keep draft values distinct from
the last committed values and explain provider validation, conflicts and uncertain outcomes.

## Interface

Receive focused [UserCards](../user-cards.md) read/command capabilities and recoverable operation
handles. Use [Catalog](../catalog.md) for valid printing attributes; use a supplied
[CardViews](card-views.md) picker with a [CardList](../card-list.md) description for card choices.
Use provider-declared capabilities and validation results rather than copying business limits.

Provide [Pages](pages.md) with independently mountable editors for query/filter input, copy attributes, tags,
associations/location, import source input, pending review and confirmation. Input identifies the
target, committed values/revision and explicit selected references. Output is draft state,
operation presentation and navigation/close intent. Expose retain, restore and dispose for drafts;
operation handles remain provider-owned.

Query editors receive the current CardList description and its change-intent capability. Keep typed
input separate from the applied query, submit explicit criteria and present query errors. Search
parsing and normalization remain behind that capability; an editor does not filter loaded cards.

## Internal design

Each activity editor maps its fields into one owning operation's input. Reuse field rendering and
draft lifecycle where they are identical; do not build a universal schema-driven workflow engine.

Keep printing, language, finish and condition editable for copies. Organization forms expose labels,
intended quantities, card/printing specificity and explicit physical-copy moves. Review forms expose
printing, finish, condition and quantity before explicit confirmation. Bulk actions retain exact
target references independently of which rows are visible.

Source input collects supported text or references and displays progress, provenance, row errors and
reconciliation outcomes. It does not parse deck formats, match names, allocate import identities or
deduplicate identical imports. A new-import command and a reopen/retry command are distinct intents.

## Drafts and asynchronous outcomes

Track the submitted draft separately from later typing. A completed submission cannot mark edits
made after it as saved. Retain unsaved values on validation failure, conflict or unavailable service;
show the returned authoritative state alongside the draft when reconciliation is needed.

Use a provider operation handle to observe pending, committed, rejected or unknown outcome. Reopening
attaches to the same attempt; recovery and safe retry belong to that handle. No editor stores its own
confirmation receipt or decides that a timeout permits another acquisition. Closing the editor drops
its subscription, not the meaning of an already submitted command.

Shared field validation covers presentation concerns such as entering a number. Semantic constraints
and supported quantities come from the operation contract. Request batch bounds cannot silently cap
the user's intended operation or selection.

## Replacement evidence

Replace an editor while keeping the same operation implementation. Verify field-to-command mapping,
exact target context, draft preservation, edits during submission, conflict presentation, unknown
outcomes and reattachment. Atomicity and replay tests belong to the operation provider.
